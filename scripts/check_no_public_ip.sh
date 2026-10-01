#!/usr/bin/env bash
# Fails if the dev server's public host (NAIS_EXTERNAL_HOST from the local, untracked .env) appears in any tracked file.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
host=$(grep -E '^NAIS_EXTERNAL_HOST=' .env 2>/dev/null | cut -d= -f2- || true)
if [[ -z "$host" || "$host" == "localhost" ]]; then echo "no external host configured; skipping"; exit 0; fi
if git grep -n -F "$host" -- . ; then echo "ERROR: public host found in tracked files" >&2; exit 1; fi
echo "ok: public host not in tracked files"
