---
"@apps/folio": patch
---

The rendition worker installs every Python package from `worker/requirements.lock`, at exact versions checked against their hashes, Torch and Transformers included, so each build of a release installs the same code. CI checks the lock holds `pyproject.toml`'s pins and scans it with OSV-Scanner (PER-219, ADR 0001 here).
