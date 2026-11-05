"""python -m folio_worker: runs Folio's rendition worker."""

import logging
import signal
import sys
import threading

from . import health, worker
from .bucket import ObjectStore
from .settings import from_env


class _Json(logging.Formatter):
    """One JSON line per entry, like Folio's service writes."""

    def format(self, record: logging.LogRecord) -> str:
        import json

        entry = {"time": self.formatTime(record), "level": record.levelname.lower(), "msg": record.getMessage()}
        entry.update({k: v for k, v in record.__dict__.items() if k in ("version", "attempt", "media_type", "reason", "images", "pages", "queue")})
        if record.exc_info:
            entry["err"] = self.formatException(record.exc_info)
        return json.dumps(entry)


def main() -> None:
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(_Json())
    logging.basicConfig(level=logging.INFO, handlers=[handler])
    settings = from_env()
    stop = threading.Event()
    signal.signal(signal.SIGTERM, lambda *_: stop.set())
    signal.signal(signal.SIGINT, lambda *_: stop.set())
    worker.launch(settings.app_id, worker.Deps(settings.database_url, ObjectStore(settings.bucket), settings.render_timeout), log_format=_Json())
    # Beats while it can reach its database, for the container's healthcheck (health.py).
    health.start(settings.database_url, stop)
    stop.wait()
    # A rendition cut short here carries on from its step when a worker starts again.
    worker.destroy()


if __name__ == "__main__":
    main()
