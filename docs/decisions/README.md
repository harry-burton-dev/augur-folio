# Decisions

Decisions that only concern Artifacts are recorded here, in the format of AUGUR's own records (`augur`
docs/decisions/template.md). Anything that touches the platform or other apps is an ADR in `augur`.

| Record | Decision | Status | Date |
| --- | --- | --- | --- |
| [0001](0001-worker-python-lock-with-uv.md) | The rendition worker installs from a hashed lock that uv writes | Proposed | 2026-11-04 |
| [0002](0002-worker-telemetry-through-dbos.md) | The rendition worker sends OpenTelemetry through DBOS, off until a collector is named | Proposed | 2026-11-05 |
