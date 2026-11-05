"""The worker's health, for its container's healthcheck (the Dockerfile's HEALTHCHECK).

The worker has no port to ask, so while it runs it beats: every `EVERY` seconds it asks its database,
which holds the queue it takes renditions from, and on an answer writes the time to a file. The
healthcheck, `python -m folio_worker.health`, is healthy while the last beat is recent.
"""

from __future__ import annotations

import logging
import os
import sys
import threading
import time
from pathlib import Path

log = logging.getLogger("folio_worker")

#: Seconds between beats. The healthcheck allows three to pass before it says the worker is down.
EVERY = 30
HEARTBEAT = Path(os.environ.get("WORKER_HEARTBEAT_FILE", "/tmp/folio-worker.alive"))


def _database_answers(database_url: str) -> bool:
    import psycopg

    try:
        with psycopg.connect(database_url, connect_timeout=5) as conn:
            conn.execute("select 1")
        return True
    except psycopg.Error as err:
        log.warning("the database didn't answer the heartbeat", extra={"reason": str(err)})
        return False


def beat(database_url: str, stop: threading.Event, *, every: float = EVERY, path: Path = HEARTBEAT, answers=_database_answers) -> None:
    """Writes a beat whenever the database answers, until `stop` is set."""
    while not stop.is_set():
        if answers(database_url):
            path.write_text(str(time.time()))
        stop.wait(every)


def start(database_url: str, stop: threading.Event) -> threading.Thread:
    thread = threading.Thread(target=beat, args=(database_url, stop), name="heartbeat", daemon=True)
    thread.start()
    return thread


def problem(path: Path = HEARTBEAT, *, now: float | None = None, every: float = EVERY) -> str | None:
    """Why the worker isn't healthy, or None when its last beat is recent."""
    try:
        last = float(path.read_text())
    except (OSError, ValueError):
        return "The rendition worker hasn't reached its database since it started."
    age = (time.time() if now is None else now) - last
    if age > 3 * every:
        return f"The rendition worker last reached its database {round(age)} seconds ago."
    return None


if __name__ == "__main__":
    why = problem()
    if why:
        print(why, file=sys.stderr)
    sys.exit(1 if why else 0)
