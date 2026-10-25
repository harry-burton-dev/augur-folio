"""The queue and the worker against a real Postgres, with Folio's schema made by its service (pnpm migrate)."""

import os
from datetime import timedelta
from pathlib import Path

import psycopg
import pytest

from folio_worker import queue
from folio_worker.worker import work_one

pytestmark = pytest.mark.skipif(not os.environ.get("DATABASE_URL"), reason="set DATABASE_URL to a Postgres with Folio's schema")

LEASE = timedelta(minutes=5)


class Objects:
    """Folio's bucket, in memory."""

    def __init__(self, files: dict[str, bytes]):
        self.files = dict(files)
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


def upload(conn, version: str, media_type: str = "text/markdown") -> str:
    """What the service does for an upload: a document, its version, and a queued rendition."""
    doc = f"d-{version}"
    conn.execute("insert into folio.documents (id, workspace_id, library_id, title, created_by) values (%s, 'w-fin', 'l-1', 'Notes', 'u-1')", (doc,))
    conn.execute(
        """insert into folio.document_versions (id, workspace_id, document_id, number, filename, media_type, size_bytes, sha256, object_key, created_by)
           values (%s, 'w-fin', %s, 1, 'notes.md', %s, 10, 'ab', %s, 'u-1')""",
        (version, doc, media_type, f"documents/{doc}/{version}"),
    )
    conn.execute("insert into folio.renditions (version_id, workspace_id) values (%s, 'w-fin')", (version,))
    return f"documents/{doc}/{version}"


def row(conn, version: str):
    return conn.execute("select state, attempts, error, reader_key, images, text, engine, run_after > now() from folio.renditions where version_id = %s", (version,)).fetchone()


def test_makes_a_reader_copy_and_records_it(conn):
    key = upload(conn, "v-1")
    objects = Objects({key: b"# Notes\n\nHello"})
    assert work_one(conn, objects, 60)
    assert not work_one(conn, objects, 60)
    state, attempts, error, reader_key, images, text, engine, _ = row(conn, "v-1")
    assert (state, attempts, error, reader_key, images, engine) == ("ready", 1, None, "renditions/v-1/reader.md", [], "docling")
    assert "Hello" in text
    assert objects.files["renditions/v-1/reader.md"] == b"# Notes\n\nHello\n"
    assert objects.types["renditions/v-1/reader.md"].startswith("text/markdown")


def test_a_file_that_cant_be_read_fails_at_once(conn):
    key = upload(conn, "v-1", "text/plain")
    assert work_one(conn, Objects({key: b"caf\xe9"}), 60)
    state, attempts, error, *_ = row(conn, "v-1")
    assert (state, attempts) == ("failed", 1) and "UTF-8" in error


def test_anything_else_is_tried_again_later_then_given_up(conn):
    upload(conn, "v-1")
    objects = Objects({})  # The original isn't there: as if the bucket were down.
    assert work_one(conn, objects, 60)
    state, attempts, error, *_, later = row(conn, "v-1")
    assert (state, attempts, later) == ("queued", 1, True) and "try again" in error
    # Not due yet, so nothing is waiting.
    assert not work_one(conn, objects, 60)
    for attempt in (2, 3):
        conn.execute("update folio.renditions set run_after = now() where version_id = 'v-1'")
        assert work_one(conn, objects, 60)
    state, attempts, error, *_ = row(conn, "v-1")
    assert (state, attempts, error) == ("failed", 3, queue.GAVE_UP)


def test_a_lease_that_runs_out_goes_to_the_next_worker_until_tries_run_out(conn):
    upload(conn, "v-1")
    first = queue.claim(conn, LEASE)
    assert first and first.attempt == 1
    assert queue.claim(conn, LEASE) is None  # Leased, so no one else takes it.
    conn.execute("update folio.renditions set locked_until = now() - interval '1 second' where version_id = 'v-1'")
    second = queue.claim(conn, LEASE)
    assert second and second.attempt == 2
    # The first worker comes back too late: its result isn't taken.
    assert not queue.finish(conn, first, engine=("docling", "x"), reader_key="k", thumbnail_key=None, images=[], pages=None, text="")
    conn.execute("update folio.renditions set attempts = 3, locked_until = now() - interval '1 second' where version_id = 'v-1'")
    assert queue.claim(conn, LEASE) is None
    assert row(conn, "v-1")[:3] == ("failed", 3, queue.GAVE_UP)


def test_oldest_first(conn):
    upload(conn, "v-b")
    upload(conn, "v-a")
    conn.execute("update folio.renditions set run_after = now() - interval '1 minute' where version_id = 'v-a'")
    assert queue.claim(conn, LEASE).version == "v-a"
    assert queue.claim(conn, LEASE).version == "v-b"
