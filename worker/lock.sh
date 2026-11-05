#!/usr/bin/env bash
# Writes worker/requirements.lock: every package the worker installs, Torch and Transformers included, at an
# exact version with its hashes, so each build of the image installs the same files (PER-219) and the
# dependency scan can read them. pyproject.toml names the direct dependencies; this resolves the rest.
#   worker/lock.sh           write it (after changing pyproject.toml); the Lockfile workflow runs it too
#   worker/lock.sh check     fail when the lock doesn't hold pyproject.toml's pins
# Needs uv (https://docs.astral.sh/uv/), at the version below, and download.pytorch.org (Torch's CPU build).
set -euo pipefail
UV_VERSION=0.11.32
here=$(cd "$(dirname "$0")" && pwd)
lock=$here/requirements.lock

if [ "${1:-}" = check ]; then
  [ -s "$lock" ] || { echo "worker/requirements.lock is missing: run worker/lock.sh" >&2; exit 1; }
  python3 - "$here/pyproject.toml" "$lock" <<'PY'
import re, sys, tomllib
pins = tomllib.load(open(sys.argv[1], "rb"))["project"]["dependencies"]
locked = {}
for line in open(sys.argv[2]):
    m = re.match(r"^([A-Za-z0-9_.-]+)(?:\[[^\]]*\])?==([^\s;\\]+)", line)
    if m:
        locked[re.sub(r"[-_.]+", "-", m.group(1)).lower()] = m.group(2)
bad = []
for pin in pins:
    m = re.match(r"^([A-Za-z0-9_.-]+)(?:\[[^\]]*\])?==(\S+)$", pin)
    if not m:
        bad.append(f"{pin}: pyproject.toml pins each direct dependency exactly (name==version)")
        continue
    name = re.sub(r"[-_.]+", "-", m.group(1)).lower()
    if locked.get(name) != m.group(2):
        bad.append(f"{pin}: the lock has {locked.get(name, 'nothing')}")
for b in bad:
    print(f"✗ {b}. Run worker/lock.sh (or Actions → Lockfile).", file=sys.stderr)
sys.exit(1 if bad else 0)
PY
  echo "worker/requirements.lock holds pyproject.toml's pins."
  exit 0
fi

uv=(uv)
if ! uv --version 2>/dev/null | grep -q "^uv $UV_VERSION"; then
  python3 -m pip install --quiet --user "uv==$UV_VERSION"
  uv=(python3 -m uv)
fi
cd "$here"
# The image is linux/amd64 on Python 3.12 (Dockerfile); Torch's CPU-only build comes from its own index.
"${uv[@]}" pip compile pyproject.toml --quiet --generate-hashes --emit-index-url \
  --python-version 3.12 --python-platform x86_64-manylinux_2_28 \
  --extra-index-url https://download.pytorch.org/whl/cpu --index-strategy unsafe-best-match \
  -o requirements.lock
echo "Wrote worker/requirements.lock"
