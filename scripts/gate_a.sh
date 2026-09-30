#!/usr/bin/env bash
# Gate A (02 §7): all containers boot; gateway, api liveness and readiness are 200 within 120 s of `up`.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
[[ -f .env ]] || cp .env.example .env
BASE="http://localhost:${NAIS_GATEWAY_PORT:-21051}"

docker compose up -d --build
start=$(date +%s)

wait_for() {
  local url=$1
  until curl -fsS -o /dev/null "$url"; do
    if (( $(date +%s) - start > 120 )); then
      echo "GATE A FAIL: $url not healthy within 120s"
      docker compose ps
      curl -sS "$BASE/api/v1/health/ready" || true
      exit 1
    fi
    sleep 2
  done
  echo "ok  $url ($(( $(date +%s) - start ))s)"
}

wait_for "$BASE/healthz"
wait_for "$BASE/api/v1/health/live"
wait_for "$BASE/api/v1/health/ready"

docker compose run --rm --no-deps api python -m api.platform.cli migrate
docker compose run --rm --no-deps api python -m api.platform.cli storage-init

set -a
# shellcheck disable=SC1091
. ./.env
set +a
PYTHONPATH=apps uv run python scripts/storage_smoke.py

fail() { echo "GATE A FAIL: $1"; exit 1; }

authed_ok() {
  curl -fsS -o /dev/null -u nais:nais "$1" || fail "$1 with nais:nais credentials did not succeed"
  echo "ok  $1 (authenticated)"
}
unauth_401() {
  local code
  code=$(curl -sS -o /dev/null -w '%{http_code}' "$1" || true)
  [[ "$code" == "401" ]] || fail "$1 without credentials returned $code, expected 401"
  echo "ok  $1 (401 without credentials)"
}

authed_ok "http://localhost:21056/_cluster/health"
unauth_401 "http://localhost:21056/_cluster/health"
authed_ok "http://localhost:21057/health"
unauth_401 "http://localhost:21057/health"
authed_ok "http://localhost:21052/"

docker compose exec -T postgres psql "postgresql://nais:nais@localhost:5432/nais" -c "select 1" >/dev/null \
  || fail "postgres login nais/nais failed"
echo "ok  postgres login nais/nais"
[[ "$(docker compose exec -T redis redis-cli --user nais --pass nais --no-auth-warning ping | tr -d '\r')" == "PONG" ]] \
  || fail "redis auth nais/nais did not return PONG"
echo "ok  redis auth nais/nais"

echo "GATE A PASS"
