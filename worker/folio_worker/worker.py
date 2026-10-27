"""Takes renditions off the queue one at a time and makes them."""

from __future__ import annotations

import logging
import tempfile
from datetime import timedelta
from pathlib import Path

import psycopg

from . import queue
from .bucket import ObjectStore, prefix
from .render import RenderError, render

log = logging.getLogger("folio_worker")


def work_one(conn: psycopg.Connection, objects: ObjectStore, render_timeout: int) -> bool:
    """Makes the rendition that has waited longest. False when nothing was waiting."""
    # The lease outlasts the longest a file may take, so no other worker takes it meanwhile.
    job = queue.claim(conn, lease=timedelta(seconds=render_timeout + 300))
    if not job:
        return False
    log.info("rendering", extra={"version": job.version, "attempt": job.attempt, "media_type": job.media_type})
    try:
        with tempfile.TemporaryDirectory(prefix="folio-") as tmp:
            original = Path(tmp) / "original"
            objects.download(job.object_key, original)
            made = render(original, job.media_type, timeout=render_timeout)
        at = prefix(job.version)
        images = []
        for n, png in enumerate(made.images, start=1):
            objects.put(f"{at}images/{n}.png", png, "image/png")
            images.append(f"{n}.png")
        thumbnail_key = None
        if made.thumbnail:
            thumbnail_key = f"{at}thumbnail.png"
            objects.put(thumbnail_key, made.thumbnail, "image/png")
        # The reader copy goes in last: once it's there, everything it shows is too.
        objects.put(f"{at}reader.md", made.markdown.encode("utf-8"), "text/markdown; charset=utf-8")
        if not queue.finish(conn, job, engine=made.engine, reader_key=f"{at}reader.md", thumbnail_key=thumbnail_key, images=images, pages=made.pages, text=made.text):
            log.warning("lost the lease before finishing", extra={"version": job.version})
        else:
            log.info("rendered", extra={"version": job.version, "images": len(images), "pages": made.pages})
    except RenderError as err:
        log.info("can't be rendered", extra={"version": job.version, "reason": str(err)})
        queue.fail(conn, job, str(err), final=True)
    except Exception as err:  # Anything else may pass: try again later.
        log.exception("rendering failed", extra={"version": job.version, "attempt": job.attempt})
        queue.fail(conn, job, f"Artifacts couldn’t make a reader copy this time ({type(err).__name__}). It will try again.", final=False)
    return True


def run(database_url: str, objects: ObjectStore, render_timeout: int, poll_seconds: int) -> None:
    """Works until stopped: through everything waiting, then waits for word of more, or the next poll."""
    with psycopg.connect(database_url, autocommit=True) as conn:
        conn.execute(f"listen {queue.CHANNEL}")
        log.info("waiting for renditions")
        while True:
            while work_one(conn, objects, render_timeout):
                pass
            # Word of a new version wakes it; the poll catches retries that come due, and anything missed.
            for _ in conn.notifies(timeout=poll_seconds, stop_after=1):
                pass
