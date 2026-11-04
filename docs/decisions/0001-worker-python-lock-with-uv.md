# 0001. The rendition worker installs from a hashed lock that uv writes

- **Status:** Proposed
- **Date:** 2026-11-04
- **Decided by:** Harry (proposed by the PER-219 work, alpha W4.5)
- **Replaces:** none. Serves AUGUR's ADR 0043 (scans) and the alpha's goal 26 (security gaps closed).

## Context

The worker's `pyproject.toml` pins its three direct dependencies, but Torch, Transformers and the rest of
Docling's tree resolved fresh on each image build, so two builds of one release could install different
code, and no scan read them: OSV-Scanner only saw `pnpm-lock.yaml`.

## Options

1. **uv writes `worker/requirements.lock`** (`uv pip compile --generate-hashes`), a plain requirements file
   with every package's version and hashes. pip installs it with `--require-hashes`, so the image needs no
   new tool; OSV-Scanner and Renovate (`pip-compile` manager) read it as they are.
2. **pip-tools (`pip-compile`)**, the older tool for the same file. Slower on Torch's tree, and its handling of
   a second index (Torch's CPU builds) is weaker.
3. **Poetry or a full uv project (`uv.lock`)**: a new lock format and a new installer in the image, for one
   small worker.

## Decision

Option 1. `worker/lock.sh` runs uv at a pinned version to write the lock for the image's platform (Python
3.12, linux/amd64, Torch's CPU index); `worker/lock.sh check` in CI fails when the lock no longer holds
`pyproject.toml`'s pins. The Lockfile workflow writes it where download.pytorch.org can't be reached.

## Consequences

- Each build of a release installs the same files; a changed or swapped package fails the build on its hash.
- The worker's packages are scanned in CI, failing only on vulnerabilities a change brings in.
- uv is used only to write the lock, never in the image or at run time.
