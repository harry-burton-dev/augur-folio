"""Makes renditions as DBOS workflows (AUGUR's ADR 0014): Folio's service queues one per version, by name.

The service enqueues the workflow `renditions` on the queue `folio.renditions` with one
argument, `{"version": "<document version id>"}`, in DBOS's portable JSON. The worker
listens to that queue only and runs each workflow as three steps:

1. start: marks the row running and finds the original, unless it is ready, failed or gone;
2. render: counts the try, renders the file and puts the results in the bucket. DBOS tries
   it again after a minute, then four, if it fails for a reason that may pass;
3. finish or fail: records what came of it.

DBOS keeps where each workflow got to in Folio's database, so a worker that dies mid-file
carries on from the step it was in when it, or another worker, starts again.
"""

from __future__ import annotations

import logging
import tempfile
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol

import psycopg
from dbos import DBOS, DBOSConfig

from . import rows
from .bucket import prefix
from .render import Rendered, RenderError, render

log = logging.getLogger("folio_worker")

#: The version of the jobs code DBOS runs workflows for. It must equal the service kit's
#: JOBS_VERSION (@augur/service-kit), or the worker won't take the workflows the service queues.
JOBS_VERSION = "augur-jobs-1"

#: The queue Folio's service puts renditions on (it registers the queue), and the workflow's name.
QUEUE = "folio.renditions"
WORKFLOW = "renditions"

#: Between tries of a render that may pass next time: a minute, then four.
RETRY_SECONDS = 60
RETRY_BACKOFF = 4


class Objects(Protocol):
    def download(self, key: str, to: Path) -> None: ...
    def put(self, key: str, body: bytes, content_type: str) -> None: ...


@dataclass
class Deps:
    """What the workflow's steps work with, set once before DBOS launches."""

    database_url: str
    objects: Objects
    render_timeout: int
    render: Callable[..., Rendered] = render


_deps: Deps | None = None


def use(deps: Deps) -> None:
    global _deps
    _deps = deps


def _now() -> Deps:
    if _deps is None:
        raise RuntimeError("folio_worker.worker.use() wasn't called before DBOS launched")
    return _deps


def _connect() -> psycopg.Connection:
    return psycopg.connect(_now().database_url, autocommit=True)


def dbos_config(app_id: str, database_url: str) -> DBOSConfig:
    """DBOS's settings: Folio's own login and database, its jobs in the schema the platform made for them."""
    return {
        "name": app_id,
        "system_database_url": database_url,
        "dbos_system_schema": f"{app_id}_jobs",
        "application_version": JOBS_VERSION,
    }


# The steps, as plain functions so they can be tested on their own.


def render_once(version: str, object_key: str, media_type: str, *, last_try: bool) -> dict[str, Any]:
    """One try at a version's renditions: counts it, renders, uploads.

    Returns `{"made": …}` with what to record, `{"error": why}` when the file can't be rendered
    (trying again won't help), or `{"gone": True}` when the row was finished or removed meanwhile.
    Anything else raises, for DBOS to try again; the row says so meanwhile, unless this was the last try.
    """
    deps = _now()
    with _connect() as conn:
        attempt = rows.begin_try(conn, version)
    if attempt is None:
        return {"gone": True}
    log.info("rendering", extra={"version": version, "attempt": attempt, "media_type": media_type})
    try:
        with tempfile.TemporaryDirectory(prefix="folio-") as tmp:
            original = Path(tmp) / "original"
            deps.objects.download(object_key, original)
            made = deps.render(original, media_type, timeout=deps.render_timeout)
        at = prefix(version)
        images = []
        for n, png in enumerate(made.images, start=1):
            deps.objects.put(f"{at}images/{n}.png", png, "image/png")
            images.append(f"{n}.png")
        thumbnail_key = None
        if made.thumbnail:
            thumbnail_key = f"{at}thumbnail.png"
            deps.objects.put(thumbnail_key, made.thumbnail, "image/png")
        # The reader copy goes in last: once it's there, everything it shows is too.
        deps.objects.put(f"{at}reader.md", made.markdown.encode("utf-8"), "text/markdown; charset=utf-8")
    except RenderError as err:
        log.info("can't be rendered", extra={"version": version, "reason": str(err)})
        return {"error": str(err)}
    except Exception as err:  # Anything else may pass: DBOS tries again.
        log.exception("rendering failed", extra={"version": version, "attempt": attempt})
        if not last_try:
            with _connect() as conn:
                rows.wait_to_retry(conn, version, rows.try_again(err))
        raise
    return {
        "made": {
            "engine": list(made.engine),
            "reader_key": f"{at}reader.md",
            "thumbnail_key": thumbnail_key,
            "images": images,
            "pages": made.pages,
            "text": made.text,
        }
    }


@DBOS.step(name="start")
def start(version: str) -> dict[str, str] | None:
    with _connect() as conn:
        found = rows.start(conn, version)
    return {"object_key": found.object_key, "media_type": found.media_type} if found else None


@DBOS.step(name="render", retries_allowed=True, max_attempts=rows.MAX_ATTEMPTS, interval_seconds=RETRY_SECONDS, backoff_rate=RETRY_BACKOFF)
def make(version: str, object_key: str, media_type: str) -> dict[str, Any]:
    status = DBOS.step_status
    last_try = status is None or status.current_attempt is None or status.max_attempts is None or status.current_attempt + 1 >= status.max_attempts
    return render_once(version, object_key, media_type, last_try=last_try)


@DBOS.step(name="finish")
def finish(version: str, made: dict[str, Any]) -> bool:
    with _connect() as conn:
        return rows.finish(conn, version, **made)


@DBOS.step(name="fail")
def fail(version: str, error: str) -> bool:
    with _connect() as conn:
        return rows.fail(conn, version, error)


@DBOS.workflow(name=WORKFLOW)
def renditions(job: dict[str, Any]) -> str:
    """Makes one version's renditions. Says how it ended: ready, failed, or skipped (nothing to do)."""
    version = job["version"]
    found = start(version)
    if found is None:
        log.info("nothing to render", extra={"version": version})
        return "skipped"
    try:
        result = make(version, found["object_key"], found["media_type"])
    except Exception:  # Out of tries.
        fail(version, rows.GAVE_UP)
        log.info("gave up", extra={"version": version})
        return "failed"
    if "gone" in result:
        log.info("nothing to render", extra={"version": version})
        return "skipped"
    if "error" in result:
        fail(version, result["error"])
        return "failed"
    if finish(version, result["made"]):
        made = result["made"]
        log.info("rendered", extra={"version": version, "images": len(made["images"]), "pages": made["pages"]})
        return "ready"
    log.info("finished elsewhere", extra={"version": version})
    return "skipped"


def launch(app_id: str, deps: Deps, log_format: logging.Formatter | None = None) -> None:
    """Starts DBOS, taking renditions off Folio's queue in the background until destroy() or exit.
    DBOS writes its own lines too: `log_format`, when given, puts them in the worker's form."""
    use(deps)
    DBOS(config=dbos_config(app_id, deps.database_url))
    if log_format:
        for handler in logging.getLogger("dbos").handlers:
            handler.setFormatter(log_format)
    DBOS.listen_queues([QUEUE])
    DBOS.launch()
    log.info("waiting for renditions", extra={"queue": QUEUE})


def destroy() -> None:
    DBOS.destroy()
