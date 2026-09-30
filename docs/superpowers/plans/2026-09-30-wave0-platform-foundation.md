# Wave 0 — Platform Foundation (Agent 0) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the NAIS AI-OS monorepo skeleton and shared runtime (API app factory, errors, auth dependency, DB + outbox + event relay, worker, storage config, contracts codegen, compose stack on port 21051) so Wave 1 agents can develop modules in parallel against fakes.

**Architecture:** Python FastAPI modular monolith under `apps/api` (import root `api`, `apps/` on `PYTHONPATH`). `api.platform` holds only cross-cutting infrastructure; business modules plug in through a `ModuleSpec` declared in `apps/api/modules/<name>/__init__.py`. Module-to-module events go through a transactional outbox table (`platform.outbox_events`) drained by a relay in the worker. Everything is exposed through one Nginx gateway on `:21051`.

**Tech Stack:** Python 3.13, uv 0.11, FastAPI, Pydantic v2, SQLAlchemy 2 + psycopg 3, Alembic, PyJWT, Dramatiq (Redis), boto3, jsonschema, OpenTelemetry, pytest + testcontainers; Docker Compose with nginx 1.27, postgres 16, redis 7, OpenSearch 2.19.1, Keycloak 26.0, OPA 1.4.2, SeaweedFS 4.48, Mailpit 1.21; Node 22 (`npx openapi-typescript@7.13.0`).

**Spec:** `NAIS_PRD/06_AGENT_ASSIGNMENTS.md` (Agent 0 block), `NAIS_PRD/07_RUNTIME_ENVIRONMENT.md`, `NAIS_PRD/11_DECISION_LOG.md`, `NAIS_PRD/contracts/*`. Module-facing platform APIs are also referenced by `NAIS_PRD/modules/M01…M10` (§3 "Ports consumed").

## Global Constraints

- The only published service port is **21051** (`NAIS_GATEWAY_PORT`); dev tools bind to `127.0.0.1:21052–21059` only (D-001, D-002).
- Port map (dev): 21052 mailpit UI, 21053 storage-a S3, 21054 storage-b S3, 21055 postgres, 21056 opensearch, 21057 opa, 21058 redis, 21059 reserved.
- Python import root is `api` (`apps/` on `PYTHONPATH`); never create a top-level package named `platform` (it shadows the stdlib).
- Agent 0 edits only M00 paths in `NAIS_PRD/contracts/module_ownership.json` (after Task 1's update). No business logic in `api.platform`.
- `NAIS_PRD/contracts/` is the contract source of truth; generated code must be reproducible with `packages/contracts/generate.py --check`.
- Error responses use only codes from `NAIS_PRD/contracts/error_codes.json`, envelope `{"error": {"code", "message", "trace_id", "details?"}}`.
- `trace_id` = `correlation_id.hex` (32 lowercase hex); `correlation_id` is a UUID; the `X-Request-Id` response header carries the dashed UUID.
- IDs are UUIDv7. Times are timezone-aware UTC.
- Every event written to the outbox must validate against `NAIS_PRD/contracts/events/p0_events.schema.json`.
- DB roles: migrations run as `nais_migrator`; api/worker run as `nais_app` (D-027). Schemas: platform, identity, project, catalog, governance, readiness, audit, marketplace, compute, knowledge, autonomy.
- Dev object storage is SeaweedFS (S3 API) because MinIO images are no longer published (D-034). Bucket gateway routes use the regex `^/nais-inst-a(/|$)` (a trailing-slash-only location makes Nginx 301 `/nais-inst-a`, which sends S3 clients into a redirect loop — verified 2026-09-30).
- Gate A: after `docker compose up -d`, `/healthz`, `/api/v1/health/live`, `/api/v1/health/ready` all return 200 within 120 s.
- `make` is not installed on the dev host: `scripts/nais` is the task runner; `Makefile` only delegates to it.
- Every commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Forged JWT algorithms** (`alg: none`, HS256 signed with the RSA public key) must be rejected with 401, never accepted — Task 9 `test_alg_none_is_rejected`, `test_hs256_with_public_key_is_rejected`.
2. **Tampered or garbage pagination cursors** must yield 422 `VALIDATION_FAILED`, never 500 — Task 5 `test_garbage_cursor_is_422`, `test_non_list_cursor_is_422`.
3. **Junk `X-Request-Id` headers** (non-UUID, 2 KB) must be replaced by a fresh UUIDv7, not echoed or crash — Task 4 `test_invalid_request_id_is_replaced`.
4. **A hung dependency** (OpenSearch/OPA not answering) must not hang `/health/ready`; it reports `down` within the timeout — Task 11 `test_hanging_check_times_out`.
5. **Two relay workers running at once** must not dispatch the same event twice in the success path — Task 8 `test_concurrent_relays_dispatch_each_event_once`.

---

## File Structure

```text
.gitignore  .dockerignore  .python-version  pyproject.toml  uv.lock  conftest.py
package.json  pnpm-workspace.yaml  Makefile  README.md  .env.example
docker-compose.yml  docker-compose.prod.yml
.github/workflows/ci.yml
scripts/nais                       task runner (bash)
scripts/gate_a.sh                  Gate A boot + storage smoke
scripts/storage_smoke.py           presigned PUT/GET through :21051
docs/adr/0001-record-architecture-decisions.md
docs/adr/0002-seaweedfs-dev-storage.md
docs/adr/CONTRACT_CHANGE_REQUEST.template.md
infra/nginx/nais.conf
infra/docker/postgres/init.sql     roles + schemas + default privileges
infra/docker/storage/start-storage.sh
packages/contracts/generate.py     codegen (Python enums, pydantic models, TS types) + --check
packages/contracts/package.json
packages/contracts/ts/openapi.d.ts                 (generated)
packages/contracts/python/nais_contracts/__init__.py
packages/contracts/python/nais_contracts/api_models.py   (generated)
apps/api/__init__.py
apps/api/Dockerfile
apps/api/main.py                   app = create_app()
apps/api/worker.py                 worker entry: relay + scheduler + dramatiq
apps/api/modules/__init__.py       (empty; module packages are owned by other agents)
apps/api/platform/__init__.py
apps/api/platform/ids.py           new_id() -> UUIDv7
apps/api/platform/clock.py         now(), frozen()
apps/api/platform/settings.py      Settings, get_settings()
apps/api/platform/context.py       correlation id contextvar
apps/api/platform/logs.py          JSON logging
apps/api/platform/generated/__init__.py
apps/api/platform/generated/error_codes.py   (generated)
apps/api/platform/generated/event_types.py   (generated)
apps/api/platform/errors.py        ApiError, install_error_handlers
apps/api/platform/middleware.py    correlation middleware
apps/api/platform/telemetry.py     OpenTelemetry wiring
apps/api/platform/broker.py        configure_broker()
apps/api/platform/modules.py       ModuleSpec, discover_modules()
apps/api/platform/ports.py         provide/get port registry
apps/api/platform/health.py        /health/live, /health/ready
apps/api/platform/app.py           create_app()
apps/api/platform/pagination.py    cursor pagination
apps/api/platform/db.py            engines, sessions
apps/api/platform/migrate.py       multi-schema alembic runner
apps/api/platform/migration_helpers.py
apps/api/platform/migrations/env.py
apps/api/platform/migrations/script.py.mako
apps/api/platform/migrations/versions/0001_platform_outbox.py
apps/api/platform/events.py        EventActor, EventEnvelope, validate_envelope
apps/api/platform/outbox.py        outbox table + OutboxWriter
apps/api/platform/event_bus.py     HandlerRegistry, subscribe, claim_event
apps/api/platform/relay.py         dispatch_batch, run_forever
apps/api/platform/auth.py          CurrentUser, PrincipalResolver, TokenVerifier, current_user
apps/api/platform/storage.py       org code -> S3 config/clients, ensure_buckets
apps/api/platform/scheduler.py     periodic jobs
apps/api/platform/seed.py          run_seed()
apps/api/platform/cli.py           migrate | new-migration | seed | storage-init
apps/api/platform/testing/__init__.py
apps/api/platform/testing/fixtures.py   pytest plugin: ports reset, postgres container
apps/api/platform/testing/app.py        create_test_app()
apps/api/platform/testing/tokens.py     FakeIssuer, StaticJwkClient
apps/api/platform/testing/contracts.py  assert_matches_response, assert_valid_event
apps/api/platform/tests/test_*.py
tests/contract/test_contract_files.py
tests/contract/test_harness.py
```

---

### Task 1: Repository bootstrap, PRD alignment, ids and clock

**Files:**
- Create: `.gitignore`, `.python-version`, `pyproject.toml`, `conftest.py`, `apps/api/__init__.py`, `apps/api/modules/__init__.py`, `apps/api/platform/__init__.py`, `apps/api/platform/ids.py`, `apps/api/platform/clock.py`, `apps/api/platform/testing/__init__.py`, `apps/api/platform/testing/fixtures.py`
- Modify: `NAIS_PRD/11_DECISION_LOG.md`, `NAIS_PRD/07_RUNTIME_ENVIRONMENT.md`, `NAIS_PRD/01_ARCHITECTURE.md`, `NAIS_PRD/06_AGENT_ASSIGNMENTS.md`, `NAIS_PRD/10_SEED_DATA.md`, `NAIS_PRD/modules/M03_data_catalog.md`, `NAIS_PRD/modules/M04_access_governance.md`, `NAIS_PRD/modules/M08_federation_data_node.md`, `NAIS_PRD/contracts/module_ownership.json`
- Test: `apps/api/platform/tests/test_ids.py`, `apps/api/platform/tests/test_clock.py`

**Interfaces:**
- Produces: `api.platform.ids.new_id() -> uuid.UUID` (version 7); `api.platform.clock.now() -> datetime` (UTC, aware); `api.platform.clock.frozen(at: datetime)` context manager.

- [ ] **Step 1: Initialise git on a feature branch**

The repo is not under git yet and there is no global git identity. The user chose the repo-local identity `yujh <bigdatanigel1513@gmail.com>` at plan approval.

```bash
cd /data/project/nst-nexus
git init -b main
git config user.name "yujh"
git config user.email "bigdatanigel1513@gmail.com"
git add NAIS_PRD NAIS_PRD_COMBINED.md docs/superpowers/plans
git commit -m "docs: NAIS AI-OS PRD v1.1 and Wave 0 plan

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git switch -c feat/m00-platform
```

- [ ] **Step 2: Apply the PRD alignment edits (MinIO → SeaweedFS, import root, task runner)**

Save as `/tmp/prd_align.py` (scratch, not committed) and run `python3 /tmp/prd_align.py`. Every replacement asserts it matched exactly once.

```python
import json
import re
from pathlib import Path

ROOT = Path("/data/project/nst-nexus/NAIS_PRD")


def edit(rel: str, pairs: list[tuple[str, str]]) -> None:
    path = ROOT / rel
    text = path.read_text(encoding="utf-8")
    for old, new in pairs:
        assert text.count(old) == 1, (rel, old[:60], text.count(old))
        text = text.replace(old, new)
    path.write_text(text, encoding="utf-8")


edit("01_ARCHITECTURE.md", [
    ("- **MinIO** for local/dev", "- **SeaweedFS** (S3 API) for local/dev — MinIO 공식 이미지 배포 중단으로 대체 (D-034)"),
    ("Browser ───── direct ─────> MinIO/S3", "Browser ───── direct ─────> S3 (dev: SeaweedFS)"),
    ("minio-a\nminio-b", "storage-a\nstorage-b"),
])

runtime = (ROOT / "07_RUNTIME_ENVIRONMENT.md").read_text(encoding="utf-8")
runtime, n = re.subn(
    r"### Nginx 참고 설정 \(infra/nginx/nais.conf\)\n```nginx\n.*?```\n",
    "### Nginx 설정\n정본은 `infra/nginx/nais.conf`다 (Agent 0). 규칙:\n"
    "- `resolver 127.0.0.11` + 변수 upstream: web/keycloak가 아직 없어도 gateway가 기동한다. web이 없으면 `/`는 503.\n"
    "- 스토리지 경로는 정규식 `location ~ ^/nais-inst-a(/|$)`. `location /nais-inst-a/`만 두면 `/nais-inst-a` 요청이 301 되어 S3 클라이언트가 무한 리다이렉트에 빠진다.\n"
    "- 스토리지·keycloak 경로는 `Host $http_host`를 보존한다 (presigned 서명 검증).\n",
    runtime,
    flags=re.S,
)
assert n == 1
(ROOT / "07_RUNTIME_ENVIRONMENT.md").write_text(runtime, encoding="utf-8")

edit("07_RUNTIME_ENVIRONMENT.md", [
    ("→ minio-a:9000    (Institute A bucket", "→ storage-a:8333  (Institute A bucket"),
    ("→ minio-b:9000    (Institute B bucket", "→ storage-b:8333  (Institute B bucket"),
    ("bucket 경로를 해당 MinIO로", "bucket 경로를 해당 S3 스토리지(SeaweedFS)로"),
    ("| 21053 | minio-a console | Institute A 스토리지 콘솔 |", "| 21053 | storage-a S3 | Institute A 스토리지 S3 endpoint (디버깅) |"),
    ("| 21054 | minio-b console | Institute B 스토리지 콘솔 |", "| 21054 | storage-b S3 | Institute B 스토리지 S3 endpoint (디버깅) |"),
    ("| 21058~21059 | 예약 | P1 이후 (예: grafana) |", "| 21058 | redis | 로컬 디버깅 |\n| 21059 | 예약 | P1 이후 (예: grafana) |"),
    ("| worker | apps/api (`python -m worker`)", "| worker | apps/api (`python -m api.worker`)"),
    ("| minio-a | minio/minio | 9000/9001 | Agent 0 | Institute A storage |", "| storage-a | chrislusf/seaweedfs:4.48 | 8333 | Agent 0 | Institute A storage (S3), `nais-platform` bucket도 여기 |"),
    ("| minio-b | minio/minio | 9000/9001 | Agent 0 | Institute B storage |", "| storage-b | chrislusf/seaweedfs:4.48 | 8333 | Agent 0 | Institute B storage (S3) |"),
    ("STORAGE_INST_A_ENDPOINT=http://minio-a:9000", "STORAGE_INST_A_ENDPOINT=http://storage-a:8333"),
    ("STORAGE_INST_B_ENDPOINT=http://minio-b:9000", "STORAGE_INST_B_ENDPOINT=http://storage-b:8333"),
    ("STORAGE_INST_B_SECRET_KEY=change-me-b\n",
     "STORAGE_INST_B_SECRET_KEY=change-me-b\nSTORAGE_NAIS_ENDPOINT=http://storage-a:8333\nSTORAGE_NAIS_BUCKET=nais-platform\n"
     "STORAGE_NAIS_ACCESS_KEY=nais-inst-a\nSTORAGE_NAIS_SECRET_KEY=change-me-a\nSTORAGE_ORG_CODES=nais,inst-a,inst-b\n"),
    ("```bash\ncp .env.example .env\nmake up          # docker compose up -d --build\nmake migrate     # 모든 모듈 alembic upgrade head\nmake seed        # 10_SEED_DATA.md 기준 데이터 적재\nopen http://localhost:21051\n```",
     "```bash\nscripts/nais up            # .env 없으면 .env.example 복사 후 docker compose up -d --build\nscripts/nais migrate       # platform + 모든 모듈 migration (nais_migrator)\nscripts/nais storage-init  # 기관 bucket 생성\nscripts/nais seed          # 10_SEED_DATA.md 기준 데이터 적재\nscripts/nais gate-a        # Gate A 판정\n```\n`make <target>`도 같은 명령으로 위임된다 (make가 설치된 환경)."),
])

edit("06_AGENT_ASSIGNMENTS.md", [("브라우저가 MinIO로", "브라우저가 S3 스토리지로")])
edit("10_SEED_DATA.md", [("MinIO objects", "S3 objects")])
edit("modules/M03_data_catalog.md", [
    ("`http://minio-a:9000`", "`http://storage-a:8333`"),
    ("(MinIO, OpenSearch testcontainer)", "(SeaweedFS S3, OpenSearch testcontainer)"),
])
edit("modules/M04_access_governance.md", [("from nais.catalog.ports import", "from api.modules.catalog.ports import")])
edit("modules/M08_federation_data_node.md", [("Institute A MinIO + Institute B MinIO를", "Institute A / Institute B S3 스토리지를")])
edit("11_DECISION_LOG.md", [("MinIO console 등 개발 도구", "스토리지 S3 endpoint 등 개발 도구")])

log = (ROOT / "11_DECISION_LOG.md").read_text(encoding="utf-8")
anchor = "\n## P1 이후로 미룬 항목"
assert log.count(anchor) == 1
rows = (
    "| D-032 | Python import root | `apps/`를 `PYTHONPATH`에 두고 `api`로 import (`api.platform`, `api.modules.<m>`). 실행: `uvicorn api.main:app`, `python -m api.worker`, `python -m api.platform.cli` | 최상위 `platform` 패키지는 표준 라이브러리를 가린다 |\n"
    "| D-033 | Task runner | `scripts/nais <cmd>`가 정본, `Makefile`은 위임만 | 개발 호스트에 make 없음 |\n"
    "| D-034 | 개발 스토리지 | MinIO 대신 SeaweedFS 4.48 (S3 API). compose 서비스 `storage-a`/`storage-b`, 포트 8333. 운영은 S3 호환 스토리지 그대로 | MinIO 공식 이미지(Docker Hub, quay.io) 조회 불가 (2026-09-30 확인). gateway 경유 presigned PUT/GET/multipart/변조 거부 검증 완료 |\n"
    "| D-035 | 개발 포트 재배치 | 21053/21054 = storage-a/b S3 endpoint, 21058 = redis | 스토리지 콘솔 없음 |\n"
    "| D-036 | 모듈 플러그인 계약 | 각 모듈은 `apps/api/modules/<name>/__init__.py`에 `MODULE = ModuleSpec(...)`을 정의. migration은 `python -m api.platform.cli new-migration <module> -m <msg>`로 생성, `alembic.ini` 없음. Dramatiq actor는 모듈 import 시 정의하며 platform이 import 전에 broker를 설정 | Wave 1 병렬 개발용 고정 인터페이스 |\n"
)
log = log.replace(anchor, rows.rstrip("\n") + "\n" + anchor, 1)
(ROOT / "11_DECISION_LOG.md").write_text(log, encoding="utf-8")

own_path = ROOT / "contracts" / "module_ownership.json"
own = json.loads(own_path.read_text(encoding="utf-8"))
m00 = own["M00"]["path"]
m00.remove("apps/api/alembic.ini")
for extra in ["apps/api/__init__.py", "apps/api/modules/__init__.py", "apps/api/Dockerfile", "conftest.py", "scripts", ".dockerignore", ".python-version", "uv.lock"]:
    if extra not in m00:
        m00.append(extra)
own["version"] = "1.1.1"
own_path.write_text(json.dumps(own, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
print("PRD aligned")
```

Expected output: `PRD aligned`. Then verify nothing still points at MinIO as a running service:

Run: `grep -rn -i "minio" NAIS_PRD --include=*.md | grep -v "D-034\|D-002\|MinIO 공식" || echo clean`
Expected: `clean`

- [ ] **Step 3: Write the root project files**

`.gitignore`:
```gitignore
.venv/
__pycache__/
*.pyc
.pytest_cache/
.ruff_cache/
.mypy_cache/
node_modules/
.next/
dist/
.env
*.egg-info/
```

`.python-version`:
```text
3.13
```

`pyproject.toml`:
```toml
[project]
name = "nais-ai-os"
version = "0.1.0"
description = "NAIS AI-OS / Research Commons"
requires-python = ">=3.13"
dependencies = [
    "fastapi>=0.115",
    "uvicorn[standard]>=0.30",
    "pydantic>=2.9",
    "pydantic-settings>=2.5",
    "sqlalchemy>=2.0.35",
    "psycopg[binary]>=3.2",
    "alembic>=1.13",
    "pyjwt[crypto]>=2.9",
    "httpx>=0.27",
    "redis>=5.0",
    "dramatiq[redis]>=1.17",
    "boto3>=1.35",
    "jsonschema>=4.23",
    "pyyaml>=6.0",
    "opentelemetry-api>=1.27",
    "opentelemetry-sdk>=1.27",
    "opentelemetry-exporter-otlp-proto-http>=1.27",
    "opentelemetry-instrumentation-fastapi>=0.48b0",
]

[dependency-groups]
dev = [
    "pytest>=8.3",
    "testcontainers[postgres]>=4.8",
    "ruff>=0.6",
    "mypy>=1.11",
    "types-PyYAML>=6.0",
    "openapi-spec-validator>=0.7",
    "datamodel-code-generator>=0.26",
]

[tool.uv]
package = false

[tool.pytest.ini_options]
pythonpath = ["apps", "packages/contracts/python"]
testpaths = ["apps/api", "tests/contract"]
addopts = "--import-mode=importlib -ra"

[tool.ruff]
line-length = 110
target-version = "py313"
extend-exclude = ["apps/api/platform/generated", "packages/contracts/python/nais_contracts/api_models.py"]

[tool.ruff.lint]
select = ["E", "F", "I", "B", "UP", "SIM"]
ignore = ["E501"]  # ruff format owns line length

[tool.mypy]
python_version = "3.13"
mypy_path = "apps:packages/contracts/python"
explicit_package_bases = true
files = ["apps/api/platform", "apps/api/main.py", "apps/api/worker.py"]
exclude = ["apps/api/platform/tests/", "apps/api/platform/migrations/"]
strict = true
ignore_missing_imports = true
disable_error_code = ["type-abstract"]
plugins = ["pydantic.mypy"]
```

`conftest.py` (repo root):
```python
pytest_plugins = ["api.platform.testing.fixtures"]
```

`apps/api/__init__.py`, `apps/api/modules/__init__.py`, `apps/api/platform/__init__.py`, `apps/api/platform/testing/__init__.py`: empty files.

`apps/api/platform/testing/fixtures.py` (grows in Tasks 4 and 6):
```python
"""Shared pytest fixtures for platform and module tests (registered from the root conftest.py)."""
```

- [ ] **Step 4: Install the environment**

Run: `uv sync`
Expected: creates `.venv` with Python 3.13 and writes `uv.lock`; ends with `Installed N packages`.

- [ ] **Step 5: Write the failing tests for ids and clock**

`apps/api/platform/tests/test_ids.py`:
```python
import time
import uuid

from api.platform.ids import new_id


def test_new_id_is_uuid_version_7() -> None:
    value = new_id()
    assert value.variant == uuid.RFC_4122
    assert value.version == 7


def test_new_id_embeds_current_unix_milliseconds() -> None:
    before = time.time_ns() // 1_000_000
    value = new_id()
    after = time.time_ns() // 1_000_000
    assert before <= value.int >> 80 <= after


def test_new_ids_are_unique() -> None:
    assert len({new_id() for _ in range(10_000)}) == 10_000


def test_ids_from_later_milliseconds_sort_later() -> None:
    first = new_id()
    time.sleep(0.002)
    second = new_id()
    assert str(first) < str(second)
```

`apps/api/platform/tests/test_clock.py`:
```python
from datetime import UTC, datetime

from api.platform import clock


def test_now_is_timezone_aware_utc() -> None:
    assert clock.now().tzinfo is UTC


def test_frozen_pins_now_and_restores() -> None:
    pinned = datetime(2026, 9, 30, 12, 0, tzinfo=UTC)
    with clock.frozen(pinned):
        assert clock.now() == pinned
    assert clock.now() != pinned
```

- [ ] **Step 6: Run to verify they fail**

Run: `uv run pytest apps/api/platform/tests/test_ids.py apps/api/platform/tests/test_clock.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'api.platform.ids'`

- [ ] **Step 7: Implement ids and clock**

`apps/api/platform/ids.py`:
```python
"""UUIDv7 generation (RFC 9562). Python 3.13 has no uuid.uuid7()."""

import os
import time
import uuid

_MASK_48 = (1 << 48) - 1
_MASK_62 = (1 << 62) - 1


def new_id() -> uuid.UUID:
    unix_ms = time.time_ns() // 1_000_000
    rand = int.from_bytes(os.urandom(10), "big")
    value = (unix_ms & _MASK_48) << 80
    value |= 0x7 << 76
    value |= (rand >> 68) << 64
    value |= 0b10 << 62
    value |= rand & _MASK_62
    return uuid.UUID(int=value)
```

`apps/api/platform/clock.py`:
```python
"""Single source of 'now' so tests can pin time."""

from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime

_frozen_at: datetime | None = None


def now() -> datetime:
    return _frozen_at if _frozen_at is not None else datetime.now(UTC)


@contextmanager
def frozen(at: datetime) -> Iterator[None]:
    global _frozen_at
    previous = _frozen_at
    _frozen_at = at
    try:
        yield
    finally:
        _frozen_at = previous
```

- [ ] **Step 8: Run to verify they pass**

Run: `uv run pytest apps/api/platform/tests/test_ids.py apps/api/platform/tests/test_clock.py -q`
Expected: `6 passed`

- [ ] **Step 9: Commit**

```bash
git add .gitignore .python-version pyproject.toml uv.lock conftest.py apps NAIS_PRD
git commit -m "feat(platform): repo bootstrap, uuid7 ids, clock; align PRD with SeaweedFS and api import root

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Settings, correlation context, JSON logging

**Files:**
- Create: `apps/api/platform/settings.py`, `apps/api/platform/context.py`, `apps/api/platform/logs.py`
- Test: `apps/api/platform/tests/test_settings.py`, `apps/api/platform/tests/test_context.py`, `apps/api/platform/tests/test_logs.py`

**Interfaces:**
- Consumes: `api.platform.ids.new_id`
- Produces:
  - `Settings` (pydantic-settings; fields below), `get_settings() -> Settings` (cached), `REPO_ROOT: Path`
  - `context.correlation_id() -> UUID`, `context.trace_id() -> str`, `context.set_correlation_id(value: UUID) -> None`, `context.use_correlation_id(value: UUID)` (context manager)
  - `logs.configure_logging(level: str = "INFO") -> None`, `logs.JsonFormatter`

- [ ] **Step 1: Write the failing tests**

`apps/api/platform/tests/test_settings.py`:
```python
import pytest

from api.platform.settings import Settings


def test_defaults_point_at_the_21051_gateway(monkeypatch: pytest.MonkeyPatch) -> None:
    for key in ("NAIS_PUBLIC_BASE_URL", "OIDC_ISSUER", "REDIS_URL"):
        monkeypatch.delenv(key, raising=False)
    settings = Settings()
    assert settings.nais_public_base_url == "http://localhost:21051"
    assert settings.oidc_issuer == "http://localhost:21051/auth/realms/nais"
    assert settings.redis_url == "redis://localhost:21058/0"


def test_environment_overrides_defaults(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DATABASE_URL", "postgresql+psycopg://u:p@db:5432/nais")
    assert Settings().database_url == "postgresql+psycopg://u:p@db:5432/nais"


def test_contracts_dir_contains_the_contracts() -> None:
    assert (Settings().contracts_dir / "openapi.yaml").is_file()


def test_storage_org_codes_are_split(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("STORAGE_ORG_CODES", " nais, inst-a ,inst-b,")
    assert Settings().storage_org_code_list == ["nais", "inst-a", "inst-b"]
```

`apps/api/platform/tests/test_context.py`:
```python
import contextvars
import uuid

from api.platform import context


def test_correlation_id_is_generated_once_per_context() -> None:
    def read_twice() -> tuple[uuid.UUID, uuid.UUID]:
        return context.correlation_id(), context.correlation_id()

    first, second = contextvars.copy_context().run(read_twice)
    assert first == second
    assert first.version == 7


def test_use_correlation_id_sets_and_restores() -> None:
    def run() -> None:
        outer = context.correlation_id()
        pinned = uuid.UUID("0192f0c0-0000-7000-8000-000000000001")
        with context.use_correlation_id(pinned):
            assert context.correlation_id() == pinned
            assert context.trace_id() == pinned.hex
        assert context.correlation_id() == outer

    contextvars.copy_context().run(run)
```

`apps/api/platform/tests/test_logs.py`:
```python
import json
import logging
import uuid

from api.platform import context
from api.platform.logs import JsonFormatter


def test_json_formatter_includes_trace_id_and_extras() -> None:
    pinned = uuid.UUID("0192f0c0-0000-7000-8000-0000000000aa")
    record = logging.LogRecord("nais.test", logging.INFO, __file__, 1, "hello %s", ("world",), None)
    record.event_id = "e-1"
    with context.use_correlation_id(pinned):
        line = JsonFormatter().format(record)
    payload = json.loads(line)
    assert payload["message"] == "hello world"
    assert payload["level"] == "INFO"
    assert payload["trace_id"] == pinned.hex
    assert payload["event_id"] == "e-1"
```

- [ ] **Step 2: Run to verify they fail**

Run: `uv run pytest apps/api/platform/tests/test_settings.py apps/api/platform/tests/test_context.py apps/api/platform/tests/test_logs.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'api.platform.settings'`

- [ ] **Step 3: Implement**

`apps/api/platform/settings.py`:
```python
from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

REPO_ROOT = Path(__file__).resolve().parents[3]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(extra="ignore")

    nais_public_base_url: str = "http://localhost:21051"
    database_url: str = "postgresql+psycopg://nais_app:nais_app@localhost:21055/nais"
    migration_database_url: str = "postgresql+psycopg://nais_migrator:nais_migrator@localhost:21055/nais"
    redis_url: str = "redis://localhost:21058/0"
    opensearch_url: str = "http://localhost:21056"
    opa_url: str = "http://localhost:21057"
    opa_timeout_ms: int = 500
    oidc_issuer: str = "http://localhost:21051/auth/realms/nais"
    oidc_internal_jwks_url: str = "http://localhost:21051/auth/realms/nais/protocol/openid-connect/certs"
    oidc_audience: str = "nais-api"
    oidc_clock_skew_seconds: int = 30
    contracts_dir: Path = REPO_ROOT / "NAIS_PRD" / "contracts"
    log_level: str = "INFO"
    otel_exporter_otlp_endpoint: str | None = None
    otel_service_name: str = "nais-api"
    outbox_batch_size: int = 100
    outbox_max_attempts: int = 10
    worker_threads: int = 4
    storage_org_codes: str = "nais,inst-a,inst-b"
    health_check_timeout_seconds: float = 2.0

    @property
    def storage_org_code_list(self) -> list[str]:
        return [code.strip() for code in self.storage_org_codes.split(",") if code.strip()]


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
```

`apps/api/platform/context.py`:
```python
"""Request/event correlation id. trace_id is always correlation_id.hex."""

from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from uuid import UUID

from api.platform.ids import new_id

_correlation_id: ContextVar[UUID | None] = ContextVar("nais_correlation_id", default=None)


def set_correlation_id(value: UUID) -> None:
    _correlation_id.set(value)


def correlation_id() -> UUID:
    value = _correlation_id.get()
    if value is None:
        value = new_id()
        _correlation_id.set(value)
    return value


def trace_id() -> str:
    return correlation_id().hex


@contextmanager
def use_correlation_id(value: UUID) -> Iterator[None]:
    token = _correlation_id.set(value)
    try:
        yield
    finally:
        _correlation_id.reset(token)
```

`apps/api/platform/logs.py`:
```python
"""Structured JSON application logs. Audit records are NOT logs (M09 owns them)."""

import json
import logging
import sys
from datetime import UTC, datetime
from typing import Any

from api.platform.context import trace_id

_STANDARD_ATTRS = set(logging.LogRecord("", 0, "", 0, "", None, None).__dict__) | {"message", "asctime"}


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "ts": datetime.fromtimestamp(record.created, UTC).isoformat(),
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
            "trace_id": trace_id(),
        }
        for key, value in record.__dict__.items():
            if key not in _STANDARD_ATTRS and not key.startswith("_"):
                payload[key] = value
        if record.exc_info:
            payload["exc"] = self.formatException(record.exc_info)
        return json.dumps(payload, ensure_ascii=False, default=str)


def configure_logging(level: str = "INFO") -> None:
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(JsonFormatter())
    root = logging.getLogger()
    root.handlers[:] = [handler]
    root.setLevel(level.upper())
```

- [ ] **Step 4: Run to verify they pass**

Run: `uv run pytest apps/api/platform/tests/test_settings.py apps/api/platform/tests/test_context.py apps/api/platform/tests/test_logs.py -q`
Expected: `7 passed`

- [ ] **Step 5: Commit**

```bash
git add apps/api/platform
git commit -m "feat(platform): settings, correlation context, JSON logging

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Contract code generation and the error envelope

**Files:**
- Create: `packages/contracts/generate.py`, `packages/contracts/package.json`, `package.json`, `pnpm-workspace.yaml`, `packages/contracts/python/nais_contracts/__init__.py`, `apps/api/platform/generated/__init__.py`, `apps/api/platform/errors.py`
- Generated (by running the script): `apps/api/platform/generated/error_codes.py`, `apps/api/platform/generated/event_types.py`, `packages/contracts/python/nais_contracts/api_models.py`, `packages/contracts/ts/openapi.d.ts`
- Test: `apps/api/platform/tests/test_generated.py`, `apps/api/platform/tests/test_errors.py`

**Interfaces:**
- Consumes: `context.trace_id()`
- Produces:
  - `api.platform.generated.error_codes.ErrorCode` (StrEnum), `HTTP_STATUS: dict[ErrorCode, int]`, `DESCRIPTION: dict[ErrorCode, str]`
  - `api.platform.generated.event_types.EventType` (StrEnum; member name = event type upper-cased with `.`→`_`, e.g. `EventType.PROJECT_ARCHIVED_V1`), `PRODUCER: dict[EventType, str]`
  - `api.platform.errors.ApiError(code: ErrorCode | str, message: str | None = None, details: dict[str, Any] | None = None)` with `.code`, `.status_code`, `.message`, `.details`; alias `DomainError = ApiError`
  - `errors.error_body(code, message, details=None) -> dict`, `errors.install_error_handlers(app: FastAPI) -> None`
  - `nais_contracts.api_models` — pydantic models for every OpenAPI schema (e.g. `AccessRequestCreate`)

- [ ] **Step 1: Write the generator**

`packages/contracts/generate.py`:
```python
"""Regenerate code from NAIS_PRD/contracts.

Usage:
    uv run python packages/contracts/generate.py            # write files
    uv run python packages/contracts/generate.py --check    # exit 1 if any generated file is stale
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import tempfile
from collections.abc import Callable
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CONTRACTS = ROOT / "NAIS_PRD" / "contracts"
OPENAPI = CONTRACTS / "openapi.yaml"
HEADER = "# GENERATED by packages/contracts/generate.py from NAIS_PRD/contracts/{source} - do not edit.\n"


def render_error_codes() -> str:
    codes = json.loads((CONTRACTS / "error_codes.json").read_text(encoding="utf-8"))["codes"]
    out = [HEADER.format(source="error_codes.json"), "from enum import StrEnum\n\n\nclass ErrorCode(StrEnum):\n"]
    out += [f'    {c["code"]} = "{c["code"]}"\n' for c in codes]
    out.append("\n\nHTTP_STATUS: dict[ErrorCode, int] = {\n")
    out += [f'    ErrorCode.{c["code"]}: {c["http"]},\n' for c in codes]
    out.append("}\n\nDESCRIPTION: dict[ErrorCode, str] = {\n")
    out += [f'    ErrorCode.{c["code"]}: {json.dumps(c["description"], ensure_ascii=False)},\n' for c in codes]
    out.append("}\n")
    return "".join(out)


def render_event_types() -> str:
    events = json.loads((CONTRACTS / "events" / "index.json").read_text(encoding="utf-8"))["events"]

    def member(event_type: str) -> str:
        return event_type.upper().replace(".", "_")

    out = [HEADER.format(source="events/index.json"), "from enum import StrEnum\n\n\nclass EventType(StrEnum):\n"]
    out += [f'    {member(e["event_type"])} = "{e["event_type"]}"\n' for e in events]
    out.append("\n\nPRODUCER: dict[EventType, str] = {\n")
    out += [f'    EventType.{member(e["event_type"])}: "{e["producer"]}",\n' for e in events]
    out.append("}\n")
    return "".join(out)


def run_datamodel_codegen(target: Path) -> None:
    subprocess.run(
        [
            sys.executable, "-m", "datamodel_code_generator",
            "--input", str(OPENAPI), "--input-file-type", "openapi",
            "--output-model-type", "pydantic_v2.BaseModel", "--target-python-version", "3.13",
            "--use-standard-collections", "--use-union-operator", "--disable-timestamp",
            "--output", str(target),
        ],
        check=True,
        capture_output=True,
    )


def run_openapi_typescript(target: Path) -> None:
    subprocess.run(
        ["npx", "--yes", "openapi-typescript@7.13.0", str(OPENAPI), "-o", str(target)],
        check=True,
        capture_output=True,
    )


TEXT_TARGETS: dict[str, Callable[[], str]] = {
    "apps/api/platform/generated/error_codes.py": render_error_codes,
    "apps/api/platform/generated/event_types.py": render_event_types,
}
TOOL_TARGETS: dict[str, Callable[[Path], None]] = {
    "packages/contracts/python/nais_contracts/api_models.py": run_datamodel_codegen,
    "packages/contracts/ts/openapi.d.ts": run_openapi_typescript,
}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true", help="fail if generated files are out of date")
    args = parser.parse_args(argv)
    stale: list[str] = []
    with tempfile.TemporaryDirectory() as tmp:
        for rel, render in TEXT_TARGETS.items():
            scratch = Path(tmp) / Path(rel).name
            scratch.write_text(render(), encoding="utf-8")
            stale += _sync(rel, scratch, check=args.check)
        for rel, tool in TOOL_TARGETS.items():
            scratch = Path(tmp) / Path(rel).name
            tool(scratch)
            stale += _sync(rel, scratch, check=args.check)
    if stale:
        print("stale generated files:\n  " + "\n  ".join(stale))
        print("run: uv run python packages/contracts/generate.py")
        return 1
    print("generated files are up to date" if args.check else "generated files written")
    return 0


def _sync(rel: str, scratch: Path, *, check: bool) -> list[str]:
    target = ROOT / rel
    fresh = scratch.read_bytes()
    if target.exists() and target.read_bytes() == fresh:
        return []
    if check:
        return [rel]
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(fresh)
    return []


if __name__ == "__main__":
    raise SystemExit(main())
```

`packages/contracts/package.json`:
```json
{
  "name": "@nais/contracts",
  "version": "1.1.1",
  "private": true,
  "types": "ts/openapi.d.ts",
  "files": ["ts"]
}
```

`package.json` (root):
```json
{
  "name": "nais-ai-os",
  "private": true,
  "packageManager": "pnpm@9.15.0",
  "scripts": {
    "contracts": "uv run python packages/contracts/generate.py"
  }
}
```

`pnpm-workspace.yaml`:
```yaml
packages:
  - "apps/web"
  - "packages/*"
```

`packages/contracts/python/nais_contracts/__init__.py`:
```python
"""Pydantic models generated from NAIS_PRD/contracts/openapi.yaml (see api_models.py)."""
```

`apps/api/platform/generated/__init__.py`:
```python
"""Files in this package are generated by packages/contracts/generate.py."""
```

- [ ] **Step 2: Run the generator**

Run: `uv run python packages/contracts/generate.py && uv run python packages/contracts/generate.py --check`
Expected: `generated files written` then `generated files are up to date`

- [ ] **Step 3: Write the failing tests**

`apps/api/platform/tests/test_generated.py`:
```python
import json

from api.platform.generated.error_codes import HTTP_STATUS, ErrorCode
from api.platform.generated.event_types import PRODUCER, EventType
from api.platform.settings import Settings


def test_every_contract_error_code_is_generated_with_its_http_status() -> None:
    codes = json.loads((Settings().contracts_dir / "error_codes.json").read_text())["codes"]
    assert {c["code"]: c["http"] for c in codes} == {code.value: HTTP_STATUS[code] for code in ErrorCode}


def test_every_contract_event_type_is_generated_with_its_producer() -> None:
    events = json.loads((Settings().contracts_dir / "events" / "index.json").read_text())["events"]
    assert {e["event_type"]: e["producer"] for e in events} == {t.value: PRODUCER[t] for t in EventType}


def test_event_member_names_follow_the_convention() -> None:
    assert EventType.PROJECT_ARCHIVED_V1 == "project.archived.v1"


def test_pydantic_api_models_are_importable() -> None:
    from nais_contracts.api_models import AccessRequestCreate

    assert "purpose_detail" in AccessRequestCreate.model_fields
```

`apps/api/platform/tests/test_errors.py`:
```python
import re

from fastapi import FastAPI, Query
from fastapi.testclient import TestClient

from api.platform.errors import ApiError, install_error_handlers
from api.platform.generated.error_codes import ErrorCode

HEX32 = re.compile(r"^[0-9a-f]{32}$")


def make_client() -> TestClient:
    app = FastAPI()
    install_error_handlers(app)

    @app.get("/expired")
    def expired() -> None:
        raise ApiError(ErrorCode.ACCESS_GRANT_EXPIRED, details={"access_grant_id": "g-1"})

    @app.get("/items")
    def items(limit: int = Query(20, ge=1, le=100)) -> dict[str, int]:
        return {"limit": limit}

    @app.get("/boom")
    def boom() -> None:
        raise RuntimeError("secret internals")

    return TestClient(app, raise_server_exceptions=False)


def test_api_error_uses_contract_status_and_envelope() -> None:
    response = make_client().get("/expired")
    assert response.status_code == 403
    error = response.json()["error"]
    assert error["code"] == "ACCESS_GRANT_EXPIRED"
    assert error["message"] == "The access grant has expired."
    assert error["details"] == {"access_grant_id": "g-1"}
    assert HEX32.match(error["trace_id"])


def test_request_validation_becomes_validation_failed_with_fields() -> None:
    response = make_client().get("/items", params={"limit": 0})
    assert response.status_code == 422
    error = response.json()["error"]
    assert error["code"] == "VALIDATION_FAILED"
    assert error["details"]["fields"][0]["field"] == "limit"


def test_unknown_route_is_not_found_envelope() -> None:
    response = make_client().get("/nope")
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "NOT_FOUND"


def test_unhandled_exception_is_internal_error_without_leaking_details() -> None:
    response = make_client().get("/boom")
    assert response.status_code == 500
    error = response.json()["error"]
    assert error["code"] == "INTERNAL_ERROR"
    assert "secret" not in response.text


def test_api_error_accepts_plain_string_codes() -> None:
    assert ApiError("USER_DISABLED").status_code == 403
```

- [ ] **Step 4: Run to verify they fail**

Run: `uv run pytest apps/api/platform/tests/test_generated.py apps/api/platform/tests/test_errors.py -q`
Expected: `test_generated.py` passes (4), `test_errors.py` FAILS — `ModuleNotFoundError: No module named 'api.platform.errors'`

- [ ] **Step 5: Implement errors**

`apps/api/platform/errors.py`:
```python
import logging
from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from api.platform.context import trace_id
from api.platform.generated.error_codes import DESCRIPTION, HTTP_STATUS, ErrorCode

logger = logging.getLogger("nais.errors")

_STATUS_TO_CODE: dict[int, ErrorCode] = {
    401: ErrorCode.UNAUTHENTICATED,
    403: ErrorCode.FORBIDDEN,
    404: ErrorCode.NOT_FOUND,
    405: ErrorCode.NOT_FOUND,
    409: ErrorCode.CONFLICT,
    429: ErrorCode.RATE_LIMITED,
}


class ApiError(Exception):
    """Raise anywhere in a request to return the contract error envelope."""

    def __init__(
        self, code: ErrorCode | str, message: str | None = None, details: dict[str, Any] | None = None
    ) -> None:
        self.code = ErrorCode(code)
        self.status_code = HTTP_STATUS[self.code]
        self.message = message or DESCRIPTION[self.code]
        self.details = details
        super().__init__(f"{self.code}: {self.message}")


DomainError = ApiError


def error_body(code: ErrorCode, message: str, details: dict[str, Any] | None = None) -> dict[str, Any]:
    error: dict[str, Any] = {"code": code.value, "message": message, "trace_id": trace_id()}
    if details:
        error["details"] = details
    return {"error": error}


def install_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(ApiError)
    async def _api_error(_: Request, exc: ApiError) -> JSONResponse:
        return JSONResponse(error_body(exc.code, exc.message, exc.details), status_code=exc.status_code)

    @app.exception_handler(RequestValidationError)
    async def _validation(_: Request, exc: RequestValidationError) -> JSONResponse:
        fields = [
            {"field": ".".join(str(part) for part in err["loc"][1:]) or str(err["loc"][0]), "reason": err["msg"]}
            for err in exc.errors()
        ]
        body = error_body(ErrorCode.VALIDATION_FAILED, "Request validation failed.", {"fields": fields})
        return JSONResponse(body, status_code=422)

    @app.exception_handler(StarletteHTTPException)
    async def _http(_: Request, exc: StarletteHTTPException) -> JSONResponse:
        code = _STATUS_TO_CODE.get(exc.status_code, ErrorCode.INTERNAL_ERROR)
        return JSONResponse(error_body(code, DESCRIPTION[code]), status_code=HTTP_STATUS[code])

    @app.exception_handler(Exception)
    async def _unhandled(_: Request, exc: Exception) -> JSONResponse:
        logger.error("unhandled error", exc_info=exc)
        return JSONResponse(error_body(ErrorCode.INTERNAL_ERROR, "Unexpected server error."), status_code=500)
```

- [ ] **Step 6: Run to verify they pass**

Run: `uv run pytest apps/api/platform/tests/test_generated.py apps/api/platform/tests/test_errors.py -q`
Expected: `9 passed`

- [ ] **Step 7: Commit**

```bash
git add packages package.json pnpm-workspace.yaml apps/api/platform
git commit -m "feat(platform): contract codegen and error envelope

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: App factory, correlation middleware, module + port registries, liveness

**Files:**
- Create: `apps/api/platform/middleware.py`, `apps/api/platform/telemetry.py`, `apps/api/platform/broker.py`, `apps/api/platform/modules.py`, `apps/api/platform/ports.py`, `apps/api/platform/health.py`, `apps/api/platform/app.py`, `apps/api/main.py`, `apps/api/platform/testing/app.py`
- Modify: `apps/api/platform/testing/fixtures.py`
- Test: `apps/api/platform/tests/test_app.py`, `apps/api/platform/tests/test_modules.py`, `apps/api/platform/tests/test_ports.py`

**Interfaces:**
- Consumes: `Settings`, `context.set_correlation_id`, `ids.new_id`, `errors.install_error_handlers`, `logs.configure_logging`
- Produces:
  - `API_PREFIX = "/api/v1"` (in `api.platform.app`)
  - `create_app(*, modules: Sequence[ModuleSpec] | None = None, settings: Settings | None = None, broker: dramatiq.Broker | None = None, span_exporter: SpanExporter | None = None) -> FastAPI` — sets `app.state.settings`, `app.state.modules`
  - `ModuleSpec(name: str, db_schema: str | None = None, router: APIRouter | None = None, migrations_dir: Path | None = None, wire: Callable[[], None] | None = None, register_worker: Callable[[Broker, Scheduler], None] | None = None, seed: Callable[[Session], None] | None = None)`
  - `DEFAULT_MODULE_ORDER = ("identity", "project", "catalog", "readiness", "governance", "audit", "marketplace", "compute", "knowledge", "autonomy")`; `discover_modules(names=DEFAULT_MODULE_ORDER) -> list[ModuleSpec]`
  - `ports.provide(port: type[T], impl: T)`, `ports.get(port: type[T]) -> T` (raises `ports.PortNotProvided`), `ports.reset()`
  - `configure_broker(settings: Settings, broker: Broker | None = None) -> Broker`
  - `health.router` with `GET /health/live`
  - `api.platform.testing.app.create_test_app(*, modules=(), settings=None, broker=None, span_exporter=None) -> FastAPI` (uses `StubBroker`)
  - autouse fixture `_reset_ports`

- [ ] **Step 1: Write the failing tests**

`apps/api/platform/tests/test_app.py`:
```python
import uuid

from fastapi import APIRouter
from fastapi.testclient import TestClient
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

from api.platform.modules import ModuleSpec
from api.platform.testing.app import create_test_app


def test_liveness() -> None:
    response = TestClient(create_test_app()).get("/api/v1/health/live")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_valid_request_id_is_echoed_as_correlation_id() -> None:
    rid = "0192f0c0-0000-7000-8000-0000000000ab"
    response = TestClient(create_test_app()).get("/api/v1/health/live", headers={"X-Request-Id": rid})
    assert response.headers["X-Request-Id"] == rid


def test_nginx_style_hex_request_id_is_accepted() -> None:
    rid = "0192f0c0000070008000000000000abc"
    response = TestClient(create_test_app()).get("/api/v1/health/live", headers={"X-Request-Id": rid})
    assert response.headers["X-Request-Id"] == str(uuid.UUID(rid))


def test_invalid_request_id_is_replaced() -> None:
    client = TestClient(create_test_app())
    for junk in ("not-a-uuid", "x" * 2048):
        header = client.get("/api/v1/health/live", headers={"X-Request-Id": junk}).headers["X-Request-Id"]
        assert uuid.UUID(header).version == 7


def test_error_trace_id_matches_request_id() -> None:
    rid = "0192f0c0-0000-7000-8000-0000000000cd"
    response = TestClient(create_test_app()).get("/api/v1/missing", headers={"X-Request-Id": rid})
    assert response.json()["error"]["trace_id"] == uuid.UUID(rid).hex


def test_module_router_is_mounted_under_api_prefix_and_wired() -> None:
    wired: list[str] = []
    router = APIRouter()

    @router.get("/probe")
    def probe() -> dict[str, str]:
        return {"probe": "ok"}

    spec = ModuleSpec(name="probe", router=router, wire=lambda: wired.append("probe"))
    response = TestClient(create_test_app(modules=[spec])).get("/api/v1/probe")
    assert response.json() == {"probe": "ok"}
    assert wired == ["probe"]


def test_trace_id_comes_from_the_opentelemetry_span_when_enabled() -> None:
    exporter = InMemorySpanExporter()
    response = TestClient(create_test_app(span_exporter=exporter)).get("/api/v1/health/live")
    trace_ids = {span.context.trace_id for span in exporter.get_finished_spans()}
    assert uuid.UUID(response.headers["X-Request-Id"]).int in trace_ids
```

`apps/api/platform/tests/test_modules.py`:
```python
import sys
import types

import pytest

from api.platform.modules import ModuleSpec, discover_modules


def test_missing_modules_are_skipped() -> None:
    assert discover_modules(["does_not_exist"]) == []


def test_module_spec_is_discovered(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = types.ModuleType("api.modules.fake")
    fake.__file__ = "/virtual/api/modules/fake/__init__.py"
    fake.MODULE = ModuleSpec(name="fake", db_schema="fake")  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "api.modules.fake", fake)
    assert [spec.name for spec in discover_modules(["fake"])] == ["fake"]


def test_module_without_spec_is_an_error(monkeypatch: pytest.MonkeyPatch) -> None:
    broken = types.ModuleType("api.modules.broken")
    broken.__file__ = "/virtual/api/modules/broken/__init__.py"
    monkeypatch.setitem(sys.modules, "api.modules.broken", broken)
    with pytest.raises(TypeError, match="MODULE = ModuleSpec"):
        discover_modules(["broken"])
```

`apps/api/platform/tests/test_ports.py`:
```python
from typing import Protocol

import pytest

from api.platform import ports


class GreeterPort(Protocol):
    def greet(self) -> str: ...


class Greeter:
    def greet(self) -> str:
        return "hi"


def test_provide_and_get() -> None:
    ports.provide(GreeterPort, Greeter())
    assert ports.get(GreeterPort).greet() == "hi"


def test_missing_port_raises() -> None:
    with pytest.raises(ports.PortNotProvided, match="GreeterPort"):
        ports.get(GreeterPort)
```

- [ ] **Step 2: Run to verify they fail**

Run: `uv run pytest apps/api/platform/tests/test_app.py apps/api/platform/tests/test_modules.py apps/api/platform/tests/test_ports.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'api.platform.modules'`

- [ ] **Step 3: Implement ports, modules, broker**

`apps/api/platform/ports.py`:
```python
"""Tiny port registry: modules provide implementations, consumers look them up by Protocol type."""

from typing import TypeVar, cast

T = TypeVar("T")


class PortNotProvided(LookupError):
    pass


_registry: dict[object, object] = {}


def provide(port: type[T], impl: T) -> None:
    _registry[port] = impl


def get(port: type[T]) -> T:
    try:
        return cast(T, _registry[port])
    except KeyError:
        raise PortNotProvided(getattr(port, "__name__", repr(port))) from None


def reset() -> None:
    _registry.clear()
```

`apps/api/platform/modules.py`:
```python
"""Module plug-in contract (D-036). Each module defines MODULE = ModuleSpec(...) in its __init__.py."""

import importlib
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from fastapi import APIRouter

DEFAULT_MODULE_ORDER: tuple[str, ...] = (
    "identity", "project", "catalog", "readiness", "governance",
    "audit", "marketplace", "compute", "knowledge", "autonomy",
)


@dataclass(frozen=True)
class ModuleSpec:
    name: str
    db_schema: str | None = None
    router: APIRouter | None = None
    migrations_dir: Path | None = None
    wire: Callable[[], None] | None = None
    register_worker: Callable[[Any, Any], None] | None = None  # (broker, scheduler)
    seed: Callable[[Any], None] | None = None  # (session)


def discover_modules(names: Iterable[str] = DEFAULT_MODULE_ORDER) -> list[ModuleSpec]:
    specs: list[ModuleSpec] = []
    for name in names:
        qualified = f"api.modules.{name}"
        try:
            module = importlib.import_module(qualified)
        except ModuleNotFoundError as exc:
            if exc.name == qualified:
                continue
            raise
        if getattr(module, "__file__", None) is None:
            continue  # empty namespace directory, module not started yet
        spec = getattr(module, "MODULE", None)
        if not isinstance(spec, ModuleSpec):
            raise TypeError(f"{qualified} must define MODULE = ModuleSpec(...)")
        specs.append(spec)
    return specs
```

`apps/api/platform/broker.py`:
```python
"""Dramatiq broker must be set BEFORE modules are imported (their actors bind at import time)."""

import dramatiq
from dramatiq.brokers.redis import RedisBroker

from api.platform.settings import Settings


def configure_broker(settings: Settings, broker: dramatiq.Broker | None = None) -> dramatiq.Broker:
    chosen = broker if broker is not None else RedisBroker(url=settings.redis_url)
    dramatiq.set_broker(chosen)
    return chosen
```

- [ ] **Step 4: Implement middleware, telemetry, health, app, main**

`apps/api/platform/middleware.py`:
```python
from collections.abc import Awaitable, Callable
from uuid import UUID

from fastapi import Request, Response
from opentelemetry import trace

from api.platform.context import set_correlation_id
from api.platform.ids import new_id


def _parse_request_id(raw: str | None) -> UUID | None:
    if not raw or len(raw) > 36:
        return None
    try:
        return UUID(raw)
    except ValueError:
        return None


def _otel_trace_uuid() -> UUID | None:
    span_context = trace.get_current_span().get_span_context()
    return UUID(int=span_context.trace_id) if span_context.is_valid else None


async def correlation_middleware(
    request: Request, call_next: Callable[[Request], Awaitable[Response]]
) -> Response:
    correlation = _otel_trace_uuid() or _parse_request_id(request.headers.get("x-request-id")) or new_id()
    set_correlation_id(correlation)
    response = await call_next(request)
    response.headers["X-Request-Id"] = str(correlation)
    return response
```

`apps/api/platform/telemetry.py`:
```python
from fastapi import FastAPI
from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor, SimpleSpanProcessor, SpanExporter

from api.platform.settings import Settings


def configure_telemetry(app: FastAPI, settings: Settings, exporter: SpanExporter | None = None) -> bool:
    """Instrument only when an OTLP endpoint (or a test exporter) is configured."""
    if exporter is None and not settings.otel_exporter_otlp_endpoint:
        return False
    provider = TracerProvider(resource=Resource.create({"service.name": settings.otel_service_name}))
    if exporter is not None:
        provider.add_span_processor(SimpleSpanProcessor(exporter))
    else:
        from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter

        endpoint = f"{str(settings.otel_exporter_otlp_endpoint).rstrip('/')}/v1/traces"
        provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter(endpoint=endpoint)))
    FastAPIInstrumentor.instrument_app(app, tracer_provider=provider)
    return True
```

`apps/api/platform/health.py`:
```python
from fastapi import APIRouter

router = APIRouter(tags=["health"])


@router.get("/health/live")
def live() -> dict[str, str]:
    return {"status": "ok"}
```

`apps/api/platform/app.py`:
```python
from collections.abc import Sequence

import dramatiq
from fastapi import FastAPI
from opentelemetry.sdk.trace.export import SpanExporter

from api.platform import health
from api.platform.broker import configure_broker
from api.platform.errors import install_error_handlers
from api.platform.logs import configure_logging
from api.platform.middleware import correlation_middleware
from api.platform.modules import ModuleSpec, discover_modules
from api.platform.settings import Settings, get_settings
from api.platform.telemetry import configure_telemetry

API_PREFIX = "/api/v1"


def create_app(
    *,
    modules: Sequence[ModuleSpec] | None = None,
    settings: Settings | None = None,
    broker: dramatiq.Broker | None = None,
    span_exporter: SpanExporter | None = None,
) -> FastAPI:
    settings = settings or get_settings()
    configure_logging(settings.log_level)
    configure_broker(settings, broker)
    app = FastAPI(
        title="NAIS AI-OS API",
        version="0.1.0",
        docs_url=f"{API_PREFIX}/docs",
        openapi_url=f"{API_PREFIX}/openapi.json",
    )
    app.state.settings = settings
    app.middleware("http")(correlation_middleware)
    install_error_handlers(app)
    app.include_router(health.router, prefix=API_PREFIX)
    specs = discover_modules() if modules is None else list(modules)
    for spec in specs:
        if spec.wire is not None:
            spec.wire()
        if spec.router is not None:
            app.include_router(spec.router, prefix=API_PREFIX)
    app.state.modules = specs
    configure_telemetry(app, settings, span_exporter)
    return app
```

`apps/api/main.py`:
```python
from api.platform.app import create_app

app = create_app()
```

`apps/api/platform/testing/app.py`:
```python
from collections.abc import Sequence

import dramatiq
from dramatiq.brokers.stub import StubBroker
from fastapi import FastAPI
from opentelemetry.sdk.trace.export import SpanExporter

from api.platform.app import create_app
from api.platform.modules import ModuleSpec
from api.platform.settings import Settings


def create_test_app(
    *,
    modules: Sequence[ModuleSpec] = (),
    settings: Settings | None = None,
    broker: dramatiq.Broker | None = None,
    span_exporter: SpanExporter | None = None,
) -> FastAPI:
    """App with only the given modules, a StubBroker and default Settings. For module agents' tests too."""
    return create_app(
        modules=list(modules),
        settings=settings or Settings(),
        broker=broker or StubBroker(),
        span_exporter=span_exporter,
    )
```

Replace `apps/api/platform/testing/fixtures.py` with:
```python
"""Shared pytest fixtures for platform and module tests (registered from the root conftest.py)."""

from collections.abc import Iterator

import pytest

from api.platform import ports


@pytest.fixture(autouse=True)
def _reset_ports() -> Iterator[None]:
    yield
    ports.reset()
```

- [ ] **Step 5: Run to verify they pass**

Run: `uv run pytest apps/api/platform/tests -q`
Expected: all pass (Task 1–4 tests: `34 passed`)

- [ ] **Step 6: Commit**

```bash
git add apps/api
git commit -m "feat(platform): app factory, correlation middleware, module and port registries

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Cursor pagination

**Files:**
- Create: `apps/api/platform/pagination.py`
- Test: `apps/api/platform/tests/test_pagination.py`

**Interfaces:**
- Consumes: `ApiError`, `ErrorCode`
- Produces: `PageInfo`, `Page[T]` (pydantic generic: `items: list[T]`, `page: PageInfo`), `PageParams(cursor: list[Any] | None, limit: int)`, `page_params` (FastAPI dependency: `cursor` ≤ 512 chars, `limit` 1..100 default 20), `encode_cursor(values: Sequence[Any]) -> str`, `decode_cursor(cursor: str) -> list[Any]`, `build_page(rows: Sequence[T], limit: int, key: Callable[[T], Sequence[Any]]) -> Page[T]` (caller fetches `limit + 1` rows)

- [ ] **Step 1: Write the failing tests**

`apps/api/platform/tests/test_pagination.py`:
```python
from typing import Annotated

from fastapi import APIRouter, Depends
from fastapi.testclient import TestClient

from api.platform.modules import ModuleSpec
from api.platform.pagination import PageParams, build_page, decode_cursor, encode_cursor, page_params
from api.platform.testing.app import create_test_app


def make_client() -> TestClient:
    router = APIRouter()

    @router.get("/things")
    def things(params: Annotated[PageParams, Depends(page_params)]) -> dict[str, object]:
        return {"cursor": params.cursor, "limit": params.limit}

    return TestClient(create_test_app(modules=[ModuleSpec(name="things", router=router)]))


def test_cursor_round_trip() -> None:
    assert decode_cursor(encode_cursor(["2026-09-30T00:00:00Z", "abc"])) == ["2026-09-30T00:00:00Z", "abc"]


def test_default_limit_and_valid_cursor() -> None:
    body = make_client().get("/api/v1/things", params={"cursor": encode_cursor([1, "x"])}).json()
    assert body == {"cursor": [1, "x"], "limit": 20}


def test_garbage_cursor_is_422() -> None:
    for garbage in ("%%%", "bm90LWpzb24", "한글"):
        response = make_client().get("/api/v1/things", params={"cursor": garbage})
        assert response.status_code == 422
        assert response.json()["error"]["details"]["fields"][0]["field"] == "cursor"


def test_non_list_cursor_is_422() -> None:
    for payload in ({"a": 1}, []):
        response = make_client().get("/api/v1/things", params={"cursor": encode_cursor(payload)})  # type: ignore[arg-type]
        assert response.status_code == 422


def test_oversized_cursor_and_bad_limits_are_422() -> None:
    client = make_client()
    assert client.get("/api/v1/things", params={"cursor": "a" * 513}).status_code == 422
    assert client.get("/api/v1/things", params={"limit": 0}).status_code == 422
    assert client.get("/api/v1/things", params={"limit": 101}).status_code == 422


def test_build_page_sets_has_more_and_next_cursor_from_last_item() -> None:
    page = build_page([1, 2, 3], limit=2, key=lambda n: [n])
    assert page.items == [1, 2]
    assert page.page.has_more is True
    assert decode_cursor(page.page.next_cursor or "") == [2]


def test_build_page_last_page_has_no_cursor() -> None:
    page = build_page([1, 2], limit=2, key=lambda n: [n])
    assert page.page.has_more is False
    assert page.page.next_cursor is None
```

- [ ] **Step 2: Run to verify they fail**

Run: `uv run pytest apps/api/platform/tests/test_pagination.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'api.platform.pagination'`

- [ ] **Step 3: Implement**

`apps/api/platform/pagination.py`:
```python
"""Opaque cursor pagination. A cursor is base64url(JSON list of the sort key of the last item)."""

import base64
import json
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from typing import Annotated, Any, Generic, TypeVar

from fastapi import Query
from pydantic import BaseModel

from api.platform.errors import ApiError
from api.platform.generated.error_codes import ErrorCode

T = TypeVar("T")
MAX_CURSOR_LENGTH = 512


class PageInfo(BaseModel):
    next_cursor: str | None = None
    has_more: bool


class Page(BaseModel, Generic[T]):
    items: list[T]
    page: PageInfo


@dataclass(frozen=True)
class PageParams:
    cursor: list[Any] | None
    limit: int


def _invalid_cursor() -> ApiError:
    return ApiError(
        ErrorCode.VALIDATION_FAILED,
        "Invalid pagination cursor.",
        {"fields": [{"field": "cursor", "reason": "INVALID_CURSOR"}]},
    )


def encode_cursor(values: Sequence[Any]) -> str:
    raw = json.dumps(list(values), separators=(",", ":"), default=str).encode()
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def decode_cursor(cursor: str) -> list[Any]:
    try:
        if len(cursor) > MAX_CURSOR_LENGTH:
            raise ValueError("cursor too long")
        padded = cursor + "=" * (-len(cursor) % 4)
        value = json.loads(base64.urlsafe_b64decode(padded.encode("ascii")))
    except (ValueError, UnicodeError) as exc:
        raise _invalid_cursor() from exc
    if not isinstance(value, list) or not value:
        raise _invalid_cursor()
    return value


def page_params(
    cursor: Annotated[str | None, Query(max_length=MAX_CURSOR_LENGTH)] = None,
    limit: Annotated[int, Query(ge=1, le=100)] = 20,
) -> PageParams:
    return PageParams(cursor=decode_cursor(cursor) if cursor else None, limit=limit)


def build_page(rows: Sequence[T], limit: int, key: Callable[[T], Sequence[Any]]) -> Page[T]:
    has_more = len(rows) > limit
    items = list(rows[:limit])
    next_cursor = encode_cursor(key(items[-1])) if has_more and items else None
    return Page(items=items, page=PageInfo(next_cursor=next_cursor, has_more=has_more))
```

- [ ] **Step 4: Run to verify they pass**

Run: `uv run pytest apps/api/platform/tests/test_pagination.py -q`
Expected: `7 passed`

- [ ] **Step 5: Commit**

```bash
git add apps/api/platform
git commit -m "feat(platform): cursor pagination helpers

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Database, roles, multi-schema migrations, platform outbox table

**Files:**
- Create: `infra/docker/postgres/init.sql`, `apps/api/platform/db.py`, `apps/api/platform/migrate.py`, `apps/api/platform/migration_helpers.py`, `apps/api/platform/migrations/env.py`, `apps/api/platform/migrations/script.py.mako`, `apps/api/platform/migrations/versions/0001_platform_outbox.py`
- Modify: `apps/api/platform/testing/fixtures.py`
- Test: `apps/api/platform/tests/test_migrate.py`

**Interfaces:**
- Consumes: `Settings`, `ModuleSpec`
- Produces:
  - `db.engine_for(url: str) -> Engine` (cached), `db.session_factory(url: str | None = None) -> sessionmaker[Session]`, `db.session_scope(url: str | None = None)` (commit/rollback context manager), `db.get_session()` (FastAPI dependency)
  - `migrate.MigrationTarget(name, schema, versions_dir)`, `migrate.PLATFORM_TARGET`, `migrate.migration_targets(modules) -> list[MigrationTarget]`, `migrate.upgrade_all(url: str, modules: Sequence[ModuleSpec], *, sql: bool = False) -> list[str]`, `migrate.new_revision(url: str, target: MigrationTarget, message: str) -> Path`
  - `migration_helpers.create_processed_events(schema: str) -> None` (for module migrations: table `<schema>.processed_events(event_id uuid pk, event_type text, processed_at timestamptz)`)
  - Table `platform.outbox_events`; alembic version table `<schema>.alembic_version` per target
  - pytest fixtures `pg_urls -> PgUrls(superuser, migrator, app)` (session scope, skips if Docker is unavailable) and `migrated_db -> PgUrls`

- [ ] **Step 1: Write init.sql**

`infra/docker/postgres/init.sql`:
```sql
-- Runs once as the postgres superuser on database "nais" (docker-entrypoint-initdb.d, and the test fixture).
-- Dev passwords only; production overrides them via secrets (D-027).
CREATE ROLE nais_migrator LOGIN PASSWORD 'nais_migrator';
CREATE ROLE nais_app LOGIN PASSWORD 'nais_app';
GRANT CONNECT, CREATE ON DATABASE nais TO nais_migrator;
GRANT CONNECT ON DATABASE nais TO nais_app;

DO $$
DECLARE
  s text;
BEGIN
  FOREACH s IN ARRAY ARRAY['platform','identity','project','catalog','governance','readiness','audit',
                           'marketplace','compute','knowledge','autonomy'] LOOP
    EXECUTE format('CREATE SCHEMA IF NOT EXISTS %I AUTHORIZATION nais_migrator', s);
    EXECUTE format('GRANT USAGE ON SCHEMA %I TO nais_app', s);
    EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE nais_migrator IN SCHEMA %I '
                   'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO nais_app', s);
    EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE nais_migrator IN SCHEMA %I '
                   'GRANT USAGE, SELECT ON SEQUENCES TO nais_app', s);
  END LOOP;
END $$;
```

- [ ] **Step 2: Add the Postgres fixtures**

Append to `apps/api/platform/testing/fixtures.py`:
```python
from dataclasses import dataclass

from sqlalchemy import create_engine
from sqlalchemy.engine import make_url

from api.platform.settings import REPO_ROOT

INIT_SQL = REPO_ROOT / "infra" / "docker" / "postgres" / "init.sql"


@dataclass(frozen=True)
class PgUrls:
    superuser: str
    migrator: str
    app: str


def _as_role(url: str, role: str) -> str:
    return make_url(url).set(username=role, password=role).render_as_string(hide_password=False)


@pytest.fixture(scope="session")
def pg_urls() -> Iterator[PgUrls]:
    """Throwaway postgres:16 with the same roles/schemas as compose. Skips when Docker is unavailable."""
    from testcontainers.postgres import PostgresContainer

    container = PostgresContainer("postgres:16", username="postgres", password="postgres", dbname="nais", driver="psycopg")
    try:
        container.start()
    except Exception as exc:  # docker missing or daemon not reachable
        pytest.skip(f"PostgreSQL container unavailable: {exc}")
    try:
        superuser = container.get_connection_url()
        engine = create_engine(superuser)
        with engine.begin() as conn:
            conn.exec_driver_sql(INIT_SQL.read_text(encoding="utf-8"))
        engine.dispose()
        yield PgUrls(superuser=superuser, migrator=_as_role(superuser, "nais_migrator"), app=_as_role(superuser, "nais_app"))
    finally:
        container.stop()


@pytest.fixture(scope="session")
def migrated_db(pg_urls: PgUrls) -> PgUrls:
    from api.platform.migrate import upgrade_all

    upgrade_all(pg_urls.migrator, [])
    return pg_urls
```

(`Iterator` and `pytest` are already imported at the top of the file from Task 4.)

- [ ] **Step 3: Write the failing tests**

`apps/api/platform/tests/test_migrate.py`:
```python
from pathlib import Path

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.exc import ProgrammingError

from api.platform.migrate import MigrationTarget, new_revision, upgrade_all
from api.platform.modules import ModuleSpec
from api.platform.testing.fixtures import PgUrls

PROBE_REVISION = '''
revision = "probe_0001"
down_revision = None
branch_labels = None
depends_on = None

import sqlalchemy as sa
from alembic import op


def upgrade() -> None:
    op.create_table("probe", sa.Column("id", sa.Integer, primary_key=True), schema="knowledge")


def downgrade() -> None:
    op.drop_table("probe", schema="knowledge")
'''


def scalar(url: str, sql: str) -> object:
    engine = create_engine(url)
    try:
        with engine.connect() as conn:
            return conn.execute(text(sql)).scalar()
    finally:
        engine.dispose()


def test_platform_migration_creates_outbox_and_version_table(migrated_db: PgUrls) -> None:
    assert scalar(migrated_db.app, "SELECT to_regclass('platform.outbox_events')::text") == "platform.outbox_events"
    assert scalar(migrated_db.migrator, "SELECT version_num FROM platform.alembic_version") == "platform_0001"


def test_upgrade_is_idempotent(migrated_db: PgUrls) -> None:
    assert upgrade_all(migrated_db.migrator, []) == ["platform"]


def test_module_migrations_use_their_own_schema_version_table(migrated_db: PgUrls, tmp_path: Path) -> None:
    (tmp_path / "probe_0001.py").write_text(PROBE_REVISION)
    spec = ModuleSpec(name="knowledge", db_schema="knowledge", migrations_dir=tmp_path)
    try:
        assert upgrade_all(migrated_db.migrator, [spec]) == ["platform", "knowledge"]
        assert scalar(migrated_db.migrator, "SELECT version_num FROM knowledge.alembic_version") == "probe_0001"
    finally:
        engine = create_engine(migrated_db.migrator)
        with engine.begin() as conn:
            conn.execute(text("DROP TABLE IF EXISTS knowledge.probe, knowledge.alembic_version"))
        engine.dispose()


def test_app_role_can_write_rows_but_not_create_tables(migrated_db: PgUrls) -> None:
    engine = create_engine(migrated_db.app)
    try:
        with engine.begin() as conn:
            conn.execute(text("SELECT count(*) FROM platform.outbox_events"))
        with pytest.raises(ProgrammingError), engine.begin() as conn:
            conn.execute(text("CREATE TABLE platform.sneaky (id int)"))
    finally:
        engine.dispose()


def test_module_with_migrations_but_no_schema_is_rejected(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="db_schema"):
        upgrade_all("postgresql+psycopg://x@localhost/nais", [ModuleSpec(name="bad", migrations_dir=tmp_path)], sql=True)


def test_offline_sql_mode_renders_ddl(capsys: pytest.CaptureFixture[str]) -> None:
    upgrade_all("postgresql+psycopg://x@localhost/nais", [], sql=True)
    assert "CREATE TABLE platform.outbox_events" in capsys.readouterr().out


def test_new_revision_writes_a_file_in_the_target_dir(tmp_path: Path) -> None:
    target = MigrationTarget(name="knowledge", schema="knowledge", versions_dir=tmp_path)
    path = new_revision("postgresql+psycopg://x@localhost/nais", target, "create concepts")
    assert path.parent == tmp_path
    assert "create_concepts" in path.name
    assert "down_revision = None" in path.read_text()
```

- [ ] **Step 4: Run to verify they fail**

Run: `uv run pytest apps/api/platform/tests/test_migrate.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'api.platform.migrate'`

- [ ] **Step 5: Implement db, migrations env, platform revision, migrate**

`apps/api/platform/db.py`:
```python
from collections.abc import Iterator
from contextlib import contextmanager
from functools import lru_cache

from sqlalchemy import Engine, create_engine
from sqlalchemy.orm import Session, sessionmaker

from api.platform.settings import get_settings


@lru_cache(maxsize=8)
def engine_for(url: str) -> Engine:
    return create_engine(url, pool_pre_ping=True, connect_args={"connect_timeout": 2})


def session_factory(url: str | None = None) -> sessionmaker[Session]:
    return sessionmaker(bind=engine_for(url or get_settings().database_url), expire_on_commit=False)


@contextmanager
def session_scope(url: str | None = None) -> Iterator[Session]:
    session = session_factory(url)()
    try:
        yield session
        session.commit()
    except BaseException:
        session.rollback()
        raise
    finally:
        session.close()


def get_session() -> Iterator[Session]:
    """FastAPI dependency: one transaction per request, rolled back on any error."""
    with session_scope() as session:
        yield session
```

`apps/api/platform/migrations/env.py`:
```python
"""Shared Alembic env for every migration target. version_table_schema comes from config.attributes."""

from alembic import context
from sqlalchemy import engine_from_config, pool

config = context.config
schema = config.attributes["version_table_schema"]


def run_offline() -> None:
    context.configure(
        url=config.get_main_option("sqlalchemy.url"),
        literal_binds=True,
        version_table_schema=schema,
        dialect_opts={"paramstyle": "named"},
    )
    with context.begin_transaction():
        context.run_migrations()


def run_online() -> None:
    connectable = engine_from_config(
        config.get_section(config.config_ini_section, {}), prefix="sqlalchemy.", poolclass=pool.NullPool
    )
    with connectable.connect() as connection:
        context.configure(connection=connection, version_table_schema=schema)
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_offline()
else:
    run_online()
```

`apps/api/platform/migrations/script.py.mako`:
```mako
"""${message}

Revision ID: ${up_revision}
Revises: ${down_revision | comma,n}
Create Date: ${create_date}
"""

import sqlalchemy as sa
from alembic import op
${imports if imports else ""}

revision = ${repr(up_revision)}
down_revision = ${repr(down_revision)}
branch_labels = ${repr(branch_labels)}
depends_on = ${repr(depends_on)}


def upgrade() -> None:
    ${upgrades if upgrades else "pass"}


def downgrade() -> None:
    ${downgrades if downgrades else "pass"}
```

`apps/api/platform/migrations/versions/0001_platform_outbox.py`:
```python
"""platform outbox

Revision ID: platform_0001
Revises:
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB, UUID

revision = "platform_0001"
down_revision = None
branch_labels = None
depends_on = None

NOW = sa.text("now()")


def upgrade() -> None:
    op.create_table(
        "outbox_events",
        sa.Column("id", sa.BigInteger, sa.Identity(always=True), primary_key=True),
        sa.Column("event_id", UUID(as_uuid=True), nullable=False, unique=True),
        sa.Column("event_type", sa.Text, nullable=False),
        sa.Column("envelope", JSONB, nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=NOW),
        sa.Column("attempts", sa.Integer, nullable=False, server_default="0"),
        sa.Column("next_attempt_at", sa.DateTime(timezone=True), nullable=False, server_default=NOW),
        sa.Column("dispatched_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("dead_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_error", sa.Text, nullable=True),
        schema="platform",
    )
    op.create_index(
        "ix_outbox_pending",
        "outbox_events",
        ["next_attempt_at", "id"],
        schema="platform",
        postgresql_where=sa.text("dispatched_at IS NULL AND dead_at IS NULL"),
    )


def downgrade() -> None:
    op.drop_table("outbox_events", schema="platform")
```

`apps/api/platform/migration_helpers.py`:
```python
"""Helpers for module migrations (call inside an Alembic upgrade())."""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID


def create_processed_events(schema: str) -> None:
    """Consumer idempotency table used by api.platform.event_bus.claim_event (D-006)."""
    op.create_table(
        "processed_events",
        sa.Column("event_id", UUID(as_uuid=True), primary_key=True),
        sa.Column("event_type", sa.Text, nullable=False),
        sa.Column("processed_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        schema=schema,
    )
```

`apps/api/platform/migrate.py`:
```python
"""Run Alembic per target (platform first, then each module) with a version table in the target's schema."""

from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path

from alembic import command
from alembic.config import Config

from api.platform.modules import ModuleSpec

MIGRATIONS_ENV_DIR = Path(__file__).parent / "migrations"


@dataclass(frozen=True)
class MigrationTarget:
    name: str
    schema: str
    versions_dir: Path


PLATFORM_TARGET = MigrationTarget("platform", "platform", MIGRATIONS_ENV_DIR / "versions")


def migration_targets(modules: Sequence[ModuleSpec]) -> list[MigrationTarget]:
    targets = [PLATFORM_TARGET]
    for spec in modules:
        if spec.migrations_dir is None:
            continue
        if spec.db_schema is None:
            raise ValueError(f"module {spec.name!r} has migrations_dir but no db_schema")
        targets.append(MigrationTarget(spec.name, spec.db_schema, spec.migrations_dir))
    return targets


def alembic_config(url: str, target: MigrationTarget) -> Config:
    config = Config()
    config.set_main_option("script_location", str(MIGRATIONS_ENV_DIR))
    config.set_main_option("version_locations", str(target.versions_dir))
    config.set_main_option("sqlalchemy.url", url.replace("%", "%%"))
    config.attributes["version_table_schema"] = target.schema
    return config


def upgrade_all(url: str, modules: Sequence[ModuleSpec], *, sql: bool = False) -> list[str]:
    applied: list[str] = []
    for target in migration_targets(modules):
        command.upgrade(alembic_config(url, target), "head", sql=sql)
        applied.append(target.name)
    return applied


def new_revision(url: str, target: MigrationTarget, message: str) -> Path:
    target.versions_dir.mkdir(parents=True, exist_ok=True)
    script = command.revision(alembic_config(url, target), message=message, version_path=str(target.versions_dir))
    if script is None or isinstance(script, list):
        raise RuntimeError("alembic did not create exactly one revision")
    return Path(script.path)
```

- [ ] **Step 6: Run to verify they pass**

Run: `uv run pytest apps/api/platform/tests/test_migrate.py -q`
Expected: `7 passed` (first run pulls `postgres:16`; if Docker is unavailable the DB tests report `skipped` — that is a failure for this task, fix Docker access before continuing)

- [ ] **Step 7: Commit**

```bash
git add infra/docker/postgres apps/api/platform
git commit -m "feat(platform): postgres roles, multi-schema alembic runner, outbox table

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Event envelope, outbox writer, handler registry

**Files:**
- Create: `apps/api/platform/events.py`, `apps/api/platform/outbox.py`, `apps/api/platform/event_bus.py`
- Test: `apps/api/platform/tests/test_outbox.py`, `apps/api/platform/tests/test_event_bus.py`

**Interfaces:**
- Consumes: `EventType`, `PRODUCER`, `new_id`, `clock.now`, `context.correlation_id`, `Settings.contracts_dir`, `migrated_db`
- Produces:
  - `EventActor(type: Literal["USER","SYSTEM"], user_id: UUID | None = None, organization_id: UUID | None = None)` with `EventActor.system()`
  - `EventEnvelope(event_id, event_type, occurred_at, producer, correlation_id, actor, payload)`
  - `events.EventSchemaError(ValueError)`, `events.validate_envelope(data: dict[str, Any]) -> None`
  - `outbox.outbox_events` (SQLAlchemy `Table`), `outbox.OutboxWriter.write(session, event_type, payload, actor, correlation_id=None) -> UUID`, module-level `outbox.outbox = OutboxWriter()`
  - `event_bus.Handler = Callable[[Session, EventEnvelope], None]`, `event_bus.Subscription(event_type, handler, name)`, `event_bus.HandlerRegistry` with `.subscribe(event_type)` decorator and `.handlers_for(event_type) -> list[Subscription]`; module-level `registry`, `subscribe`
  - `event_bus.claim_event(session, schema: str, envelope: EventEnvelope) -> bool`
  - (Task 9 adds `EventActor.for_user(user)`)

- [ ] **Step 1: Write the failing tests**

`apps/api/platform/tests/test_outbox.py`:
```python
import uuid

import pytest
from sqlalchemy import select

from api.platform.context import use_correlation_id
from api.platform.db import session_factory
from api.platform.events import EventActor, EventSchemaError
from api.platform.generated.event_types import EventType
from api.platform.outbox import OutboxWriter, outbox_events
from api.platform.testing.fixtures import PgUrls


def test_write_stores_a_schema_valid_envelope(migrated_db: PgUrls) -> None:
    project_id = uuid.uuid4()
    correlation = uuid.UUID("0192f0c0-0000-7000-8000-0000000000ef")
    with use_correlation_id(correlation), session_factory(migrated_db.app)() as session, session.begin():
        event_id = OutboxWriter().write(
            session, EventType.PROJECT_ARCHIVED_V1, {"project_id": str(project_id)}, EventActor.system()
        )
    with session_factory(migrated_db.app)() as session:
        row = session.execute(select(outbox_events).where(outbox_events.c.event_id == event_id)).one()
    assert row.event_type == "project.archived.v1"
    assert row.envelope["producer"] == "project"
    assert row.envelope["correlation_id"] == str(correlation)
    assert row.envelope["actor"] == {"type": "SYSTEM", "user_id": None, "organization_id": None}
    assert row.attempts == 0 and row.dispatched_at is None


def test_invalid_payload_is_rejected_before_insert(migrated_db: PgUrls) -> None:
    with pytest.raises(EventSchemaError, match="project_id"), session_factory(migrated_db.app)() as session:
        OutboxWriter().write(session, EventType.PROJECT_ARCHIVED_V1, {}, EventActor.system())


def test_unknown_event_type_is_rejected(migrated_db: PgUrls) -> None:
    with pytest.raises(ValueError), session_factory(migrated_db.app)() as session:
        OutboxWriter().write(session, "project.exploded.v1", {}, EventActor.system())


def test_rolled_back_transaction_leaves_no_event(migrated_db: PgUrls) -> None:
    with session_factory(migrated_db.app)() as session:
        with pytest.raises(RuntimeError), session.begin():
            event_id = OutboxWriter().write(
                session, EventType.PROJECT_ARCHIVED_V1, {"project_id": str(uuid.uuid4())}, EventActor.system()
            )
            raise RuntimeError("business failure after publish")
        assert session.execute(select(outbox_events).where(outbox_events.c.event_id == event_id)).first() is None
```

`apps/api/platform/tests/test_event_bus.py`:
```python
import uuid
from datetime import UTC, datetime

import pytest
from sqlalchemy import create_engine, text

from api.platform.db import session_factory
from api.platform.event_bus import HandlerRegistry, claim_event
from api.platform.events import EventActor, EventEnvelope
from api.platform.testing.fixtures import PgUrls


def envelope() -> EventEnvelope:
    return EventEnvelope(
        event_id=uuid.uuid4(),
        event_type="project.archived.v1",
        occurred_at=datetime.now(UTC),
        producer="project",
        correlation_id=uuid.uuid4(),
        actor=EventActor.system(),
        payload={"project_id": str(uuid.uuid4())},
    )


def test_subscribe_registers_handlers_in_order() -> None:
    registry = HandlerRegistry()

    @registry.subscribe("project.archived.v1")
    def first(session, event) -> None: ...  # type: ignore[no-untyped-def]

    @registry.subscribe("project.archived.v1")
    def second(session, event) -> None: ...  # type: ignore[no-untyped-def]

    names = [s.name for s in registry.handlers_for("project.archived.v1")]
    assert names == [f"{__name__}.test_subscribe_registers_handlers_in_order.<locals>.{n}" for n in ("first", "second")]
    assert registry.handlers_for("project.created.v1") == []


def test_subscribe_rejects_unknown_event_types() -> None:
    with pytest.raises(ValueError):
        HandlerRegistry().subscribe("nope.v1")


def test_claim_event_is_idempotent(migrated_db: PgUrls) -> None:
    engine = create_engine(migrated_db.migrator)
    with engine.begin() as conn:
        conn.execute(text(
            "CREATE TABLE IF NOT EXISTS autonomy.processed_events "
            "(event_id uuid PRIMARY KEY, event_type text NOT NULL, processed_at timestamptz NOT NULL DEFAULT now())"
        ))
    try:
        event = envelope()
        with session_factory(migrated_db.app)() as session, session.begin():
            assert claim_event(session, "autonomy", event) is True
        with session_factory(migrated_db.app)() as session, session.begin():
            assert claim_event(session, "autonomy", event) is False
    finally:
        with engine.begin() as conn:
            conn.execute(text("DROP TABLE autonomy.processed_events"))
        engine.dispose()


def test_claim_event_rejects_unsafe_schema_names(migrated_db: PgUrls) -> None:
    with pytest.raises(ValueError), session_factory(migrated_db.app)() as session:
        claim_event(session, 'audit"; DROP TABLE x; --', envelope())
```

- [ ] **Step 2: Run to verify they fail**

Run: `uv run pytest apps/api/platform/tests/test_outbox.py apps/api/platform/tests/test_event_bus.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'api.platform.events'`

- [ ] **Step 3: Implement events, outbox, event_bus**

`apps/api/platform/events.py`:
```python
import json
from datetime import datetime
from functools import lru_cache
from pathlib import Path
from typing import Any, Literal
from uuid import UUID

from jsonschema import Draft202012Validator
from pydantic import BaseModel, ConfigDict

from api.platform.settings import get_settings


class EventActor(BaseModel):
    model_config = ConfigDict(frozen=True)

    type: Literal["USER", "SYSTEM"]
    user_id: UUID | None = None
    organization_id: UUID | None = None

    @classmethod
    def system(cls) -> "EventActor":
        return cls(type="SYSTEM")


class EventEnvelope(BaseModel):
    model_config = ConfigDict(frozen=True)

    event_id: UUID
    event_type: str
    occurred_at: datetime
    producer: str
    correlation_id: UUID
    actor: EventActor
    payload: dict[str, Any]


class EventSchemaError(ValueError):
    pass


@lru_cache(maxsize=4)
def _validators(schema_path: Path) -> dict[str, Draft202012Validator]:
    """One validator per event type (envelope + that type's variant), so errors name the exact field."""
    schema = json.loads(schema_path.read_text(encoding="utf-8"))
    variants = schema.pop("oneOf")
    validators: dict[str, Draft202012Validator] = {}
    for variant in variants:
        event_type = variant["properties"]["event_type"]["const"]
        validators[event_type] = Draft202012Validator(
            {**schema, "allOf": [variant]}, format_checker=Draft202012Validator.FORMAT_CHECKER
        )
    return validators


def validate_envelope(data: dict[str, Any]) -> None:
    validators = _validators(get_settings().contracts_dir / "events" / "p0_events.schema.json")
    event_type = str(data.get("event_type"))
    validator = validators.get(event_type)
    if validator is None:
        raise EventSchemaError(f"unknown event_type {event_type!r}")
    errors = sorted(validator.iter_errors(data), key=lambda e: [str(p) for p in e.absolute_path])
    if errors:
        location = "/".join(str(part) for part in errors[0].absolute_path) or "(root)"
        raise EventSchemaError(f"{event_type}: {location}: {errors[0].message}")
```

Why per-type validators: a single `oneOf` reports "not valid under any of the given schemas", which hides the missing field. Splitting by `event_type` makes the error read `project.archived.v1: payload: 'project_id' is a required property`.

`apps/api/platform/outbox.py`:
```python
"""Transactional outbox (D-005): write the event in the SAME session/transaction as the business change."""

from typing import Any
from uuid import UUID

from sqlalchemy import BigInteger, Column, DateTime, Integer, MetaData, Table, Text, insert
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.orm import Session

from api.platform import clock
from api.platform.context import correlation_id as current_correlation_id
from api.platform.events import EventActor, EventEnvelope, validate_envelope
from api.platform.generated.event_types import PRODUCER, EventType
from api.platform.ids import new_id

metadata = MetaData(schema="platform")

outbox_events = Table(
    "outbox_events",
    metadata,
    Column("id", BigInteger, primary_key=True),
    Column("event_id", PG_UUID(as_uuid=True), nullable=False),
    Column("event_type", Text, nullable=False),
    Column("envelope", JSONB, nullable=False),
    Column("created_at", DateTime(timezone=True)),
    Column("attempts", Integer),
    Column("next_attempt_at", DateTime(timezone=True)),
    Column("dispatched_at", DateTime(timezone=True)),
    Column("dead_at", DateTime(timezone=True)),
    Column("last_error", Text),
)


class OutboxWriter:
    def write(
        self,
        session: Session,
        event_type: EventType | str,
        payload: dict[str, Any],
        actor: EventActor,
        correlation_id: UUID | None = None,
    ) -> UUID:
        kind = EventType(event_type)
        envelope = EventEnvelope(
            event_id=new_id(),
            event_type=kind.value,
            occurred_at=clock.now(),
            producer=PRODUCER[kind],
            correlation_id=correlation_id or current_correlation_id(),
            actor=actor,
            payload=payload,
        )
        data = envelope.model_dump(mode="json")
        validate_envelope(data)
        session.execute(insert(outbox_events).values(event_id=envelope.event_id, event_type=kind.value, envelope=data))
        return envelope.event_id


outbox = OutboxWriter()
```

`apps/api/platform/event_bus.py`:
```python
"""In-process handler registry (D-006). Delivery is at-least-once; handlers must be idempotent (claim_event)."""

import re
from collections import defaultdict
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, cast

from sqlalchemy import CursorResult, text
from sqlalchemy.orm import Session

from api.platform.events import EventEnvelope
from api.platform.generated.event_types import EventType

Handler = Callable[[Session, EventEnvelope], None]
_SCHEMA_NAME = re.compile(r"^[a-z][a-z_]{1,30}$")


@dataclass(frozen=True)
class Subscription:
    event_type: str
    handler: Handler
    name: str


class HandlerRegistry:
    def __init__(self) -> None:
        self._subscriptions: dict[str, list[Subscription]] = defaultdict(list)

    def subscribe(self, event_type: EventType | str) -> Callable[[Handler], Handler]:
        kind = EventType(event_type).value

        def decorator(handler: Handler) -> Handler:
            name = f"{handler.__module__}.{handler.__qualname__}"
            self._subscriptions[kind].append(Subscription(kind, handler, name))
            return handler

        return decorator

    def handlers_for(self, event_type: str) -> list[Subscription]:
        return list(self._subscriptions.get(event_type, []))


registry = HandlerRegistry()
subscribe = registry.subscribe


def claim_event(session: Session, schema: str, envelope: EventEnvelope) -> bool:
    """Insert into <schema>.processed_events; False means this consumer already handled the event."""
    if not _SCHEMA_NAME.fullmatch(schema):
        raise ValueError(f"invalid schema name: {schema!r}")
    result = cast(
        CursorResult[Any],
        session.execute(
            text(
                f'INSERT INTO "{schema}".processed_events (event_id, event_type) '
                "VALUES (:event_id, :event_type) ON CONFLICT (event_id) DO NOTHING"
            ),
            {"event_id": envelope.event_id, "event_type": envelope.event_type},
        ),
    )
    return result.rowcount == 1
```

- [ ] **Step 4: Run to verify they pass**

Run: `uv run pytest apps/api/platform/tests/test_outbox.py apps/api/platform/tests/test_event_bus.py -q`
Expected: `8 passed`

- [ ] **Step 5: Commit**

```bash
git add apps/api/platform
git commit -m "feat(platform): event envelope validation, outbox writer, handler registry

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Outbox relay

**Files:**
- Create: `apps/api/platform/relay.py`
- Test: `apps/api/platform/tests/test_relay.py`

**Interfaces:**
- Consumes: `outbox_events`, `EventEnvelope`, `HandlerRegistry`, `use_correlation_id`, `clock.now`, `session_factory`
- Produces: `relay.RelayResult(dispatched: int = 0, retried: int = 0, dead: int = 0)`, `relay.backoff_seconds(attempts: int) -> float` (= min(2**attempts, 300)), `relay.dispatch_batch(session_factory, registry, *, batch_size=100, max_attempts=10, now=clock.now) -> RelayResult`, `relay.run_forever(stop: threading.Event, session_factory, registry, *, idle_sleep_s=0.5, batch_size=100, max_attempts=10) -> None`

- [ ] **Step 1: Write the failing tests**

`apps/api/platform/tests/test_relay.py`:
```python
import threading
import time
import uuid
from collections import Counter
from datetime import timedelta

from sqlalchemy import delete, select

from api.platform import clock
from api.platform.context import correlation_id
from api.platform.db import session_factory
from api.platform.event_bus import HandlerRegistry
from api.platform.events import EventActor, EventEnvelope
from api.platform.outbox import OutboxWriter, outbox_events
from api.platform.relay import dispatch_batch
from api.platform.testing.fixtures import PgUrls

EVENT = "project.archived.v1"


def clear_outbox(url: str) -> None:
    with session_factory(url)() as session, session.begin():
        session.execute(delete(outbox_events))


def publish(url: str, count: int = 1) -> list[uuid.UUID]:
    ids = []
    with session_factory(url)() as session, session.begin():
        for _ in range(count):
            ids.append(OutboxWriter().write(session, EVENT, {"project_id": str(uuid.uuid4())}, EventActor.system()))
    return ids


def row(url: str, event_id: uuid.UUID):  # type: ignore[no-untyped-def]
    with session_factory(url)() as session:
        return session.execute(select(outbox_events).where(outbox_events.c.event_id == event_id)).one()


def test_handler_receives_event_with_its_correlation_id(migrated_db: PgUrls) -> None:
    clear_outbox(migrated_db.app)
    seen: list[tuple[uuid.UUID, uuid.UUID]] = []
    registry = HandlerRegistry()

    @registry.subscribe(EVENT)
    def handler(session, event: EventEnvelope) -> None:  # type: ignore[no-untyped-def]
        seen.append((event.event_id, correlation_id()))

    [event_id] = publish(migrated_db.app)
    result = dispatch_batch(session_factory(migrated_db.app), registry)
    assert result.dispatched == 1
    envelope_correlation = uuid.UUID(row(migrated_db.app, event_id).envelope["correlation_id"])
    assert seen == [(event_id, envelope_correlation)]
    assert row(migrated_db.app, event_id).dispatched_at is not None


def test_events_without_handlers_are_marked_dispatched(migrated_db: PgUrls) -> None:
    clear_outbox(migrated_db.app)
    [event_id] = publish(migrated_db.app)
    assert dispatch_batch(session_factory(migrated_db.app), HandlerRegistry()).dispatched == 1
    assert row(migrated_db.app, event_id).dispatched_at is not None


def test_failing_handler_is_retried_with_backoff_then_dead(migrated_db: PgUrls) -> None:
    clear_outbox(migrated_db.app)
    registry = HandlerRegistry()

    @registry.subscribe(EVENT)
    def broken(session, event) -> None:  # type: ignore[no-untyped-def]
        raise RuntimeError("downstream exploded")

    [event_id] = publish(migrated_db.app)
    factory = session_factory(migrated_db.app)
    assert dispatch_batch(factory, registry, max_attempts=2).retried == 1
    first = row(migrated_db.app, event_id)
    assert first.attempts == 1 and "downstream exploded" in first.last_error
    assert dispatch_batch(factory, registry, max_attempts=2).retried == 0  # not due yet (backoff 2s)
    later = clock.now() + timedelta(seconds=10)
    assert dispatch_batch(factory, registry, max_attempts=2, now=lambda: later).dead == 1
    assert row(migrated_db.app, event_id).dead_at is not None


def test_other_handlers_still_run_when_one_fails(migrated_db: PgUrls) -> None:
    clear_outbox(migrated_db.app)
    calls: list[str] = []
    registry = HandlerRegistry()

    @registry.subscribe(EVENT)
    def ok(session, event) -> None:  # type: ignore[no-untyped-def]
        calls.append("ok")

    @registry.subscribe(EVENT)
    def broken(session, event) -> None:  # type: ignore[no-untyped-def]
        raise RuntimeError("nope")

    publish(migrated_db.app)
    dispatch_batch(session_factory(migrated_db.app), registry)
    assert calls == ["ok"]


def test_concurrent_relays_dispatch_each_event_once(migrated_db: PgUrls) -> None:
    clear_outbox(migrated_db.app)
    counts: Counter[uuid.UUID] = Counter()
    lock = threading.Lock()
    registry = HandlerRegistry()

    @registry.subscribe(EVENT)
    def slow(session, event: EventEnvelope) -> None:  # type: ignore[no-untyped-def]
        time.sleep(0.01)
        with lock:
            counts[event.event_id] += 1

    ids = publish(migrated_db.app, count=40)
    factory = session_factory(migrated_db.app)

    def drain() -> None:
        for _ in range(10):
            dispatch_batch(factory, registry, batch_size=5)

    threads = [threading.Thread(target=drain) for _ in range(2)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert set(counts) == set(ids)
    assert set(counts.values()) == {1}
```

- [ ] **Step 2: Run to verify they fail**

Run: `uv run pytest apps/api/platform/tests/test_relay.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'api.platform.relay'`

- [ ] **Step 3: Implement**

`apps/api/platform/relay.py`:
```python
"""Outbox relay: locks due rows (SKIP LOCKED), runs each handler in its own transaction, records outcome."""

import logging
import threading
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any

from sqlalchemy import select, update
from sqlalchemy.orm import Session

from api.platform import clock
from api.platform.context import use_correlation_id
from api.platform.event_bus import HandlerRegistry
from api.platform.events import EventEnvelope
from api.platform.outbox import outbox_events

logger = logging.getLogger("nais.outbox")
SessionFactory = Callable[[], Session]


@dataclass(frozen=True)
class RelayResult:
    dispatched: int = 0
    retried: int = 0
    dead: int = 0


def backoff_seconds(attempts: int) -> float:
    return float(min(2**attempts, 300))


def _run_handlers(session_factory: SessionFactory, registry: HandlerRegistry, envelope: EventEnvelope) -> str | None:
    failures: list[str] = []
    for subscription in registry.handlers_for(envelope.event_type):
        try:
            with use_correlation_id(envelope.correlation_id), session_factory() as session, session.begin():
                subscription.handler(session, envelope)
        except Exception as exc:
            logger.exception(
                "event handler failed", extra={"handler": subscription.name, "event_id": str(envelope.event_id)}
            )
            failures.append(f"{subscription.name}: {exc!r}")
    return "; ".join(failures) or None


def dispatch_batch(
    session_factory: SessionFactory,
    registry: HandlerRegistry,
    *,
    batch_size: int = 100,
    max_attempts: int = 10,
    now: Callable[[], datetime] = clock.now,
) -> RelayResult:
    dispatched = retried = dead = 0
    with session_factory() as session, session.begin():
        rows = session.execute(
            select(outbox_events.c.id, outbox_events.c.envelope, outbox_events.c.attempts)
            .where(
                outbox_events.c.dispatched_at.is_(None),
                outbox_events.c.dead_at.is_(None),
                outbox_events.c.next_attempt_at <= now(),
            )
            .order_by(outbox_events.c.id)
            .limit(batch_size)
            .with_for_update(skip_locked=True)
        ).all()
        for row in rows:
            envelope = EventEnvelope.model_validate(row.envelope)
            error = _run_handlers(session_factory, registry, envelope)
            current = now()
            values: dict[str, Any]
            if error is None:
                values = {"dispatched_at": current, "last_error": None}
                dispatched += 1
            else:
                attempts = row.attempts + 1
                values = {"attempts": attempts, "last_error": error[:4000]}
                if attempts >= max_attempts:
                    values["dead_at"] = current
                    dead += 1
                else:
                    values["next_attempt_at"] = current + timedelta(seconds=backoff_seconds(attempts))
                    retried += 1
            session.execute(update(outbox_events).where(outbox_events.c.id == row.id).values(**values))
    return RelayResult(dispatched=dispatched, retried=retried, dead=dead)


def run_forever(
    stop: threading.Event,
    session_factory: SessionFactory,
    registry: HandlerRegistry,
    *,
    idle_sleep_s: float = 0.5,
    batch_size: int = 100,
    max_attempts: int = 10,
) -> None:
    while not stop.is_set():
        try:
            result = dispatch_batch(session_factory, registry, batch_size=batch_size, max_attempts=max_attempts)
        except Exception:
            logger.exception("outbox relay batch failed")
            stop.wait(idle_sleep_s * 4)
            continue
        if result == RelayResult():
            stop.wait(idle_sleep_s)
```

- [ ] **Step 4: Run to verify they pass**

Run: `uv run pytest apps/api/platform/tests/test_relay.py -q`
Expected: `5 passed`

- [ ] **Step 5: Commit**

```bash
git add apps/api/platform
git commit -m "feat(platform): outbox relay with retries, dead-lettering and SKIP LOCKED

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Authentication dependency

**Files:**
- Create: `apps/api/platform/auth.py`, `apps/api/platform/testing/tokens.py`
- Modify: `apps/api/platform/events.py` (add `EventActor.for_user`)
- Test: `apps/api/platform/tests/test_auth.py`

**Interfaces:**
- Consumes: `ApiError`, `ErrorCode`, `ports`, `context.correlation_id`, `Settings`
- Produces:
  - `CurrentUser(user_id, organization_id, org_roles: frozenset[str], platform_roles: frozenset[str], session_id: str, display_name: str)` with `.has_org_role(organization_id, role) -> bool`, `.is_platform_admin` (M01 §8)
  - `PrincipalResolver` Protocol: `resolve(self, claims: dict[str, Any], correlation_id: UUID) -> CurrentUser` (M01 implements; raises `ApiError`)
  - `TokenVerifier(*, issuer: str, audience: str, jwk_client: JwkClient, leeway: int = 30)` with `.verify(token: str) -> dict[str, Any]`
  - FastAPI deps: `get_token_verifier() -> TokenVerifier` (override in tests), `current_user(...) -> CurrentUser`, alias `current_principal = current_user`, `CurrentUserDep = Annotated[CurrentUser, Depends(current_user)]`
  - `EventActor.for_user(user: CurrentUser) -> EventActor`
  - Testing: `FakeIssuer(issuer=..., audience=..., kid="test-key")` with `.token(*, expires_in=300, **claims) -> str`, `.jwk_client() -> StaticJwkClient`, `.public_pem() -> bytes`; `forge_hs256(payload: dict, secret: bytes, kid: str) -> str`

- [ ] **Step 1: Write the test helpers**

`apps/api/platform/testing/tokens.py`:
```python
"""JWT helpers for tests: a fake Keycloak issuer with an in-memory RSA key."""

import base64
import hashlib
import hmac
import json
import time
from types import SimpleNamespace
from typing import Any

import jwt
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa


class StaticJwkClient:
    def __init__(self, public_key: Any, kid: str, *, fail: Exception | None = None) -> None:
        self._public_key = public_key
        self._kid = kid
        self._fail = fail

    def get_signing_key_from_jwt(self, token: str) -> Any:
        if self._fail is not None:
            raise self._fail
        if jwt.get_unverified_header(token).get("kid") != self._kid:
            raise jwt.PyJWKClientError("Unable to find a signing key that matches")
        return SimpleNamespace(key=self._public_key)


class FakeIssuer:
    def __init__(
        self,
        issuer: str = "http://localhost:21051/auth/realms/nais",
        audience: str = "nais-api",
        kid: str = "test-key",
    ) -> None:
        self.issuer = issuer
        self.audience = audience
        self.kid = kid
        self.private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)

    def token(self, *, expires_in: int = 300, **claims: Any) -> str:
        now = int(time.time())
        payload = {
            "iss": self.issuer, "aud": self.audience, "sub": "kc-user-1", "iat": now, "exp": now + expires_in,
            "sid": "session-1", "email": "a.researcher@inst-a.local", "name": "A Researcher", "org_code": "inst-a",
        }
        payload.update(claims)
        return jwt.encode(payload, self.private_key, algorithm="RS256", headers={"kid": self.kid})

    def jwk_client(self, *, fail: Exception | None = None) -> StaticJwkClient:
        return StaticJwkClient(self.private_key.public_key(), self.kid, fail=fail)

    def public_pem(self) -> bytes:
        return self.private_key.public_key().public_bytes(
            serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo
        )


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode().rstrip("=")


def forge_hs256(payload: dict[str, Any], secret: bytes, kid: str) -> str:
    """Build an HS256 token by hand (PyJWT refuses PEM secrets) to test algorithm-confusion defenses."""
    header = _b64(json.dumps({"alg": "HS256", "typ": "JWT", "kid": kid}).encode())
    body = _b64(json.dumps(payload).encode())
    signature = hmac.new(secret, f"{header}.{body}".encode(), hashlib.sha256).digest()
    return f"{header}.{body}.{_b64(signature)}"
```

- [ ] **Step 2: Write the failing tests**

`apps/api/platform/tests/test_auth.py`:
```python
import time
import uuid
from typing import Any

import jwt
import pytest
from fastapi import APIRouter
from fastapi.testclient import TestClient

from api.platform import ports
from api.platform.auth import CurrentUser, CurrentUserDep, PrincipalResolver, TokenVerifier, get_token_verifier
from api.platform.errors import ApiError
from api.platform.events import EventActor
from api.platform.modules import ModuleSpec
from api.platform.testing.app import create_test_app
from api.platform.testing.tokens import FakeIssuer, forge_hs256

USER_ID = uuid.UUID("00000000-0000-7000-8000-000000000a02")
ORG_ID = uuid.UUID("00000000-0000-7000-8000-00000000000a")
ISSUER = FakeIssuer()


class FakeResolver:
    def __init__(self, error: ApiError | None = None) -> None:
        self.error = error

    def resolve(self, claims: dict[str, Any], correlation_id: uuid.UUID) -> CurrentUser:
        if self.error:
            raise self.error
        return CurrentUser(
            user_id=USER_ID, organization_id=ORG_ID, org_roles=frozenset({"DATA_STEWARD"}),
            session_id=claims["sid"], display_name=claims["name"],
        )


def make_client(*, jwk_fail: Exception | None = None, resolver: FakeResolver | None = FakeResolver()) -> TestClient:
    router = APIRouter()

    @router.get("/whoami")
    def whoami(user: CurrentUserDep) -> dict[str, str]:
        return {"user_id": str(user.user_id), "session": user.session_id}

    app = create_test_app(modules=[ModuleSpec(name="probe", router=router)])
    app.dependency_overrides[get_token_verifier] = lambda: TokenVerifier(
        issuer=ISSUER.issuer, audience=ISSUER.audience, jwk_client=ISSUER.jwk_client(fail=jwk_fail)
    )
    if resolver is not None:
        ports.provide(PrincipalResolver, resolver)
    return TestClient(app)


def call(client: TestClient, token: str | None) -> Any:
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    return client.get("/api/v1/whoami", headers=headers)


def error_code(response: Any) -> str:
    return str(response.json()["error"]["code"])


def test_valid_token_resolves_current_user() -> None:
    response = call(make_client(), ISSUER.token())
    assert response.status_code == 200
    assert response.json() == {"user_id": str(USER_ID), "session": "session-1"}


def test_missing_token_is_401() -> None:
    response = call(make_client(), None)
    assert response.status_code == 401 and error_code(response) == "UNAUTHENTICATED"


@pytest.mark.parametrize(
    "claims",
    [{"expires_in": -120}, {"aud": "someone-else"}, {"iss": "http://evil.example/realms/nais"}],
    ids=["expired", "wrong-audience", "wrong-issuer"],
)
def test_invalid_claims_are_401(claims: dict[str, Any]) -> None:
    response = call(make_client(), ISSUER.token(**claims))
    assert response.status_code == 401 and error_code(response) == "UNAUTHENTICATED"


def test_alg_none_is_rejected() -> None:
    now = int(time.time())
    payload = {"iss": ISSUER.issuer, "aud": ISSUER.audience, "sub": "x", "iat": now, "exp": now + 300, "sid": "s"}
    token = jwt.encode(payload, None, algorithm="none", headers={"kid": ISSUER.kid})  # type: ignore[arg-type]
    assert call(make_client(), token).status_code == 401


def test_hs256_with_public_key_is_rejected() -> None:
    now = int(time.time())
    payload = {"iss": ISSUER.issuer, "aud": ISSUER.audience, "sub": "x", "iat": now, "exp": now + 300, "sid": "s"}
    token = forge_hs256(payload, ISSUER.public_pem(), ISSUER.kid)
    assert call(make_client(), token).status_code == 401


def test_resolver_errors_pass_through() -> None:
    response = call(make_client(resolver=FakeResolver(ApiError("USER_DISABLED"))), ISSUER.token())
    assert response.status_code == 403 and error_code(response) == "USER_DISABLED"


def test_missing_identity_module_is_503() -> None:
    response = call(make_client(resolver=None), ISSUER.token())
    assert response.status_code == 503 and error_code(response) == "DEPENDENCY_UNAVAILABLE"


def test_unreachable_jwks_is_503() -> None:
    response = call(make_client(jwk_fail=jwt.PyJWKClientConnectionError("down")), ISSUER.token())
    assert response.status_code == 503 and error_code(response) == "DEPENDENCY_UNAVAILABLE"


def test_current_user_helpers_and_event_actor() -> None:
    user = FakeResolver().resolve({"sid": "s", "name": "n"}, uuid.uuid4())
    assert user.has_org_role(ORG_ID, "DATA_STEWARD")
    assert not user.has_org_role(uuid.uuid4(), "DATA_STEWARD")
    assert not user.is_platform_admin
    assert EventActor.for_user(user) == EventActor(type="USER", user_id=USER_ID, organization_id=ORG_ID)
```

- [ ] **Step 3: Run to verify they fail**

Run: `uv run pytest apps/api/platform/tests/test_auth.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'api.platform.auth'`

- [ ] **Step 4: Implement auth and EventActor.for_user**

`apps/api/platform/auth.py`:
```python
"""Platform half of authentication (M01 §3): verify the Keycloak JWT, then ask M01's PrincipalResolver."""

from functools import lru_cache
from typing import Annotated, Any, Protocol
from uuid import UUID

import jwt
from fastapi import Depends
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, ConfigDict

from api.platform import ports
from api.platform.context import correlation_id
from api.platform.errors import ApiError
from api.platform.generated.error_codes import ErrorCode
from api.platform.settings import get_settings


class CurrentUser(BaseModel):
    model_config = ConfigDict(frozen=True)

    user_id: UUID
    organization_id: UUID
    org_roles: frozenset[str] = frozenset()
    platform_roles: frozenset[str] = frozenset()
    session_id: str
    display_name: str

    def has_org_role(self, organization_id: UUID, role: str) -> bool:
        return organization_id == self.organization_id and role in self.org_roles

    @property
    def is_platform_admin(self) -> bool:
        return "PLATFORM_ADMIN" in self.platform_roles


class PrincipalResolver(Protocol):
    def resolve(self, claims: dict[str, Any], correlation_id: UUID) -> CurrentUser: ...


class JwkClient(Protocol):
    def get_signing_key_from_jwt(self, token: str) -> Any: ...


class TokenVerifier:
    def __init__(self, *, issuer: str, audience: str, jwk_client: JwkClient, leeway: int = 30) -> None:
        self._issuer = issuer
        self._audience = audience
        self._jwk_client = jwk_client
        self._leeway = leeway

    def verify(self, token: str) -> dict[str, Any]:
        try:
            key = self._jwk_client.get_signing_key_from_jwt(token).key
            claims: dict[str, Any] = jwt.decode(
                token,
                key,
                algorithms=["RS256"],
                audience=self._audience,
                issuer=self._issuer,
                leeway=self._leeway,
                options={"require": ["exp", "iat", "iss", "aud", "sub"]},
            )
            return claims
        except jwt.PyJWKClientConnectionError as exc:
            raise ApiError(ErrorCode.DEPENDENCY_UNAVAILABLE, "Identity provider keys are unavailable.") from exc
        except jwt.PyJWTError as exc:
            raise ApiError(ErrorCode.UNAUTHENTICATED) from exc


@lru_cache(maxsize=1)
def get_token_verifier() -> TokenVerifier:
    settings = get_settings()
    return TokenVerifier(
        issuer=settings.oidc_issuer,
        audience=settings.oidc_audience,
        jwk_client=jwt.PyJWKClient(settings.oidc_internal_jwks_url, cache_keys=True, timeout=5),
        leeway=settings.oidc_clock_skew_seconds,
    )


_bearer = HTTPBearer(auto_error=False)


def current_user(
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(_bearer)],
    verifier: Annotated[TokenVerifier, Depends(get_token_verifier)],
) -> CurrentUser:
    if credentials is None or credentials.scheme.lower() != "bearer":
        raise ApiError(ErrorCode.UNAUTHENTICATED)
    claims = verifier.verify(credentials.credentials)
    try:
        resolver = ports.get(PrincipalResolver)
    except ports.PortNotProvided as exc:
        raise ApiError(ErrorCode.DEPENDENCY_UNAVAILABLE, "Identity module is not installed.") from exc
    return resolver.resolve(claims, correlation_id())


current_principal = current_user
CurrentUserDep = Annotated[CurrentUser, Depends(current_user)]
```

In `apps/api/platform/events.py`, add to the imports block:
```python
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from api.platform.auth import CurrentUser
```
and add this method inside `class EventActor` below `system()`:
```python
    @classmethod
    def for_user(cls, user: "CurrentUser") -> "EventActor":
        return cls(type="USER", user_id=user.user_id, organization_id=user.organization_id)
```

- [ ] **Step 5: Run to verify they pass**

Run: `uv run pytest apps/api/platform/tests/test_auth.py -q`
Expected: `11 passed`

- [ ] **Step 6: Commit**

```bash
git add apps/api/platform
git commit -m "feat(platform): JWT verification and CurrentUser dependency

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Institutional storage configuration

**Files:**
- Create: `apps/api/platform/storage.py`
- Test: `apps/api/platform/tests/test_storage.py`

**Interfaces:**
- Produces: `StorageConfig(org_code, endpoint, bucket, access_key, secret_key)`, `StorageNotConfigured(LookupError)`, `env_prefix(org_code: str) -> str` (`inst-b` → `STORAGE_INST_B`), `load_storage_config(org_code: str, environ: Mapping[str, str] = os.environ) -> StorageConfig`, `internal_client(cfg) -> S3Client`, `public_client(cfg, public_base_url: str) -> S3Client` (for presigning only; path-style, SigV4), `ensure_buckets(org_codes: Sequence[str], environ=os.environ) -> list[str]` (returns buckets created). M03 builds presign/key rules on top of these (D-024).

- [ ] **Step 1: Write the failing tests**

`apps/api/platform/tests/test_storage.py`:
```python
import pytest

from api.platform.storage import StorageNotConfigured, env_prefix, load_storage_config, public_client

ENV = {
    "STORAGE_INST_B_ENDPOINT": "http://storage-b:8333",
    "STORAGE_INST_B_BUCKET": "nais-inst-b",
    "STORAGE_INST_B_ACCESS_KEY": "nais-inst-b",
    "STORAGE_INST_B_SECRET_KEY": "change-me-b",
}


def test_env_prefix_is_derived_from_org_code() -> None:
    assert env_prefix("inst-b") == "STORAGE_INST_B"
    assert env_prefix("nais") == "STORAGE_NAIS"


@pytest.mark.parametrize("bad", ["INST-B", "a", "inst b", "../etc"])
def test_invalid_org_codes_are_rejected(bad: str) -> None:
    with pytest.raises(ValueError):
        env_prefix(bad)


def test_load_storage_config() -> None:
    cfg = load_storage_config("inst-b", ENV)
    assert (cfg.endpoint, cfg.bucket, cfg.access_key) == ("http://storage-b:8333", "nais-inst-b", "nais-inst-b")


def test_missing_configuration_names_the_variable() -> None:
    with pytest.raises(StorageNotConfigured, match="STORAGE_INST_A_BUCKET"):
        load_storage_config("inst-a", {"STORAGE_INST_A_ENDPOINT": "http://storage-a:8333"})


def test_public_client_presigns_path_style_urls_on_the_gateway() -> None:
    client = public_client(load_storage_config("inst-b", ENV), "http://localhost:21051")
    url = client.generate_presigned_url(
        "get_object", Params={"Bucket": "nais-inst-b", "Key": "datasets/d/v/data.csv"}, ExpiresIn=300
    )
    assert url.startswith("http://localhost:21051/nais-inst-b/datasets/d/v/data.csv?")
    assert "X-Amz-Signature=" in url
```

- [ ] **Step 2: Run to verify they fail**

Run: `uv run pytest apps/api/platform/tests/test_storage.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'api.platform.storage'`

- [ ] **Step 3: Implement**

`apps/api/platform/storage.py`:
```python
"""Institution storage settings (D-024): org code -> STORAGE_<CODE>_* env vars. Key layout/presign rules: M03."""

import os
import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError

_ORG_CODE = re.compile(r"^[a-z0-9-]{2,32}$")
_S3_CONFIG = Config(signature_version="s3v4", s3={"addressing_style": "path"}, retries={"max_attempts": 3})


class StorageNotConfigured(LookupError):
    pass


@dataclass(frozen=True)
class StorageConfig:
    org_code: str
    endpoint: str
    bucket: str
    access_key: str
    secret_key: str


def env_prefix(org_code: str) -> str:
    if not _ORG_CODE.fullmatch(org_code):
        raise ValueError(f"invalid organization code: {org_code!r}")
    return "STORAGE_" + org_code.upper().replace("-", "_")


def load_storage_config(org_code: str, environ: Mapping[str, str] = os.environ) -> StorageConfig:
    prefix = env_prefix(org_code)
    values: dict[str, str] = {}
    for field in ("ENDPOINT", "BUCKET", "ACCESS_KEY", "SECRET_KEY"):
        name = f"{prefix}_{field}"
        if not environ.get(name):
            raise StorageNotConfigured(f"{name} is not set for organization {org_code!r}")
        values[field.lower()] = environ[name]
    return StorageConfig(org_code=org_code, **values)


def _client(cfg: StorageConfig, endpoint: str) -> Any:
    return boto3.client(
        "s3",
        endpoint_url=endpoint,
        aws_access_key_id=cfg.access_key,
        aws_secret_access_key=cfg.secret_key,
        region_name="us-east-1",
        config=_S3_CONFIG,
    )


def internal_client(cfg: StorageConfig) -> Any:
    """For server-side calls inside the compose network (HEAD, hashing, multipart complete)."""
    return _client(cfg, cfg.endpoint)


def public_client(cfg: StorageConfig, public_base_url: str) -> Any:
    """For presigning URLs that browsers call through the :21051 gateway. Never used for direct calls."""
    return _client(cfg, public_base_url.rstrip("/"))


def ensure_buckets(org_codes: Sequence[str], environ: Mapping[str, str] = os.environ) -> list[str]:
    created: list[str] = []
    for code in org_codes:
        cfg = load_storage_config(code, environ)
        client = internal_client(cfg)
        try:
            client.head_bucket(Bucket=cfg.bucket)
        except ClientError as exc:
            if exc.response.get("Error", {}).get("Code") not in ("404", "NoSuchBucket", "NotFound"):
                raise
            client.create_bucket(Bucket=cfg.bucket)
            created.append(cfg.bucket)
    return created
```

- [ ] **Step 4: Run to verify they pass**

Run: `uv run pytest apps/api/platform/tests/test_storage.py -q`
Expected: `8 passed`

- [ ] **Step 5: Commit**

```bash
git add apps/api/platform
git commit -m "feat(platform): institution storage config and S3 clients

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Readiness endpoint

**Files:**
- Modify: `apps/api/platform/health.py`
- Test: `apps/api/platform/tests/test_health.py`

**Interfaces:**
- Consumes: `engine_for`, `Settings` (via `request.app.state.settings`)
- Produces: `HealthCheck = Callable[[], None]` (raise = down), `default_health_checks() -> dict[str, HealthCheck]` (postgres, redis, opensearch, opa), `get_health_checks()` (FastAPI dependency, overridable), `run_checks(checks, timeout_s) -> dict[str, str]`, `GET /api/v1/health/ready` → 200 `{"status":"ok","checks":{...}}` or 503 `{"status":"degraded",...}`

- [ ] **Step 1: Write the failing tests**

`apps/api/platform/tests/test_health.py`:
```python
import time

from fastapi.testclient import TestClient

from api.platform.health import get_health_checks
from api.platform.settings import Settings
from api.platform.testing.app import create_test_app


def ok() -> None:
    return None


def down() -> None:
    raise ConnectionError("refused")


def hang() -> None:
    time.sleep(3)


def client_with(checks: dict, timeout: float = 2.0) -> TestClient:  # type: ignore[type-arg]
    app = create_test_app(settings=Settings(health_check_timeout_seconds=timeout))
    app.dependency_overrides[get_health_checks] = lambda: checks
    return TestClient(app)


def test_ready_when_all_dependencies_are_up() -> None:
    response = client_with({"postgres": ok, "redis": ok}).get("/api/v1/health/ready")
    assert response.status_code == 200
    assert response.json() == {"status": "ok", "checks": {"postgres": "ok", "redis": "ok"}}


def test_not_ready_when_one_dependency_is_down() -> None:
    response = client_with({"postgres": ok, "opa": down}).get("/api/v1/health/ready")
    assert response.status_code == 503
    assert response.json() == {"status": "degraded", "checks": {"postgres": "ok", "opa": "down"}}


def test_hanging_check_times_out() -> None:
    started = time.monotonic()
    response = client_with({"opensearch": hang, "postgres": ok}, timeout=0.2).get("/api/v1/health/ready")
    assert time.monotonic() - started < 1.5
    assert response.status_code == 503
    assert response.json()["checks"] == {"opensearch": "down", "postgres": "ok"}


def test_default_checks_cover_the_gate_a_dependencies() -> None:
    from api.platform.health import default_health_checks

    assert set(default_health_checks()) == {"postgres", "redis", "opensearch", "opa"}
```

- [ ] **Step 2: Run to verify they fail**

Run: `uv run pytest apps/api/platform/tests/test_health.py -q`
Expected: FAIL — `ImportError: cannot import name 'get_health_checks'`

- [ ] **Step 3: Implement (replace `apps/api/platform/health.py`)**

```python
import time
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from typing import Annotated

import httpx
from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse
from redis import Redis
from sqlalchemy import text

from api.platform.db import engine_for
from api.platform.settings import get_settings

HealthCheck = Callable[[], None]
router = APIRouter(tags=["health"])
_executor = ThreadPoolExecutor(max_workers=8, thread_name_prefix="health")


def default_health_checks() -> dict[str, HealthCheck]:
    settings = get_settings()

    def postgres() -> None:
        with engine_for(settings.database_url).connect() as conn:
            conn.execute(text("SELECT 1"))

    def redis() -> None:
        Redis.from_url(settings.redis_url, socket_timeout=1, socket_connect_timeout=1).ping()

    def opensearch() -> None:
        httpx.get(f"{settings.opensearch_url}/_cluster/health", timeout=1.5).raise_for_status()

    def opa() -> None:
        httpx.get(f"{settings.opa_url}/health", timeout=1.5).raise_for_status()

    return {"postgres": postgres, "redis": redis, "opensearch": opensearch, "opa": opa}


def get_health_checks() -> dict[str, HealthCheck]:
    return default_health_checks()


def run_checks(checks: dict[str, HealthCheck], timeout_s: float) -> dict[str, str]:
    futures = {name: _executor.submit(check) for name, check in checks.items()}
    deadline = time.monotonic() + timeout_s
    results: dict[str, str] = {}
    for name, future in futures.items():
        try:
            future.result(timeout=max(0.0, deadline - time.monotonic()))
            results[name] = "ok"
        except Exception:
            results[name] = "down"
    return results


@router.get("/health/live")
def live() -> dict[str, str]:
    return {"status": "ok"}


@router.get("/health/ready")
def ready(request: Request, checks: Annotated[dict[str, HealthCheck], Depends(get_health_checks)]) -> JSONResponse:
    results = run_checks(checks, request.app.state.settings.health_check_timeout_seconds)
    healthy = all(state == "ok" for state in results.values())
    return JSONResponse(
        {"status": "ok" if healthy else "degraded", "checks": results}, status_code=200 if healthy else 503
    )
```

- [ ] **Step 4: Run to verify they pass**

Run: `uv run pytest apps/api/platform/tests/test_health.py apps/api/platform/tests/test_app.py -q`
Expected: `11 passed`

- [ ] **Step 5: Commit**

```bash
git add apps/api/platform
git commit -m "feat(platform): readiness endpoint with bounded dependency checks

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Scheduler and worker entry point

**Files:**
- Create: `apps/api/platform/scheduler.py`, `apps/api/worker.py`
- Test: `apps/api/platform/tests/test_scheduler.py`, `apps/api/platform/tests/test_worker.py`

**Interfaces:**
- Consumes: `configure_broker`, `discover_modules`, `ModuleSpec`, `relay.run_forever`, `event_bus.registry`, `session_factory`, `configure_logging`
- Produces: `Scheduler(clock=time.monotonic)` with `.every(interval_s: float, name: str, fn, *, run_immediately=False)`, `.run_pending() -> list[str]`, `.run_forever(stop, tick_s=0.5)`, `.job_names -> list[str]`; `api.worker.WorkerRuntime(broker, scheduler, modules)`, `api.worker.build_worker(*, modules=None, broker=None, settings=None) -> WorkerRuntime`, `api.worker.main()`

- [ ] **Step 1: Write the failing tests**

`apps/api/platform/tests/test_scheduler.py`:
```python
import pytest

from api.platform.scheduler import Scheduler


class FakeClock:
    def __init__(self) -> None:
        self.value = 0.0

    def __call__(self) -> float:
        return self.value


def test_jobs_run_when_due_and_are_rescheduled() -> None:
    clock = FakeClock()
    ran: list[str] = []
    scheduler = Scheduler(clock=clock)
    scheduler.every(60, "sweep", lambda: ran.append("sweep"))
    assert scheduler.run_pending() == []
    clock.value = 60
    assert scheduler.run_pending() == ["sweep"]
    clock.value = 119
    assert scheduler.run_pending() == []
    clock.value = 120
    assert scheduler.run_pending() == ["sweep"]
    assert ran == ["sweep", "sweep"]


def test_run_immediately() -> None:
    scheduler = Scheduler(clock=FakeClock())
    scheduler.every(60, "now", lambda: None, run_immediately=True)
    assert scheduler.run_pending() == ["now"]


def test_failing_job_does_not_stop_others() -> None:
    clock = FakeClock()
    ran: list[str] = []
    scheduler = Scheduler(clock=clock)

    def broken() -> None:
        raise RuntimeError("boom")

    scheduler.every(1, "broken", broken)
    scheduler.every(1, "fine", lambda: ran.append("fine"))
    clock.value = 1
    assert scheduler.run_pending() == ["broken", "fine"]
    assert ran == ["fine"]


def test_invalid_and_duplicate_jobs_are_rejected() -> None:
    scheduler = Scheduler(clock=FakeClock())
    with pytest.raises(ValueError):
        scheduler.every(0, "zero", lambda: None)
    scheduler.every(1, "dup", lambda: None)
    with pytest.raises(ValueError):
        scheduler.every(1, "dup", lambda: None)
```

`apps/api/platform/tests/test_worker.py`:
```python
from typing import Any

import dramatiq
from dramatiq.brokers.stub import StubBroker

from api.platform.modules import ModuleSpec
from api.platform.settings import Settings
from api.worker import build_worker


def test_build_worker_sets_broker_wires_modules_and_registers_jobs() -> None:
    calls: list[Any] = []

    def register(broker: dramatiq.Broker, scheduler: Any) -> None:
        scheduler.every(60, "probe.sweep", lambda: None)
        calls.append(broker)

    spec = ModuleSpec(name="probe", wire=lambda: calls.append("wired"), register_worker=register)
    broker = StubBroker()
    runtime = build_worker(modules=[spec], broker=broker, settings=Settings())
    assert calls == ["wired", broker]
    assert runtime.scheduler.job_names == ["probe.sweep"]
    assert dramatiq.get_broker() is broker
```

- [ ] **Step 2: Run to verify they fail**

Run: `uv run pytest apps/api/platform/tests/test_scheduler.py apps/api/platform/tests/test_worker.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'api.platform.scheduler'`

- [ ] **Step 3: Implement**

`apps/api/platform/scheduler.py`:
```python
"""Minimal periodic job runner for the worker (e.g. M04 grant expiry sweeper every 60 s)."""

import logging
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass

logger = logging.getLogger("nais.scheduler")


@dataclass
class PeriodicJob:
    name: str
    interval_s: float
    fn: Callable[[], None]
    next_run: float


class Scheduler:
    def __init__(self, clock: Callable[[], float] = time.monotonic) -> None:
        self._clock = clock
        self._jobs: list[PeriodicJob] = []

    @property
    def job_names(self) -> list[str]:
        return [job.name for job in self._jobs]

    def every(
        self, interval_s: float, name: str, fn: Callable[[], None], *, run_immediately: bool = False
    ) -> None:
        if interval_s <= 0:
            raise ValueError("interval_s must be positive")
        if name in self.job_names:
            raise ValueError(f"duplicate job name: {name}")
        first_run = self._clock() + (0 if run_immediately else interval_s)
        self._jobs.append(PeriodicJob(name, interval_s, fn, first_run))

    def run_pending(self) -> list[str]:
        ran: list[str] = []
        now = self._clock()
        for job in self._jobs:
            if job.next_run > now:
                continue
            try:
                job.fn()
            except Exception:
                logger.exception("scheduled job failed", extra={"job": job.name})
            job.next_run = now + job.interval_s
            ran.append(job.name)
        return ran

    def run_forever(self, stop: threading.Event, tick_s: float = 0.5) -> None:
        while not stop.is_set():
            self.run_pending()
            stop.wait(tick_s)
```

`apps/api/worker.py`:
```python
"""Worker process: outbox relay + periodic jobs + Dramatiq actors. Run: python -m api.worker"""

import signal
import threading
from collections.abc import Sequence
from dataclasses import dataclass

import dramatiq
from dramatiq import Worker

from api.platform import relay
from api.platform.broker import configure_broker
from api.platform.db import session_factory
from api.platform.event_bus import registry
from api.platform.logs import configure_logging
from api.platform.modules import ModuleSpec, discover_modules
from api.platform.scheduler import Scheduler
from api.platform.settings import Settings, get_settings


@dataclass
class WorkerRuntime:
    broker: dramatiq.Broker
    scheduler: Scheduler
    modules: list[ModuleSpec]


def build_worker(
    *,
    modules: Sequence[ModuleSpec] | None = None,
    broker: dramatiq.Broker | None = None,
    settings: Settings | None = None,
) -> WorkerRuntime:
    settings = settings or get_settings()
    chosen = configure_broker(settings, broker)  # before module import: actors bind at import time
    specs = discover_modules() if modules is None else list(modules)
    scheduler = Scheduler()
    for spec in specs:
        if spec.wire is not None:
            spec.wire()
        if spec.register_worker is not None:
            spec.register_worker(chosen, scheduler)
    return WorkerRuntime(broker=chosen, scheduler=scheduler, modules=specs)


def main() -> None:
    settings = get_settings()
    configure_logging(settings.log_level)
    runtime = build_worker(settings=settings)
    stop = threading.Event()
    signal.signal(signal.SIGTERM, lambda *_: stop.set())
    signal.signal(signal.SIGINT, lambda *_: stop.set())
    threads = [
        threading.Thread(
            target=relay.run_forever,
            args=(stop, session_factory(), registry),
            kwargs={"batch_size": settings.outbox_batch_size, "max_attempts": settings.outbox_max_attempts},
            name="outbox-relay",
            daemon=True,
        ),
        threading.Thread(target=runtime.scheduler.run_forever, args=(stop,), name="scheduler", daemon=True),
    ]
    for thread in threads:
        thread.start()
    actor_worker = Worker(runtime.broker, worker_threads=settings.worker_threads)
    actor_worker.start()
    try:
        while not stop.is_set():
            stop.wait(1)
    finally:
        actor_worker.stop()
        for thread in threads:
            thread.join(timeout=10)


if __name__ == "__main__":
    main()
```

- [ ] **Step 4: Run to verify they pass**

Run: `uv run pytest apps/api/platform/tests/test_scheduler.py apps/api/platform/tests/test_worker.py -q`
Expected: `5 passed`

- [ ] **Step 5: Commit**

```bash
git add apps/api
git commit -m "feat(platform): periodic scheduler and worker entry point

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: Seed orchestrator and platform CLI

**Files:**
- Create: `apps/api/platform/seed.py`, `apps/api/platform/cli.py` (invoked as `python -m api.platform.cli`)
- Test: `apps/api/platform/tests/test_seed.py`, `apps/api/platform/tests/test_cli.py`

**Interfaces:**
- Consumes: `session_scope`, `ModuleSpec`, `discover_modules`, `configure_broker`, `upgrade_all`, `new_revision`, `migration_targets`, `PLATFORM_TARGET`, `ensure_buckets`
- Produces: `seed.run_seed(modules: Sequence[ModuleSpec], *, url: str | None = None) -> list[str]` (one transaction per module, in the given order); `cli.main(argv: Sequence[str] | None = None) -> int` with sub-commands `migrate [--sql]`, `new-migration MODULE -m MESSAGE`, `seed`, `storage-init`

- [ ] **Step 1: Write the failing tests**

`apps/api/platform/tests/test_seed.py`:
```python
import uuid

import pytest
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from api.platform.db import session_factory
from api.platform.events import EventActor
from api.platform.modules import ModuleSpec
from api.platform.outbox import OutboxWriter, outbox_events
from api.platform.seed import run_seed
from api.platform.testing.fixtures import PgUrls


def count_events(url: str) -> int:
    with session_factory(url)() as session:
        return int(session.execute(select(func.count()).select_from(outbox_events)).scalar_one())


def publish(session: Session) -> None:
    OutboxWriter().write(session, "project.archived.v1", {"project_id": str(uuid.uuid4())}, EventActor.system())


def test_seeds_run_in_order_and_skip_modules_without_seed(migrated_db: PgUrls) -> None:
    order: list[str] = []
    specs = [
        ModuleSpec(name="identity", seed=lambda s: order.append("identity")),
        ModuleSpec(name="project"),
        ModuleSpec(name="catalog", seed=lambda s: order.append("catalog")),
    ]
    assert run_seed(specs, url=migrated_db.app) == ["identity", "catalog"]
    assert order == ["identity", "catalog"]


def test_failing_seed_rolls_back_its_own_writes(migrated_db: PgUrls) -> None:
    before = count_events(migrated_db.app)

    def broken(session: Session) -> None:
        publish(session)
        raise RuntimeError("seed failed")

    with pytest.raises(RuntimeError):
        run_seed([ModuleSpec(name="catalog", seed=broken)], url=migrated_db.app)
    assert count_events(migrated_db.app) == before
```

`apps/api/platform/tests/test_cli.py`:
```python
from typing import Any

import pytest

from api.platform import cli


def test_migrate_passes_sql_flag(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict[str, Any] = {}
    monkeypatch.setattr(cli, "discover_modules", lambda: [])
    monkeypatch.setattr(cli, "upgrade_all", lambda url, modules, sql=False: captured.update(url=url, sql=sql) or [])
    assert cli.main(["migrate", "--sql"]) == 0
    assert captured["sql"] is True
    assert "nais_migrator" in captured["url"]


def test_new_migration_for_unknown_module_fails(monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]) -> None:
    monkeypatch.setattr(cli, "discover_modules", lambda: [])
    assert cli.main(["new-migration", "ghost", "-m", "x"]) == 2
    assert "unknown module 'ghost'" in capsys.readouterr().err


def test_storage_init_uses_configured_org_codes(monkeypatch: pytest.MonkeyPatch) -> None:
    seen: list[list[str]] = []
    monkeypatch.setattr(cli, "ensure_buckets", lambda codes: seen.append(list(codes)) or [])
    monkeypatch.setenv("STORAGE_ORG_CODES", "inst-a,inst-b")
    cli.get_settings.cache_clear()
    try:
        assert cli.main(["storage-init"]) == 0
    finally:
        cli.get_settings.cache_clear()
    assert seen == [["inst-a", "inst-b"]]
```

- [ ] **Step 2: Run to verify they fail**

Run: `uv run pytest apps/api/platform/tests/test_seed.py apps/api/platform/tests/test_cli.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'api.platform.seed'`

- [ ] **Step 3: Implement**

`apps/api/platform/seed.py`:
```python
"""Seed orchestrator (10_SEED_DATA.md §1). Each module's seed() must be idempotent (fixed UUIDs)."""

from collections.abc import Sequence

from api.platform.db import session_scope
from api.platform.modules import ModuleSpec


def run_seed(modules: Sequence[ModuleSpec], *, url: str | None = None) -> list[str]:
    seeded: list[str] = []
    for spec in modules:
        if spec.seed is None:
            continue
        with session_scope(url) as session:
            spec.seed(session)
        seeded.append(spec.name)
    return seeded
```

`apps/api/platform/cli.py`:
```python
"""Platform CLI. Run: python -m api.platform.cli <command>"""

import argparse
import sys
from collections.abc import Sequence

from api.platform.broker import configure_broker
from api.platform.logs import configure_logging
from api.platform.migrate import PLATFORM_TARGET, MigrationTarget, migration_targets, new_revision, upgrade_all
from api.platform.modules import discover_modules
from api.platform.seed import run_seed
from api.platform.settings import get_settings
from api.platform.storage import ensure_buckets


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m api.platform.cli")
    commands = parser.add_subparsers(dest="command", required=True)
    migrate = commands.add_parser("migrate", help="upgrade platform + every module to head")
    migrate.add_argument("--sql", action="store_true", help="print SQL instead of executing (dry run)")
    revision = commands.add_parser("new-migration", help="create an empty revision for a module")
    revision.add_argument("module")
    revision.add_argument("-m", "--message", required=True)
    commands.add_parser("seed", help="load 10_SEED_DATA.md data")
    commands.add_parser("storage-init", help="create institution buckets")
    args = parser.parse_args(argv)

    settings = get_settings()
    configure_logging(settings.log_level)

    if args.command == "storage-init":
        for bucket in ensure_buckets(settings.storage_org_code_list):
            print(f"created bucket {bucket}")
        return 0

    configure_broker(settings)  # modules may define dramatiq actors at import time
    modules = discover_modules()

    if args.command == "migrate":
        for name in upgrade_all(settings.migration_database_url, modules, sql=args.sql):
            print(f"migrated {name}", file=sys.stderr if args.sql else sys.stdout)
        return 0

    if args.command == "new-migration":
        targets: dict[str, MigrationTarget] = {t.name: t for t in migration_targets(modules)}
        targets["platform"] = PLATFORM_TARGET
        target = targets.get(args.module)
        if target is None:
            print(f"unknown module {args.module!r} (needs ModuleSpec.migrations_dir)", file=sys.stderr)
            return 2
        print(new_revision(settings.migration_database_url, target, args.message))
        return 0

    for name in run_seed(modules, url=settings.database_url):
        print(f"seeded {name}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
```

- [ ] **Step 4: Run to verify they pass**

Run: `uv run pytest apps/api/platform/tests/test_seed.py apps/api/platform/tests/test_cli.py -q`
Expected: `5 passed`

- [ ] **Step 5: Commit**

```bash
git add apps/api/platform
git commit -m "feat(platform): seed orchestrator and platform CLI

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 14: Contract test harness

**Files:**
- Create: `apps/api/platform/testing/contracts.py`, `tests/contract/test_contract_files.py`, `tests/contract/test_harness.py`

**Interfaces:**
- Consumes: `Settings.contracts_dir`, `validate_envelope`
- Produces (for every module agent's tests): `assert_matches_response(operation_id: str, status_code: int, body: Any) -> None`, `assert_valid_event(envelope: dict[str, Any]) -> None`, `operation(operation_id: str) -> tuple[str, str]` (path, method)

- [ ] **Step 1: Write the failing tests**

`tests/contract/test_harness.py`:
```python
import uuid

import pytest

from api.platform.testing.contracts import assert_matches_response, assert_valid_event, operation

PROJECT = {
    "project_id": "0192f0c0-0000-7000-8000-000000000001",
    "name": "Battery study",
    "status": "ACTIVE",
    "visibility": "PRIVATE",
    "lead_organization_id": "0192f0c0-0000-7000-8000-00000000000a",
    "description": "d",
    "organizations": [],
    "created_at": "2026-09-30T00:00:00Z",
}


def test_operation_lookup() -> None:
    assert operation("getProject") == ("/projects/{project_id}", "get")


def test_valid_body_passes() -> None:
    assert_matches_response("getProject", 200, PROJECT)


def test_contract_violation_fails_with_readable_message() -> None:
    with pytest.raises(AssertionError, match="DELETED"):
        assert_matches_response("getProject", 200, {**PROJECT, "status": "DELETED"})


def test_error_envelope_is_checked_through_shared_response_refs() -> None:
    body = {"error": {"code": "NOT_FOUND", "message": "x", "trace_id": "0" * 32}}
    assert_matches_response("getProject", 404, body)
    with pytest.raises(AssertionError):
        assert_matches_response("getProject", 404, {"error": {"code": "NOT_FOUND"}})


def test_undeclared_status_and_unknown_operation_fail() -> None:
    with pytest.raises(AssertionError, match="no 418 response"):
        assert_matches_response("getProject", 418, {})
    with pytest.raises(AssertionError, match="unknown operationId"):
        assert_matches_response("launchRocket", 200, {})


def test_no_content_responses() -> None:
    assert_matches_response("removeProjectMember", 204, None)


def test_event_validation() -> None:
    event = {
        "event_id": str(uuid.uuid4()), "event_type": "project.archived.v1", "occurred_at": "2026-09-30T00:00:00Z",
        "producer": "project", "correlation_id": str(uuid.uuid4()),
        "actor": {"type": "SYSTEM", "user_id": None, "organization_id": None},
        "payload": {"project_id": str(uuid.uuid4())},
    }
    assert_valid_event(event)
    with pytest.raises(AssertionError):
        assert_valid_event({**event, "producer": "catalog"})
```

`tests/contract/test_contract_files.py`:
```python
import json
from collections import Counter
from pathlib import PurePosixPath

import yaml
from jsonschema import Draft202012Validator
from openapi_spec_validator import validate

from api.platform.settings import Settings

CONTRACTS = Settings().contracts_dir


def load_openapi() -> dict:  # type: ignore[type-arg]
    return yaml.safe_load((CONTRACTS / "openapi.yaml").read_text(encoding="utf-8"))


def test_openapi_is_valid() -> None:
    validate(load_openapi())


def test_operation_ids_are_unique() -> None:
    ids = [op["operationId"] for item in load_openapi()["paths"].values() for op in item.values() if isinstance(op, dict) and "operationId" in op]
    assert [i for i, n in Counter(ids).items() if n > 1] == []


def test_event_schema_is_valid_and_matches_the_index() -> None:
    schema = json.loads((CONTRACTS / "events" / "p0_events.schema.json").read_text())
    Draft202012Validator.check_schema(schema)
    index = {e["event_type"] for e in json.loads((CONTRACTS / "events" / "index.json").read_text())["events"]}
    variants = {v["properties"]["event_type"]["const"] for v in schema["oneOf"]}
    assert index == variants


def test_error_codes_are_unique_and_use_known_statuses() -> None:
    codes = json.loads((CONTRACTS / "error_codes.json").read_text())["codes"]
    assert len({c["code"] for c in codes}) == len(codes)
    assert {c["http"] for c in codes} <= {401, 403, 404, 409, 422, 429, 500, 503}


def test_module_ownership_paths_do_not_overlap() -> None:
    ownership = json.loads((CONTRACTS / "module_ownership.json").read_text())
    owned = [(module, PurePosixPath(p)) for module, spec in ownership.items() if isinstance(spec, dict) for p in spec.get("path", [])]
    clashes = [
        (a, str(pa), b, str(pb))
        for i, (a, pa) in enumerate(owned)
        for b, pb in owned[i + 1:]
        if a != b and (pa == pb or pa in pb.parents or pb in pa.parents)
    ]
    assert clashes == []
```

- [ ] **Step 2: Run to verify they fail**

Run: `uv run pytest tests/contract -q`
Expected: `test_harness.py` FAILS — `ModuleNotFoundError: No module named 'api.platform.testing.contracts'`; `test_contract_files.py` passes (5)

- [ ] **Step 3: Implement**

`apps/api/platform/testing/contracts.py`:
```python
"""Contract assertions for module tests: responses vs openapi.yaml, events vs p0_events.schema.json."""

from functools import lru_cache
from typing import Any

import yaml
from jsonschema import Draft202012Validator

from api.platform.events import EventSchemaError, validate_envelope
from api.platform.settings import get_settings

_METHODS = ("get", "post", "put", "patch", "delete")


@lru_cache(maxsize=1)
def _spec() -> dict[str, Any]:
    spec: dict[str, Any] = yaml.safe_load((get_settings().contracts_dir / "openapi.yaml").read_text(encoding="utf-8"))
    return spec


def _escape(part: str) -> str:
    return part.replace("~", "~0").replace("/", "~1")


def _pointer(*parts: str) -> str:
    return "#/" + "/".join(_escape(p) for p in parts)


def operation(operation_id: str) -> tuple[str, str]:
    for path, item in _spec()["paths"].items():
        for method in _METHODS:
            if item.get(method, {}).get("operationId") == operation_id:
                return path, method
    raise AssertionError(f"unknown operationId {operation_id!r}")


def assert_matches_response(operation_id: str, status_code: int, body: Any) -> None:
    path, method = operation(operation_id)
    responses = _spec()["paths"][path][method]["responses"]
    response = responses.get(str(status_code))
    if response is None:
        raise AssertionError(f"{operation_id} declares no {status_code} response in openapi.yaml")
    base: tuple[str, ...] = ("paths", path, method, "responses", str(status_code))
    if "$ref" in response:
        ref_parts = response["$ref"].removeprefix("#/").split("/")
        base = tuple(ref_parts)
        response = _spec()
        for part in ref_parts:
            response = response[part]
    if "content" not in response:
        if body not in (None, b"", ""):
            raise AssertionError(f"{operation_id} {status_code} declares no body but got {body!r}")
        return
    root = {**_spec(), "$ref": _pointer(*base, "content", "application/json", "schema")}
    errors = sorted(Draft202012Validator(root).iter_errors(body), key=lambda e: list(e.absolute_path))
    if errors:
        details = "\n".join(f"  {'/'.join(map(str, e.absolute_path)) or '(root)'}: {e.message}" for e in errors)
        raise AssertionError(f"{operation_id} {status_code} response violates openapi.yaml:\n{details}")


def assert_valid_event(envelope: dict[str, Any]) -> None:
    try:
        validate_envelope(envelope)
    except EventSchemaError as exc:
        raise AssertionError(str(exc)) from exc
```

- [ ] **Step 4: Run to verify they pass**

Run: `uv run pytest tests/contract -q`
Expected: `12 passed`

- [ ] **Step 5: Commit**

```bash
git add apps/api/platform/testing tests/contract
git commit -m "test(contract): response/event contract harness and contract file checks

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 15: Container stack, gateway, task runner

**Files:**
- Create: `apps/api/Dockerfile`, `.dockerignore`, `docker-compose.yml`, `docker-compose.prod.yml`, `infra/nginx/nais.conf`, `infra/docker/storage/start-storage.sh`, `.env.example`, `scripts/nais`, `Makefile`

**Interfaces:**
- Consumes: `api.main:app`, `api.worker`, `api.platform.cli`
- Produces: compose services `gateway, api, worker, postgres, redis, opensearch, keycloak, opa, storage-a, storage-b, mailpit`; `scripts/nais {up|down|logs|migrate|seed|storage-init|test|lint|typecheck|contracts|contracts-check|contract-test|gate-a}`

- [ ] **Step 1: Write the image and stack files**

`apps/api/Dockerfile`:
```dockerfile
FROM python:3.13-slim
COPY --from=ghcr.io/astral-sh/uv:0.11.19 /uv /usr/local/bin/uv
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    UV_PROJECT_ENVIRONMENT=/opt/venv \
    PATH=/opt/venv/bin:$PATH \
    PYTHONPATH=/app/apps:/app/packages/contracts/python
WORKDIR /app
COPY pyproject.toml uv.lock .python-version ./
RUN uv sync --frozen --no-dev --no-install-project
COPY NAIS_PRD/contracts NAIS_PRD/contracts
COPY packages/contracts/python packages/contracts/python
COPY infra/docker/postgres/init.sql infra/docker/postgres/init.sql
COPY apps/api apps/api
EXPOSE 8000
CMD ["uvicorn", "api.main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", "--forwarded-allow-ips", "*"]
```

`.dockerignore`:
```text
.git
.venv
**/__pycache__
**/node_modules
apps/web
docs
NAIS_PRD/*.md
NAIS_PRD/modules
NAIS_PRD_COMBINED.md
.env
```

`infra/docker/storage/start-storage.sh`:
```sh
#!/bin/sh
# SeaweedFS single-node S3 for one institution (D-034). Credentials come from the environment.
set -eu
: "${S3_ACCESS_KEY:?S3_ACCESS_KEY is required}"
: "${S3_SECRET_KEY:?S3_SECRET_KEY is required}"
cat > /tmp/s3.json <<EOF
{"identities":[{"name":"nais","credentials":[{"accessKey":"${S3_ACCESS_KEY}","secretKey":"${S3_SECRET_KEY}"}],"actions":["Admin","Read","Write","List","Tagging"]}]}
EOF
exec weed server -dir=/data -s3 -s3.port=8333 -s3.config=/tmp/s3.json -master.volumeSizeLimitMB=1024
```

`infra/nginx/nais.conf`:
```nginx
map $http_upgrade $connection_upgrade {
  default upgrade;
  ''      close;
}

server {
  listen 21051;

  # Docker DNS + variable upstreams: gateway starts even if web/keycloak are not deployed yet.
  resolver 127.0.0.11 valid=10s ipv6=off;
  set $api_upstream      http://api:8000;
  set $web_upstream      http://web:3000;
  set $keycloak_upstream http://keycloak:8080;
  set $storage_a         http://storage-a:8333;
  set $storage_b         http://storage-b:8333;

  location = /healthz {
    default_type text/plain;
    return 200 "ok\n";
  }

  location /api/ {
    client_max_body_size 10m;
    proxy_pass $api_upstream;
    proxy_set_header Host              $http_host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-Host  $http_host;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Request-Id      $request_id;
  }

  location /auth/ {
    proxy_pass $keycloak_upstream;
    proxy_set_header Host              $http_host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-Host  $http_host;
    proxy_set_header X-Forwarded-Port  $server_port;
    proxy_buffer_size 128k;
    proxy_buffers 4 256k;
  }

  # Regex, not "location /nais-inst-a/": the prefix form 301-redirects "/nais-inst-a" and S3 clients loop.
  location ~ ^/nais-inst-a(/|$) {
    client_max_body_size 0;
    proxy_request_buffering off;
    proxy_buffering off;
    proxy_pass $storage_a;
    proxy_set_header Host $http_host;
  }

  location ~ ^/nais-inst-b(/|$) {
    client_max_body_size 0;
    proxy_request_buffering off;
    proxy_buffering off;
    proxy_pass $storage_b;
    proxy_set_header Host $http_host;
  }

  location / {
    proxy_pass $web_upstream;
    proxy_http_version 1.1;
    proxy_set_header Host       $http_host;
    proxy_set_header Upgrade    $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
    proxy_intercept_errors on;
    error_page 502 504 = @web_unavailable;
  }

  location @web_unavailable {
    default_type text/plain;
    return 503 "NAIS web portal is not deployed yet.\n";
  }
}
```

`.env.example`:
```dotenv
NAIS_PUBLIC_BASE_URL=http://localhost:21051
NAIS_GATEWAY_PORT=21051

# API / worker (runtime role; migrations use MIGRATION_DATABASE_URL, D-027)
DATABASE_URL=postgresql+psycopg://nais_app:nais_app@postgres:5432/nais
MIGRATION_DATABASE_URL=postgresql+psycopg://nais_migrator:nais_migrator@postgres:5432/nais
POSTGRES_SUPERUSER_PASSWORD=postgres
REDIS_URL=redis://redis:6379/0
OPENSEARCH_URL=http://opensearch:9200
OPA_URL=http://opa:8181
OPA_TIMEOUT_MS=500
OIDC_ISSUER=http://localhost:21051/auth/realms/nais
OIDC_INTERNAL_JWKS_URL=http://keycloak:8080/auth/realms/nais/protocol/openid-connect/certs
OIDC_AUDIENCE=nais-api
SMTP_HOST=mailpit
SMTP_PORT=1025
LOG_LEVEL=INFO
KEYCLOAK_ADMIN_PASSWORD=admin

# Storage: org code -> STORAGE_<CODE>_* (D-024). Dev storage is SeaweedFS (D-034).
STORAGE_ORG_CODES=nais,inst-a,inst-b
STORAGE_INST_A_ENDPOINT=http://storage-a:8333
STORAGE_INST_A_BUCKET=nais-inst-a
STORAGE_INST_A_ACCESS_KEY=nais-inst-a
STORAGE_INST_A_SECRET_KEY=change-me-a
STORAGE_INST_B_ENDPOINT=http://storage-b:8333
STORAGE_INST_B_BUCKET=nais-inst-b
STORAGE_INST_B_ACCESS_KEY=nais-inst-b
STORAGE_INST_B_SECRET_KEY=change-me-b
STORAGE_NAIS_ENDPOINT=http://storage-a:8333
STORAGE_NAIS_BUCKET=nais-platform
STORAGE_NAIS_ACCESS_KEY=nais-inst-a
STORAGE_NAIS_SECRET_KEY=change-me-a
STORAGE_PRESIGN_TTL_SECONDS=300
STORAGE_MULTIPART_THRESHOLD_BYTES=67108864

# Web (Agent 7, D-026)
AUTH_URL=http://localhost:21051/web-auth
AUTH_SECRET=change-me-32-bytes
AUTH_KEYCLOAK_ISSUER=http://localhost:21051/auth/realms/nais
AUTH_KEYCLOAK_INTERNAL_URL=http://keycloak:8080/auth/realms/nais
AUTH_KEYCLOAK_ID=nais-web
NEXT_PUBLIC_API_BASE=/api/v1
API_INTERNAL_BASE=http://api:8000/api/v1
NEXT_PUBLIC_API_MOCKING=disabled
```

`docker-compose.yml`:
```yaml
name: nais

x-api-image: &api-image
  build:
    context: .
    dockerfile: apps/api/Dockerfile
  image: nais/api:dev
  env_file: .env
  restart: unless-stopped
  depends_on:
    postgres: { condition: service_healthy }
    redis: { condition: service_healthy }

services:
  gateway:
    image: nginx:1.27-alpine
    ports: ["${NAIS_GATEWAY_PORT:-21051}:21051"]
    volumes: ["./infra/nginx/nais.conf:/etc/nginx/conf.d/default.conf:ro"]
    depends_on: [api]
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://127.0.0.1:21051/healthz"]
      interval: 10s
      timeout: 3s
      retries: 5

  api:
    <<: *api-image
    healthcheck:
      test: ["CMD", "python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/api/v1/health/live', timeout=2)"]
      interval: 10s
      timeout: 3s
      retries: 5

  worker:
    <<: *api-image
    command: ["python", "-m", "api.worker"]

  postgres:
    image: postgres:16
    environment:
      POSTGRES_DB: nais
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: ${POSTGRES_SUPERUSER_PASSWORD:-postgres}
    volumes:
      - pgdata:/var/lib/postgresql/data
      - ./infra/docker/postgres/init.sql:/docker-entrypoint-initdb.d/10-init.sql:ro
    ports: ["127.0.0.1:21055:5432"]
    restart: unless-stopped
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres -d nais"]
      interval: 5s
      timeout: 3s
      retries: 20

  redis:
    image: redis:7-alpine
    ports: ["127.0.0.1:21058:6379"]
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 3s
      retries: 20

  opensearch:
    image: opensearchproject/opensearch:2.19.1
    environment:
      discovery.type: single-node
      DISABLE_SECURITY_PLUGIN: "true"
      DISABLE_INSTALL_DEMO_CONFIG: "true"
      OPENSEARCH_JAVA_OPTS: "-Xms512m -Xmx512m"
    volumes: ["osdata:/usr/share/opensearch/data"]
    ports: ["127.0.0.1:21056:9200"]
    restart: unless-stopped
    healthcheck:
      test: ["CMD-SHELL", "curl -fs http://127.0.0.1:9200/_cluster/health || exit 1"]
      interval: 10s
      timeout: 5s
      retries: 30

  keycloak:
    image: quay.io/keycloak/keycloak:26.0
    command: ["start-dev", "--import-realm"]
    environment:
      KC_HTTP_RELATIVE_PATH: /auth
      KC_HOSTNAME: http://localhost:21051/auth
      KC_HOSTNAME_BACKCHANNEL_DYNAMIC: "true"
      KC_PROXY_HEADERS: xforwarded
      KC_HTTP_ENABLED: "true"
      KC_HEALTH_ENABLED: "true"
      KC_BOOTSTRAP_ADMIN_USERNAME: admin
      KC_BOOTSTRAP_ADMIN_PASSWORD: ${KEYCLOAK_ADMIN_PASSWORD:-admin}
    volumes: ["./infra/keycloak/import:/opt/keycloak/data/import:ro"]
    restart: unless-stopped

  opa:
    image: openpolicyagent/opa:1.4.2
    command: ["run", "--server", "--addr=0.0.0.0:8181", "/policies"]
    volumes: ["./infra/opa/policies:/policies:ro"]
    ports: ["127.0.0.1:21057:8181"]
    restart: unless-stopped

  storage-a:
    image: chrislusf/seaweedfs:4.48
    entrypoint: ["/bin/sh", "/start-storage.sh"]
    environment:
      S3_ACCESS_KEY: ${STORAGE_INST_A_ACCESS_KEY}
      S3_SECRET_KEY: ${STORAGE_INST_A_SECRET_KEY}
    volumes:
      - storage-a:/data
      - ./infra/docker/storage/start-storage.sh:/start-storage.sh:ro
    ports: ["127.0.0.1:21053:8333"]
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://127.0.0.1:8333/healthz"]
      interval: 10s
      timeout: 3s
      retries: 10

  storage-b:
    image: chrislusf/seaweedfs:4.48
    entrypoint: ["/bin/sh", "/start-storage.sh"]
    environment:
      S3_ACCESS_KEY: ${STORAGE_INST_B_ACCESS_KEY}
      S3_SECRET_KEY: ${STORAGE_INST_B_SECRET_KEY}
    volumes:
      - storage-b:/data
      - ./infra/docker/storage/start-storage.sh:/start-storage.sh:ro
    ports: ["127.0.0.1:21054:8333"]
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://127.0.0.1:8333/healthz"]
      interval: 10s
      timeout: 3s
      retries: 10

  mailpit:
    image: axllent/mailpit:v1.21
    ports: ["127.0.0.1:21052:8025"]
    restart: unless-stopped

volumes:
  pgdata:
  osdata:
  storage-a:
  storage-b:
```

`docker-compose.prod.yml` (use as `docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d`):
```yaml
# Production override: only the gateway publishes a port (D-002). Dev tool ports are removed.
services:
  postgres:
    ports: !reset []
  redis:
    ports: !reset []
  opensearch:
    ports: !reset []
  opa:
    ports: !reset []
  storage-a:
    ports: !reset []
  storage-b:
    ports: !reset []
  mailpit:
    ports: !reset []
  keycloak:
    command: ["start", "--import-realm"]
```

`scripts/nais`:
```bash
#!/usr/bin/env bash
# NAIS task runner (D-033). Usage: scripts/nais <command> [args]
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

ensure_env() {
  if [[ ! -f .env ]]; then
    cp .env.example .env
    echo "created .env from .env.example"
  fi
}

cli() { docker compose run --rm --no-deps api python -m api.platform.cli "$@"; }

cmd="${1:-help}"
shift || true
case "$cmd" in
  up)              ensure_env; docker compose up -d --build "$@" ;;
  down)            docker compose down "$@" ;;
  logs)            docker compose logs -f "$@" ;;
  migrate)         ensure_env; cli migrate "$@" ;;
  seed)            ensure_env; cli seed ;;
  storage-init)    ensure_env; cli storage-init ;;
  test)            uv run pytest "$@" ;;
  lint)            uv run ruff check . && uv run ruff format --check . ;;
  typecheck)       uv run mypy ;;
  contracts)       uv run python packages/contracts/generate.py "$@" ;;
  contracts-check) uv run python packages/contracts/generate.py --check ;;
  contract-test)   uv run pytest tests/contract "$@" ;;
  gate-a)          scripts/gate_a.sh ;;
  help)            echo "usage: scripts/nais {up|down|logs|migrate|seed|storage-init|test|lint|typecheck|contracts|contracts-check|contract-test|gate-a}" ;;
  *)               echo "unknown command: $cmd" >&2; exit 2 ;;
esac
```

`Makefile` (recipe lines start with a TAB):
```make
# Thin wrapper; scripts/nais is the source of truth (D-033).
.PHONY: up down logs migrate seed storage-init test lint typecheck contracts contracts-check contract-test gate-a
up down logs migrate seed storage-init test lint typecheck contracts contracts-check contract-test gate-a:
	@./scripts/nais $@
```

Make scripts executable and keep Keycloak/OPA mount sources present without touching their owners' files:

```bash
chmod +x scripts/nais infra/docker/storage/start-storage.sh
```

(Compose creates `infra/keycloak/import` and `infra/opa/policies` as empty bind sources if missing; Agents 1 and 4 fill them.)

- [ ] **Step 2: Validate compose, nginx and the image**

Run: `cp -n .env.example .env; docker compose config -q && echo compose-ok`
Expected: `compose-ok`

Run: `docker compose -f docker-compose.yml -f docker-compose.prod.yml config -q && echo prod-ok`
Expected: `prod-ok`

Run: `docker run --rm -v "$PWD/infra/nginx/nais.conf:/etc/nginx/conf.d/default.conf:ro" nginx:1.27-alpine nginx -t`
Expected: `nginx: configuration file /etc/nginx/nginx.conf test is successful`

Run: `docker compose build api`
Expected: `Built` / `naming to docker.io/nais/api:dev`

- [ ] **Step 3: Commit**

```bash
git add apps/api/Dockerfile .dockerignore docker-compose.yml docker-compose.prod.yml infra .env.example scripts/nais Makefile
git commit -m "build: compose stack behind the 21051 gateway, SeaweedFS storage, task runner

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 16: Gate A verification (boot + storage through the gateway)

**Files:**
- Create: `scripts/gate_a.sh`, `scripts/storage_smoke.py`

**Interfaces:**
- Consumes: the compose stack, `api.platform.storage.load_storage_config`, `public_client`
- Produces: `scripts/nais gate-a` → prints `GATE A PASS` or exits non-zero with the failing check

- [ ] **Step 1: Write the smoke script and gate script**

`scripts/storage_smoke.py`:
```python
"""Gate A storage smoke: presigned PUT/GET for each institute bucket through the :21051 gateway."""

import os

import httpx

from api.platform.storage import load_storage_config, public_client

BASE = os.environ.get("NAIS_PUBLIC_BASE_URL", "http://localhost:21051")


def expect(condition: bool, message: str) -> None:
    if not condition:
        raise SystemExit(f"STORAGE SMOKE FAIL: {message}")


def check(org_code: str) -> None:
    cfg = load_storage_config(org_code)
    client = public_client(cfg, BASE)
    key = f"_smoke/{org_code}.txt"
    body = f"nais gate-a {org_code}".encode()
    put_url = client.generate_presigned_url("put_object", Params={"Bucket": cfg.bucket, "Key": key}, ExpiresIn=60)
    put = httpx.put(put_url, content=body, timeout=10)
    expect(put.status_code == 200, f"{org_code} presigned PUT returned {put.status_code}: {put.text[:200]}")
    get_url = client.generate_presigned_url("get_object", Params={"Bucket": cfg.bucket, "Key": key}, ExpiresIn=60)
    got = httpx.get(get_url, timeout=10)
    expect(got.status_code == 200 and got.content == body, f"{org_code} presigned GET returned {got.status_code}")
    tampered = httpx.get(get_url.replace(f"{org_code}.txt", f"{org_code}-x.txt"), timeout=10)
    expect(tampered.status_code == 403, f"{org_code} tampered URL returned {tampered.status_code}, expected 403")
    anonymous = httpx.get(f"{BASE}/{cfg.bucket}/{key}", timeout=10)
    expect(anonymous.status_code == 403, f"{org_code} anonymous GET returned {anonymous.status_code}, expected 403")
    print(f"ok  storage {org_code} ({cfg.bucket})")


if __name__ == "__main__":
    for code in ("inst-a", "inst-b"):
        check(code)
```

`scripts/gate_a.sh`:
```bash
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

echo "GATE A PASS"
```

Run: `chmod +x scripts/gate_a.sh`

- [ ] **Step 2: Run Gate A**

Run: `scripts/nais gate-a`
Expected (timings vary; each ≤ 120 s):
```text
ok  http://localhost:21051/healthz (…s)
ok  http://localhost:21051/api/v1/health/live (…s)
ok  http://localhost:21051/api/v1/health/ready (…s)
migrated platform
created bucket nais-platform
created bucket nais-inst-a
created bucket nais-inst-b
ok  storage inst-a (nais-inst-a)
ok  storage inst-b (nais-inst-b)
GATE A PASS
```
If `/health/ready` times out, run `curl -s localhost:21051/api/v1/health/ready` — the `checks` map names the dependency that is down.

- [ ] **Step 3: Check the gateway contract by hand**

Run: `curl -si localhost:21051/ | head -1; curl -s localhost:21051/api/v1/nope; echo; curl -si localhost:21051/api/v1/health/live | grep -i x-request-id`
Expected: `HTTP/1.1 503` (web not deployed), a `NOT_FOUND` error envelope with a 32-hex `trace_id`, and an `X-Request-Id` header holding a UUID.

Run: `ss -ltn | grep -E ':2105[0-9]'`
Expected: `0.0.0.0:21051` (and the unrelated pre-existing `:21050`); every other `2105x` listener is bound to `127.0.0.1`.

- [ ] **Step 4: Commit**

```bash
git add scripts/gate_a.sh scripts/storage_smoke.py
git commit -m "test(gate-a): boot + presigned storage smoke through the 21051 gateway

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 17: CI, developer README, ADRs, whole-suite check

**Files:**
- Create: `.github/workflows/ci.yml`, `README.md`, `docs/adr/0001-record-architecture-decisions.md`, `docs/adr/0002-seaweedfs-dev-storage.md`, `docs/adr/CONTRACT_CHANGE_REQUEST.template.md`

- [ ] **Step 1: Write CI**

`.github/workflows/ci.yml`:
```yaml
name: ci
on:
  push:
  pull_request:

jobs:
  python:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: astral-sh/setup-uv@v6
        with:
          version: "0.11.19"
      - run: uv sync --frozen
      - name: lint
        run: uv run ruff check . && uv run ruff format --check .
      - name: typecheck
        run: uv run mypy
      - name: unit + contract tests (testcontainers postgres)
        run: uv run pytest -q
      - name: migration dry-run
        env:
          PYTHONPATH: apps
          MIGRATION_DATABASE_URL: postgresql+psycopg://ci:ci@localhost/nais
        run: uv run python -m api.platform.cli migrate --sql > /dev/null

  contracts:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: astral-sh/setup-uv@v6
        with:
          version: "0.11.19"
      - uses: actions/setup-node@v4
        with:
          node-version: "22"
      - run: uv sync --frozen
      - run: uv run python packages/contracts/generate.py --check

  gate-a:
    needs: [python, contracts]
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: astral-sh/setup-uv@v6
        with:
          version: "0.11.19"
      - run: uv sync --frozen
      - run: scripts/gate_a.sh
      - if: always()
        run: docker compose logs --no-color | tail -300
      - if: always()
        run: docker compose down -v
```

- [ ] **Step 2: Write README and ADRs**

`README.md`:
````markdown
# NAIS AI-OS / Research Commons

Product and contracts: [`NAIS_PRD/README.md`](NAIS_PRD/README.md). Service port: **21051**.

## Prerequisites
Docker (Compose v2), [uv](https://docs.astral.sh/uv/) 0.11+, Node 22 (only for `scripts/nais contracts`).

## Run it
```bash
scripts/nais up            # creates .env from .env.example on first run
scripts/nais migrate
scripts/nais storage-init
open http://localhost:21051/api/v1/docs
scripts/nais gate-a        # boot + readiness + storage smoke
```

## Develop
```bash
uv sync
scripts/nais test          # pytest (postgres via testcontainers)
scripts/nais lint && scripts/nais typecheck
scripts/nais contracts     # regenerate code after NAIS_PRD/contracts changes
```

## Adding a module (Wave 1 agents)
Create `apps/api/modules/<name>/__init__.py` exporting `MODULE = ModuleSpec(...)` (see `api.platform.modules`):
`router` is mounted under `/api/v1`; `migrations_dir` + `db_schema` are migrated by `scripts/nais migrate`
(new revision: `docker compose run --rm api python -m api.platform.cli new-migration <name> -m "..."`);
`wire()` provides your ports via `api.platform.ports.provide`; `register_worker(broker, scheduler)` adds periodic jobs;
`seed(session)` loads `10_SEED_DATA.md` rows. Publish events with `api.platform.outbox.outbox.write(...)` in the same
session as your change; consume with `@api.platform.event_bus.subscribe(...)` + `claim_event(session, "<schema>", event)`.
Test helpers: `api.platform.testing.app.create_test_app`, fixtures `migrated_db`, `api.platform.testing.tokens.FakeIssuer`,
`api.platform.testing.contracts.assert_matches_response` / `assert_valid_event`.
````

`docs/adr/0001-record-architecture-decisions.md`:
```markdown
# ADR 0001 — Record architecture decisions

Status: accepted (2026-09-30)

Decisions are recorded as rows in `NAIS_PRD/11_DECISION_LOG.md` (D-001…). A decision that needs more than a table row
gets an ADR file here, referenced from its D-number. Contract changes follow `CONTRACT_CHANGE_REQUEST.template.md`.
```

`docs/adr/0002-seaweedfs-dev-storage.md`:
```markdown
# ADR 0002 — SeaweedFS replaces MinIO for local/dev storage (D-034)

Status: accepted (2026-09-30)

## Context
The PRD specified MinIO for local/dev institution storage. On 2026-09-30 neither `minio/minio` (Docker Hub) nor
`quay.io/minio/minio` could be resolved, so the dev stack cannot depend on MinIO images.

## Decision
Run one SeaweedFS 4.48 (`chrislusf/seaweedfs:4.48`) S3 server per institution (`storage-a`, `storage-b`, port 8333).
Application code uses only the S3 API (boto3, SigV4, path-style), so production keeps any S3-compatible store.

## Verification
Through an Nginx gateway preserving `Host`: presigned PUT/GET, multipart upload via presigned part URLs, tampered URL → 403,
anonymous GET → 403. The Nginx bucket location must be a regex (`^/nais-inst-a(/|$)`); a trailing-slash prefix location
301-redirects `/nais-inst-a` and sends boto3 into a redirect loop.

## Consequences
No web console in dev (ports 21053/21054 expose the S3 endpoints instead). Credentials are generated into the container
from env at start (`infra/docker/storage/start-storage.sh`).
```

`docs/adr/CONTRACT_CHANGE_REQUEST.template.md`:
```markdown
# Contract Change Request

Copy to `CONTRACT_CHANGE_REQUEST.md` at the repo root, fill in, and stop until Agent 0 merges the contract change.

- Requesting agent / module:
- Contract file(s): openapi.yaml | events/p0_events.schema.json | error_codes.json | module_ownership.json
- Change (exact endpoint / schema / event / code, before → after):
- Why the current contract cannot express it:
- Consumers affected (modules, web):
- Backwards compatible? (yes / no — if no, new event version `.v2` or new endpoint)
```

- [ ] **Step 3: Run the whole local suite**

Run: `uv run ruff format . && uv run ruff check --fix . && uv run mypy && uv run pytest -q && uv run python packages/contracts/generate.py --check`
Expected: ruff `All checks passed!`, mypy `Success: no issues found`, pytest all passed (≈ 100 tests, 0 skipped), `generated files are up to date`. Fix any remaining mypy findings in the files this plan created, re-run, then `git add -u` so formatting changes are included in this task's commit.

- [ ] **Step 4: Regenerate the combined PRD and commit**

The PRD docs changed in Task 1. Regenerate `NAIS_PRD_COMBINED.md` with the same concatenation used for v1.1 (README, numbered docs, modules, each under a `# FILE: <path>` heading):

```bash
python3 - <<'EOF'
import os
root = "NAIS_PRD"
files = ["README.md"] + sorted(f for f in os.listdir(root) if f[:2].isdigit() and f.endswith(".md")) \
    + ["modules/" + f for f in sorted(os.listdir(root + "/modules"))]
out = ["# NAIS AI-OS / Research Commons — Consolidated PRD (v1.1)\n",
       "\n> 생성물: `NAIS_PRD/`의 마크다운을 합친 파일. 직접 수정하지 말 것. 기계 계약(`contracts/*.yaml|json`)은 포함하지 않는다.\n"]
for f in files:
    out.append(f"\n\n---\n\n# FILE: {f}\n\n")
    out.append(open(os.path.join(root, f), encoding="utf-8").read().rstrip() + "\n")
open("NAIS_PRD_COMBINED.md", "w", encoding="utf-8").write("".join(out))
print(len(files), "files combined")
EOF
git add -u
git add .github README.md docs/adr NAIS_PRD_COMBINED.md
git commit -m "ci: lint, typecheck, tests, contract drift and Gate A; developer docs and ADRs

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
Expected: `25 files combined`, commit created.

---

## Self-Review Notes

- **Spec coverage (06 Agent 0 deliverables):** monorepo skeleton (T1, T3), compose + prod override + 21051-only (T15), nginx (T15), app factory + health live/ready (T4, T11), error envelope from error_codes.json (T3), pagination (T5), CurrentUser dependency with injected resolver (T9), DB session/unit of work + `platform.outbox_events` + OutboxWriter (T6, T7), relay + handler registry (T7, T8), OTel + structured logging + X-Request-Id (T2, T4), seed orchestrator (T13), worker (T12), multi-location Alembic with per-schema version tables (T6), contracts TS/Python generation (T3), contract test harness (T14), task runner (T15), CI gate (T17), postgres roles (T6), storage config loader (T10), Gate A (T16).
- **Deferred to other agents by ownership:** Keycloak realm (Agent 1, `infra/keycloak`), OPA policies (Agent 4, `infra/opa`), OpenSearch index templates (Agent 3), web service in compose (Agent 7 adds the `web` service; the gateway already routes `/` to `web:3000`).
- **Type consistency:** `ModuleSpec` fields used by `create_app`, `build_worker`, `migration_targets`, `run_seed`, CLI are the ones defined in T4. `EventActor.system()/for_user()`, `OutboxWriter.write(session, event_type, payload, actor, correlation_id=None)` match M01 §3's `OutboxWriter` protocol.
````
