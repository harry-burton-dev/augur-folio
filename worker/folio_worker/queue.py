"""The rendition queue: rows of folio.renditions, which Folio's service adds as versions are uploaded.

A worker leases one row at a time (`for update skip locked`, so any number can run
side by side) and holds it until `locked_until`. A worker that dies mid-file lets
its lease run out, and the row goes to the next worker. Each lease counts as an
attempt; after MAX_ATTEMPTS the rendition fails for good.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import timedelta

import psycopg

#: How many times a rendition is tried before Folio gives up on it.
MAX_ATTEMPTS = 3

#: The channel Folio's service tells of new versions on.
CHANNEL = "folio_renditions"

GAVE_UP = "Folio gave up making a reader copy of this version after several tries. Ask for it again, or tell your admin if it keeps failing."


@dataclass(frozen=True)
class Job:
    version: str
    attempt: int
    object_key: str
    media_type: str


def backoff(attempt: int) -> timedelta:
    """How long to wait after a failed try before the next: a minute, then four, then sixteen."""
    return timedelta(minutes=4 ** (attempt - 1))


def claim(conn: psycopg.Connection, lease: timedelta) -> Job | None:
    """Leases the rendition that has waited longest, or None when nothing is waiting."""
    with conn.transaction():
        # A lease that ran out on its last try won't be taken again: that file stops here.
        conn.execute(
            """update folio.renditions set state = 'failed', error = %s, locked_until = null, updated_at = now()
                where state = 'running' and locked_until < now() and attempts >= %s""",
            (GAVE_UP, MAX_ATTEMPTS),
        )
        row = conn.execute(
            """with next as (
                 select version_id from folio.renditions
                 where (state = 'queued' and run_after <= now()) or (state = 'running' and locked_until < now())
                 order by run_after, version_id
                 limit 1
                 for update skip locked
               )
               update folio.renditions r
                 set state = 'running', attempts = r.attempts + 1, locked_until = now() + %s, updated_at = now()
                 from next, folio.document_versions v
                 where r.version_id = next.version_id and v.id = r.version_id
                 returning r.version_id, r.attempts, v.object_key, v.media_type""",
            (lease,),
        ).fetchone()
    return Job(*row) if row else None


def finish(conn: psycopg.Connection, job: Job, *, engine: tuple[str, str], reader_key: str, thumbnail_key: str | None, images: list[str], pages: int | None, text: str) -> bool:
    """Records a made rendition. False when the lease was lost, so another worker has it now."""
    with conn.transaction():
        cur = conn.execute(
            """update folio.renditions set state = 'ready', error = null, locked_until = null, updated_at = now(),
                   engine = %s, engine_version = %s, reader_key = %s, thumbnail_key = %s, images = %s, pages = %s, text = %s
                 where version_id = %s and state = 'running' and attempts = %s""",
            # Postgres text can't hold NUL, which some PDFs carry.
            (*engine, reader_key, thumbnail_key, json.dumps(images), pages, text.replace("\x00", ""), job.version, job.attempt),
        )
        return cur.rowcount == 1


def fail(conn: psycopg.Connection, job: Job, error: str, *, final: bool) -> None:
    """Records a try that failed: for good when `final` or out of tries, otherwise queued again for later."""
    with conn.transaction():
        if final or job.attempt >= MAX_ATTEMPTS:
            conn.execute(
                """update folio.renditions set state = 'failed', error = %s, locked_until = null, updated_at = now()
                     where version_id = %s and state = 'running' and attempts = %s""",
                (error if final else GAVE_UP, job.version, job.attempt),
            )
        else:
            conn.execute(
                """update folio.renditions set state = 'queued', error = %s, locked_until = null, run_after = now() + %s, updated_at = now()
                     where version_id = %s and state = 'running' and attempts = %s""",
                (error, backoff(job.attempt), job.version, job.attempt),
            )
