"""python -m folio_worker: runs Folio's rendition worker."""

import logging
import sys

from .bucket import ObjectStore
from .settings import from_env
from .worker import run


class _Json(logging.Formatter):
    """One JSON line per entry, like Folio's service writes."""

    def format(self, record: logging.LogRecord) -> str:
        import json

        entry = {"time": self.formatTime(record), "level": record.levelname.lower(), "msg": record.getMessage()}
        entry.update({k: v for k, v in record.__dict__.items() if k in ("version", "attempt", "media_type", "reason", "images", "pages")})
        if record.exc_info:
            entry["err"] = self.formatException(record.exc_info)
        return json.dumps(entry)


def main() -> None:
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(_Json())
    logging.basicConfig(level=logging.INFO, handlers=[handler])
    settings = from_env()
    run(settings.database_url, ObjectStore(settings.bucket), settings.render_timeout, settings.poll_seconds)


if __name__ == "__main__":
    main()
