"""The worker against a real Postgres, with Folio's schema made by its service (pnpm migrate).

Its steps one by one, then whole workflows run by DBOS: queued by name on Folio's queue, as
the service queues them.
"""

import os
import uuid
from pathlib import Path

import psycopg
import pytest
from dbos import DBOS, DBOSClient
from dbos._serialization import WorkflowSerializationFormat

from folio_worker import rows, worker
from folio_worker.render import Rendered, RenderError

pytestmark = pytest.mark.skipif(not os.environ.get("DATABASE_URL"), reason="set DATABASE_URL to a Postgres with Folio's schema")

#: Not Folio's own id, so the tests keep their jobs apart from a local stack's.
TEST_APP = "folio_worker_test"


class Objects:
    """Folio's bucket, in memory."""

    def __init__(self, files: dict[str, bytes] | None = None):
        self.files = dict(files or {})
        self.types: dict[str, str] = {}

    def download(self, key: str, to: Path) -> None:
        to.write_bytes(self.files[key])

    def put(self, key: str, body: bytes, content_type: str) -> None:
        self.files[key] = body
        self.types[key] = content_type


@pytest.fixture
def conn():
    with psycopg.connect(os.environ["DATABASE_URL"], autocommit=True) as conn:
        conn.execute("truncate folio.renditions, folio.document_versions, folio.documents, folio.libraries cascade")
        conn.execute("insert into folio.libraries (id, workspace_id, name, created_by) values ('l-1', 'w-fin', 'Policies', 'u-1')")
        yield conn


@pytest.fixture
def objects(conn):
    objects = Objects()
    worker.use(worker.Deps(os.environ["DATABASE_URL"], objects, 60))
    return objects


def upload(conn, objects: Objects, version: str, body: bytes = b"Hello", media_type: str = "text/plain") -> str:
    """What the service does for an upload: a document, its version, and a queued rendition."""
    doc = f"d-{version}"
    key = f"documents/{doc}/{version}"
    conn.execute("insert into folio.documents (id, workspace_id, library_id, title, created_by) values (%s, 'w-fin', 'l-1', 'Notes', 'u-1')", (doc,))
    conn.execute(
        """insert into folio.document_versions (id, workspace_id, document_id, number, filename, media_type, size_bytes, sha256, object_key, created_by)
           values (%s, 'w-fin', %s, 1, 'notes.txt', %s, 10, 'ab', %s, 'u-1')""",
        (version, doc, media_type, key),
    )
    conn.execute("insert into folio.renditions (version_id, workspace_id) values (%s, 'w-fin')", (version,))
    objects.files[key] = body
    return key


def row(conn, version: str):
    return conn.execute("select state, attempts, error, reader_key, images, text, engine from folio.renditions where version_id = %s", (version,)).fetchone()


# The steps.


def test_start_marks_it_running_and_finds_the_file(conn, objects):
    key = upload(conn, objects, "v-1")
    assert rows.start(conn, "v-1") == rows.Original(key, "text/plain")
    assert row(conn, "v-1")[:2] == ("running", 0)
    # Run again after a crash, it changes nothing.
    assert rows.start(conn, "v-1") == rows.Original(key, "text/plain")
    assert row(conn, "v-1")[:2] == ("running", 0)


def test_start_leaves_a_finished_or_missing_rendition_alone(conn, objects):
    upload(conn, objects, "v-1")
    conn.execute("update folio.renditions set state = 'ready' where version_id = 'v-1'")
    assert rows.start(conn, "v-1") is None
    assert rows.start(conn, "v-gone") is None
    assert row(conn, "v-1")[0] == "ready"


def test_a_try_makes_a_reader_copy_and_finishing_records_it(conn, objects):
    key = upload(conn, objects, "v-1", b"Hello *world*")
    rows.start(conn, "v-1")
    result = worker.render_once("v-1", key, "text/plain", last_try=False)
    assert row(conn, "v-1")[:2] == ("running", 1)
    assert objects.files["renditions/v-1/reader.md"] == b"Hello \\*world\\*\n"
    assert objects.types["renditions/v-1/reader.md"].startswith("text/markdown")
    made = result["made"]
    assert made["reader_key"] == "renditions/v-1/reader.md" and made["engine"] == ["folio-text", "1"]
    assert rows.finish(conn, "v-1", **made)
    assert row(conn, "v-1") == ("ready", 1, None, "renditions/v-1/reader.md", [], "Hello *world*", "folio-text")
    # Finishing again changes nothing.
    assert not rows.finish(conn, "v-1", **{**made, "text": "other"})
    assert row(conn, "v-1")[5] == "Hello *world*"


def test_a_file_that_cant_be_read_says_why_without_raising(conn, objects):
    key = upload(conn, objects, "v-1", b"caf\xe9")
    rows.start(conn, "v-1")
    result = worker.render_once("v-1", key, "text/plain", last_try=False)
    assert "UTF-8" in result["error"]
    assert rows.fail(conn, "v-1", result["error"])
    state, attempts, error, *_ = row(conn, "v-1")
    assert (state, attempts) == ("failed", 1) and "UTF-8" in error


def test_anything_else_raises_for_another_try_and_says_so_meanwhile(conn, objects):
    upload(conn, objects, "v-1")
    rows.start(conn, "v-1")
    objects.files.clear()  # The original isn't there: as if the bucket were down.
    with pytest.raises(KeyError):
        worker.render_once("v-1", "documents/d-v-1/v-1", "text/plain", last_try=False)
    state, attempts, error, *_ = row(conn, "v-1")
    assert (state, attempts) == ("queued", 1) and "try again" in error
    # Every try counts, and the last says nothing of another.
    with pytest.raises(KeyError):
        worker.render_once("v-1", "documents/d-v-1/v-1", "text/plain", last_try=True)
    assert row(conn, "v-1")[:2] == ("running", 2)
    assert rows.fail(conn, "v-1", rows.GAVE_UP)
    assert row(conn, "v-1")[:3] == ("failed", 2, rows.GAVE_UP)


def test_a_try_at_a_rendition_finished_meanwhile_does_nothing(conn, objects):
    key = upload(conn, objects, "v-1")
    conn.execute("update folio.renditions set state = 'failed', attempts = 3 where version_id = 'v-1'")
    assert worker.render_once("v-1", key, "text/plain", last_try=False) == {"gone": True}
    assert row(conn, "v-1")[:2] == ("failed", 3)
    assert not rows.fail(conn, "v-1", "again")


# Whole workflows, run by DBOS.


def _stub(path: Path, media_type: str, timeout: int) -> Rendered:
    body = path.read_text()
    if body == "damaged":
        raise RenderError("Artifacts couldn’t read this file.")
    return Rendered(markdown=f"# {body}\n", text=body, images=[b"png"], pages=2, engine=("stub", "1"))


@pytest.fixture(scope="module")
def dbos():
    url = os.environ["DATABASE_URL"]
    schema = worker.dbos_config(TEST_APP, url)["dbos_system_schema"]
    with psycopg.connect(url, autocommit=True) as c:
        c.execute(f"drop schema if exists {schema} cascade")
    objects = Objects()
    worker.launch(TEST_APP, worker.Deps(url, objects, 60, _stub))
    # The service registers the queue; here the test stands in for it.
    DBOS.register_queue(worker.QUEUE)
    client = DBOSClient(system_database_url=url, dbos_system_schema=schema, application_name=TEST_APP)
    yield client, objects
    client.destroy()
    worker.destroy()
    with psycopg.connect(url, autocommit=True) as c:
        c.execute(f"drop schema if exists {schema} cascade")


def enqueue(client: DBOSClient, version: str):
    """As the service queues a rendition: by name, on Folio's queue, in portable JSON."""
    return client.enqueue(
        {
            "workflow_name": worker.WORKFLOW,
            "queue_name": worker.QUEUE,
            "workflow_id": f"renditions-{version}-{uuid.uuid4().hex[:8]}",
            "app_version": worker.JOBS_VERSION,
            "serialization_type": WorkflowSerializationFormat.PORTABLE,
        },
        {"version": version},
    )


def test_a_queued_rendition_becomes_ready(conn, dbos):
    client, objects = dbos
    key = "documents/d-v-1/v-1"
    upload(conn, Objects(), "v-1", media_type="text/markdown")
    objects.files[key] = b"Notes"
    assert enqueue(client, "v-1").get_result(polling_interval_sec=0.2) == "ready"
    state, attempts, error, reader_key, images, text, engine = row(conn, "v-1")
    assert (state, attempts, error, reader_key, images, text, engine) == ("ready", 1, None, "renditions/v-1/reader.md", ["1.png"], "Notes", "stub")
    assert objects.files["renditions/v-1/reader.md"] == b"# Notes\n"
    assert objects.files["renditions/v-1/images/1.png"] == b"png"
    # Asked for again once ready, a run finds nothing to do.
    assert enqueue(client, "v-1").get_result(polling_interval_sec=0.2) == "skipped"
    assert row(conn, "v-1")[:2] == ("ready", 1)


def test_a_file_that_cant_be_rendered_fails_at_once(conn, dbos):
    client, objects = dbos
    upload(conn, Objects(), "v-2", media_type="text/markdown")
    objects.files["documents/d-v-2/v-2"] = b"damaged"
    assert enqueue(client, "v-2").get_result(polling_interval_sec=0.2) == "failed"
    assert row(conn, "v-2")[:3] == ("failed", 1, "Artifacts couldn’t read this file.")

