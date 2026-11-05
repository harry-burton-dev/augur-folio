"""OpenTelemetry for the worker, the way AUGUR's services send it (AUGUR's ADR 0034, this repository's 0002).

Off unless OTEL_EXPORTER_OTLP_ENDPOINT (or the traces endpoint) is set, and OTEL_SDK_DISABLED isn't
"true", as the service kit does. DBOS sends a span for each rendition and each of its steps, and its own
log lines; the worker's own log lines go too. The other standard OTEL_* settings apply as usual
(headers, sampling, resource attributes).
"""

from __future__ import annotations

import logging
import os
from collections.abc import Mapping
from importlib.metadata import version
from typing import Any

#: What the worker is called in traces and logs, unless OTEL_SERVICE_NAME says otherwise.
SERVICE_NAME = "folio-worker"


def _endpoint(env: Mapping[str, str], signal: str) -> str | None:
    own = env.get(f"OTEL_EXPORTER_OTLP_{signal.upper()}_ENDPOINT")
    if own:
        return own
    base = env.get("OTEL_EXPORTER_OTLP_ENDPOINT")
    return f"{base.rstrip('/')}/v1/{signal}" if base else None


def on(env: Mapping[str, str] = os.environ) -> bool:
    return bool(_endpoint(env, "traces")) and env.get("OTEL_SDK_DISABLED", "").lower() != "true"


def dbos_settings(env: Mapping[str, str] = os.environ) -> dict[str, Any]:
    """What DBOS's settings add for telemetry: nothing while it's off."""
    if not on(env):
        return {}
    logs = _endpoint(env, "logs")
    return {"enable_otlp": True, "otlp_traces_endpoints": [_endpoint(env, "traces")], **({"otlp_logs_endpoints": [logs]} if logs else {})}


def name_service(env: Mapping[str, str] = os.environ) -> None:
    """Before DBOS starts: names the worker and its version, which DBOS's own providers wouldn't."""
    if not on(env):
        return
    from opentelemetry import _logs, trace
    from opentelemetry.sdk._logs import LoggerProvider
    from opentelemetry.sdk.resources import Resource
    from opentelemetry.sdk.trace import TracerProvider

    attributes = {"service.version": version("folio-worker")}
    if not env.get("OTEL_SERVICE_NAME"):
        attributes["service.name"] = SERVICE_NAME
    resource = Resource.create(attributes)
    trace.set_tracer_provider(TracerProvider(resource=resource))
    _logs.set_logger_provider(LoggerProvider(resource=resource))


def send_logs(logger: logging.Logger, env: Mapping[str, str] = os.environ) -> None:
    """After DBOS starts (it adds the exporter): the worker's own lines go out with DBOS's."""
    if not on(env) or not _endpoint(env, "logs"):
        return
    from opentelemetry._logs import get_logger_provider
    from opentelemetry.instrumentation.logging.handler import LoggingHandler

    logger.addHandler(LoggingHandler(logger_provider=get_logger_provider()))
