"""The rows of folio.renditions the worker keeps: the record people see of each version's reader copy.

Folio's service owns the table and adds a `queued` row for each version it asks for. The
work itself runs as a DBOS workflow (worker.py); these are the updates it makes along the
way. Each is safe to make twice, because DBOS may run a step again after a crash.
"""

from __future__ import annotations

import json
from dataclasses import dataclass

import psycopg

#: How many times a rendition is tried before Artifacts gives up on it.
MAX_ATTEMPTS = 3

GAVE_UP = "Artifacts gave up making a reader copy of this version after several tries. Ask for it again, or tell your admin if it keeps failing."


def try_again(err: BaseException) -> str:
    """What a row says between tries."""
    return f"Artifacts couldn’t make a reader copy this time ({type(err).__name__}). It will try again."


@dataclass(frozen=True)
class Original:
    object_key: str
    media_type: str


def start(conn: psycopg.Connection, version: str) -> Original | None:
    """Marks a version's rendition running and finds its file. None when there's nothing to do:
    the row is ready or failed already, or gone with its version."""
    row = conn.execute(
        """update folio.renditions r set state = 'running', updated_at = now()
             from folio.document_versions v
             where r.version_id = %s and v.id = r.version_id and r.state in ('queued', 'running')
             returning v.object_key, v.media_type""",
        (version,),
    ).fetchone()
    return Original(*row) if row else None


def begin_try(conn: psycopg.Connection, version: str) -> int | None:
    """Counts a try at rendering, as it starts, and says which it is. None when the row was
    finished or removed meanwhile. A try run again after a crash is a try made, so it counts too."""
    row = conn.execute(
        """update folio.renditions set state = 'running', attempts = attempts + 1, updated_at = now()
             where version_id = %s and state in ('queued', 'running')
             returning attempts""",
        (version,),
    ).fetchone()
    return row[0] if row else None


def wait_to_retry(conn: psycopg.Connection, version: str, error: str) -> None:
    """Puts a rendition back to waiting after a try that may pass next time, saying why."""
    conn.execute(
        """update folio.renditions set state = 'queued', error = %s, updated_at = now()
             where version_id = %s and state in ('queued', 'running')""",
        (error, version),
    )


def finish(conn: psycopg.Connection, version: str, *, engine: list[str] | tuple[str, str], reader_key: str, thumbnail_key: str | None, images: list[str], pages: int | None, text: str) -> bool:
    """Records a made rendition. False when the row was no longer running (finished already, or gone)."""
    cur = conn.execute(
        """update folio.renditions set state = 'ready', error = null, updated_at = now(),
               engine = %s, engine_version = %s, reader_key = %s, thumbnail_key = %s, images = %s, pages = %s, text = %s
             where version_id = %s and state = 'running'""",
        # Postgres text can't hold NUL, which some PDFs carry.
        (*engine, reader_key, thumbnail_key, json.dumps(images), pages, text.replace("\x00", ""), version),
    )
    return cur.rowcount == 1


def fail(conn: psycopg.Connection, version: str, error: str) -> bool:
    """Records that a rendition failed for good, saying why. False when it had finished already, or gone."""
    cur = conn.execute(
        """update folio.renditions set state = 'failed', error = %s, updated_at = now()
             where version_id = %s and state in ('queued', 'running')""",
        (error, version),
    )
    return cur.rowcount == 1
