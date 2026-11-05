# 0002. The rendition worker sends OpenTelemetry through DBOS, off until a collector is named

- **Status:** Proposed
- **Date:** 2026-11-05
- **Decided by:** Harry (proposed by the PER-226 audit fixes)
- **Replaces:** none. Extends AUGUR's ADR 0034 (OpenTelemetry in the service kit) to the one part of Artifacts that isn't Node.

## Context

AUGUR's ADR 0034 gives every Node service OpenTelemetry through the service kit: traces and logs over
OTLP, off unless `OTEL_EXPORTER_OTLP_ENDPOINT` is set. The rendition worker is Python, so it sent nothing:
a slow or failing reader copy showed only in `pc logs`, not beside the service's traces of the same upload.

## Options

1. **DBOS's own export (`dbos[otel]`).** The worker already runs renditions as DBOS workflows. DBOS's
   `otel` extra brings the OpenTelemetry SDK, its OTLP exporter over HTTP and the logging handler, and sends
   a span for each workflow and step, with its logs. A few lines name the service and add the worker's own
   log lines.
2. **The OpenTelemetry Python SDK with auto-instrumentation** (`opentelemetry-distro`, psycopg and boto3
   instrumentations). More detail, such as each bucket call, but more packages, and the workflow and step
   spans still come from DBOS.
3. **Logs only**, as today.

## Decision

Option 1. `folio_worker/telemetry.py` turns it on when the deployment names a collector, by the same rules
as the service kit: `OTEL_EXPORTER_OTLP_ENDPOINT` (or `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`) is set and
`OTEL_SDK_DISABLED` isn't `true`. The worker is `folio-worker` with its version, unless `OTEL_SERVICE_NAME`
says otherwise. The other standard settings (headers, sampling, resource attributes) apply as the SDK reads
them. With telemetry off nothing of OpenTelemetry is loaded.

## Consequences

- The image grows by the OpenTelemetry SDK and exporter, a few MB beside Docling and Torch.
- A deployment's compose entry for the worker needs the `x-telemetry` settings, as an app service's does
  (AUGUR's docs/observability.md). Until then it stays off.
- A trace of a rendition starts at its workflow: the service's upload and the worker's run are two traces,
  joined by the version id, because DBOS doesn't carry the enqueuing request's trace context.
- DBOS names its span attributes its own way (`operationUUID`, `applicationID`).

## Links

- AUGUR's ADR 0034 and docs/observability.md.
- The 2 Nov codebase audit (PER-226): "Worker: no healthcheck or telemetry".
