# M00 Wave 1 Kickoff (Agent 0) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Apply the controller's shared Wave 1 decisions (W1-D1…W1-D4) once, before any module work starts, so every module plan can rely on them.

**Architecture:** Agent 0 owns the shared files: the decision log and README (D-038 port location), `infra/docker/postgres/init.sql` (pg_trgm, applied once to the running stack too), `NAIS_PRD/contracts/openapi.yaml` (1.1.1 → 1.2.0 via a committed, idempotent text-edit script, then regenerated code), `pyproject.toml` mypy scope and `.env.example` module keys. Each change is pinned by a platform test.

**Tech Stack:** Python 3.13, uv, pytest + testcontainers (postgres:16), PyYAML, datamodel-code-generator + openapi-typescript (via `packages/contracts/generate.py`), mypy, docker compose (running stack, ports 21051–21058).

**Spec:** `docs/superpowers/plans/wave1-controller-decisions.md` (W1-D1…W1-D6, binding) and `docs/superpowers/plans/wave1-integration-notes.md`.

**Execution order (W1):** **M00 kickoff (this plan)** → M01 → M02 → M03 → M05 → M09 → M10. No module plan starts before this plan is merged.

## Global Constraints

- Edit only: `NAIS_PRD/11_DECISION_LOG.md`, `NAIS_PRD/03_API_EVENT_CONTRACTS.md`, `README.md`, `infra/docker/postgres/init.sql`, `NAIS_PRD/contracts/openapi.yaml`, generated files written by `packages/contracts/generate.py`, `packages/contracts/package.json`, `packages/contracts/changes/openapi_1_2_0.py` (new), `pyproject.toml` (`[tool.mypy]` only), `.env.example`, new tests under `apps/api/platform/tests/`.
- pg_trgm: exactly `CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;` in init.sql (runs as superuser); module migrations never create extensions (W1-D2).
- Running stack: apply pg_trgm with `docker compose exec -T postgres psql -U nais -d nais -c "CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public"`. Never `docker compose down`, never delete volumes, do not restart services for this plan.
- openapi: every added response is `{ $ref: "#/components/responses/Error" }`; contract version `1.2.0`; regenerate with `uv run python packages/contracts/generate.py`; `uv run python packages/contracts/generate.py --check` must then pass (CI `contracts` job).
- mypy: `files` += `"apps/api/modules"`; module `tests/` and `migrations/` directories are excluded like the platform's.
- `.env.example` defaults equal the code defaults in the module plans (nothing breaks if a key is absent).
- ruff: line length 110, rules E,F,I,B,UP,SIM; run `uv run ruff check --fix` and `uv run ruff format` on touched Python files before each commit.
- Every commit message ends with the trailer line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Running stack already initialised** (init.sql only runs on an empty volume): the live `nais` database must get pg_trgm too, or M01/M02 migrations fail on `public.gin_trgm_ops` against the stack. Pinned in Task 2 Step 5 (live `psql` check).
2. **Runtime role vs. extension objects**: `nais_app` must be able to call `public.similarity()` and `nais_migrator` must be able to build a `public.gin_trgm_ops` index in its own schema without CREATE on `public`. Pinned in Task 2 (`test_app_role_can_use_trigram_functions`, `test_migrator_can_index_with_public_trgm_opclass`).
3. **Script re-run / partial apply** of the openapi edit: running the script twice must not duplicate responses or properties (duplicate YAML keys would silently collapse). Pinned in Task 3 (`test_contract_edit_script_is_idempotent`).
4. **Health endpoints accidentally gaining 401**: `healthLive`/`healthReady` have `security: []` and must stay unauthenticated in the contract. Pinned in Task 3 (`test_every_secured_operation_declares_401`).
5. **Strict consumers of `UploadSession.files[].upload`**: making it optional must not loosen the inner `oneOf` shapes (PUT/MULTIPART). Pinned in Task 3 (`test_upload_session_upload_is_optional_but_shaped`).

---

## File Structure

| Path | Responsibility |
|---|---|
| `NAIS_PRD/11_DECISION_LOG.md` | + row D-038 (port Protocols in provider `public.py`) |
| `README.md` | "Adding a module": public.py rule (D-038), pg_trgm note |
| `infra/docker/postgres/init.sql` | + `CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;` |
| `apps/api/platform/tests/test_pg_trgm.py` | pg_trgm usable by `nais_app` / `nais_migrator` in the test DB |
| `packages/contracts/changes/openapi_1_2_0.py` | Deterministic, idempotent text edit of openapi.yaml 1.1.1 → 1.2.0 (W1-D3) |
| `NAIS_PRD/contracts/openapi.yaml` | 401/404/409/422/503 responses, optional fields, version 1.2.0 |
| `NAIS_PRD/03_API_EVENT_CONTRACTS.md`, `packages/contracts/package.json` | version string 1.2.0 |
| `apps/api/platform/generated/*`, `packages/contracts/python/nais_contracts/api_models.py`, `packages/contracts/ts/openapi.d.ts` | regenerated |
| `apps/api/platform/tests/test_contract_v1_2.py` | pins every W1-D3 contract change + script idempotency |
| `pyproject.toml` | `[tool.mypy] files`/`exclude` cover `apps/api/modules` |
| `.env.example` | module env keys (W1-D4) |
| `apps/api/platform/tests/test_env_example.py` | pins the module env keys and defaults |

---

### Task 1: Record D-038 (port location) in the decision log and README

**Files:**
- Modify: `NAIS_PRD/11_DECISION_LOG.md` (table, after the D-037 row)
- Modify: `README.md` ("Adding a module (Wave 1 agents)" section)

**Interfaces:**
- Consumes: nothing.
- Produces: the written rule every module plan cites: provider Protocols + DTOs live in `apps/api/modules/<provider>/public.py`; that class object is the `api.platform.ports` key; consumer-side Protocols only for providers outside Wave 1 (M04 `GrantQueryPort` in M09, with `# TODO(Wave 2): replace with api.modules.governance.public`).

- [ ] **Step 1: Verify the rule is not recorded yet**

Run: `grep -c "D-038" NAIS_PRD/11_DECISION_LOG.md; grep -c "public.py" README.md`
Expected: `0` and `0`.

- [ ] **Step 2: Add the D-038 row**

In `NAIS_PRD/11_DECISION_LOG.md`, insert this line directly after the line starting with `| D-037 |`:

```markdown
| D-038 | 모듈 간 Port 인터페이스 위치 | 제공 모듈이 `apps/api/modules/<provider>/public.py`에 공개 Port Protocol과 DTO를 둔다(모듈 명세 §8 그대로). `public.py`는 stdlib, pydantic/dataclasses, typing, `api.platform`, 생성된 계약 패키지(`nais_contracts`)만 import하고 모듈 내부는 import하지 않는다. `public.py`의 Protocol 클래스 객체가 `api.platform.ports` 레지스트리 키다: 제공자는 `wire()`에서 `ports.provide(X, impl)`, 소비자는 `from api.modules.<provider>.public import X` 후 `ports.get(X)`. 명세 호환을 위해 `ports.py`에서 re-export 가능. Wave 1에 제공자가 없는 port(M04 `GrantQueryPort`, M09가 소비)만 소비자 `ports.py`에 정의하고 `# TODO(Wave 2): replace with api.modules.governance.public` 표시 | Wave 1 통합 결정 W1-D1. 실행 순서 M00→M01→M02→M03→M05→M09→M10이라 소비자는 실제 `public.py`를 import한다. 제공자 미연결 시 동작은 각 소비자 명세(Wave 1 seed fake + 경고, 또는 503)를 따른다 |
```

- [ ] **Step 3: Add the README note**

In `README.md`, replace the line

```markdown
`wire()` provides your ports via `api.platform.ports.provide`; `register_worker(broker, scheduler)` adds periodic jobs;
```

with

```markdown
`wire()` provides your ports via `api.platform.ports.provide`; `register_worker(broker, scheduler)` adds periodic jobs;
**public interface (D-038):** put the Port Protocols + DTOs other modules use in `apps/api/modules/<name>/public.py`
(no imports from your module internals); that class is the `ports` key — consumers do
`from api.modules.<provider>.public import XPort` and `ports.get(XPort)`, never their own copy of the Protocol;
```

and append this bullet to the end of the "### Module author checklist" list:

```markdown
- **Extensions:** `pg_trgm` is installed once in schema `public` by the platform (`init.sql`). Migrations never run
  `CREATE EXTENSION`; reference `public.gin_trgm_ops` / `public.similarity(...)`.
```

- [ ] **Step 4: Verify**

Run: `grep -c "^| D-038 |" NAIS_PRD/11_DECISION_LOG.md; grep -c "public.py" README.md; grep -c "public.gin_trgm_ops" README.md`
Expected: `1`, `1`, `1`.

- [ ] **Step 5: Commit**

```bash
git add NAIS_PRD/11_DECISION_LOG.md README.md
git commit -m "docs: D-038 cross-module port Protocols live in provider public.py" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: pg_trgm installed once by the platform (init.sql + running stack)

**Files:**
- Modify: `infra/docker/postgres/init.sql` (append)
- Test: `apps/api/platform/tests/test_pg_trgm.py`

**Interfaces:**
- Consumes: fixture `pg_urls` (`api.platform.testing.fixtures`, executes init.sql as superuser; `PgUrls(superuser, migrator, app)`).
- Produces: extension `pg_trgm` in schema `public` in every database built from init.sql and in the running stack's `nais` DB. Modules use `public.gin_trgm_ops`, `public.similarity`.

- [ ] **Step 1: Write the failing test**

`apps/api/platform/tests/test_pg_trgm.py`:

```python
"""W1-D2: pg_trgm is installed once in schema public by init.sql and usable by both runtime roles."""

from sqlalchemy import create_engine, text

from api.platform.testing.fixtures import PgUrls


def test_pg_trgm_is_installed_in_public(pg_urls: PgUrls) -> None:
    engine = create_engine(pg_urls.superuser)
    with engine.connect() as conn:
        schema = conn.execute(
            text(
                "SELECT n.nspname FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace "
                "WHERE e.extname = 'pg_trgm'"
            )
        ).scalar_one_or_none()
    engine.dispose()
    assert schema == "public"


def test_app_role_can_use_trigram_functions(pg_urls: PgUrls) -> None:
    engine = create_engine(pg_urls.app)
    with engine.connect() as conn:
        score = conn.execute(text("SELECT public.similarity('researcher', 'research')")).scalar_one()
        matches = conn.execute(text("SELECT 'Institute A' OPERATOR(public.%) 'Institute'")).scalar_one()
    engine.dispose()
    assert 0.5 < score <= 1.0
    assert matches is True


def test_migrator_can_index_with_public_trgm_opclass(pg_urls: PgUrls) -> None:
    engine = create_engine(pg_urls.migrator)
    with engine.begin() as conn:
        conn.execute(text("CREATE TABLE identity.trgm_probe (name text NOT NULL)"))
        conn.execute(
            text("CREATE INDEX ix_trgm_probe ON identity.trgm_probe USING gin (name public.gin_trgm_ops)")
        )
        conn.execute(text("DROP TABLE identity.trgm_probe"))
    engine.dispose()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest apps/api/platform/tests/test_pg_trgm.py -v`
Expected: FAIL — `test_pg_trgm_is_installed_in_public` asserts `None == 'public'`; the other two fail with `psycopg.errors.UndefinedFunction: function public.similarity(unknown, unknown) does not exist` / `UndefinedObject: operator class "public.gin_trgm_ops" does not exist`.

- [ ] **Step 3: Add the extension to init.sql**

Append to `infra/docker/postgres/init.sql`:

```sql

-- W1-D2: trigram search for module migrations (public.gin_trgm_ops, public.similarity). Installed once here, as
-- superuser; module migrations never CREATE EXTENSION.
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run pytest apps/api/platform/tests/test_pg_trgm.py -v`
Expected: 3 passed.

Run the whole platform suite (init.sql feeds every DB test): `uv run pytest apps/api/platform -q`
Expected: all pass.

- [ ] **Step 5: Apply once to the running stack (its volume was initialised before this change)**

```bash
cd /data/project/nst-nexus
docker compose exec -T postgres psql -U nais -d nais -c "CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public"
docker compose exec -T postgres psql -U nais -d nais -tAc "SELECT n.nspname FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = 'pg_trgm'"
```
Expected: `CREATE EXTENSION` (or `NOTICE: extension "pg_trgm" already exists, skipping`), then `public`.

- [ ] **Step 6: Commit**

```bash
uv run ruff check --fix apps/api/platform/tests/test_pg_trgm.py && uv run ruff format apps/api/platform/tests/test_pg_trgm.py
git add infra/docker/postgres/init.sql apps/api/platform/tests/test_pg_trgm.py
git commit -m "feat(infra): install pg_trgm once in schema public (W1-D2)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: openapi 1.2.0 — declared error statuses, optional fields, regenerate

**Files:**
- Create: `packages/contracts/changes/openapi_1_2_0.py`
- Modify: `NAIS_PRD/contracts/openapi.yaml` (by the script only)
- Modify: `NAIS_PRD/03_API_EVENT_CONTRACTS.md` (line 4 version), `packages/contracts/package.json` (`"version"`)
- Regenerate: `apps/api/platform/generated/error_codes.py`, `apps/api/platform/generated/event_types.py`, `packages/contracts/python/nais_contracts/api_models.py`, `packages/contracts/ts/openapi.d.ts`
- Test: `apps/api/platform/tests/test_contract_v1_2.py`

**Interfaces:**
- Consumes: `api.platform.testing.contracts.assert_matches_response(operation_id, status_code, body)`, `api.platform.settings.Settings().contracts_dir`.
- Produces (every module plan relies on these): contract `info.version == "1.2.0"`; `"401"` on every operation except `healthLive`/`healthReady`; `listOrganizationMembers` 404; `listUsers` 422; `updateProject` 404/422; `archiveProject` 404; `addProjectMember` 404; `updateProjectMemberRole` 404/422; `listProjects` 422; `searchDatasets` 422/503; `updateDataset` 404/409; `listDatasetVersions` 404; `createDatasetVersion` 404; `createUploadSession` 404/503; `completeUploadSession` 403/404/503; `deleteDraftFile` 503; `publishDatasetVersion` 404; `startReadinessValidation` 404/503; `getReadiness` 503 — all `$ref: "#/components/responses/Error"`. `UploadSession.files[].required == [file_id, path, status]`. Optional string properties `AccessGrant.subject_display_name`, `AccessGrant.project_name`, `ProjectSummary.lead_organization_name` (generated as `str | None = None` in `nais_contracts.api_models`, optional in `openapi.d.ts`).

- [ ] **Step 1: Write the failing test**

`apps/api/platform/tests/test_contract_v1_2.py`:

```python
"""W1-D3: openapi 1.2.0 declares every status the Wave 1 modules return, plus the M10 optional fields."""

import importlib.util
import shutil
from pathlib import Path
from typing import Any

import pytest
import yaml

from api.platform.settings import REPO_ROOT, Settings
from api.platform.testing.contracts import assert_matches_response

ERROR_BODY = {"error": {"code": "NOT_FOUND", "message": "x", "trace_id": "0" * 32, "details": {}}}
SCRIPT = REPO_ROOT / "packages" / "contracts" / "changes" / "openapi_1_2_0.py"
EXPECTED = {
    "listOrganizationMembers": {"404"},
    "listUsers": {"422"},
    "updateProject": {"404", "422"},
    "archiveProject": {"404"},
    "addProjectMember": {"404"},
    "updateProjectMemberRole": {"404", "422"},
    "listProjects": {"422"},
    "searchDatasets": {"422", "503"},
    "updateDataset": {"404", "409"},
    "listDatasetVersions": {"404"},
    "createDatasetVersion": {"404"},
    "createUploadSession": {"404", "503"},
    "completeUploadSession": {"403", "404", "503"},
    "deleteDraftFile": {"503"},
    "publishDatasetVersion": {"404"},
    "startReadinessValidation": {"404", "503"},
    "getReadiness": {"503"},
}


def _spec() -> dict[str, Any]:
    spec: dict[str, Any] = yaml.safe_load((Settings().contracts_dir / "openapi.yaml").read_text(encoding="utf-8"))
    return spec


def _operations(spec: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {
        op["operationId"]: op
        for item in spec["paths"].values()
        for method, op in item.items()
        if method in ("get", "post", "put", "patch", "delete")
    }


def test_contract_version_is_1_2_0() -> None:
    assert _spec()["info"]["version"] == "1.2.0"


def test_every_secured_operation_declares_401() -> None:
    ops = _operations(_spec())
    for op_id, op in ops.items():
        if op.get("security") == []:
            assert op_id in {"healthLive", "healthReady"}
            assert "401" not in op["responses"], op_id
        else:
            assert op["responses"]["401"] == {"$ref": "#/components/responses/Error"}, op_id


@pytest.mark.parametrize(("op_id", "codes"), sorted(EXPECTED.items()))
def test_module_error_statuses_are_declared(op_id: str, codes: set[str]) -> None:
    op = _operations(_spec())[op_id]
    for code in codes:
        assert op["responses"][code]["$ref"] == "#/components/responses/Error", (op_id, code)
        assert_matches_response(op_id, int(code), ERROR_BODY)


def test_upload_session_upload_is_optional_but_shaped() -> None:
    files = _spec()["components"]["schemas"]["UploadSession"]["properties"]["files"]["items"]
    assert files["required"] == ["file_id", "path", "status"]
    methods = [variant["properties"]["method"]["const"] for variant in files["properties"]["upload"]["oneOf"]]
    assert methods == ["PUT", "MULTIPART"]


def test_m10_optional_display_fields() -> None:
    schemas = _spec()["components"]["schemas"]
    for schema, field in (
        ("AccessGrant", "subject_display_name"),
        ("AccessGrant", "project_name"),
        ("ProjectSummary", "lead_organization_name"),
    ):
        assert schemas[schema]["properties"][field] == {"type": "string"}
        assert field not in schemas[schema]["required"]


def test_generated_models_have_the_optional_fields() -> None:
    from nais_contracts.api_models import AccessGrant, ProjectSummary

    assert AccessGrant.model_fields["subject_display_name"].is_required() is False
    assert AccessGrant.model_fields["project_name"].is_required() is False
    assert ProjectSummary.model_fields["lead_organization_name"].is_required() is False


def test_contract_edit_script_is_idempotent(tmp_path: Path) -> None:
    copy = tmp_path / "openapi.yaml"
    shutil.copy(Settings().contracts_dir / "openapi.yaml", copy)
    spec_ = importlib.util.spec_from_file_location("openapi_1_2_0", SCRIPT)
    assert spec_ is not None and spec_.loader is not None
    module = importlib.util.module_from_spec(spec_)
    spec_.loader.exec_module(module)
    module.main(copy)
    assert copy.read_bytes() == (Settings().contracts_dir / "openapi.yaml").read_bytes()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest apps/api/platform/tests/test_contract_v1_2.py -v`
Expected: FAIL — `test_contract_version_is_1_2_0` (`'1.1.1' == '1.2.0'`), the 401/status/optional-field tests with `KeyError`, the generated-model test with `KeyError: 'subject_display_name'`, and the idempotency test with `FileNotFoundError` for the script.

- [ ] **Step 3: Write the edit script**

`packages/contracts/changes/openapi_1_2_0.py`:

```python
"""One-off, deterministic edit of NAIS_PRD/contracts/openapi.yaml 1.1.1 -> 1.2.0 (W1-D3).

Text-level edit (keeps the file's flow style and comments); idempotent; verifies the result with yaml.safe_load.
Usage: uv run python packages/contracts/changes/openapi_1_2_0.py NAIS_PRD/contracts/openapi.yaml
"""

import re
import sys
from pathlib import Path

import yaml

ERROR = '{ $ref: "#/components/responses/Error" }'
PUBLIC_OPS = {"healthLive", "healthReady"}
EXTRA: dict[str, tuple[str, ...]] = {
    "listOrganizationMembers": ("404",),
    "listUsers": ("422",),
    "updateProject": ("404", "422"),
    "archiveProject": ("404",),
    "addProjectMember": ("404",),
    "updateProjectMemberRole": ("404", "422"),
    "listProjects": ("422",),
    "searchDatasets": ("422", "503"),
    "updateDataset": ("404", "409"),
    "listDatasetVersions": ("404",),
    "createDatasetVersion": ("404",),
    "createUploadSession": ("404", "503"),
    "completeUploadSession": ("403", "404", "503"),
    "deleteDraftFile": ("503",),
    "publishDatasetVersion": ("404",),
    "startReadinessValidation": ("404", "503"),
    "getReadiness": ("503",),
}
PROPERTY_INSERTS = (  # (anchor line, line inserted right after it)
    (
        '        lead_organization_id: { $ref: "#/components/schemas/Id" }\n'
        '        my_role: { oneOf: [ { $ref: "#/components/schemas/ProjectRole" }, { type: "null" } ] }\n',
        "        lead_organization_name: { type: string }\n",
    ),
    (
        '        subject_user_id: { $ref: "#/components/schemas/Id" }\n'
        '        project_id: { $ref: "#/components/schemas/Id" }\n'
        '        dataset_id: { $ref: "#/components/schemas/Id" }\n'
        "        dataset_title: { type: string }\n",
        "        subject_display_name: { type: string }\n        project_name: { type: string }\n",
    ),
)
UPLOAD_REQUIRED_OLD = "            required: [file_id, path, status, upload]\n"
UPLOAD_REQUIRED_NEW = "            required: [file_id, path, status]\n"


def wanted_statuses(spec: dict) -> dict[str, set[str]]:
    wanted: dict[str, set[str]] = {}
    for item in spec["paths"].values():
        for method, op in item.items():
            if method not in ("get", "post", "put", "patch", "delete"):
                continue
            op_id = op["operationId"]
            codes = set(EXTRA.get(op_id, ()))
            if op_id not in PUBLIC_OPS and op.get("security") != []:
                codes.add("401")
            wanted[op_id] = codes
    return wanted


def add_responses(lines: list[str], op_id: str, codes: set[str]) -> None:
    start = next(i for i, line in enumerate(lines) if line.strip() == f"operationId: {op_id}")
    resp = next(i for i in range(start, len(lines)) if lines[i].strip() == "responses:")
    resp_indent = len(lines[resp]) - len(lines[resp].lstrip())
    key_indent = " " * (resp_indent + 2)
    key_re = re.compile(rf'^{key_indent}"(\d{{3}})":')
    end = resp + 1
    last = resp
    while end < len(lines):
        line = lines[end]
        if line.strip() and len(line) - len(line.lstrip()) <= resp_indent:
            break
        if line.strip():
            last = end
        end += 1
    keys = {i: m.group(1) for i in range(resp + 1, last + 1) if (m := key_re.match(lines[i]))}
    for code in sorted(codes - set(keys.values()), reverse=True):
        before = [i for i, existing in keys.items() if existing > code]
        at = min(before) if before else last + 1
        lines.insert(at, f'{key_indent}"{code}": {ERROR}\n')
        keys = {(i + 1 if i >= at else i): c for i, c in keys.items()}
        keys[at] = code
        last += 1


def main(path: Path) -> None:
    text = path.read_text(encoding="utf-8")
    text = text.replace("\n  version: 1.1.1\n", "\n  version: 1.2.0\n", 1)
    for anchor, insert in PROPERTY_INSERTS:
        if anchor + insert not in text:
            assert text.count(anchor) == 1, anchor
            text = text.replace(anchor, anchor + insert)
    if UPLOAD_REQUIRED_OLD in text:
        assert text.count(UPLOAD_REQUIRED_OLD) == 1
        text = text.replace(UPLOAD_REQUIRED_OLD, UPLOAD_REQUIRED_NEW)
    lines = text.splitlines(keepends=True)
    for op_id, codes in wanted_statuses(yaml.safe_load(text)).items():
        add_responses(lines, op_id, codes)
    text = "".join(lines)
    spec = yaml.safe_load(text)
    assert spec["info"]["version"] == "1.2.0"
    for item in spec["paths"].values():
        for method, op in item.items():
            if method in ("get", "post", "put", "patch", "delete"):
                missing = wanted_statuses(spec)[op["operationId"]] - set(op["responses"])
                assert not missing, (op["operationId"], missing)
    path.write_text(text, encoding="utf-8")
    print("openapi.yaml is at 1.2.0")


if __name__ == "__main__":
    main(Path(sys.argv[1]))
```

- [ ] **Step 4: Run the script, bump the other version strings, regenerate**

```bash
cd /data/project/nst-nexus
uv run python packages/contracts/changes/openapi_1_2_0.py NAIS_PRD/contracts/openapi.yaml
uv run python packages/contracts/changes/openapi_1_2_0.py NAIS_PRD/contracts/openapi.yaml   # 2nd run: no change
git diff --stat NAIS_PRD/contracts/openapi.yaml
sed -i 's/"version": "1.1.1"/"version": "1.2.0"/' packages/contracts/package.json
sed -i 's/(OpenAPI 3.1, v1.1.1: 41 paths \/ 49 operations)/(OpenAPI 3.1, v1.2.0: 41 paths \/ 49 operations)/' NAIS_PRD/03_API_EVENT_CONTRACTS.md
uv run python packages/contracts/generate.py
```
Expected: the script prints `openapi.yaml is at 1.2.0` twice; the diff is `1 file changed, 74 insertions(+), 2 deletions(-)` (69 response lines, 3 property lines, and the changed version and `UploadSession` required lines); `grep -c "1.2.0" packages/contracts/package.json NAIS_PRD/03_API_EVENT_CONTRACTS.md` prints `1` for each; the generator prints `generated files written`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `uv run pytest apps/api/platform/tests/test_contract_v1_2.py -v`
Expected: all pass (5 + 17 parametrized + idempotency).

Run: `uv run python packages/contracts/generate.py --check && uv run pytest -q && uv run mypy`
Expected: `generated files are up to date`; whole suite passes (`test_generated.py` included); mypy `Success`.

- [ ] **Step 6: Commit**

```bash
uv run ruff check --fix packages/contracts/changes/openapi_1_2_0.py apps/api/platform/tests/test_contract_v1_2.py
uv run ruff format packages/contracts/changes/openapi_1_2_0.py apps/api/platform/tests/test_contract_v1_2.py
git add packages/contracts/changes/openapi_1_2_0.py NAIS_PRD/contracts/openapi.yaml NAIS_PRD/03_API_EVENT_CONTRACTS.md \
  packages/contracts/package.json apps/api/platform/generated packages/contracts/python packages/contracts/ts \
  apps/api/platform/tests/test_contract_v1_2.py
git commit -m "feat(contracts): openapi 1.2.0 - Wave 1 error statuses, optional upload, M10 display fields (W1-D3)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Shared config — mypy covers modules, `.env.example` module keys

**Files:**
- Modify: `pyproject.toml` (`[tool.mypy]` `files` and `exclude`)
- Modify: `.env.example`
- Test: `apps/api/platform/tests/test_env_example.py`

**Interfaces:**
- Consumes: nothing.
- Produces: `uv run mypy` (CI `python` job) type-checks `apps/api/modules/**` except `apps/api/modules/<name>/tests/` and `.../migrations/`; `.env.example` lists every Wave 1 module env key with the module plans' code defaults. Module plans do not edit either file.

- [ ] **Step 1: Write the failing test**

`apps/api/platform/tests/test_env_example.py`:

```python
"""W1-D4: .env.example lists every Wave 1 module env key with the module's code default."""

import tomllib

from api.platform.settings import REPO_ROOT

MODULE_KEYS = {
    # M02 project
    "PROJECT_MAX_MEMBERS": "200",
    # M03 catalog
    "UPLOAD_URL_TTL_SECONDS": "3600",
    "UPLOAD_SESSION_TTL_SECONDS": "3600",
    "CATALOG_SYNC_VERIFY_MAX_BYTES": "268435456",
    "CATALOG_INDEX_ALIAS": "nais-datasets",
    "MALWARE_SCANNER": "noop",
    # M05 readiness
    "READINESS_RUN_TIMEOUT_SECONDS": "1800",
    "READINESS_FILE_TIMEOUT_SECONDS": "600",
    "READINESS_WORKER_CONCURRENCY": "2",
    # M09 audit / notification
    "SMTP_FROM": '"NAIS AI-OS <no-reply@nais.local>"',
    "NOTIFICATION_EMAIL_ENABLED": "true",
    "NOTIFICATION_RETENTION_DAYS": "180",
    # M10 web
    "AUTH_TRUST_HOST": "true",
    "WEB_API_MOCKING": "enabled",
}


def _env_example() -> dict[str, str]:
    pairs: dict[str, str] = {}
    for line in (REPO_ROOT / ".env.example").read_text(encoding="utf-8").splitlines():
        if line.strip() and not line.lstrip().startswith("#"):
            key, _, value = line.partition("=")
            assert key not in pairs, f"duplicate key {key}"
            pairs[key] = value
    return pairs


def test_module_env_keys_have_the_code_defaults() -> None:
    env = _env_example()
    assert {key: env.get(key) for key in MODULE_KEYS} == MODULE_KEYS


def test_mypy_covers_module_code_but_not_tests_or_migrations() -> None:
    mypy = tomllib.loads((REPO_ROOT / "pyproject.toml").read_text(encoding="utf-8"))["tool"]["mypy"]
    assert "apps/api/modules" in mypy["files"]
    assert {"apps/api/modules/[^/]+/tests/", "apps/api/modules/[^/]+/migrations/"} <= set(mypy["exclude"])
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest apps/api/platform/tests/test_env_example.py -v`
Expected: FAIL — `test_module_env_keys_have_the_code_defaults` (all values `None`), `test_mypy_covers_module_code_but_not_tests_or_migrations` (`assert 'apps/api/modules' in [...]`).

- [ ] **Step 3: Edit `pyproject.toml`**

Replace

```toml
files = ["apps/api/platform", "apps/api/main.py", "apps/api/worker.py"]
exclude = ["apps/api/platform/tests/", "apps/api/platform/migrations/"]
```

with

```toml
files = ["apps/api/platform", "apps/api/modules", "apps/api/main.py", "apps/api/worker.py"]
exclude = [
    "apps/api/platform/tests/",
    "apps/api/platform/migrations/",
    "apps/api/modules/[^/]+/tests/",
    "apps/api/modules/[^/]+/migrations/",
]
```

- [ ] **Step 4: Edit `.env.example`**

Insert after the line `SMTP_PORT=1025`:

```dotenv
SMTP_FROM="NAIS AI-OS <no-reply@nais.local>"
NOTIFICATION_EMAIL_ENABLED=true
NOTIFICATION_RETENTION_DAYS=180
```

Insert after the line `STORAGE_MULTIPART_THRESHOLD_BYTES=67108864` (before the blank line and `# Web (Agent 7, D-026)`):

```dotenv

# Modules (Wave 1; values equal the code defaults, so every key is optional)
PROJECT_MAX_MEMBERS=200
UPLOAD_URL_TTL_SECONDS=3600
UPLOAD_SESSION_TTL_SECONDS=3600
CATALOG_SYNC_VERIFY_MAX_BYTES=268435456
CATALOG_INDEX_ALIAS=nais-datasets
MALWARE_SCANNER=noop
READINESS_RUN_TIMEOUT_SECONDS=1800
READINESS_FILE_TIMEOUT_SECONDS=600
READINESS_WORKER_CONCURRENCY=2
```

Append at the end of the file (the `# Web (Agent 7, D-026)` block; keep `NEXT_PUBLIC_API_MOCKING=disabled` as is, M10 overrides it at build time):

```dotenv
AUTH_TRUST_HOST=true
# Web portal uses its in-app mock API until Wave 2 (build-time switch: rebuild `web` after changing).
WEB_API_MOCKING=enabled
```

Do not edit the running stack's `.env`; these keys are optional there.

- [ ] **Step 5: Run tests to verify they pass**

Run: `uv run pytest apps/api/platform/tests/test_env_example.py -v && uv run mypy && docker compose config --quiet`
Expected: 2 passed; mypy `Success: no issues found` (only `apps/api/modules/__init__.py` exists today); `docker compose config` exits 0.

- [ ] **Step 6: Commit**

```bash
uv run ruff check --fix apps/api/platform/tests/test_env_example.py && uv run ruff format apps/api/platform/tests/test_env_example.py
git add pyproject.toml .env.example apps/api/platform/tests/test_env_example.py
git commit -m "chore: mypy covers apps/api/modules; .env.example Wave 1 module keys (W1-D4)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Not in this plan (by decision)

- Approved shared changes that stay with their module plans (W1-D4): M01 `fastapi>=0.121`; M03 compose `opensearch: build: infra/opensearch`; M05 `pyarrow`; M10 compose `web` service and root `pnpm-lock.yaml`.
- CI web job: added by Agent 0 in the Wave 1 integration step, after M10.
- Keycloak `nais-web` client (W1-D6): owned by the M01 realm file.

## Self-review

- Spec coverage: W1-D1 → Task 1; W1-D2 → Task 2 (init.sql, running stack, test DB proof for `nais_app` and `nais_migrator`); W1-D3 → Task 3 (every listed status incl. optional 503 on readiness start/get, `UploadSession.files[].upload` optional, three M10 optional fields, version 1.2.0, regenerate, `--check` and full suite); W1-D4 → Task 4 (mypy, `.env.example` keys collected from M02/M03/M05/M09/M10 plans' Settings defaults). W1-D5/D6 are module-plan concerns (M03/M05, M01).
- Placeholder scan: none; every code step has complete content.
- Type consistency: `PgUrls(superuser, migrator, app)` and `pg_urls` come from `api.platform.testing.fixtures`; `assert_matches_response(operation_id, status_code, body)` from `api.platform.testing.contracts`; `REPO_ROOT`, `Settings().contracts_dir` from `api.platform.settings`; the script's `main(path: Path) -> None` is what the idempotency test calls.
