#!/usr/bin/env bash
# Create a venv next to this script (first run), install requirements, start Flash Admin.
set -euo pipefail
cd "$(dirname "$0")"
PY="${PYTHON:-python3}"
if [ ! -x .venv/bin/python ]; then
  "$PY" -m venv .venv
  .venv/bin/python -m pip install --upgrade pip >/dev/null
fi
if [ ! -f .venv/.req-stamp ] || [ requirements.txt -nt .venv/.req-stamp ]; then
  .venv/bin/python -m pip install -r requirements.txt
  touch .venv/.req-stamp
fi
exec .venv/bin/python -m flashadmin "$@"
