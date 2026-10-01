# M05 AI-Ready Pipeline (readiness) - Wave 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `readiness` module: deterministic validation of PUBLISHED dataset versions against `GENERIC_BASIC@1.0.0` and `TABULAR_ML_BASIC@1.0.0` (9 validators, evidence without raw values), run by a Dramatiq actor that is auto-queued by `catalog.dataset.version_published.v1` or by a steward through the API, with 4 golden fixtures.

**Architecture:** A pure engine (`engine/` + `validators/`, no DB, no clock, no network) turns `(metadata snapshot, file manifest, file bytes, profile, VALIDATOR_VERSION)` into a canonical, hashed `ValidationResult`. Around it: a Postgres state machine (`readiness.validations` / `check_results`), a Dramatiq actor `readiness.run_validation` on queue `readiness`, an outbox-published `started`/`completed` event pair, a per-handler idempotent publish consumer, a stale-job sweeper, and three HTTP operations. M03 is reached only through its public ports (`api.modules.catalog.public`, re-exported by `catalog_port.py`), faked in tests by `FixtureCatalog`, which serves the committed fixtures from disk.

**Tech Stack:** Python 3.13, FastAPI (`SessionDep`, `CurrentUserDep`), SQLAlchemy 2 Core + Alembic (platform runner), Dramatiq (StubBroker in tests), stdlib `csv`, `pyarrow` (parquet, new dependency), `jsonschema`, `pyyaml`, pytest + testcontainers Postgres.

**Spec:** `NAIS_PRD/modules/M05_ai_ready.md` (binding) and `NAIS_PRD/09_AI_READY_RULES.md` (rules, thresholds, fixtures). Cross-cutting: `NAIS_PRD/11_DECISION_LOG.md` (D-005, D-006, D-012, D-018, D-028, D-029, D-036), `NAIS_PRD/contracts/openapi.yaml` (readiness tag), `NAIS_PRD/contracts/events/p0_events.schema.json`, `NAIS_PRD/contracts/error_codes.json`, `NAIS_PRD/10_SEED_DATA.md` §1 step 4.

> Every code block in this plan was run: all 16 tasks were applied in order on a copy of `feat/wave1` and each task's tests plus `ruff check`/`ruff format --check` passed at that point; the final full suite was `343 passed, 1 skipped`. Copy code verbatim.
>
> **Harmonized with the Wave 1 controller decisions (W1-D1…D6)** after that run: `catalog_port.py` now re-exports `api.modules.catalog.public` (D-038), `FixtureCatalog` gained `get_policy_view`, `generate.py` takes the fixture file bytes from M03's `seed_files.fixture_files` (W1-D5), and the 401/404 tests contract-check against openapi 1.2.0. These edits were not re-run in scratch.

**Execution order (W1):** M00 kickoff → M01 → M02 → M03 → M05 → M09 → M10. Prerequisites from M00: pg_trgm in `public`, openapi 1.2.0, mypy covers `apps/api/modules`, `.env.example` keys (incl. `READINESS_*`). M03 must be merged first (catalog public ports and the `seed_files` generator).

## Global Constraints

- Owned paths only: `apps/api/modules/readiness/**`, `tests/fixtures/readiness/**`. Only other file touched: `pyproject.toml` + `uv.lock` (add `pyarrow>=18.0`, Agent 0 approved). Anything else goes to "Contract/shared changes needed".
- DB schema `readiness`; every `op.*` call passes `schema="readiness"`; Alembic version table `readiness.alembic_version`; migrations live directly in `apps/api/modules/readiness/migrations/`.
- Imports use the `api.` root (D-032): `from api.platform... import ...`, `from api.modules.readiness... import ...`.
- "LLM이 pass/fail을 판정하지 않는다. 네트워크 조회도 하지 않는다." No `anthropic`, `openai`, `httpx`, `requests`, `urllib`, `aiohttp`, `socket` import anywhere in the module; validators never read the clock, randomness or env (M05-AT-14 test).
- Same input / version / profile => same result: floats rounded to 6 places, dict keys sorted, arrays sorted (path -> field -> row), canonical JSON `separators=(",", ":")`, `ensure_ascii=False`; `result_sha256` = sha256 of canonical `{checks, overall_status, summary}`.
- `VALIDATOR_VERSION = "1.0.0"` (code constant); profiles `GENERIC_BASIC@1.0.0`, `TABULAR_ML_BASIC@1.0.0`; profile parameters exactly 09 §2.3 (`sample_max_rows: 100000`, `sample_max_bytes: 268435456`, `max_tabular_files: 50`, `checksum_max_total_bytes: 10737418240`, `description_min_length: 50`, `provenance_min_length: 50`, `usage_policy_min_length: 20`, `datatype_warn_ratio: 0.0`, `datatype_fail_ratio: 0.01`, `malformed_rows_fail_ratio: 0.001`, `missing_warn_ratio: 0.05`, `missing_fail_ratio: 0.5`, `missing_overall_warn_ratio: 0.05`, `unit_missing_fail_ratio: 0.2`, `mapping_pass_ratio: 0.8`). Verdict-affecting values are never env.
- Env (M05 §11): `READINESS_RUN_TIMEOUT_SECONDS=1800`, `READINESS_FILE_TIMEOUT_SECONDS=600`, `READINESS_WORKER_CONCURRENCY=2`; broker from `REDIS_URL` (platform).
- Evidence (D-018): counts, ratios (6 places), file paths, field names, declared unit strings, 1-based data row numbers (max 10), lengths. Never a cell value, part of one, a sample row, or min/max/mean. Evidence <= 64 KiB of canonical JSON, else arrays truncated and `"truncated": true`.
- Parsing: CSV with stdlib `csv` (all values `str`), delimiter by extension (`.csv` `,` / `.tsv` `\t`, never sniffed), UTF-8 with BOM allowed, RFC 4180 quotes; parquet via `pyarrow.parquet.ParquetFile.iter_batches`; no pandas type inference.
- T = files ending `.csv`/`.tsv`/`.parquet` whose name does not start with `_`, path order, at most 50 (rest listed in `skipped_files`).
- Run states `QUEUED -> RUNNING -> COMPLETED | FAILED`, infra retries `RUNNING -> QUEUED` while `attempt < 3` (`max_retries=2`), stale sweeper every 10 min (QUEUED > 1h, RUNNING > run timeout + 10 min -> `FAILED(STALE_JOB)`).
- Endpoints take `session: SessionDep` (never `session.commit()`), auth via `CurrentUserDep`; errors only through `ApiError` with codes from `error_codes.json` (`NOT_FOUND`, `FORBIDDEN`, `DATASET_VERSION_NOT_PUBLISHED`, `READINESS_PROFILE_UNKNOWN`, `READINESS_VALIDATION_IN_PROGRESS`, `READINESS_NOT_AVAILABLE`, `VALIDATION_FAILED`, `DEPENDENCY_UNAVAILABLE`).
- Events only with `outbox.write(session, ...)` in the same transaction as the state change; produced: `readiness.validation.started.v1` (actor SYSTEM), `readiness.validation.completed.v1` (actor USER for manual runs, SYSTEM for auto); consumed: `catalog.dataset.version_published.v1` via `@subscribe` + `claim_event(session, "readiness", event, handler="on_version_published")` on a `create_processed_events("readiness", per_handler=True)` table.
- The Dramatiq actor is defined at module import (platform sets the broker first, D-036) and the module plugs in through `ModuleSpec(register_worker=..., wire=..., router=..., migrations_dir=...)`; handlers are imported from the package `__init__`.
- Tests: every API response checked with `assert_matches_response`, every emitted event with `assert_valid_event`; real Postgres via `migrated_db`; `create_test_app(modules=[MODULE])`; `FakeIssuer` tokens.
- Dev environment: gateway `http://localhost:21051`, logins `nais`/`nais` (D-037); never `docker compose down` or delete volumes; restarting `api`/`worker` is fine.
- Every commit ends with the trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Redis down when a QUEUED row commits** -> the API call / handler still succeeds, the row stays `QUEUED` (the sweeper fails it after 1 h, a steward can re-run); no exception escapes the commit. Pinned by `test_broker_outage_at_enqueue_keeps_the_committed_row` (Task 13).
2. **Evidence right at the 64 KiB bound** -> canonical JSON <= 64 KiB but `jsonb::text` is ~73 KB; the row must still be stored and the run COMPLETE (a DB check at 65536 would crash the run after evaluation). Pinned by `test_evidence_at_the_64_kib_bound_is_stored` (Task 12) against the 128 KiB backstop from Task 11.
3. **A tabular file with a header and zero data rows** (and an empty file) -> ratios are `0.0`, checks PASS/NA, no `ZeroDivisionError`. Pinned by `test_header_only_file_has_zero_ratios` (Task 8) and `test_empty_file_has_no_header` (Task 4).
4. **Worker started without M03's ports wired** -> the publish event is retried by the relay and the idempotency claim is rolled back (not silently marked processed). Pinned by `test_missing_catalog_port_retries_the_event_instead_of_dropping_it` (Task 14).
5. **WITHDRAWN version** -> earlier results stay readable (only DRAFT is 404) while a new run is `409 DATASET_VERSION_NOT_PUBLISHED`. Pinned by `test_withdrawn_version_keeps_results_but_rejects_new_runs` (Task 15).

## Resolved spec ambiguities (decisions this plan implements)

- **input_fingerprint**: D-029 and openapi include `metadata_snapshot_sha256`; 09 §4 omits it. Decision log wins: `sha256("|".join([manifest_sha256, sha256(canonical_json(snapshot)), profile_id, profile_version, validator_version]))` (09's `|` form).
- **Missing object (storage 404)**: M05 §5 (run FAILED) vs 09 §3.8 (check FAIL). The state machine wins: `ObjectMissing` -> run `FAILED` with `FILE_NOT_FOUND: <path> ...`; `integrity.file_checksum` keeps `"missing": []` for evidence-shape compatibility.
- **Actor of `completed` for manual runs**: §4.1 stores only `requested_by`; added nullable `requester_organization_id` so `actor.organization_id` is right for PLATFORM_ADMIN requesters (M09 audit).
- **Port keys** (W1-D1 / D-038): `catalog_port.py` re-exports M03's `api.modules.catalog.public` types/ports and readiness looks ports up under those classes; `is_visible` takes the platform `CurrentUser` (has every AuthContext field readiness needs).
- **schema.presence extra FAILs**: a `resources[].path` that is not a file of the version, and duplicate header columns (spec silent; both make "field set exactly matches" unverifiable).
- **Undecodable parquet** = `encoding_error` (FAIL), same as an undecodable CSV. **CSV byte budget** counts UTF-8 value bytes + 1 separator per value (independent of I/O buffering). Blank CSV lines are not data rows.
- **Worker concurrency**: the platform worker has one thread pool for every queue, so `READINESS_WORKER_CONCURRENCY` is a per-process `BoundedSemaphore` around the actor body.
- **getReadiness with an unknown `profile_id`** -> `404 READINESS_NOT_AVAILABLE` (openapi declares only 200/404 there).
- **UCUM**: bundled P0 subset of atoms (`dictionaries/ucum_atoms_v1.txt`) and SI prefixes; binary prefixes not included.

## File Structure

```text
pyproject.toml, uv.lock                        shared file change (Agent 0 approved): + pyarrow>=18.0
apps/api/modules/readiness/
  __init__.py                                  MODULE = ModuleSpec(...); imports handlers (registers @subscribe)
  README.md                                    rules link, version policy, integration notes (§13.1, §13.7)
  settings.py                                  READINESS_* operational env (never verdict thresholds)
  catalog_port.py                              re-export of api.modules.catalog.public: FileRef, VersionView, ports, errors
  profile_registry.py                          loads profiles/*.yaml -> PROFILES, PROFILE_ORDER
  profiles/GENERIC_BASIC.yaml, TABULAR_ML_BASIC.yaml
  dictionaries/ucum_atoms_v1.txt, ucum_prefixes_v1.txt, unit_aliases_v1.csv, spdx_license_ids_v1.txt
  schemas/table_schema_subset_v1.json          JSON Schema of the _schema.json subset (09 §1.2)
  engine/__init__.py                           VALIDATOR_VERSION
  engine/canonical.py                          canonical JSON, r6/ratio, bound_evidence, manifest, fingerprint
  engine/parsing.py                            streaming csv/parquet -> FileStats (no values kept)
  engine/context.py                            EvaluationContext, CheckOutcome, _schema.json / _codebook.csv parsing, T
  engine/units.py                              UCUM syntax check + alias suggestions
  engine/evaluate.py                           evaluate(), overall/summary/result_sha256
  validators/__init__.py                       VALIDATORS registry
  validators/<one file per check>.py           9 checks (09 §3.1-3.9)
  fakes.py                                     FixtureCatalog (M03 fake for tests + selfcheck)
  selfcheck.py                                 python -m api.modules.readiness.selfcheck [DIR] [--record]
  tables.py                                    SQLAlchemy Core tables
  migrations/0001_readiness_initial.py         readiness schema DDL (revision readiness_0001)
  jobs.py                                      actor, state machine, events, retries, sweeper, enqueue_after_commit
  service.py                                   reuse / in-progress / queue rules, reads, API mapping
  public.py                                    ReadinessQueryPort + wire()
  handlers.py                                  catalog.dataset.version_published.v1 consumer
  router.py                                    3 HTTP operations
  tests/__init__.py, conftest.py, helpers.py, builders.py, dbutil.py, test_*.py
tests/fixtures/readiness/
  generate.py, fixtures.lock
  {clean_tabular,missing_metadata,invalid_units,missing_provenance}/dataset.json, files/**, expected/*.json
```

Conventions for every task: run commands from the repo root; `uv run pytest ...` uses the platform's testcontainers Postgres (Docker must be reachable); lint command is `uv run ruff check apps/api/modules/readiness tests/fixtures && uv run ruff format --check apps/api/modules/readiness tests/fixtures`.

---

### Task 1: pyarrow dependency, module skeleton, profile registry and settings

Profiles are code (M05 §4), loaded once and validated at import. Env knobs are operational only (§11).

**Files:**
- Modify: `pyproject.toml` (shared file change, Agent 0 approved) + `uv.lock` (regenerated)
- Create: `apps/api/modules/readiness/settings.py`
- Create: `apps/api/modules/readiness/catalog_port.py`
- Create: `apps/api/modules/readiness/profiles/GENERIC_BASIC.yaml`
- Create: `apps/api/modules/readiness/profiles/TABULAR_ML_BASIC.yaml`
- Create: `apps/api/modules/readiness/profile_registry.py`
- Create: `apps/api/modules/readiness/__init__.py`
- Create: `apps/api/modules/readiness/tests/__init__.py`
- Test: `apps/api/modules/readiness/tests/test_profiles.py`, `apps/api/modules/readiness/tests/test_catalog_port.py`

**Interfaces:**
- Consumes: `api.platform.modules.ModuleSpec`; M03 `api.modules.catalog.public` (`CatalogQueryPort`, `CatalogReadPort`, `FileRef`, `VersionView`, `ObjectMissing(LookupError)`, `StorageUnavailable(RuntimeError)`, `DatasetPolicyView`).
- Produces: `profile_registry.PROFILES: dict[str, Profile]` (keys in `PROFILE_ORDER = ("GENERIC_BASIC", "TABULAR_ML_BASIC")`), `Profile(profile_id, version, name, description, checks: tuple[CheckSpec], params: ProfileParams)`, `Profile.to_api() -> dict`, `CheckSpec(check_id, severity, ordinal)`, `ProfileParams` (15 fields of 09 §2.3), `Severity = Literal["REQUIRED","RECOMMENDED"]`, `load_profiles(directory) -> dict[str, Profile]`; `settings.ReadinessSettings` / `get_readiness_settings()` (`run_timeout_seconds`, `file_timeout_seconds`, `worker_concurrency`); `catalog_port.FileRef`, `VersionView`, `CatalogQueryPort`, `CatalogReadPort`, `StorageUnavailable`, `ObjectMissing` (re-exports of `api.modules.catalog.public`); `MODULE` (grows in later tasks).

- [ ] **Step 1: Add pyarrow (shared file change, Agent 0 approved)**

In `pyproject.toml` `[project].dependencies`, add one line right after `"pyyaml>=6.0",`:

```toml
    "pyarrow>=18.0",
```

Then:

```bash
uv lock && uv sync
uv run python -c "import pyarrow; print(pyarrow.__version__)"
```
Expected: the lock adds `pyarrow` (25.x at time of writing) and the import prints a version.

- [ ] **Step 2: Write the failing test**

`apps/api/modules/readiness/tests/__init__.py` (create as an empty file).

`apps/api/modules/readiness/tests/test_profiles.py` (create):

```python
from pathlib import Path

import pytest

from api.modules.readiness.profile_registry import PROFILE_ORDER, PROFILES, load_profiles
from api.modules.readiness.settings import ReadinessSettings


def test_two_profiles_in_contract_order() -> None:
    assert tuple(PROFILES) == PROFILE_ORDER == ("GENERIC_BASIC", "TABULAR_ML_BASIC")
    assert {p.version for p in PROFILES.values()} == {"1.0.0"}


def test_generic_basic_checks_and_severities() -> None:
    checks = [(c.ordinal, c.check_id, c.severity) for c in PROFILES["GENERIC_BASIC"].checks]
    assert checks == [
        (1, "metadata.completeness", "REQUIRED"),
        (2, "provenance.presence", "REQUIRED"),
        (3, "policy.license_usage", "REQUIRED"),
        (4, "integrity.file_checksum", "REQUIRED"),
        (5, "schema.presence", "RECOMMENDED"),
        (6, "semantics.units_codebook", "RECOMMENDED"),
        (7, "semantics.mapping_status", "RECOMMENDED"),
    ]


def test_tabular_ml_basic_checks_and_severities() -> None:
    checks = [(c.check_id, c.severity) for c in PROFILES["TABULAR_ML_BASIC"].checks]
    assert checks == [
        ("metadata.completeness", "REQUIRED"),
        ("provenance.presence", "REQUIRED"),
        ("policy.license_usage", "REQUIRED"),
        ("integrity.file_checksum", "REQUIRED"),
        ("schema.presence", "REQUIRED"),
        ("schema.datatype_validity", "REQUIRED"),
        ("data.missing_values", "RECOMMENDED"),
        ("semantics.units_codebook", "REQUIRED"),
        ("semantics.mapping_status", "RECOMMENDED"),
    ]


def test_parameters_match_09_section_2_3() -> None:
    for profile in PROFILES.values():
        p = profile.params
        assert (p.sample_max_rows, p.sample_max_bytes, p.max_tabular_files) == (100000, 268435456, 50)
        assert p.checksum_max_total_bytes == 10737418240
        assert (p.description_min_length, p.provenance_min_length, p.usage_policy_min_length) == (50, 50, 20)
        assert (p.datatype_warn_ratio, p.datatype_fail_ratio, p.malformed_rows_fail_ratio) == (
            0.0,
            0.01,
            0.001,
        )
        assert (p.missing_warn_ratio, p.missing_fail_ratio, p.missing_overall_warn_ratio) == (0.05, 0.5, 0.05)
        assert (p.unit_missing_fail_ratio, p.mapping_pass_ratio) == (0.2, 0.8)


def test_api_shape_lists_checks_in_order() -> None:
    body = PROFILES["GENERIC_BASIC"].to_api()
    assert set(body) == {"profile_id", "version", "name", "description", "checks"}
    assert body["checks"][0] == {"check_id": "metadata.completeness", "severity": "REQUIRED"}


def test_unknown_check_id_is_rejected(tmp_path: Path) -> None:
    source = (Path(__file__).parents[1] / "profiles" / "GENERIC_BASIC.yaml").read_text(encoding="utf-8")
    (tmp_path / "GENERIC_BASIC.yaml").write_text(
        source.replace("schema.presence", "schema.bogus"), encoding="utf-8"
    )
    with pytest.raises(ValueError, match="unknown checks"):
        load_profiles(tmp_path)


def test_env_only_tunes_operations_not_verdicts(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("READINESS_RUN_TIMEOUT_SECONDS", "60")
    monkeypatch.setenv("READINESS_SAMPLE_MAX_ROWS", "5")
    settings = ReadinessSettings()
    assert settings.run_timeout_seconds == 60
    assert not hasattr(settings, "sample_max_rows")
    assert (settings.file_timeout_seconds, settings.worker_concurrency) == (600, 2)
```

- [ ] **Step 3: Run the tests to verify they fail**

```bash
uv run pytest apps/api/modules/readiness/tests/test_profiles.py apps/api/modules/readiness/tests/test_catalog_port.py -q
```
Expected: collection error, `ModuleNotFoundError: No module named 'api.modules.readiness.profile_registry'` (and `...settings`, `...catalog_port`).

- [ ] **Step 4: Implement**

`apps/api/modules/readiness/settings.py` (create):

```python
"""Operational knobs only (M05 §11). Anything that changes a verdict is a profile parameter, never env."""

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class ReadinessSettings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="READINESS_", extra="ignore")

    run_timeout_seconds: int = 1800
    file_timeout_seconds: int = 600
    worker_concurrency: int = 2


@lru_cache(maxsize=1)
def get_readiness_settings() -> ReadinessSettings:
    return ReadinessSettings()
```

`apps/api/modules/readiness/catalog_port.py` (create):

```python
"""M03 public types readiness consumes (W1-D1 / D-038: M03 owns them in api.modules.catalog.public).

This file only re-exports them so the rest of readiness keeps one import path. The Protocol classes ARE the
`api.platform.ports` registry keys M03 provides in its wiring; tests provide `fakes.FixtureCatalog` under the
same keys. Nothing else in readiness may import catalog code.
"""

from api.modules.catalog.public import (
    CatalogQueryPort,
    CatalogReadPort,
    FileRef,
    ObjectMissing,
    StorageUnavailable,
    VersionView,
)

__all__ = [
    "CatalogQueryPort",
    "CatalogReadPort",
    "FileRef",
    "ObjectMissing",
    "StorageUnavailable",
    "VersionView",
]
```

`apps/api/modules/readiness/tests/test_catalog_port.py` (create):

```python
import api.modules.catalog.public as catalog_public
from api.modules.readiness import catalog_port


def test_catalog_port_reexports_the_m03_public_classes() -> None:
    """W1-D1: the registry key is the provider's public.py class, never a readiness-side copy."""
    assert catalog_port.CatalogQueryPort is catalog_public.CatalogQueryPort
    assert catalog_port.CatalogReadPort is catalog_public.CatalogReadPort
    assert catalog_port.FileRef is catalog_public.FileRef
    assert catalog_port.VersionView is catalog_public.VersionView
    assert catalog_port.ObjectMissing is catalog_public.ObjectMissing
    assert catalog_port.StorageUnavailable is catalog_public.StorageUnavailable
```

`apps/api/modules/readiness/profiles/GENERIC_BASIC.yaml` (create):

```yaml
profile_id: GENERIC_BASIC
version: "1.0.0"
name: 기본 AI-Ready 점검
description: 모든 PUBLISHED version에 자동 실행되는 메타데이터·출처·라이선스·무결성 기본 점검.
checks:
  - { check_id: metadata.completeness, severity: REQUIRED }
  - { check_id: provenance.presence, severity: REQUIRED }
  - { check_id: policy.license_usage, severity: REQUIRED }
  - { check_id: integrity.file_checksum, severity: REQUIRED }
  - { check_id: schema.presence, severity: RECOMMENDED }
  - { check_id: semantics.units_codebook, severity: RECOMMENDED }
  - { check_id: semantics.mapping_status, severity: RECOMMENDED }
parameters:
  sample_max_rows: 100000
  sample_max_bytes: 268435456
  max_tabular_files: 50
  checksum_max_total_bytes: 10737418240
  description_min_length: 50
  provenance_min_length: 50
  usage_policy_min_length: 20
  datatype_warn_ratio: 0.0
  datatype_fail_ratio: 0.01
  malformed_rows_fail_ratio: 0.001
  missing_warn_ratio: 0.05
  missing_fail_ratio: 0.5
  missing_overall_warn_ratio: 0.05
  unit_missing_fail_ratio: 0.2
  mapping_pass_ratio: 0.8
```

`apps/api/modules/readiness/profiles/TABULAR_ML_BASIC.yaml` (create):

```yaml
profile_id: TABULAR_ML_BASIC
version: "1.0.0"
name: 표 형식 ML 학습 준비 점검
description: 표 형식 파일(csv/tsv/parquet)이 있는 version에 자동 실행. 스키마·타입·결측·단위까지 점검한다.
checks:
  - { check_id: metadata.completeness, severity: REQUIRED }
  - { check_id: provenance.presence, severity: REQUIRED }
  - { check_id: policy.license_usage, severity: REQUIRED }
  - { check_id: integrity.file_checksum, severity: REQUIRED }
  - { check_id: schema.presence, severity: REQUIRED }
  - { check_id: schema.datatype_validity, severity: REQUIRED }
  - { check_id: data.missing_values, severity: RECOMMENDED }
  - { check_id: semantics.units_codebook, severity: REQUIRED }
  - { check_id: semantics.mapping_status, severity: RECOMMENDED }
parameters:
  sample_max_rows: 100000
  sample_max_bytes: 268435456
  max_tabular_files: 50
  checksum_max_total_bytes: 10737418240
  description_min_length: 50
  provenance_min_length: 50
  usage_policy_min_length: 20
  datatype_warn_ratio: 0.0
  datatype_fail_ratio: 0.01
  malformed_rows_fail_ratio: 0.001
  missing_warn_ratio: 0.05
  missing_fail_ratio: 0.5
  missing_overall_warn_ratio: 0.05
  unit_missing_fail_ratio: 0.2
  mapping_pass_ratio: 0.8
```

`apps/api/modules/readiness/profile_registry.py` (create):

```python
"""Profiles live in code (profiles/*.yaml), reviewed like code (M05 §4). Loaded once at import."""

from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

import yaml

Severity = Literal["REQUIRED", "RECOMMENDED"]
PROFILES_DIR = Path(__file__).parent / "profiles"
PROFILE_ORDER = ("GENERIC_BASIC", "TABULAR_ML_BASIC")
KNOWN_CHECKS = frozenset(
    {
        "metadata.completeness",
        "schema.presence",
        "schema.datatype_validity",
        "data.missing_values",
        "semantics.units_codebook",
        "provenance.presence",
        "policy.license_usage",
        "integrity.file_checksum",
        "semantics.mapping_status",
    }
)


@dataclass(frozen=True)
class ProfileParams:
    sample_max_rows: int
    sample_max_bytes: int
    max_tabular_files: int
    checksum_max_total_bytes: int
    description_min_length: int
    provenance_min_length: int
    usage_policy_min_length: int
    datatype_warn_ratio: float
    datatype_fail_ratio: float
    malformed_rows_fail_ratio: float
    missing_warn_ratio: float
    missing_fail_ratio: float
    missing_overall_warn_ratio: float
    unit_missing_fail_ratio: float
    mapping_pass_ratio: float


@dataclass(frozen=True)
class CheckSpec:
    check_id: str
    severity: Severity
    ordinal: int


@dataclass(frozen=True)
class Profile:
    profile_id: str
    version: str
    name: str
    description: str
    checks: tuple[CheckSpec, ...]
    params: ProfileParams

    def to_api(self) -> dict[str, Any]:
        return {
            "profile_id": self.profile_id,
            "version": self.version,
            "name": self.name,
            "description": self.description,
            "checks": [{"check_id": c.check_id, "severity": c.severity} for c in self.checks],
        }


def _load(path: Path) -> Profile:
    raw = yaml.safe_load(path.read_text(encoding="utf-8"))
    checks = tuple(
        CheckSpec(check_id=c["check_id"], severity=c["severity"], ordinal=i)
        for i, c in enumerate(raw["checks"], start=1)
    )
    unknown = {c.check_id for c in checks} - KNOWN_CHECKS
    if unknown or any(c.severity not in ("REQUIRED", "RECOMMENDED") for c in checks):
        raise ValueError(f"invalid profile {path.name}: unknown checks {sorted(unknown)}")
    if raw["profile_id"] != path.stem:
        raise ValueError(f"profile file {path.name} declares {raw['profile_id']}")
    return Profile(
        profile_id=raw["profile_id"],
        version=str(raw["version"]),
        name=raw["name"],
        description=raw["description"],
        checks=checks,
        params=ProfileParams(**raw["parameters"]),
    )


def load_profiles(directory: Path = PROFILES_DIR) -> dict[str, Profile]:
    loaded = {p.profile_id: p for p in map(_load, sorted(directory.glob("*.yaml")))}
    if set(loaded) != set(PROFILE_ORDER):
        raise ValueError(f"expected profiles {PROFILE_ORDER}, found {tuple(loaded)}")
    return {name: loaded[name] for name in PROFILE_ORDER}


PROFILES: dict[str, Profile] = load_profiles()
```

`apps/api/modules/readiness/__init__.py` (create):

```python
"""M05 AI-Ready Pipeline (readiness): deterministic validation of PUBLISHED dataset versions."""

from api.platform.modules import ModuleSpec

MODULE = ModuleSpec(name="readiness", db_schema="readiness")
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
uv run pytest apps/api/modules/readiness/tests/test_profiles.py apps/api/modules/readiness/tests/test_catalog_port.py -q
uv run ruff check apps/api/modules/readiness tests/fixtures && uv run ruff format --check apps/api/modules/readiness tests/fixtures
```
Expected: `8 passed`; ruff clean.

- [ ] **Step 6: Commit**

```bash
git add apps/api/modules/readiness/__init__.py apps/api/modules/readiness/catalog_port.py apps/api/modules/readiness/profile_registry.py apps/api/modules/readiness/profiles/GENERIC_BASIC.yaml apps/api/modules/readiness/profiles/TABULAR_ML_BASIC.yaml apps/api/modules/readiness/settings.py apps/api/modules/readiness/tests/__init__.py apps/api/modules/readiness/tests/test_profiles.py apps/api/modules/readiness/tests/test_catalog_port.py pyproject.toml uv.lock
git commit -m "feat(readiness): module skeleton, profiles and catalog port re-export" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```


---

### Task 2: Canonical JSON, evidence bound, manifest and input fingerprint

09 §4 determinism primitives and D-029 fingerprint; M03 §4.9 manifest (re-computed by the checksum check).

**Files:**
- Create: `apps/api/modules/readiness/engine/__init__.py`
- Create: `apps/api/modules/readiness/engine/canonical.py`
- Test: `apps/api/modules/readiness/tests/test_canonical.py`

**Interfaces:**
- Consumes: `catalog_port.FileRef` (Task 1).
- Produces: `engine.VALIDATOR_VERSION = "1.0.0"`; `engine.canonical`: `EVIDENCE_MAX_BYTES = 65536`, `r6(float) -> float`, `ratio(int, int) -> float` (0.0 on zero denominator), `canonical_json(obj) -> str`, `sha256_hex(str) -> str`, `bound_evidence(dict, limit=EVIDENCE_MAX_BYTES) -> dict`, `manifest_sha256(Iterable[FileRef]) -> str`, `metadata_snapshot_sha256(dict) -> str`, `input_fingerprint(manifest, snapshot, profile_id, profile_version, validator_version) -> str`.

- [ ] **Step 1: Write the failing test**

`apps/api/modules/readiness/tests/test_canonical.py` (create):

```python
import hashlib
import math
import uuid

import pytest

from api.modules.readiness.catalog_port import FileRef
from api.modules.readiness.engine.canonical import (
    EVIDENCE_MAX_BYTES,
    bound_evidence,
    canonical_json,
    input_fingerprint,
    manifest_sha256,
    metadata_snapshot_sha256,
    ratio,
)


def test_canonical_json_sorts_keys_keeps_unicode_and_array_order() -> None:
    assert canonical_json({"b": [3, 1], "a": "측정"}) == '{"a":"측정","b":[3,1]}'


def test_canonical_json_rejects_nan() -> None:
    with pytest.raises(ValueError):
        canonical_json({"x": math.nan})


def test_ratio_rounds_to_six_places_and_handles_zero_denominator() -> None:
    assert ratio(1, 3) == 0.333333
    assert ratio(3, 990) == 0.00303
    assert ratio(5, 0) == 0.0


def test_bound_evidence_leaves_small_evidence_untouched() -> None:
    evidence = {"fields": [{"path": "a.csv"}]}
    assert bound_evidence(evidence) is evidence


def test_bound_evidence_truncates_largest_array_and_marks_it() -> None:
    evidence = {
        "fields": [{"path": f"data/{i:06d}.csv", "field": "x" * 50} for i in range(5000)],
        "count": 5000,
    }
    bounded = bound_evidence(evidence)
    assert bounded["truncated"] is True
    assert bounded["count"] == 5000
    assert 0 < len(bounded["fields"]) < 5000
    assert bounded["fields"][0] == evidence["fields"][0]  # keeps the sorted prefix
    assert len(canonical_json(bounded).encode()) <= EVIDENCE_MAX_BYTES
    assert len(evidence["fields"]) == 5000  # input not mutated


def test_input_fingerprint_is_d029_joined_with_pipes() -> None:
    snapshot = {"title": "t", "license": "MIT"}
    snap_sha = hashlib.sha256(canonical_json(snapshot).encode()).hexdigest()
    assert metadata_snapshot_sha256(snapshot) == snap_sha
    expected = hashlib.sha256(f"{'a' * 64}|{snap_sha}|GENERIC_BASIC|1.0.0|1.0.0".encode()).hexdigest()
    assert input_fingerprint("a" * 64, snapshot, "GENERIC_BASIC", "1.0.0", "1.0.0") == expected


def test_fingerprint_changes_with_snapshot_and_versions() -> None:
    base = input_fingerprint("a" * 64, {"title": "t"}, "GENERIC_BASIC", "1.0.0", "1.0.0")
    assert input_fingerprint("a" * 64, {"title": "u"}, "GENERIC_BASIC", "1.0.0", "1.0.0") != base
    assert input_fingerprint("a" * 64, {"title": "t"}, "GENERIC_BASIC", "1.0.0", "1.0.1") != base
    assert input_fingerprint("a" * 64, {"title": "t"}, "TABULAR_ML_BASIC", "1.0.0", "1.0.0") != base


def test_manifest_sha256_matches_m03_definition() -> None:
    def ref(path: str, size: int, sha: str) -> FileRef:
        return FileRef(uuid.uuid4(), path, size, sha, "text/csv", "VERIFIED", "b", f"k/{path}")

    files = [ref("b.csv", 2, "2" * 64), ref("README.md", 1, "1" * 64), ref("a/z.csv", 3, "3" * 64)]
    text = f"README.md\t1\t{'1' * 64}\na/z.csv\t3\t{'3' * 64}\nb.csv\t2\t{'2' * 64}\n"
    assert manifest_sha256(files) == hashlib.sha256(text.encode()).hexdigest()
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
uv run pytest apps/api/modules/readiness/tests/test_canonical.py -q
```
Expected: collection error, `ModuleNotFoundError: No module named 'api.modules.readiness.engine'`.

- [ ] **Step 3: Implement**

`apps/api/modules/readiness/engine/__init__.py` (create):

```python
"""Deterministic readiness engine (09_AI_READY_RULES.md). No DB, no network, no clock in any verdict."""

VALIDATOR_VERSION = "1.0.0"
"""Bump when rule code, bundled dictionaries (UCUM, SPDX, aliases) or a parser library major version change."""
```

`apps/api/modules/readiness/engine/canonical.py` (create):

```python
"""Canonical JSON, rounding, evidence bounds, manifest and fingerprints (09 §4, M03 §4.9, D-029)."""

import copy
import hashlib
import json
from collections.abc import Iterable
from typing import Any

from api.modules.readiness.catalog_port import FileRef

EVIDENCE_MAX_BYTES = 64 * 1024


def r6(value: float) -> float:
    return round(float(value), 6)


def ratio(numerator: int, denominator: int) -> float:
    return r6(numerator / denominator) if denominator else 0.0


def canonical_json(obj: Any) -> str:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False)


def sha256_hex(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _size(obj: Any) -> int:
    return len(canonical_json(obj).encode("utf-8"))


def bound_evidence(evidence: dict[str, Any], limit: int = EVIDENCE_MAX_BYTES) -> dict[str, Any]:
    """M05 §4.2: evidence <= 64 KiB. Halve the largest top-level array until it fits, mark truncated."""
    if _size(evidence) <= limit:
        return evidence
    bounded = copy.deepcopy(evidence)
    bounded["truncated"] = True
    while _size(bounded) > limit:
        arrays = [(_size(v), k) for k, v in bounded.items() if isinstance(v, list) and v]
        if not arrays:
            break
        _, key = max(arrays)
        bounded[key] = bounded[key][: len(bounded[key]) // 2]
    return bounded


def manifest_sha256(files: Iterable[FileRef]) -> str:
    """M03 §4.9: sorted by UTF-8 path bytes, one "path\\tsize\\tsha256\\n" line per file."""
    ordered = sorted(files, key=lambda f: f.path.encode("utf-8"))
    return sha256_hex("".join(f"{f.path}\t{f.size_bytes}\t{f.sha256}\n" for f in ordered))


def metadata_snapshot_sha256(snapshot: dict[str, Any]) -> str:
    return sha256_hex(canonical_json(snapshot))


def input_fingerprint(
    manifest: str, snapshot: dict[str, Any], profile_id: str, profile_version: str, validator_version: str
) -> str:
    """D-029: manifest + metadata snapshot + profile id/version + validator version, '|'-joined (09 §4 form)."""
    parts = [manifest, metadata_snapshot_sha256(snapshot), profile_id, profile_version, validator_version]
    return sha256_hex("|".join(parts))
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
uv run pytest apps/api/modules/readiness/tests/test_canonical.py -q
uv run ruff check apps/api/modules/readiness tests/fixtures && uv run ruff format --check apps/api/modules/readiness tests/fixtures
```
Expected: `8 passed`; ruff clean.

- [ ] **Step 5: Commit**

```bash
git add apps/api/modules/readiness/engine/__init__.py apps/api/modules/readiness/engine/canonical.py apps/api/modules/readiness/tests/test_canonical.py
git commit -m "feat(readiness): canonical json, evidence bound, manifest and fingerprint" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```


---

### Task 3: Golden fixtures (generate.py, fixtures.lock) and the FixtureCatalog fake

09 §5 fixtures are owned by M05 and generated once by a deterministic script, then committed. Their `files/**` bytes come from M03's `api.modules.catalog.seed_files.fixture_files(fixture)` (W1-D5: M03 is the single source; `fixtures.lock` pins the 09-conformant bytes). `FixtureCatalog` is the in-module fake of M03's `CatalogQueryPort` + `CatalogReadPort` (M05 §3.1): it serves versions from fixture files on disk or from in-memory bytes.

**Files:**
- Create: `tests/fixtures/readiness/generate.py`
- Create: `apps/api/modules/readiness/fakes.py`
- Create: `apps/api/modules/readiness/tests/helpers.py`
- Test: `apps/api/modules/readiness/tests/test_fixtures.py`

**Interfaces:**
- Consumes: `engine.canonical.manifest_sha256` (Task 2), `catalog_port` types (Task 1), M03 `api.modules.catalog.seed_files.fixture_files(fixture: str) -> dict[str, bytes]`, M03 `api.modules.catalog.public.DatasetPolicyView`.
- Produces: `fakes.FIXTURES_ROOT`, `fakes.FixtureCatalog` with `add_version(files: dict[str, Path | bytes], snapshot, *, owner_organization_id, status="PUBLISHED", dataset_id=None, dataset_version_id=None, access_level=None) -> VersionView`, `add_fixture(name, *, owner_organization_id, **kw) -> VersionView`, `replace_view(view)`, `delete_object(version_id, path)`, `get_version`, `is_visible` (D-012), `open_stream` (raises `fail_reads` if set, `ObjectMissing` when deleted), attributes `reads: list[str]`, `live_metadata: dict[UUID, dict]`; `tests/helpers.py`: `ORG_NAIS/ORG_A/ORG_B`, `USERS` (seed ids), `FIXTURE_NAMES`, `clean_snapshot()`, `fixture_files(name) -> dict[str, bytes]`; fixture tree under `tests/fixtures/readiness/` with `expected/*.json` (`result_sha256: null` until Task 10).

- [ ] **Step 1: Write the failing test**

`apps/api/modules/readiness/tests/helpers.py` (create):

```python
"""Shared constants and fixture readers for readiness tests (no DB, no engine)."""

import json
from typing import Any
from uuid import UUID

from api.modules.readiness.fakes import FIXTURES_ROOT
from api.platform.auth import CurrentUser

ORG_NAIS = UUID("00000000-0000-7000-8000-000000000001")
ORG_A = UUID("00000000-0000-7000-8000-00000000000a")
ORG_B = UUID("00000000-0000-7000-8000-00000000000b")
FIXTURE_NAMES = ("clean_tabular", "missing_metadata", "invalid_units", "missing_provenance")


def _user(
    suffix: str, org: UUID, name: str, org_roles: set[str] | None = None, admin: bool = False
) -> CurrentUser:
    return CurrentUser(
        user_id=UUID(f"00000000-0000-7000-8000-00000000{suffix}"),
        organization_id=org,
        org_roles=frozenset(org_roles or set()),
        platform_roles=frozenset({"PLATFORM_ADMIN"} if admin else set()),
        session_id=f"s-{suffix}",
        display_name=name,
    )


USERS: dict[str, CurrentUser] = {  # 10_SEED_DATA.md §3 ids
    "admin": _user("0101", ORG_NAIS, "NAIS Admin", {"ORG_ADMIN"}, admin=True),
    "a_researcher": _user("0a02", ORG_A, "A Researcher"),
    "a_steward": _user("0a03", ORG_A, "A Steward", {"DATA_STEWARD"}),
    "b_researcher": _user("0b02", ORG_B, "B Researcher"),
    "b_steward": _user("0b03", ORG_B, "B Steward", {"DATA_STEWARD"}),
}


def clean_snapshot() -> dict[str, Any]:
    return json.loads((FIXTURES_ROOT / "clean_tabular" / "dataset.json").read_text(encoding="utf-8"))  # type: ignore[no-any-return]


def fixture_files(name: str = "clean_tabular") -> dict[str, bytes]:
    base = FIXTURES_ROOT / name / "files"
    return {p.relative_to(base).as_posix(): p.read_bytes() for p in sorted(base.rglob("*")) if p.is_file()}
```

`apps/api/modules/readiness/tests/test_fixtures.py` (create):

```python
import hashlib
import importlib.util
import json
from types import ModuleType

from api.modules.catalog.seed_files import fixture_files as catalog_fixture_files
from api.modules.readiness.engine import VALIDATOR_VERSION
from api.modules.readiness.engine.canonical import manifest_sha256
from api.modules.readiness.fakes import FIXTURES_ROOT, FixtureCatalog
from api.modules.readiness.tests.helpers import FIXTURE_NAMES, ORG_A, ORG_B, USERS


def _generator() -> ModuleType:
    spec = importlib.util.spec_from_file_location("readiness_fixture_generate", FIXTURES_ROOT / "generate.py")
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_fixture_files_match_the_lock() -> None:
    entries = (FIXTURES_ROOT / "fixtures.lock").read_text(encoding="utf-8").splitlines()
    assert len(entries) == 4 * 5  # dataset.json + 4 files per fixture
    for line in entries:
        digest, rel = line.split("  ", 1)
        assert hashlib.sha256((FIXTURES_ROOT / rel).read_bytes()).hexdigest() == digest, f"{rel} was modified"


def test_generator_reproduces_committed_inputs() -> None:
    generate = _generator()
    assert generate.VALIDATOR_VERSION == VALIDATOR_VERSION
    for name in FIXTURE_NAMES:
        dataset, files = generate.fixture_inputs(name)
        assert json.loads((FIXTURES_ROOT / name / "dataset.json").read_text(encoding="utf-8")) == dataset
        for rel, data in files.items():
            assert (FIXTURES_ROOT / name / "files" / rel).read_bytes() == data, f"{name}/{rel}"


def test_committed_files_equal_catalog_seed_files() -> None:
    """W1-D5: M03's seed_files generator is the single source of the fixture bytes (catalog seed == golden)."""
    for name in FIXTURE_NAMES:
        committed = {
            p.relative_to(FIXTURES_ROOT / name / "files").as_posix(): p.read_bytes()
            for p in sorted((FIXTURES_ROOT / name / "files").rglob("*"))
            if p.is_file()
        }
        assert committed == catalog_fixture_files(name), name


def test_measurements_csv_follows_the_formula() -> None:
    text = (FIXTURES_ROOT / "clean_tabular/files/data/measurements.csv").read_text(encoding="utf-8")
    lines = text.splitlines()
    assert lines[0] == "sample_id,material,temperature_c,pressure_kpa,measured_at"
    assert len(lines) == 1001
    assert lines[1] == "S0001,CU,20.5,102.325,2026-01-01T00:01:00Z"
    assert lines[100] == "S0100,CU,20.0,,2026-01-01T01:40:00Z"
    assert sum(1 for line in lines[1:] if line.split(",")[3] == "") == 10


def test_fake_catalog_serves_a_published_fixture() -> None:
    catalog = FixtureCatalog()
    view = catalog.add_fixture("clean_tabular", owner_organization_id=ORG_B)
    assert [f.path for f in view.files] == [
        "README.md",
        "_codebook.csv",
        "_schema.json",
        "data/measurements.csv",
    ]
    assert view.manifest_sha256 == manifest_sha256(view.files)
    assert view.metadata_snapshot is not None and view.metadata_snapshot["license"] == "CC-BY-4.0"
    ref = view.files[3]
    with catalog.open_stream(ref) as stream:
        assert hashlib.sha256(stream.read()).hexdigest() == ref.sha256
    assert catalog.get_version(view.dataset_version_id) == view


def test_fake_catalog_visibility_follows_d012() -> None:
    catalog = FixtureCatalog()
    internal = catalog.add_fixture("invalid_units", owner_organization_id=ORG_B, access_level="INTERNAL")
    controlled = catalog.add_fixture("clean_tabular", owner_organization_id=ORG_B)
    assert not catalog.is_visible(USERS["a_researcher"], internal.dataset_id)
    assert catalog.is_visible(USERS["b_researcher"], internal.dataset_id)
    assert catalog.is_visible(USERS["admin"], internal.dataset_id)
    assert catalog.is_visible(USERS["a_researcher"], controlled.dataset_id)
    draft = catalog.add_version({}, None, owner_organization_id=ORG_A, status="DRAFT")
    assert draft.metadata_snapshot is None and draft.manifest_sha256 is None


def test_fake_catalog_policy_view_satisfies_the_m03_port() -> None:
    catalog = FixtureCatalog()
    view = catalog.add_fixture("clean_tabular", owner_organization_id=ORG_B)
    policy = catalog.get_policy_view(view.dataset_id)
    assert policy is not None and policy.owner_organization_id == ORG_B
    assert (policy.access_level, policy.status) == ("CONTROLLED", "ACTIVE")
    assert policy.title == "고분자 전해질 막 온도-압력 측정"
    assert catalog.get_policy_view(ORG_A) is None
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
uv run pytest apps/api/modules/readiness/tests/test_fixtures.py -q
```
Expected: collection error, `ModuleNotFoundError: No module named 'api.modules.readiness.fakes'`.

- [ ] **Step 3: Implement**

`tests/fixtures/readiness/generate.py` (create):

```python
"""Regenerate the M05 readiness fixtures (09_AI_READY_RULES.md §5). Deterministic: no randomness, no clock.

Run from the repo root:  uv run python tests/fixtures/readiness/generate.py
Writes <fixture>/dataset.json, <fixture>/files/**, <fixture>/expected/*.json (keeps an already recorded
result_sha256) and fixtures.lock (sha256 of every input file). Commit the output.

W1-D5: the files/** bytes are NOT built here. They come from M03's `api.modules.catalog.seed_files.fixture_files`
(the catalog seed uploads the same files), so the golden fixtures and the seeded datasets are byte-identical by
construction. fixtures.lock pins the 09 §1.2/§5-conformant bytes; if M03's generator drifts, the lock test fails.
"""

import copy
import hashlib
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT.parents[2] / "apps"))  # script run from the repo root; pytest already has `apps`

from api.modules.catalog.seed_files import fixture_files  # noqa: E402

FIXTURES = ("clean_tabular", "missing_metadata", "invalid_units", "missing_provenance")
VALIDATOR_VERSION = "1.0.0"  # must equal api.modules.readiness.engine.VALIDATOR_VERSION

CLEAN_DATASET = {
    "title": "고분자 전해질 막 온도-압력 측정",
    "description": (
        "연료전지용 고분자 전해질 막 시편 1,000개에 대해 온도와 압력을 측정한 표 형식 데이터셋이다. "
        "재료 코드는 codebook에 정의되어 있다."
    ),
    "keywords": ["fuel-cell", "membrane", "temperature", "pressure"],
    "domain": "materials",
    "access_level": "CONTROLLED",
    "license": "CC-BY-4.0",
    "usage_policy": "학술 연구 및 AI 학습 목적에 한해 사용한다. 재배포 금지. 결과 공개 시 출처를 표기한다.",
    "allowed_purposes": ["ACADEMIC_RESEARCH", "AI_TRAINING"],
    "max_grant_days": 180,
    "contact_email": "steward@inst-b.example",
    "provenance": (
        "Institute B 연료전지 실험실의 환경 챔버(모델 EC-200)에서 2026년 1월 1일 1분 간격으로 "
        "자동 수집한 측정값."
    ),
}

def fixture_inputs(name: str) -> tuple[dict[str, object], dict[str, bytes]]:
    dataset: dict[str, object] = copy.deepcopy(CLEAN_DATASET)
    if name == "missing_metadata":
        dataset.update(description="측정 데이터", keywords=[], domain=None, contact_email=None)
    elif name == "missing_provenance":
        dataset["provenance"] = None
    return dataset, fixture_files(name)


# 09_AI_READY_RULES.md §5.6 (GENERIC_BASIC has no datatype_validity / missing_values).
GOLDEN: dict[str, dict[str, str]] = {
    "clean_tabular": {},
    "missing_metadata": {"metadata.completeness": "FAIL"},
    "invalid_units": {"semantics.units_codebook": "FAIL"},
    "missing_provenance": {"provenance.presence": "FAIL"},
}
OVERALL = {
    "clean_tabular": {"GENERIC_BASIC": "PASS", "TABULAR_ML_BASIC": "PASS"},
    "missing_metadata": {"GENERIC_BASIC": "FAIL", "TABULAR_ML_BASIC": "FAIL"},
    "invalid_units": {"GENERIC_BASIC": "WARNING", "TABULAR_ML_BASIC": "FAIL"},
    "missing_provenance": {"GENERIC_BASIC": "FAIL", "TABULAR_ML_BASIC": "FAIL"},
}
PROFILE_CHECKS = {
    "GENERIC_BASIC": [
        "metadata.completeness",
        "provenance.presence",
        "policy.license_usage",
        "integrity.file_checksum",
        "schema.presence",
        "semantics.units_codebook",
        "semantics.mapping_status",
    ],
    "TABULAR_ML_BASIC": [
        "metadata.completeness",
        "provenance.presence",
        "policy.license_usage",
        "integrity.file_checksum",
        "schema.presence",
        "schema.datatype_validity",
        "data.missing_values",
        "semantics.units_codebook",
        "semantics.mapping_status",
    ],
}


def expected(name: str, profile_id: str, previous: dict[str, object] | None) -> dict[str, object]:
    checks = {check: GOLDEN[name].get(check, "PASS") for check in PROFILE_CHECKS[profile_id]}
    return {
        "profile_id": profile_id,
        "profile_version": "1.0.0",
        "validator_version": VALIDATOR_VERSION,
        "overall_status": OVERALL[name][profile_id],
        "checks": checks,
        "result_sha256": previous.get("result_sha256") if previous else None,
    }


def write(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)


def dump(obj: object) -> bytes:
    return (json.dumps(obj, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


def main() -> None:
    lock: list[str] = []
    for name in FIXTURES:
        dataset, files = fixture_inputs(name)
        base = ROOT / name
        write(base / "dataset.json", dump(dataset))
        for rel, data in files.items():
            write(base / "files" / rel, data)
        for profile_id in PROFILE_CHECKS:
            target = base / "expected" / f"{profile_id}.json"
            previous = json.loads(target.read_text(encoding="utf-8")) if target.exists() else None
            write(target, dump(expected(name, profile_id, previous)))
        for path in [base / "dataset.json", *sorted((base / "files").rglob("*"))]:
            if path.is_file():
                digest = hashlib.sha256(path.read_bytes()).hexdigest()
                lock.append(f"{digest}  {path.relative_to(ROOT).as_posix()}")
    (ROOT / "fixtures.lock").write_text("\n".join(lock) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
```

`apps/api/modules/readiness/fakes.py` (create):

```python
"""In-module fake of M03's CatalogQueryPort + CatalogReadPort (api.modules.catalog.public; mock-first, 02 §4).

Serves versions built from files on disk (tests/fixtures/readiness/<fixture>/files) or from in-memory bytes.
Used by the readiness tests and by `python -m api.modules.readiness.selfcheck`. Never wired in production.
"""

import hashlib
import io
import json
import uuid
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any, BinaryIO
from uuid import UUID

from api.modules.catalog.public import DatasetPolicyView
from api.modules.readiness.catalog_port import FileRef, ObjectMissing, VersionView
from api.modules.readiness.engine.canonical import manifest_sha256
from api.platform.auth import CurrentUser
from api.platform.settings import REPO_ROOT

FIXTURES_ROOT = REPO_ROOT / "tests" / "fixtures" / "readiness"
_MEDIA_TYPES = {
    ".csv": "text/csv",
    ".tsv": "text/tab-separated-values",
    ".parquet": "application/vnd.apache.parquet",
    ".json": "application/json",
    ".md": "text/markdown",
}


def _sha256_of(source: Path | bytes) -> tuple[str, int]:
    if isinstance(source, bytes):
        return hashlib.sha256(source).hexdigest(), len(source)
    digest = hashlib.sha256()
    size = 0
    with source.open("rb") as fh:
        while chunk := fh.read(1 << 20):
            digest.update(chunk)
            size += len(chunk)
    return digest.hexdigest(), size


@dataclass
class _Entry:
    view: VersionView
    access_level: str
    sources: dict[str, Path | bytes]  # storage_key -> content


@dataclass
class FixtureCatalog:
    """Implements CatalogQueryPort and CatalogReadPort. `fail_reads` simulates a storage outage."""

    fail_reads: Exception | None = None
    reads: list[str] = field(default_factory=list)
    live_metadata: dict[UUID, dict[str, Any]] = field(default_factory=dict)  # dataset_id -> live metadata
    _versions: dict[UUID, _Entry] = field(default_factory=dict)

    def add_version(
        self,
        files: dict[str, Path | bytes],
        snapshot: dict[str, Any] | None,
        *,
        owner_organization_id: UUID,
        status: str = "PUBLISHED",
        dataset_id: UUID | None = None,
        dataset_version_id: UUID | None = None,
        access_level: str | None = None,
    ) -> VersionView:
        dataset_id = dataset_id or uuid.uuid4()
        version_id = dataset_version_id or uuid.uuid4()
        refs: list[FileRef] = []
        sources: dict[str, Path | bytes] = {}
        for path in sorted(files, key=lambda p: p.encode("utf-8")):
            sha, size = _sha256_of(files[path])
            key = f"datasets/{dataset_id}/{version_id}/{path}"
            sources[key] = files[path]
            refs.append(
                FileRef(
                    file_id=uuid.uuid5(version_id, path),
                    path=path,
                    size_bytes=size,
                    sha256=sha,
                    media_type=_MEDIA_TYPES.get(Path(path).suffix.lower(), "application/octet-stream"),
                    status="VERIFIED",
                    storage_bucket="nais-fake",
                    storage_key=key,
                )
            )
        published = status == "PUBLISHED"
        level = access_level or (snapshot or {}).get("access_level") or "INTERNAL"
        snap = {**(snapshot or {}), "access_level": level} if published else None
        view = VersionView(
            dataset_version_id=version_id,
            dataset_id=dataset_id,
            owner_organization_id=owner_organization_id,
            version_label="v1",
            status=status,  # type: ignore[arg-type]
            manifest_sha256=manifest_sha256(refs) if published else None,
            metadata_snapshot=snap,
            files=tuple(refs),
        )
        self._versions[version_id] = _Entry(view, level, sources)
        self.live_metadata[dataset_id] = dict(snap or snapshot or {})
        return view

    def add_fixture(self, name: str, *, owner_organization_id: UUID, **kwargs: Any) -> VersionView:
        base = FIXTURES_ROOT / name
        snapshot = json.loads((base / "dataset.json").read_text(encoding="utf-8"))
        files: dict[str, Path | bytes] = {
            p.relative_to(base / "files").as_posix(): p for p in (base / "files").rglob("*") if p.is_file()
        }
        return self.add_version(files, snapshot, owner_organization_id=owner_organization_id, **kwargs)

    def replace_view(self, view: VersionView) -> None:
        """Swap the served view (e.g. to fake a tampered sha256 or manifest)."""
        self._versions[view.dataset_version_id] = replace(self._versions[view.dataset_version_id], view=view)

    def delete_object(self, dataset_version_id: UUID, path: str) -> None:
        entry = self._versions[dataset_version_id]
        [ref] = [f for f in entry.view.files if f.path == path]
        del entry.sources[ref.storage_key]

    # ---- CatalogQueryPort (full M03 Protocol, so it can be provided under the M03 key)
    def get_policy_view(self, dataset_id: UUID) -> DatasetPolicyView | None:
        for entry in self._versions.values():
            if entry.view.dataset_id != dataset_id:
                continue
            meta = self.live_metadata.get(dataset_id, {})
            return DatasetPolicyView(
                dataset_id=dataset_id,
                owner_organization_id=entry.view.owner_organization_id,
                access_level=entry.access_level,  # type: ignore[arg-type]
                allowed_purposes=tuple(meta.get("allowed_purposes") or ()),
                approval_required=entry.access_level in ("CONTROLLED", "SENSITIVE"),
                max_grant_days=int(meta.get("max_grant_days") or 180),
                status="ACTIVE",
                title=str(meta.get("title") or ""),
            )
        return None

    def get_version(self, dataset_version_id: UUID) -> VersionView | None:
        entry = self._versions.get(dataset_version_id)
        return entry.view if entry else None

    def is_visible(self, ctx: CurrentUser, dataset_id: UUID) -> bool:
        """D-012: INTERNAL metadata only for owner-org members (and platform admins); others for everyone."""
        for entry in self._versions.values():
            if entry.view.dataset_id != dataset_id:
                continue
            if entry.access_level != "INTERNAL":
                return True
            return ctx.is_platform_admin or ctx.organization_id == entry.view.owner_organization_id
        return False

    # ---- CatalogReadPort
    def open_stream(self, file: FileRef, byte_range: tuple[int, int] | None = None) -> BinaryIO:
        if byte_range is not None:
            raise NotImplementedError("readiness never reads byte ranges")
        if self.fail_reads is not None:
            raise self.fail_reads
        for entry in self._versions.values():
            source = entry.sources.get(file.storage_key)
            if source is not None:
                self.reads.append(file.path)
                return io.BytesIO(source) if isinstance(source, bytes) else source.open("rb")
        raise ObjectMissing(file.path)
```

- [ ] **Step 4: Generate the fixtures (commit the output)**

```bash
uv run python tests/fixtures/readiness/generate.py
find tests/fixtures/readiness -type f | sort
cat tests/fixtures/readiness/fixtures.lock
```
Expected: 4 fixture directories, each with `dataset.json`, `files/README.md`, `files/_codebook.csv`, `files/_schema.json`, `files/data/measurements.csv` and `expected/{GENERIC_BASIC,TABULAR_ML_BASIC}.json` (`"result_sha256": null`). `fixtures.lock` must read exactly:

```text
12505286fce8ee26041021f34c871ea67e1e74a797071b6ae2ca3ef52c40346d  clean_tabular/dataset.json
88be8b70c07a95412db9b0b0ca1d2dc4bcd14be5755af580d6f2c820b182c7aa  clean_tabular/files/README.md
4265d09fed27a06f91d28383236e6757a520a2f4c9fd538c0383d832ee0489a9  clean_tabular/files/_codebook.csv
9491e70abaf9671da301335707a9b63f4c049f3c4b8a9f1fe1e111ba7f7251e3  clean_tabular/files/_schema.json
eab038a6519381749bdf1fe3363c99baecbeeb349ed3b568c8524bd131127300  clean_tabular/files/data/measurements.csv
a0c880644676a46f9e72fb2ba80bb3a081a75afafbc18cf1a74afe99e887da24  missing_metadata/dataset.json
88be8b70c07a95412db9b0b0ca1d2dc4bcd14be5755af580d6f2c820b182c7aa  missing_metadata/files/README.md
4265d09fed27a06f91d28383236e6757a520a2f4c9fd538c0383d832ee0489a9  missing_metadata/files/_codebook.csv
9491e70abaf9671da301335707a9b63f4c049f3c4b8a9f1fe1e111ba7f7251e3  missing_metadata/files/_schema.json
eab038a6519381749bdf1fe3363c99baecbeeb349ed3b568c8524bd131127300  missing_metadata/files/data/measurements.csv
12505286fce8ee26041021f34c871ea67e1e74a797071b6ae2ca3ef52c40346d  invalid_units/dataset.json
88be8b70c07a95412db9b0b0ca1d2dc4bcd14be5755af580d6f2c820b182c7aa  invalid_units/files/README.md
4265d09fed27a06f91d28383236e6757a520a2f4c9fd538c0383d832ee0489a9  invalid_units/files/_codebook.csv
a33e0ca6cd0dadd9b080cd581d6aa1ffc094a93817c0f924a9694fc954e6b95a  invalid_units/files/_schema.json
eab038a6519381749bdf1fe3363c99baecbeeb349ed3b568c8524bd131127300  invalid_units/files/data/measurements.csv
eee08acde0b1c648386efe3bec0a8306fc2bc3f8e572599b86eda02610231628  missing_provenance/dataset.json
66c0ef10e36611103c3d660e1ac4de37a753267fbd7a4ce887b768c66f753d28  missing_provenance/files/README.md
4265d09fed27a06f91d28383236e6757a520a2f4c9fd538c0383d832ee0489a9  missing_provenance/files/_codebook.csv
9491e70abaf9671da301335707a9b63f4c049f3c4b8a9f1fe1e111ba7f7251e3  missing_provenance/files/_schema.json
eab038a6519381749bdf1fe3363c99baecbeeb349ed3b568c8524bd131127300  missing_provenance/files/data/measurements.csv
```
Re-running the script must leave `git status` clean (it is deterministic).

- [ ] **Step 5: Run the tests to verify they pass**

```bash
uv run pytest apps/api/modules/readiness/tests/test_fixtures.py -q
uv run ruff check apps/api/modules/readiness tests/fixtures && uv run ruff format --check apps/api/modules/readiness tests/fixtures
```
Expected: `7 passed`; ruff clean. If `fixtures.lock` differs from the listing above or `test_committed_files_equal_catalog_seed_files` fails, M03's `seed_files.py` is not 09 §1.2/§5-conformant: stop and report to the controller (do not edit catalog code from this plan).

- [ ] **Step 6: Commit**

```bash
git add apps/api/modules/readiness/fakes.py apps/api/modules/readiness/tests/helpers.py apps/api/modules/readiness/tests/test_fixtures.py tests/fixtures/readiness
git commit -m "test(readiness): golden fixtures, lock file and FixtureCatalog fake" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```


---

### Task 4: Streaming CSV/parquet profiling (09 §1.4 parse rules, §3.3 type rules)

One pass per tabular file produces per-column statistics that the schema, datatype, missing and units checks share (M05 §10). Values are never kept; csv values stay `str`; parquet uses `ParquetFile.iter_batches`; no pandas.

**Files:**
- Create: `apps/api/modules/readiness/engine/parsing.py`
- Test: `apps/api/modules/readiness/tests/test_parsing.py`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `engine.parsing`: `DEFAULT_MISSING`, `FIRST_ROWS_LIMIT = 10`, `FileTimeout`, `Deadline = Callable[[], None]`, `is_valid_value(declared_type, value) -> bool`, `ColumnPlan(declared_type=None, codes=None)`, `FilePlan(missing_tokens=DEFAULT_MISSING, columns={})`, `ColumnStats(missing, checked, invalid, first_invalid_rows, undefined_codes)`, `FileStats(path, header, sampled_rows, rows_read, truncated, malformed_rows, encoding_error, columns, parquet_types, parquet_numeric)` + `.duplicate_columns`, `profile_csv(stream, *, path, delimiter, plan, max_rows, max_bytes, deadline) -> FileStats`, `profile_parquet(stream, *, path, plan, max_rows, max_bytes, deadline) -> FileStats`, `is_numeric_arrow_type(arrow_type) -> bool`.

- [ ] **Step 1: Write the failing test**

`apps/api/modules/readiness/tests/test_parsing.py` (create):

```python
import io

import pyarrow as pa
import pyarrow.parquet as pq
import pytest

from api.modules.readiness.engine.parsing import (
    ColumnPlan,
    FilePlan,
    FileStats,
    FileTimeout,
    is_valid_value,
    profile_csv,
    profile_parquet,
)


def no_deadline() -> None:
    return None


def _csv(
    data: bytes, plan: FilePlan | None = None, max_rows: int = 100_000, max_bytes: int = 1 << 28
) -> FileStats:
    return profile_csv(
        io.BytesIO(data),
        path="d.csv",
        delimiter=",",
        plan=plan or FilePlan(),
        max_rows=max_rows,
        max_bytes=max_bytes,
        deadline=no_deadline,
    )


@pytest.mark.parametrize(
    ("declared", "value", "ok"),
    [
        ("integer", "+42", True),
        ("integer", "4.0", False),
        ("integer", "٣", False),  # non-ASCII digit
        ("number", "1e-3", True),
        ("number", ".5", True),
        ("number", "5.", True),
        ("number", "NaN", False),
        ("number", "Infinity", False),
        ("number", "1,5", False),
        ("boolean", "TRUE", True),
        ("boolean", "yes", False),
        ("date", "2026-02-28", True),
        ("date", "2026-02-30", False),
        ("datetime", "2026-01-01T00:01:00Z", True),
        ("datetime", "2026-01-01T00:01:00.5+09:00", True),
        ("datetime", "2026-01-01T00:01:00", False),  # offset required
        ("datetime", "2026-01-01T24:00:00Z", False),
        ("string", "anything", True),
    ],
)
def test_type_rules(declared: str, value: str, ok: bool) -> None:
    assert is_valid_value(declared, value) is ok


def test_csv_counts_missing_invalid_and_first_rows() -> None:
    plan = FilePlan(missing_tokens=frozenset({"", "NA"}), columns={"n": ColumnPlan("integer")})
    rows = [f"r{i},{'x' if i in (3, 7) else ('NA' if i == 5 else i)}\n" for i in range(1, 11)]
    stats = _csv(("id,n\n" + "".join(rows)).encode(), plan)
    assert stats.header == ("id", "n")
    assert (stats.sampled_rows, stats.malformed_rows, stats.truncated, stats.encoding_error) == (
        10,
        0,
        False,
        False,
    )
    n = stats.columns["n"]
    assert (n.missing, n.checked, n.invalid, n.first_invalid_rows) == (1, 9, 2, [3, 7])
    assert stats.columns["id"].checked == 0  # undeclared column: missing counted, no type check


def test_csv_bom_quotes_and_blank_lines() -> None:
    stats = _csv('﻿a,b\n"x, y",1\n\n"multi\nline",2\n'.encode())
    assert stats.header == ("a", "b")
    assert stats.sampled_rows == 2


def test_csv_malformed_rows_are_counted_and_excluded() -> None:
    stats = _csv(b"a,b\n1,2\n1,2,3\n4\n5,x\n", FilePlan(columns={"b": ColumnPlan("integer")}))
    assert (stats.rows_read, stats.sampled_rows, stats.malformed_rows) == (4, 2, 2)
    assert stats.columns["b"].invalid == 1
    assert stats.columns["b"].first_invalid_rows == [4]  # row numbers count malformed rows too


def test_csv_encoding_error_stops_parsing() -> None:
    assert _csv(b"a,b\n1,2\n\xff\xfe,3\n").encoding_error is True


def test_csv_row_limit_sets_truncated_only_when_more_rows_exist() -> None:
    data = b"a\n" + b"".join(b"%d\n" % i for i in range(10))
    assert _csv(data, max_rows=10).truncated is False
    limited = _csv(data, max_rows=4)
    assert (limited.sampled_rows, limited.truncated) == (4, True)


def test_csv_byte_limit_truncates() -> None:
    data = b"a\n" + b"".join(b"%06d\n" % i for i in range(1000))
    stats = _csv(data, max_bytes=70)  # 6 value bytes + 1 separator per row
    assert (stats.sampled_rows, stats.truncated) == (10, True)


def test_csv_codebook_codes() -> None:
    stats = _csv(b"m\nAL\nFE\nCU\nZN\n\n", FilePlan(columns={"m": ColumnPlan(codes=frozenset({"AL", "CU"}))}))
    assert stats.columns["m"].undefined_codes == 2


def test_csv_duplicate_header_columns_are_reported() -> None:
    assert _csv(b"a,b,a\n1,2,3\n").duplicate_columns == ["a"]


def test_empty_file_has_no_header() -> None:
    stats = _csv(b"")
    assert stats.header == () and stats.sampled_rows == 0


def test_deadline_aborts_parsing() -> None:
    def expired() -> None:
        raise FileTimeout()

    with pytest.raises(FileTimeout):
        profile_csv(
            io.BytesIO(b"a\n" + b"1\n" * 5000),
            path="d.csv",
            delimiter=",",
            plan=FilePlan(),
            max_rows=10_000,
            max_bytes=1 << 20,
            deadline=expired,
        )


def _parquet(table: pa.Table) -> io.BytesIO:
    sink = io.BytesIO()
    pq.write_table(table, sink, row_group_size=3)
    sink.seek(0)
    return sink


def test_parquet_types_nulls_and_compatibility() -> None:
    table = pa.table({"n": pa.array([1, None, 3, 4], pa.int64()), "s": pa.array(["a", "b", None, "d"])})
    plan = FilePlan(columns={"n": ColumnPlan("integer"), "s": ColumnPlan("number")})
    stats = profile_parquet(
        _parquet(table), path="t.parquet", plan=plan, max_rows=100, max_bytes=1 << 20, deadline=no_deadline
    )
    assert stats.header == ("n", "s")
    assert stats.parquet_numeric == ("n",)
    assert (stats.columns["n"].missing, stats.columns["n"].invalid) == (1, 0)
    s = stats.columns["s"]
    assert (s.missing, s.invalid, s.checked, s.first_invalid_rows) == (1, 3, 3, [1, 2, 4])


def test_parquet_row_limit_truncates() -> None:
    table = pa.table({"n": pa.array(range(10), pa.int32())})
    stats = profile_parquet(
        _parquet(table),
        path="t.parquet",
        plan=FilePlan(),
        max_rows=4,
        max_bytes=1 << 20,
        deadline=no_deadline,
    )
    assert (stats.sampled_rows, stats.truncated) == (4, True)


def test_not_a_parquet_file_is_an_encoding_error() -> None:
    stats = profile_parquet(
        io.BytesIO(b"nope"),
        path="t.parquet",
        plan=FilePlan(),
        max_rows=4,
        max_bytes=100,
        deadline=no_deadline,
    )
    assert stats.encoding_error is True
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
uv run pytest apps/api/modules/readiness/tests/test_parsing.py -q
```
Expected: collection error, `ModuleNotFoundError: No module named 'api.modules.readiness.engine.parsing'`.

- [ ] **Step 3: Implement**

`apps/api/modules/readiness/engine/parsing.py` (create):

```python
"""One streaming pass per tabular file -> per-column statistics (09 §1.4). Never keeps cell values.

CSV: stdlib csv, every value a str, fixed delimiter by extension, UTF-8 (BOM allowed). Parquet: pyarrow
iter_batches in row-group order. Sample = first `sample_max_rows` data rows within `sample_max_bytes`.
"""

import csv
import io
import re
import shutil
import tempfile
from collections import Counter
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import date
from typing import IO, Any, BinaryIO

DEFAULT_MISSING = frozenset({"", "NA", "N/A", "null", "NULL", "NaN"})
FIRST_ROWS_LIMIT = 10

_INTEGER = re.compile(r"[+-]?[0-9]+")
_NUMBER = re.compile(r"[+-]?([0-9]+\.?[0-9]*|\.[0-9]+)([eE][+-]?[0-9]+)?")
_BOOLEAN = frozenset({"true", "false", "True", "False", "TRUE", "FALSE", "1", "0"})
_DATE = re.compile(r"([0-9]{4})-([0-9]{2})-([0-9]{2})")
_DATETIME = re.compile(
    r"([0-9]{4})-([0-9]{2})-([0-9]{2})[Tt]([0-9]{2}):([0-9]{2}):([0-9]{2})(\.[0-9]+)?"
    r"([Zz]|[+-]([0-9]{2}):([0-9]{2}))"
)


class FileTimeout(Exception):
    """Parsing one file exceeded READINESS_FILE_TIMEOUT_SECONDS: the run fails with FILE_TIMEOUT."""


Deadline = Callable[[], None]  # raises FileTimeout when the per-file budget is spent


def _real_date(y: str, m: str, d: str) -> bool:
    try:
        date(int(y), int(m), int(d))
    except ValueError:
        return False
    return True


def is_valid_value(declared_type: str, value: str) -> bool:
    """09 §3.3 type rules on a non-missing CSV string (ASCII digits only)."""
    if declared_type == "integer":
        return _INTEGER.fullmatch(value) is not None
    if declared_type == "number":
        return _NUMBER.fullmatch(value) is not None
    if declared_type == "boolean":
        return value in _BOOLEAN
    if declared_type == "date":
        match = _DATE.fullmatch(value)
        return match is not None and _real_date(*match.groups())
    if declared_type == "datetime":
        match = _DATETIME.fullmatch(value)
        if match is None or not _real_date(*match.group(1, 2, 3)):
            return False
        hour, minute, second = int(match.group(4)), int(match.group(5)), int(match.group(6))
        offset_ok = match.group(9) is None or (int(match.group(9)) < 24 and int(match.group(10)) < 60)
        return hour < 24 and minute < 60 and second <= 60 and offset_ok
    return True  # string


@dataclass(frozen=True)
class ColumnPlan:
    declared_type: str | None = None  # None: not described by _schema.json -> no type check
    codes: frozenset[str] | None = None  # codebook codes for this field, if any


@dataclass(frozen=True)
class FilePlan:
    missing_tokens: frozenset[str] = DEFAULT_MISSING
    columns: dict[str, ColumnPlan] = field(default_factory=dict)


@dataclass
class ColumnStats:
    missing: int = 0
    checked: int = 0
    invalid: int = 0
    first_invalid_rows: list[int] = field(default_factory=list)
    undefined_codes: int = 0


@dataclass
class FileStats:
    path: str
    header: tuple[str, ...] = ()
    sampled_rows: int = 0  # well-formed data rows in the sample
    rows_read: int = 0  # data rows in the sample incl. malformed
    truncated: bool = False
    malformed_rows: int = 0
    encoding_error: bool = False
    columns: dict[str, ColumnStats] = field(default_factory=dict)
    parquet_types: dict[str, str] | None = None  # column -> arrow type string (parquet only)
    parquet_numeric: tuple[str, ...] = ()  # parquet columns of integer/floating/decimal type

    @property
    def duplicate_columns(self) -> list[str]:
        return sorted(name for name, count in Counter(self.header).items() if count > 1)


def _record(stats: ColumnStats, plan: ColumnPlan | None, value: str, row_number: int, missing: bool) -> None:
    if missing:
        stats.missing += 1
        return
    if plan is None:
        return
    if plan.declared_type is not None:
        stats.checked += 1
        if not is_valid_value(plan.declared_type, value):
            stats.invalid += 1
            if len(stats.first_invalid_rows) < FIRST_ROWS_LIMIT:
                stats.first_invalid_rows.append(row_number)
    if plan.codes is not None and value not in plan.codes:
        stats.undefined_codes += 1


def profile_csv(
    stream: BinaryIO,
    *,
    path: str,
    delimiter: str,
    plan: FilePlan,
    max_rows: int,
    max_bytes: int,
    deadline: Deadline,
) -> FileStats:
    stats = FileStats(path=path)
    text = io.TextIOWrapper(stream, encoding="utf-8-sig", newline="")
    reader = csv.reader(text, delimiter=delimiter, quotechar='"')
    consumed = 0
    try:
        try:
            header = next(reader)
        except StopIteration:
            return stats
        stats.header = tuple(header)
        index: dict[str, int] = {}
        for i, name in enumerate(header):
            index.setdefault(name, i)
        stats.columns = {name: ColumnStats() for name in index}
        slots = [(name, i, plan.columns.get(name)) for name, i in index.items()]
        width = len(header)
        while True:
            try:
                row = next(reader)
            except StopIteration:
                break
            except csv.Error:
                stats.rows_read += 1
                stats.malformed_rows += 1
                continue
            if not row:
                continue  # blank line: not a data row
            if stats.rows_read >= max_rows or consumed >= max_bytes:
                stats.truncated = True
                break
            stats.rows_read += 1
            consumed += sum(len(v.encode("utf-8")) for v in row) + len(row)
            if stats.rows_read % 1000 == 0:
                deadline()
            if len(row) != width:
                stats.malformed_rows += 1
                continue
            stats.sampled_rows += 1
            for name, i, col_plan in slots:
                value = row[i]
                _record(stats.columns[name], col_plan, value, stats.rows_read, value in plan.missing_tokens)
    except UnicodeDecodeError:
        stats.encoding_error = True
    finally:
        text.detach()
    return stats


# ---------------------------------------------------------------- parquet


def _arrow_compatible(declared_type: str, arrow_type: Any) -> bool:
    import pyarrow as pa

    t = pa.types
    if declared_type == "string":
        return True
    if declared_type == "integer":
        return bool(t.is_integer(arrow_type))
    if declared_type == "number":
        return bool(t.is_integer(arrow_type) or t.is_floating(arrow_type) or t.is_decimal(arrow_type))
    if declared_type == "boolean":
        return bool(t.is_boolean(arrow_type))
    if declared_type == "date":
        return bool(t.is_date(arrow_type))
    if declared_type == "datetime":
        return bool(t.is_timestamp(arrow_type))
    return False


def is_numeric_arrow_type(arrow_type: Any) -> bool:
    import pyarrow as pa

    t = pa.types
    return bool(t.is_integer(arrow_type) or t.is_floating(arrow_type) or t.is_decimal(arrow_type))


def _seekable(stream: BinaryIO) -> IO[bytes]:
    if stream.seekable():
        return stream
    spooled = tempfile.SpooledTemporaryFile(max_size=64 * 1024 * 1024)  # noqa: SIM115 - returned to caller
    shutil.copyfileobj(stream, spooled)
    spooled.seek(0)
    return spooled


def profile_parquet(
    stream: BinaryIO, *, path: str, plan: FilePlan, max_rows: int, max_bytes: int, deadline: Deadline
) -> FileStats:
    import pyarrow.parquet as pq

    stats = FileStats(path=path)
    try:
        parquet = pq.ParquetFile(_seekable(stream))
    except Exception:  # not a parquet file: same verdict as an undecodable CSV
        stats.encoding_error = True
        return stats
    schema = parquet.schema_arrow
    stats.header = tuple(schema.names)
    stats.parquet_types = {f.name: str(f.type) for f in schema}
    stats.parquet_numeric = tuple(sorted(f.name for f in schema if is_numeric_arrow_type(f.type)))
    stats.columns = {name: ColumnStats() for name in dict.fromkeys(schema.names)}
    compatible = {
        f.name: _arrow_compatible(plan.columns[f.name].declared_type or "string", f.type)
        for f in schema
        if f.name in plan.columns
    }
    consumed = 0
    for batch in parquet.iter_batches(batch_size=min(max_rows, 65536)):
        deadline()
        if stats.rows_read >= max_rows or consumed >= max_bytes:
            stats.truncated = True
            break
        take = min(batch.num_rows, max_rows - stats.rows_read)
        if take < batch.num_rows:
            stats.truncated = True
            batch = batch.slice(0, take)
        first_row = stats.rows_read + 1
        stats.rows_read += take
        stats.sampled_rows += take
        consumed += batch.nbytes
        for name, col_stats in stats.columns.items():
            column = batch.column(schema.get_field_index(name))
            col_stats.missing += column.null_count
            col_plan = plan.columns.get(name)
            if col_plan is None:
                continue
            for offset, value in enumerate(column.to_pylist()):
                if value is None:
                    continue
                if col_plan.declared_type is not None:
                    col_stats.checked += 1
                    if not compatible[name]:
                        col_stats.invalid += 1
                        if len(col_stats.first_invalid_rows) < FIRST_ROWS_LIMIT:
                            col_stats.first_invalid_rows.append(first_row + offset)
                if col_plan.codes is not None and str(value) not in col_plan.codes:
                    col_stats.undefined_codes += 1
    if not stats.truncated and parquet.metadata.num_rows > stats.rows_read:
        stats.truncated = True
    return stats
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
uv run pytest apps/api/modules/readiness/tests/test_parsing.py -q
uv run ruff check apps/api/modules/readiness tests/fixtures && uv run ruff format --check apps/api/modules/readiness tests/fixtures
```
Expected: `31 passed`; ruff clean.

- [ ] **Step 5: Commit**

```bash
git add apps/api/modules/readiness/engine/parsing.py apps/api/modules/readiness/tests/test_parsing.py
git commit -m "feat(readiness): streaming csv/parquet sample profiling" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```


---

### Task 5: Evaluation context + metadata.completeness, provenance.presence, policy.license_usage

`EvaluationContext` is everything a validator may read: snapshot, manifest, convention files (`_schema.json` checked against the bundled subset JSON Schema, `_codebook.csv`, `README.md`), T, and the per-run parse cache. The three metadata-only checks follow 09 §3.1, §3.6, §3.7.

**Files:**
- Create: `apps/api/modules/readiness/schemas/table_schema_subset_v1.json`
- Create: `apps/api/modules/readiness/engine/context.py`
- Create: `apps/api/modules/readiness/dictionaries/spdx_license_ids_v1.txt`
- Create: `apps/api/modules/readiness/validators/__init__.py`
- Create: `apps/api/modules/readiness/validators/metadata_completeness.py`
- Create: `apps/api/modules/readiness/validators/provenance_presence.py`
- Create: `apps/api/modules/readiness/validators/license_usage.py`
- Create: `apps/api/modules/readiness/tests/builders.py`
- Test: `apps/api/modules/readiness/tests/test_validators_metadata.py`

**Interfaces:**
- Consumes: `engine.parsing` (Task 4), `ProfileParams` (Task 1), `FixtureCatalog` + `tests/helpers.py` (Task 3).
- Produces: `engine.context`: `CheckStatus`, `CheckOutcome(status, message, evidence)`, `is_tabular(path) -> bool`, `FieldSchema`, `ResourceSchema(path, fields, primary_key, missing_values)`, `SchemaDoc(present, valid, errors, resources)`, `Codebook(present, units, codes)`, `parse_schema_doc(bytes)`, `parse_codebook(bytes)`, `EvaluationContext(snapshot, files, manifest_sha256, reader, params, file_timeout_s=None)` with `by_path`, `tabular`, `skipped_tabular`, `readme_present`, `readme_text`, `schema_doc`, `codebook`, `resource(path)`, `plan_for(path)`, `file_stats(path)`; validators `metadata_completeness.check`, `provenance_presence.check` (+ `readme_provenance_section(text)`), `license_usage.check` (+ `license_recognized(id)`); `tests/builders.py`: `make_ctx(files=None, snapshot=None, catalog=None, **param_overrides) -> EvaluationContext`, `schema_doc(path, fields, **schema)`, `with_schema(files, doc)`.

- [ ] **Step 1: Write the failing test**

`apps/api/modules/readiness/tests/builders.py` (create):

```python
"""Evaluation contexts over in-memory files, for validator unit tests."""

import json
from dataclasses import replace
from pathlib import Path
from typing import Any

from api.modules.readiness.engine.context import EvaluationContext
from api.modules.readiness.fakes import FixtureCatalog
from api.modules.readiness.profile_registry import PROFILES
from api.modules.readiness.tests.helpers import ORG_B, clean_snapshot, fixture_files


def make_ctx(
    files: dict[str, Path | bytes] | dict[str, bytes] | None = None,
    snapshot: dict[str, Any] | None = None,
    catalog: FixtureCatalog | None = None,
    **params: Any,
) -> EvaluationContext:
    """A TABULAR_ML_BASIC context (parameters overridable) over `files` (default: clean_tabular)."""
    catalog = catalog or FixtureCatalog()
    view = catalog.add_version(
        dict(fixture_files() if files is None else files),
        clean_snapshot() if snapshot is None else snapshot,
        owner_organization_id=ORG_B,
    )
    assert view.metadata_snapshot is not None
    return EvaluationContext(
        snapshot=view.metadata_snapshot,
        files=view.files,
        manifest_sha256=view.manifest_sha256,
        reader=catalog,
        params=replace(PROFILES["TABULAR_ML_BASIC"].params, **params),
    )


def schema_doc(path: str, fields: list[dict[str, Any]], **schema: Any) -> dict[str, Any]:
    return {"resources": [{"path": path, "schema": {"fields": fields, **schema}}]}


def with_schema(files: dict[str, bytes], doc: dict[str, Any]) -> dict[str, bytes]:
    return {**files, "_schema.json": json.dumps(doc).encode("utf-8")}
```

`apps/api/modules/readiness/tests/test_validators_metadata.py` (create):

```python
from typing import Any

import pytest

from api.modules.readiness.tests.builders import make_ctx
from api.modules.readiness.tests.helpers import clean_snapshot, fixture_files
from api.modules.readiness.validators import license_usage, metadata_completeness, provenance_presence
from api.modules.readiness.validators.provenance_presence import readme_provenance_section


def _snap(**changes: Any) -> dict[str, Any]:
    return {**clean_snapshot(), **changes}


# ---------------------------------------------------------------- metadata.completeness


def test_metadata_pass() -> None:
    outcome = metadata_completeness.check(make_ctx())
    assert outcome.status == "PASS"
    assert outcome.evidence == {
        "required_missing": [],
        "recommended_missing": [],
        "description_length": 80,
        "keyword_count": 4,
        "readme_present": True,
    }


def test_metadata_fail_matches_missing_metadata_fixture() -> None:
    snap = _snap(description="측정 데이터", keywords=[], domain=None, contact_email=None)
    outcome = metadata_completeness.check(make_ctx(snapshot=snap))
    assert outcome.status == "FAIL"
    assert outcome.evidence["required_missing"] == ["contact_email", "description", "keywords"]
    assert outcome.evidence["recommended_missing"] == ["domain", "keywords_min_3"]
    assert outcome.evidence["description_length"] == 6
    assert (
        outcome.message
        == "필수 메타데이터 3개가 누락되었습니다: contact_email, description(50자 미만), keywords."
    )


@pytest.mark.parametrize(
    ("changes", "status"),
    [
        ({"description": "가" * 50}, "PASS"),  # exactly the minimum
        ({"description": "  " + "가" * 49 + "  "}, "FAIL"),  # trimmed below the minimum
        ({"title": "ab"}, "FAIL"),
        ({"license": "  "}, "FAIL"),
        ({"keywords": ["a", "b"]}, "WARNING"),  # REQUIRED met, keywords_min_3 not
        ({"domain": ""}, "WARNING"),
        ({"keywords": "not-a-list"}, "FAIL"),
    ],
)
def test_metadata_boundaries(changes: dict[str, Any], status: str) -> None:
    assert metadata_completeness.check(make_ctx(snapshot=_snap(**changes))).status == status


def test_metadata_warns_without_readme() -> None:
    files = {k: v for k, v in fixture_files().items() if k != "README.md"}
    outcome = metadata_completeness.check(make_ctx(files=files))
    assert (outcome.status, outcome.evidence["recommended_missing"]) == ("WARNING", ["readme"])


# ---------------------------------------------------------------- provenance.presence


def test_readme_section_extraction_rules() -> None:
    assert readme_provenance_section("# T\n\n## 데이터 출처\n\n  본문 A  \n\n## 다음\n나머지\n") == "본문 A"
    assert readme_provenance_section("#### Provenance\nbody\n") is None  # only # .. ###
    assert readme_provenance_section("### PROVENANCE ###\nbody\n") == "body"
    assert readme_provenance_section("## Provenance notes\nbody\n") is None


def test_provenance_pass_from_metadata_only() -> None:
    files = {**fixture_files(), "README.md": b"# Title\n"}
    outcome = provenance_presence.check(make_ctx(files=files))
    assert outcome.status == "PASS"
    assert outcome.evidence == {
        "metadata_provenance_length": 72,
        "readme_present": True,
        "readme_section_found": False,
        "readme_section_length": 0,
    }


def test_provenance_pass_from_readme_only() -> None:
    outcome = provenance_presence.check(make_ctx(snapshot=_snap(provenance=None)))
    assert (outcome.status, outcome.evidence["readme_section_found"]) == ("PASS", True)


def test_provenance_warning_when_both_short() -> None:
    files = {**fixture_files(), "README.md": "## 출처\n짧은 설명\n".encode()}
    outcome = provenance_presence.check(make_ctx(files=files, snapshot=_snap(provenance="가" * 49)))
    assert outcome.status == "WARNING"


def test_provenance_fail_when_absent() -> None:
    files = {**fixture_files(), "README.md": b"# Title\n"}
    outcome = provenance_presence.check(make_ctx(files=files, snapshot=_snap(provenance="  ")))
    assert (outcome.status, outcome.evidence["metadata_provenance_length"]) == ("FAIL", 0)


# ---------------------------------------------------------------- policy.license_usage


@pytest.mark.parametrize(
    ("changes", "status"),
    [
        ({}, "PASS"),
        ({"license": "NAIS-RESEARCH-ONLY-1.0"}, "PASS"),
        ({"license": "My-Own-License"}, "WARNING"),
        ({"license": ""}, "FAIL"),
        ({"usage_policy": "가" * 19}, "FAIL"),  # CONTROLLED needs >= 20
        ({"usage_policy": "가" * 20}, "PASS"),
        ({"access_level": "SENSITIVE", "usage_policy": None}, "FAIL"),
        ({"access_level": "PUBLIC", "usage_policy": None}, "PASS"),
        ({"access_level": "INTERNAL", "usage_policy": ""}, "PASS"),
    ],
)
def test_license_usage_rules(changes: dict[str, Any], status: str) -> None:
    assert license_usage.check(make_ctx(snapshot=_snap(**changes))).status == status


def test_license_evidence_has_lengths_not_policy_text() -> None:
    assert license_usage.check(make_ctx()).evidence == {
        "license": "CC-BY-4.0",
        "license_recognized": True,
        "access_level": "CONTROLLED",
        "usage_policy_length": 52,
        "allowed_purposes_count": 2,
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
uv run pytest apps/api/modules/readiness/tests/test_validators_metadata.py -q
```
Expected: collection error, `ModuleNotFoundError: No module named 'api.modules.readiness.engine.context'`.

- [ ] **Step 3: Implement**

`apps/api/modules/readiness/schemas/table_schema_subset_v1.json` (create):

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://nais.local/readiness/table_schema_subset_v1.json",
  "title": "NAIS _schema.json subset (Frictionless Data Package subset, 09_AI_READY_RULES.md 1.2)",
  "type": "object",
  "required": ["resources"],
  "properties": {
    "resources": { "type": "array", "items": { "$ref": "#/$defs/resource" } }
  },
  "$defs": {
    "resource": {
      "type": "object",
      "required": ["path", "schema"],
      "properties": {
        "path": { "type": "string", "minLength": 1 },
        "schema": { "$ref": "#/$defs/tableSchema" }
      }
    },
    "tableSchema": {
      "type": "object",
      "required": ["fields"],
      "properties": {
        "fields": { "type": "array", "minItems": 1, "items": { "$ref": "#/$defs/field" } },
        "primaryKey": {
          "oneOf": [
            { "type": "string", "minLength": 1 },
            { "type": "array", "minItems": 1, "items": { "type": "string", "minLength": 1 } }
          ]
        },
        "missingValues": { "type": "array", "items": { "type": "string" } }
      }
    },
    "field": {
      "type": "object",
      "required": ["name", "type"],
      "properties": {
        "name": { "type": "string", "minLength": 1 },
        "type": { "enum": ["string", "integer", "number", "boolean", "date", "datetime"] },
        "unit": { "type": "string" },
        "description": { "type": "string" },
        "constraints": {
          "type": "object",
          "properties": {
            "required": { "type": "boolean" },
            "enum": { "type": "array" }
          }
        },
        "x-nais-concept": { "type": "string" }
      }
    }
  }
}
```

`apps/api/modules/readiness/engine/context.py` (create):

```python
"""Everything a validator may look at for one run: snapshot, manifest, convention files, lazily parsed tables."""

import csv
import io
import json
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from functools import cached_property, lru_cache
from pathlib import Path
from typing import Any, Literal

from jsonschema import Draft202012Validator

from api.modules.readiness.catalog_port import CatalogReadPort, FileRef
from api.modules.readiness.engine.parsing import (
    DEFAULT_MISSING,
    ColumnPlan,
    FilePlan,
    FileStats,
    FileTimeout,
    profile_csv,
    profile_parquet,
)
from api.modules.readiness.profile_registry import ProfileParams

CheckStatus = Literal["PASS", "WARNING", "FAIL", "NOT_APPLICABLE"]
TABULAR_SUFFIXES = (".csv", ".tsv", ".parquet")
SCHEMA_FILE = "_schema.json"
CODEBOOK_FILE = "_codebook.csv"
README_FILE = "README.md"
CONVENTION_MAX_BYTES = 16 * 1024 * 1024
SUBSET_SCHEMA_PATH = Path(__file__).resolve().parents[1] / "schemas" / "table_schema_subset_v1.json"


@dataclass(frozen=True)
class CheckOutcome:
    status: CheckStatus
    message: str  # Korean, 1-2 sentences, never a cell value
    evidence: dict[str, Any]  # counts, ratios, paths, field names, declared units, row numbers only (D-018)


def is_tabular(path: str) -> bool:
    """T membership (09 §1.3): .csv/.tsv/.parquet whose file name does not start with '_'."""
    return path.lower().endswith(TABULAR_SUFFIXES) and not path.rsplit("/", 1)[-1].startswith("_")


@lru_cache(maxsize=1)
def subset_validator() -> Draft202012Validator:
    return Draft202012Validator(json.loads(SUBSET_SCHEMA_PATH.read_text(encoding="utf-8")))


@dataclass(frozen=True)
class FieldSchema:
    name: str
    type: str
    unit: str | None
    required: bool
    concept: str | None


@dataclass(frozen=True)
class ResourceSchema:
    path: str
    fields: tuple[FieldSchema, ...]
    primary_key: tuple[str, ...]
    missing_values: frozenset[str]


@dataclass(frozen=True)
class SchemaDoc:
    present: bool
    valid: bool
    errors: tuple[dict[str, str], ...] = ()
    resources: dict[str, ResourceSchema] = field(default_factory=dict)


@dataclass(frozen=True)
class Codebook:
    present: bool
    units: dict[tuple[str, str], str] = field(
        default_factory=dict
    )  # (path, field) -> unit, rows with code ""
    codes: dict[tuple[str, str], frozenset[str]] = field(default_factory=dict)


def parse_schema_doc(raw: bytes) -> SchemaDoc:
    try:
        doc = json.loads(raw.decode("utf-8-sig"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return SchemaDoc(present=True, valid=False, errors=({"pointer": "", "error": "json_parse"},))
    errors = sorted(
        {
            ("".join(f"/{p}" for p in e.absolute_path), str(e.validator))
            for e in subset_validator().iter_errors(doc)
        }
    )
    if errors:
        return SchemaDoc(
            present=True, valid=False, errors=tuple({"pointer": p, "error": v} for p, v in errors)
        )
    resources: dict[str, ResourceSchema] = {}
    for res in doc["resources"]:
        schema = res["schema"]
        pk = schema.get("primaryKey", [])
        fields = tuple(
            FieldSchema(
                name=f["name"],
                type=f["type"],
                unit=f.get("unit"),
                required=bool(f.get("constraints", {}).get("required", False)),
                concept=f.get("x-nais-concept"),
            )
            for f in schema["fields"]
        )
        missing = frozenset(schema["missingValues"]) if "missingValues" in schema else DEFAULT_MISSING
        resources.setdefault(  # first description of a path wins
            res["path"],
            ResourceSchema(
                path=res["path"],
                fields=fields,
                primary_key=(pk,) if isinstance(pk, str) else tuple(pk),
                missing_values=missing,
            ),
        )
    return SchemaDoc(present=True, valid=True, resources=resources)


def parse_codebook(raw: bytes) -> Codebook:
    units: dict[tuple[str, str], str] = {}
    codes: dict[tuple[str, str], set[str]] = {}
    try:
        for row in csv.DictReader(io.StringIO(raw.decode("utf-8-sig"), newline="")):
            key = ((row.get("path") or "").strip(), (row.get("field") or "").strip())
            code = row.get("code") or ""
            if code == "":
                if row.get("unit"):
                    units.setdefault(key, row["unit"])
            else:
                codes.setdefault(key, set()).add(code)
    except (UnicodeDecodeError, csv.Error):
        return Codebook(present=True)
    return Codebook(present=True, units=units, codes={k: frozenset(v) for k, v in codes.items()})


@dataclass
class EvaluationContext:
    snapshot: dict[str, Any]
    files: tuple[FileRef, ...]
    manifest_sha256: str | None
    reader: CatalogReadPort
    params: ProfileParams
    file_timeout_s: float | None = None
    monotonic: Callable[[], float] = time.monotonic  # only to abort slow parses, never for verdicts
    _stats: dict[str, FileStats] = field(default_factory=dict)

    @cached_property
    def by_path(self) -> dict[str, FileRef]:
        return {f.path: f for f in self.files}

    @cached_property
    def all_tabular(self) -> list[FileRef]:
        return sorted((f for f in self.files if is_tabular(f.path)), key=lambda f: f.path)

    @property
    def tabular(self) -> list[FileRef]:
        """T, capped at max_tabular_files (path order)."""
        return self.all_tabular[: self.params.max_tabular_files]

    @property
    def skipped_tabular(self) -> list[str]:
        return [f.path for f in self.all_tabular[self.params.max_tabular_files :]]

    def read_small(self, path: str) -> bytes | None:
        """A convention file's bytes; None when absent or larger than CONVENTION_MAX_BYTES."""
        ref = self.by_path.get(path)
        if ref is None:
            return None
        with self.reader.open_stream(ref) as stream:
            data = stream.read(CONVENTION_MAX_BYTES + 1)
        return data if len(data) <= CONVENTION_MAX_BYTES else None

    @property
    def readme_present(self) -> bool:
        return README_FILE in self.by_path

    @cached_property
    def readme_text(self) -> str | None:
        raw = self.read_small(README_FILE)
        return None if raw is None else raw.decode("utf-8-sig", errors="replace")

    @cached_property
    def schema_doc(self) -> SchemaDoc:
        if SCHEMA_FILE not in self.by_path:
            return SchemaDoc(present=False, valid=False)
        raw = self.read_small(SCHEMA_FILE)
        if raw is None:
            return SchemaDoc(present=True, valid=False, errors=({"pointer": "", "error": "too_large"},))
        return parse_schema_doc(raw)

    @cached_property
    def codebook(self) -> Codebook:
        if CODEBOOK_FILE not in self.by_path:
            return Codebook(present=False)
        raw = self.read_small(CODEBOOK_FILE)
        return Codebook(present=True) if raw is None else parse_codebook(raw)

    def resource(self, path: str) -> ResourceSchema | None:
        return self.schema_doc.resources.get(path) if self.schema_doc.valid else None

    def plan_for(self, path: str) -> FilePlan:
        resource = self.resource(path)
        codes = {f: c for (p, f), c in self.codebook.codes.items() if p == path}
        columns: dict[str, ColumnPlan] = {name: ColumnPlan(codes=c) for name, c in codes.items()}
        if resource is not None:
            for fld in resource.fields:
                columns[fld.name] = ColumnPlan(declared_type=fld.type, codes=codes.get(fld.name))
        missing = resource.missing_values if resource is not None else DEFAULT_MISSING
        return FilePlan(missing_tokens=missing, columns=columns)

    def _deadline(self) -> Callable[[], None]:
        if self.file_timeout_s is None:
            return lambda: None
        limit = self.monotonic() + self.file_timeout_s

        def check() -> None:
            if self.monotonic() > limit:
                raise FileTimeout()

        return check

    def file_stats(self, path: str) -> FileStats:
        """Parsed once per run and shared by the schema / datatype / missing / units checks (M05 §10)."""
        if path not in self._stats:
            p = self.params
            with self.reader.open_stream(self.by_path[path]) as stream:
                if path.lower().endswith(".parquet"):
                    stats = profile_parquet(
                        stream,
                        path=path,
                        plan=self.plan_for(path),
                        max_rows=p.sample_max_rows,
                        max_bytes=p.sample_max_bytes,
                        deadline=self._deadline(),
                    )
                else:
                    stats = profile_csv(
                        stream,
                        path=path,
                        delimiter="\t" if path.lower().endswith(".tsv") else ",",
                        plan=self.plan_for(path),
                        max_rows=p.sample_max_rows,
                        max_bytes=p.sample_max_bytes,
                        deadline=self._deadline(),
                    )
            self._stats[path] = stats
        return self._stats[path]
```

`apps/api/modules/readiness/dictionaries/spdx_license_ids_v1.txt` (create):

```text
# SPDX license identifiers recognised by policy.license_usage (subset of the SPDX list). One per line.
0BSD
AFL-3.0
AGPL-3.0-only
AGPL-3.0-or-later
Apache-2.0
Artistic-2.0
BSD-1-Clause
BSD-2-Clause
BSD-3-Clause
BSD-4-Clause
BSL-1.0
CC-BY-1.0
CC-BY-2.0
CC-BY-2.5
CC-BY-3.0
CC-BY-4.0
CC-BY-NC-3.0
CC-BY-NC-4.0
CC-BY-NC-ND-3.0
CC-BY-NC-ND-4.0
CC-BY-NC-SA-3.0
CC-BY-NC-SA-4.0
CC-BY-ND-3.0
CC-BY-ND-4.0
CC-BY-SA-3.0
CC-BY-SA-4.0
CC-PDDC
CC0-1.0
CDLA-Permissive-1.0
CDLA-Permissive-2.0
CDLA-Sharing-1.0
ECL-2.0
EPL-1.0
EPL-2.0
EUPL-1.1
EUPL-1.2
GFDL-1.3-only
GFDL-1.3-or-later
GPL-2.0-only
GPL-2.0-or-later
GPL-3.0-only
GPL-3.0-or-later
ISC
KOGL-Type-1
LGPL-2.1-only
LGPL-2.1-or-later
LGPL-3.0-only
LGPL-3.0-or-later
MIT
MIT-0
MPL-2.0
MS-PL
NCSA
ODbL-1.0
ODC-By-1.0
OFL-1.1
OGL-UK-3.0
PDDL-1.0
PSF-2.0
Unlicense
UPL-1.0
W3C
Zlib
```

`apps/api/modules/readiness/validators/__init__.py` (create):

```python
"""One file per check (M05 §2). Each exposes check(ctx) -> CheckOutcome and must stay deterministic:
no clock, no randomness, no network, no environment reads (M05-AT-14 enforces this).
The VALIDATORS registry is added once all nine checks exist (Task 10)."""
```

`apps/api/modules/readiness/validators/metadata_completeness.py` (create):

```python
"""metadata.completeness (09 §3.1)."""

from typing import Any

from api.modules.readiness.engine.context import CheckOutcome, EvaluationContext


def _text(value: Any) -> str:
    return value.strip() if isinstance(value, str) else ""


def check(ctx: EvaluationContext) -> CheckOutcome:
    snap = ctx.snapshot
    p = ctx.params
    raw_keywords = snap.get("keywords")
    keywords = raw_keywords if isinstance(raw_keywords, list) else []
    keyword_count = len([k for k in keywords if _text(k)])
    description_length = len(_text(snap.get("description")))
    required_missing = sorted(
        name
        for name, ok in (
            ("title", len(_text(snap.get("title"))) >= 3),
            ("description", description_length >= p.description_min_length),
            ("license", bool(_text(snap.get("license")))),
            ("contact_email", bool(_text(snap.get("contact_email")))),
            ("keywords", keyword_count >= 1),
        )
        if not ok
    )
    recommended_missing = sorted(
        name
        for name, ok in (
            ("keywords_min_3", keyword_count >= 3),
            ("domain", bool(_text(snap.get("domain")))),
            ("readme", ctx.readme_present),
        )
        if not ok
    )
    evidence = {
        "required_missing": required_missing,
        "recommended_missing": recommended_missing,
        "description_length": description_length,
        "keyword_count": keyword_count,
        "readme_present": ctx.readme_present,
    }
    if required_missing:
        labels = [
            f"description({p.description_min_length}자 미만)" if n == "description" else n
            for n in required_missing
        ]
        message = f"필수 메타데이터 {len(required_missing)}개가 누락되었습니다: {', '.join(labels)}."
        return CheckOutcome("FAIL", message, evidence)
    if recommended_missing:
        return CheckOutcome(
            "WARNING", f"권장 메타데이터가 부족합니다: {', '.join(recommended_missing)}.", evidence
        )
    return CheckOutcome("PASS", "필수·권장 메타데이터가 모두 채워져 있습니다.", evidence)
```

`apps/api/modules/readiness/validators/provenance_presence.py` (create):

```python
"""provenance.presence (09 §3.6)."""

import re

from api.modules.readiness.engine.context import CheckOutcome, EvaluationContext

_HEADING = re.compile(r"^(#{1,6})[ \t]+(.*?)[ \t#]*$")
_PROVENANCE_TITLE = re.compile(r"^(provenance|출처|데이터 출처|생성 방법)$", re.IGNORECASE)


def readme_provenance_section(text: str) -> str | None:
    """Trimmed body of the first #..### heading named like provenance, up to the next heading; None if absent."""
    lines = text.splitlines()
    for i, line in enumerate(lines):
        match = _HEADING.match(line)
        if match and len(match.group(1)) <= 3 and _PROVENANCE_TITLE.match(match.group(2).strip()):
            body: list[str] = []
            for following in lines[i + 1 :]:
                if _HEADING.match(following):
                    break
                body.append(following)
            return "\n".join(body).strip()
    return None


def check(ctx: EvaluationContext) -> CheckOutcome:
    raw = ctx.snapshot.get("provenance")
    metadata_length = len(raw.strip()) if isinstance(raw, str) else 0
    section = readme_provenance_section(ctx.readme_text) if ctx.readme_text is not None else None
    section_length = len(section) if section is not None else 0
    evidence = {
        "metadata_provenance_length": metadata_length,
        "readme_present": ctx.readme_present,
        "readme_section_found": section is not None,
        "readme_section_length": section_length,
    }
    minimum = ctx.params.provenance_min_length
    if max(metadata_length, section_length) >= minimum:
        return CheckOutcome("PASS", "데이터 출처(provenance)가 기록되어 있습니다.", evidence)
    if metadata_length or section_length:
        return CheckOutcome("WARNING", f"데이터 출처 설명이 {minimum}자 미만으로 짧습니다.", evidence)
    message = "데이터 출처(provenance)가 없습니다. 메타데이터 provenance 또는 README.md의 Provenance 섹션을 작성하세요."
    return CheckOutcome("FAIL", message, evidence)
```

`apps/api/modules/readiness/validators/license_usage.py` (create):

```python
"""policy.license_usage (09 §3.7)."""

import re
from functools import lru_cache
from pathlib import Path

from api.modules.readiness.engine.context import CheckOutcome, EvaluationContext

_NAIS_LICENSE = re.compile(r"NAIS-[A-Z0-9-]+-[0-9]+\.[0-9]+")
_SPDX_FILE = Path(__file__).resolve().parents[1] / "dictionaries" / "spdx_license_ids_v1.txt"


@lru_cache(maxsize=1)
def spdx_ids() -> frozenset[str]:
    lines = _SPDX_FILE.read_text(encoding="utf-8").splitlines()
    return frozenset(line.strip() for line in lines if line.strip() and not line.startswith("#"))


def license_recognized(license_id: str) -> bool:
    return license_id in spdx_ids() or _NAIS_LICENSE.fullmatch(license_id) is not None


def _text(value: object) -> str:
    return value.strip() if isinstance(value, str) else ""


def check(ctx: EvaluationContext) -> CheckOutcome:
    snap = ctx.snapshot
    license_id = _text(snap.get("license"))
    usage = _text(snap.get("usage_policy"))
    access_level = snap.get("access_level")
    raw_purposes = snap.get("allowed_purposes")
    purposes = raw_purposes if isinstance(raw_purposes, list) else []
    recognized = bool(license_id) and license_recognized(license_id)
    evidence = {
        "license": license_id,
        "license_recognized": recognized,
        "access_level": access_level,
        "usage_policy_length": len(usage),
        "allowed_purposes_count": len(purposes),
    }
    minimum = ctx.params.usage_policy_min_length
    usage_ok = access_level in ("PUBLIC", "INTERNAL") or len(usage) >= minimum
    if not license_id:
        return CheckOutcome("FAIL", "라이선스가 지정되지 않았습니다.", evidence)
    if not usage_ok:
        message = f"{access_level} 데이터에는 {minimum}자 이상의 이용 정책(usage_policy)이 필요합니다."
        return CheckOutcome("FAIL", message, evidence)
    if not recognized:
        return CheckOutcome(
            "WARNING", "라이선스 식별자를 SPDX 또는 NAIS 라이선스로 인식할 수 없습니다.", evidence
        )
    return CheckOutcome("PASS", "라이선스와 이용 정책이 확인되었습니다.", evidence)
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
uv run pytest apps/api/modules/readiness/tests/test_validators_metadata.py -q
uv run ruff check apps/api/modules/readiness tests/fixtures && uv run ruff format --check apps/api/modules/readiness tests/fixtures
```
Expected: `25 passed`; ruff clean.

- [ ] **Step 5: Commit**

```bash
git add apps/api/modules/readiness/dictionaries/spdx_license_ids_v1.txt apps/api/modules/readiness/engine/context.py apps/api/modules/readiness/schemas/table_schema_subset_v1.json apps/api/modules/readiness/tests/builders.py apps/api/modules/readiness/tests/test_validators_metadata.py apps/api/modules/readiness/validators/__init__.py apps/api/modules/readiness/validators/license_usage.py apps/api/modules/readiness/validators/metadata_completeness.py apps/api/modules/readiness/validators/provenance_presence.py
git commit -m "feat(readiness): evaluation context and metadata/provenance/license checks" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```


---

### Task 6: integrity.file_checksum

09 §3.8: stream-recompute sha256 of files within the 10 GiB budget (path order), trust M03 `VERIFIED` beyond it, and recompute `manifest_sha256`. A missing object is not a verdict: it propagates `ObjectMissing` and the job fails the run (`FILE_NOT_FOUND`, M05 §5), so `missing` stays `[]`.

**Files:**
- Create: `apps/api/modules/readiness/validators/file_checksum.py`
- Test: `apps/api/modules/readiness/tests/test_validator_checksum.py`

**Interfaces:**
- Consumes: `EvaluationContext` (Task 5), `manifest_sha256` (Task 2), `tests/builders.make_ctx` (Task 5).
- Produces: `validators.file_checksum.check(ctx) -> CheckOutcome`.

- [ ] **Step 1: Write the failing test**

`apps/api/modules/readiness/tests/test_validator_checksum.py` (create):

```python
import dataclasses

from api.modules.readiness.fakes import FixtureCatalog
from api.modules.readiness.tests.builders import make_ctx
from api.modules.readiness.tests.helpers import fixture_files
from api.modules.readiness.validators import file_checksum


def test_checksum_pass_recomputes_every_file() -> None:
    catalog = FixtureCatalog()
    outcome = file_checksum.check(make_ctx(catalog=catalog))
    assert outcome.status == "PASS"
    assert outcome.evidence == {
        "files_total": 4,
        "recomputed": 4,
        "catalog_verified": 0,
        "mismatched": [],
        "not_verified": [],
        "missing": [],
        "manifest_match": True,
    }
    assert sorted(catalog.reads) == ["README.md", "_codebook.csv", "_schema.json", "data/measurements.csv"]


def test_checksum_fail_on_content_mismatch() -> None:
    ctx = make_ctx()
    tampered = tuple(
        dataclasses.replace(f, sha256="0" * 64) if f.path == "_schema.json" else f for f in ctx.files
    )
    outcome = file_checksum.check(dataclasses.replace(ctx, files=tampered))
    assert outcome.status == "FAIL"
    assert outcome.evidence["mismatched"] == ["_schema.json"]
    assert outcome.evidence["manifest_match"] is False  # the manifest was computed from the true sha256


def test_checksum_fail_on_manifest_mismatch() -> None:
    outcome = file_checksum.check(dataclasses.replace(make_ctx(), manifest_sha256="f" * 64))
    assert (outcome.status, outcome.evidence["manifest_match"]) == ("FAIL", False)


def test_files_beyond_budget_use_catalog_verified_status() -> None:
    files = fixture_files()
    budget = len(files["README.md"]) + len(
        files["_codebook.csv"]
    )  # path order: README.md, _codebook.csv, ...
    catalog = FixtureCatalog()
    ctx = make_ctx(catalog=catalog, checksum_max_total_bytes=budget)
    outcome = file_checksum.check(ctx)
    assert (outcome.status, outcome.evidence["recomputed"], outcome.evidence["catalog_verified"]) == (
        "PASS",
        2,
        2,
    )
    assert sorted(catalog.reads) == ["README.md", "_codebook.csv"]
    unverified = tuple(
        dataclasses.replace(f, status="UPLOADED") if f.path == "data/measurements.csv" else f
        for f in ctx.files
    )
    outcome = file_checksum.check(dataclasses.replace(ctx, files=unverified))
    assert (outcome.status, outcome.evidence["not_verified"]) == ("FAIL", ["data/measurements.csv"])
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
uv run pytest apps/api/modules/readiness/tests/test_validator_checksum.py -q
```
Expected: collection error, `ImportError: cannot import name 'file_checksum' from 'api.modules.readiness.validators'`.

- [ ] **Step 3: Implement**

`apps/api/modules/readiness/validators/file_checksum.py` (create):

```python
"""integrity.file_checksum (09 §3.8). A missing object is a run failure (M05 §5), not a check verdict."""

import hashlib

from api.modules.readiness.catalog_port import FileRef
from api.modules.readiness.engine.canonical import manifest_sha256
from api.modules.readiness.engine.context import CheckOutcome, EvaluationContext

CHUNK = 1024 * 1024


def _recompute(ctx: EvaluationContext, ref: FileRef) -> str:
    digest = hashlib.sha256()
    with ctx.reader.open_stream(ref) as stream:
        while chunk := stream.read(CHUNK):
            digest.update(chunk)
    return digest.hexdigest()


def check(ctx: EvaluationContext) -> CheckOutcome:
    budget = ctx.params.checksum_max_total_bytes
    cumulative = recomputed = catalog_verified = 0
    mismatched: list[str] = []
    not_verified: list[str] = []
    for ref in sorted(ctx.files, key=lambda f: f.path):
        cumulative += ref.size_bytes
        if cumulative <= budget:
            recomputed += 1
            if _recompute(ctx, ref) != ref.sha256.lower():
                mismatched.append(ref.path)
        else:
            catalog_verified += 1
            if ref.status != "VERIFIED":
                not_verified.append(ref.path)
    manifest_match = ctx.manifest_sha256 is not None and manifest_sha256(ctx.files) == ctx.manifest_sha256
    evidence = {
        "files_total": len(ctx.files),
        "recomputed": recomputed,
        "catalog_verified": catalog_verified,
        "mismatched": mismatched,
        "not_verified": not_verified,
        "missing": [],
        "manifest_match": manifest_match,
    }
    if mismatched or not_verified or not manifest_match:
        problems = len(mismatched) + len(not_verified) + (0 if manifest_match else 1)
        return CheckOutcome("FAIL", f"파일 무결성 검증에서 불일치 {problems}건이 발견되었습니다.", evidence)
    return CheckOutcome("PASS", f"파일 {len(ctx.files)}개의 checksum과 manifest가 일치합니다.", evidence)
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
uv run pytest apps/api/modules/readiness/tests/test_validator_checksum.py -q
uv run ruff check apps/api/modules/readiness tests/fixtures && uv run ruff format --check apps/api/modules/readiness tests/fixtures
```
Expected: `4 passed`; ruff clean.

- [ ] **Step 5: Commit**

```bash
git add apps/api/modules/readiness/tests/test_validator_checksum.py apps/api/modules/readiness/validators/file_checksum.py
git commit -m "feat(readiness): integrity.file_checksum" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```


---

### Task 7: schema.presence and semantics.mapping_status

09 §3.2 and §3.9 (P0 mapping source is `x-nais-concept` only).

**Files:**
- Create: `apps/api/modules/readiness/validators/schema_presence.py`
- Create: `apps/api/modules/readiness/validators/mapping_status.py`
- Test: `apps/api/modules/readiness/tests/test_validators_schema.py`

**Interfaces:**
- Consumes: `EvaluationContext.schema_doc/file_stats/tabular` (Task 5), `ratio` (Task 2).
- Produces: `validators.schema_presence.check`, `validators.mapping_status.check`.

- [ ] **Step 1: Write the failing test**

`apps/api/modules/readiness/tests/test_validators_schema.py` (create):

```python
import io
import json

import pyarrow as pa
import pyarrow.parquet as pq

from api.modules.readiness.tests.builders import make_ctx, schema_doc, with_schema
from api.modules.readiness.tests.helpers import fixture_files
from api.modules.readiness.validators import mapping_status, schema_presence

FIELDS = [
    {"name": "a", "type": "integer", "x-nais-concept": "https://example.org/a"},
    {"name": "b", "type": "string", "x-nais-concept": "https://example.org/b"},
]


def _base() -> dict[str, bytes]:
    return {"README.md": b"# t\n", "data/t.csv": b"a,b\n1,x\n"}


def _parquet_bytes() -> bytes:
    sink = io.BytesIO()
    pq.write_table(pa.table({"a": [1, 2]}), sink)
    return sink.getvalue()


# ---------------------------------------------------------------- schema.presence


def test_schema_presence_pass_on_fixture() -> None:
    outcome = schema_presence.check(make_ctx())
    assert outcome.status == "PASS"
    assert (outcome.evidence["tabular_files"], outcome.evidence["described"]) == (1, 1)


def test_not_applicable_without_tabular_files() -> None:
    files = {"README.md": b"# t\n", "raw/scan.h5": b"\x89HDF", "_notes.csv": b"a\n1\n"}
    assert schema_presence.check(make_ctx(files=files)).status == "NOT_APPLICABLE"


def test_missing_schema_fails_for_csv_but_warns_for_parquet_only() -> None:
    assert schema_presence.check(make_ctx(files=_base())).status == "FAIL"
    parquet_only = {"README.md": b"# t\n", "data/t.parquet": _parquet_bytes()}
    assert schema_presence.check(make_ctx(files=parquet_only)).status == "WARNING"


def test_invalid_json_and_subset_violations_fail_with_pointers() -> None:
    outcome = schema_presence.check(make_ctx(files={**_base(), "_schema.json": b"{not json"}))
    assert (outcome.status, outcome.evidence["schema_errors"]) == (
        "FAIL",
        [{"pointer": "", "error": "json_parse"}],
    )
    bad_type = with_schema(_base(), schema_doc("data/t.csv", [{"name": "a", "type": "float"}]))
    outcome = schema_presence.check(make_ctx(files=bad_type))
    assert outcome.status == "FAIL"
    assert outcome.evidence["schema_errors"] == [
        {"pointer": "/resources/0/schema/fields/0/type", "error": "enum"}
    ]


def test_undescribed_csv_fails_and_undescribed_parquet_warns() -> None:
    files = with_schema({**_base(), "data/u.csv": b"z\n1\n"}, schema_doc("data/t.csv", FIELDS))
    outcome = schema_presence.check(make_ctx(files=files))
    assert (outcome.status, outcome.evidence["undescribed"]) == ("FAIL", ["data/u.csv"])
    files = with_schema({**_base(), "data/u.parquet": _parquet_bytes()}, schema_doc("data/t.csv", FIELDS))
    outcome = schema_presence.check(make_ctx(files=files))
    assert (outcome.status, outcome.evidence["undescribed"]) == ("WARNING", ["data/u.parquet"])


def test_header_mismatch_rules() -> None:
    missing_col = with_schema({**_base(), "data/t.csv": b"a\n1\n"}, schema_doc("data/t.csv", FIELDS))
    outcome = schema_presence.check(make_ctx(files=missing_col))
    assert outcome.status == "FAIL"
    assert outcome.evidence["header_mismatch"] == [
        {"path": "data/t.csv", "missing_in_header": ["b"], "undeclared_columns": []}
    ]
    extra_col = with_schema({**_base(), "data/t.csv": b"a,b,note\n1,x,y\n"}, schema_doc("data/t.csv", FIELDS))
    outcome = schema_presence.check(make_ctx(files=extra_col))
    assert outcome.status == "WARNING"
    assert outcome.evidence["header_mismatch"][0]["undeclared_columns"] == ["note"]
    case = with_schema({**_base(), "data/t.csv": b"A,b\n1,x\n"}, schema_doc("data/t.csv", FIELDS))
    assert schema_presence.check(make_ctx(files=case)).status == "FAIL"  # names are case-sensitive
    dup = with_schema({**_base(), "data/t.csv": b"a,b,a\n1,x,2\n"}, schema_doc("data/t.csv", FIELDS))
    outcome = schema_presence.check(make_ctx(files=dup))
    assert (outcome.status, outcome.evidence["header_mismatch"][0]["duplicate_columns"]) == ("FAIL", ["a"])


def test_resource_path_not_in_version_fails() -> None:
    doc = {
        "resources": schema_doc("data/t.csv", FIELDS)["resources"]
        + schema_doc("data/gone.csv", FIELDS)["resources"]
    }
    outcome = schema_presence.check(make_ctx(files=with_schema(_base(), doc)))
    assert (outcome.status, outcome.evidence["unknown_resource_paths"]) == ("FAIL", ["data/gone.csv"])


def test_tabular_cap_records_skipped_files() -> None:
    files = {f"data/{i:02d}.csv": b"a\n1\n" for i in range(3)}
    doc = {
        "resources": [{"path": p, "schema": {"fields": [{"name": "a", "type": "integer"}]}} for p in files]
    }
    outcome = schema_presence.check(make_ctx(files=with_schema(files, doc), max_tabular_files=2))
    assert outcome.evidence["tabular_files"] == 2
    assert outcome.evidence["skipped_files"] == ["data/02.csv"]


# ---------------------------------------------------------------- semantics.mapping_status


def test_mapping_pass_on_fixture() -> None:
    outcome = mapping_status.check(make_ctx())
    assert outcome.status == "PASS"
    assert outcome.evidence == {
        "declared_fields": 5,
        "mapped_fields": 5,
        "ratio": 1.0,
        "unmapped": [],
        "malformed_iri": [],
    }


def test_mapping_boundary_and_malformed_iri() -> None:
    fields = [{"name": f"f{i}", "type": "string", "x-nais-concept": f"https://e.org/{i}"} for i in range(4)]
    fields.append({"name": "f4", "type": "string", "x-nais-concept": "urn:not-http"})
    csv = (",".join(f["name"] for f in fields) + "\n" + ",".join("x" for _ in fields) + "\n").encode()
    outcome = mapping_status.check(
        make_ctx(files=with_schema({"data/t.csv": csv}, schema_doc("data/t.csv", fields)))
    )
    assert (outcome.status, outcome.evidence["ratio"]) == ("PASS", 0.8)  # exactly 80%
    assert outcome.evidence["malformed_iri"] == [{"path": "data/t.csv", "field": "f4"}]
    fields[3].pop("x-nais-concept")
    outcome = mapping_status.check(
        make_ctx(files=with_schema({"data/t.csv": csv}, schema_doc("data/t.csv", fields)))
    )
    assert outcome.status == "WARNING"


def test_mapping_not_applicable_without_valid_schema() -> None:
    files = {k: v for k, v in fixture_files().items() if k != "_schema.json"}
    assert mapping_status.check(make_ctx(files=files)).status == "NOT_APPLICABLE"
    files["_schema.json"] = json.dumps({"resources": "nope"}).encode()
    assert mapping_status.check(make_ctx(files=files)).status == "NOT_APPLICABLE"
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
uv run pytest apps/api/modules/readiness/tests/test_validators_schema.py -q
```
Expected: collection error, `ImportError: cannot import name 'mapping_status' from 'api.modules.readiness.validators'`.

- [ ] **Step 3: Implement**

`apps/api/modules/readiness/validators/schema_presence.py` (create):

```python
"""schema.presence (09 §3.2)."""

from typing import Any

from api.modules.readiness.engine.context import CheckOutcome, EvaluationContext


def check(ctx: EvaluationContext) -> CheckOutcome:
    tabular_paths = [f.path for f in ctx.tabular]
    if not tabular_paths:
        return CheckOutcome(
            "NOT_APPLICABLE", "표 형식 데이터 파일이 없어 평가하지 않습니다.", {"tabular_files": 0}
        )
    doc = ctx.schema_doc
    evidence: dict[str, Any] = {
        "tabular_files": len(tabular_paths),
        "described": 0,
        "undescribed": [],
        "schema_present": doc.present,
        "schema_errors": list(doc.errors),
        "unknown_resource_paths": [],
        "header_mismatch": [],
    }
    if ctx.skipped_tabular:
        evidence["skipped_files"] = ctx.skipped_tabular
    if not doc.present:
        evidence["undescribed"] = tabular_paths
        if all(p.lower().endswith(".parquet") for p in tabular_paths):
            return CheckOutcome("WARNING", "_schema.json이 없어 parquet 내장 스키마로 대체합니다.", evidence)
        return CheckOutcome(
            "FAIL", "_schema.json이 없습니다. 표 형식 파일의 필드와 타입을 기술하세요.", evidence
        )
    if not doc.valid:
        return CheckOutcome("FAIL", "_schema.json을 해석할 수 없거나 스키마 규칙을 위반합니다.", evidence)

    evidence["unknown_resource_paths"] = sorted(p for p in doc.resources if p not in ctx.by_path)
    fail = bool(evidence["unknown_resource_paths"])
    warn = False
    for path in tabular_paths:
        resource = doc.resources.get(path)
        if resource is None:
            evidence["undescribed"].append(path)
            if path.lower().endswith(".parquet"):
                warn = True
            else:
                fail = True
            continue
        evidence["described"] += 1
        stats = ctx.file_stats(path)
        declared = {f.name for f in resource.fields}
        missing_in_header = sorted(declared - set(stats.header))
        undeclared = sorted(set(stats.header) - declared)
        duplicates = stats.duplicate_columns
        if missing_in_header or undeclared or duplicates:
            entry: dict[str, Any] = {
                "path": path,
                "missing_in_header": missing_in_header,
                "undeclared_columns": undeclared,
            }
            if duplicates:
                entry["duplicate_columns"] = duplicates
            evidence["header_mismatch"].append(entry)
            fail = fail or bool(missing_in_header or duplicates)
            warn = warn or bool(undeclared)
    if fail:
        return CheckOutcome(
            "FAIL", "스키마에 기술되지 않은 파일이 있거나 선언된 필드가 헤더와 맞지 않습니다.", evidence
        )
    if warn:
        return CheckOutcome(
            "WARNING", "일부 컬럼 또는 parquet 파일이 스키마에 기술되지 않았습니다.", evidence
        )
    return CheckOutcome("PASS", f"표 형식 파일 {len(tabular_paths)}개가 모두 스키마와 일치합니다.", evidence)
```

`apps/api/modules/readiness/validators/mapping_status.py` (create):

```python
"""semantics.mapping_status (09 §3.9). P0 source: x-nais-concept in _schema.json only."""

import re
from typing import Any

from api.modules.readiness.engine.canonical import ratio
from api.modules.readiness.engine.context import CheckOutcome, EvaluationContext

_IRI = re.compile(r"https?://\S+")


def check(ctx: EvaluationContext) -> CheckOutcome:
    doc = ctx.schema_doc
    if not ctx.tabular or not doc.valid:
        message = "표 형식 파일 또는 유효한 _schema.json이 없어 평가하지 않습니다."
        return CheckOutcome("NOT_APPLICABLE", message, {"declared_fields": 0})
    declared = mapped = 0
    unmapped: list[dict[str, str]] = []
    malformed: list[dict[str, str]] = []
    for path in sorted(doc.resources):
        for fld in doc.resources[path].fields:
            declared += 1
            if fld.concept is not None and _IRI.fullmatch(fld.concept):
                mapped += 1
                continue
            unmapped.append({"path": path, "field": fld.name})
            if fld.concept is not None:
                malformed.append({"path": path, "field": fld.name})
    share = ratio(mapped, declared)
    evidence: dict[str, Any] = {
        "declared_fields": declared,
        "mapped_fields": mapped,
        "ratio": share,
        "unmapped": sorted(unmapped, key=lambda e: (e["path"], e["field"])),
        "malformed_iri": sorted(malformed, key=lambda e: (e["path"], e["field"])),
    }
    if share >= ctx.params.mapping_pass_ratio:
        return CheckOutcome(
            "PASS", f"필드 {declared}개 중 {mapped}개가 개념 IRI에 매핑되어 있습니다.", evidence
        )
    threshold = f"{ctx.params.mapping_pass_ratio:.0%}"
    return CheckOutcome(
        "WARNING", f"개념 IRI 매핑 비율이 {threshold} 미만입니다 ({mapped}/{declared}).", evidence
    )
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
uv run pytest apps/api/modules/readiness/tests/test_validators_schema.py -q
uv run ruff check apps/api/modules/readiness tests/fixtures && uv run ruff format --check apps/api/modules/readiness tests/fixtures
```
Expected: `11 passed`; ruff clean.

- [ ] **Step 5: Commit**

```bash
git add apps/api/modules/readiness/tests/test_validators_schema.py apps/api/modules/readiness/validators/mapping_status.py apps/api/modules/readiness/validators/schema_presence.py
git commit -m "feat(readiness): schema.presence and semantics.mapping_status" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```


---

### Task 8: schema.datatype_validity and data.missing_values

09 §3.3 and §3.4. Row numbers are 1-based data rows (header excluded), at most 10 per field.

**Files:**
- Create: `apps/api/modules/readiness/validators/datatype_validity.py`
- Create: `apps/api/modules/readiness/validators/missing_values.py`
- Test: `apps/api/modules/readiness/tests/test_validators_values.py`

**Interfaces:**
- Consumes: `EvaluationContext.file_stats/resource` (Task 5), `ratio` (Task 2).
- Produces: `validators.datatype_validity.check` (+ `evaluable_paths(ctx)`), `validators.missing_values.check`.

- [ ] **Step 1: Write the failing test**

`apps/api/modules/readiness/tests/test_validators_values.py` (create):

```python
from typing import Any

from api.modules.readiness.tests.builders import make_ctx, schema_doc, with_schema
from api.modules.readiness.validators import datatype_validity, missing_values

FIELDS = [{"name": "id", "type": "string"}, {"name": "v", "type": "number"}]


def _files(values: list[str], fields: list[dict[str, Any]] | None = None, **schema: Any) -> dict[str, bytes]:
    body = "id,v\n" + "".join(f"r{i},{v}\n" for i, v in enumerate(values, start=1))
    return with_schema({"data/t.csv": body.encode()}, schema_doc("data/t.csv", fields or FIELDS, **schema))


# ---------------------------------------------------------------- schema.datatype_validity


def test_datatype_pass_on_fixture() -> None:
    outcome = datatype_validity.check(make_ctx())
    assert outcome.status == "PASS"
    assert outcome.evidence == {
        "files": [
            {
                "path": "data/measurements.csv",
                "sampled_rows": 1000,
                "truncated": False,
                "malformed_rows": 0,
                "encoding_error": False,
            }
        ],
        "fields": [],
    }


def test_datatype_warning_at_exactly_one_percent_and_fail_above() -> None:
    warn = datatype_validity.check(make_ctx(files=_files(["x"] + ["1.5"] * 99)))
    assert warn.status == "WARNING"
    assert warn.evidence["fields"] == [
        {
            "path": "data/t.csv",
            "field": "v",
            "declared_type": "number",
            "checked": 100,
            "invalid": 1,
            "invalid_ratio": 0.01,
            "first_invalid_rows": [1],
        }
    ]
    assert datatype_validity.check(make_ctx(files=_files(["x", "y"] + ["1.5"] * 98))).status == "FAIL"


def test_missing_tokens_are_not_type_checked() -> None:
    assert datatype_validity.check(make_ctx(files=_files(["", "NA", "1"]))).status == "PASS"


def test_first_invalid_rows_capped_at_ten() -> None:
    outcome = datatype_validity.check(make_ctx(files=_files(["bad"] * 12)))
    assert outcome.evidence["fields"][0]["first_invalid_rows"] == list(range(1, 11))


def test_malformed_rows_warn_then_fail() -> None:
    rows = "id,v\n" + "".join(f"r{i},1\n" for i in range(1, 1000)) + "broken\n"
    ctx = make_ctx(files=with_schema({"data/t.csv": rows.encode()}, schema_doc("data/t.csv", FIELDS)))
    assert datatype_validity.check(ctx).status == "WARNING"  # 1/1000 = 0.1% is not above the limit
    rows += "broken\n"
    ctx = make_ctx(files=with_schema({"data/t.csv": rows.encode()}, schema_doc("data/t.csv", FIELDS)))
    assert datatype_validity.check(ctx).status == "FAIL"


def test_encoding_error_fails() -> None:
    files = with_schema({"data/t.csv": b"id,v\nr1,\xff\n"}, schema_doc("data/t.csv", FIELDS))
    outcome = datatype_validity.check(make_ctx(files=files))
    assert (outcome.status, outcome.evidence["files"][0]["encoding_error"]) == ("FAIL", True)


def test_datatype_not_applicable_when_nothing_evaluable() -> None:
    assert datatype_validity.check(make_ctx(files={"data/t.csv": b"a\n1\n"})).status == "NOT_APPLICABLE"
    assert datatype_validity.check(make_ctx(files={"README.md": b"#\n"})).status == "NOT_APPLICABLE"


def test_evidence_never_contains_cell_values() -> None:
    outcome = datatype_validity.check(make_ctx(files=_files(["SECRET-VALUE-123"] + ["1"] * 5)))
    assert "SECRET-VALUE-123" not in str(outcome.evidence) + outcome.message


# ---------------------------------------------------------------- data.missing_values


def test_missing_pass_on_fixture_lists_pressure() -> None:
    outcome = missing_values.check(make_ctx())
    assert outcome.status == "PASS"
    assert outcome.evidence == {
        "overall_missing_ratio": 0.002,
        "fields": [{"path": "data/measurements.csv", "field": "pressure_kpa", "missing": 10, "ratio": 0.01}],
        "required_field_violations": [],
    }


def test_missing_field_boundaries() -> None:
    five_pct = ["", *["1"] * 19]  # field 1/20 = 5% (not above), overall 1/40
    assert missing_values.check(make_ctx(files=_files(five_pct))).status == "PASS"
    ten_pct = ["", "", *["1"] * 18]  # field 10%, overall exactly 5%
    assert missing_values.check(make_ctx(files=_files(ten_pct))).status == "WARNING"
    half = ["", "1"]  # 50% is not above the FAIL limit
    assert missing_values.check(make_ctx(files=_files(half))).status == "WARNING"
    assert missing_values.check(make_ctx(files=_files(["", "", "1"]))).status == "FAIL"


def test_required_and_primary_key_fields_must_not_be_missing() -> None:
    fields = [
        {"name": "id", "type": "string"},
        {"name": "v", "type": "number", "constraints": {"required": True}},
    ]
    outcome = missing_values.check(make_ctx(files=_files(["1"] * 99 + [""], fields)))
    assert outcome.status == "FAIL"
    assert outcome.evidence["required_field_violations"] == [
        {"path": "data/t.csv", "field": "v", "missing": 1}
    ]
    pk = with_schema({"data/t.csv": b"id,v\n,1\nr2,2\n"}, schema_doc("data/t.csv", FIELDS, primaryKey="id"))
    assert missing_values.check(make_ctx(files=pk)).status == "FAIL"


def test_resource_missing_values_override_defaults() -> None:
    outcome = missing_values.check(make_ctx(files=_files(["-999", "1", "2", "3"], missingValues=["-999"])))
    assert outcome.evidence["fields"] == [{"path": "data/t.csv", "field": "v", "missing": 1, "ratio": 0.25}]
    outcome = missing_values.check(make_ctx(files=_files(["NA", "1", "2", "3"], missingValues=["-999"])))
    assert outcome.evidence["fields"] == []  # "NA" is a value for this resource


def test_undescribed_csv_uses_default_tokens() -> None:
    outcome = missing_values.check(make_ctx(files={"data/t.csv": b"a\nNULL\n1\n1\n1\n"}))
    assert outcome.evidence["fields"] == [{"path": "data/t.csv", "field": "a", "missing": 1, "ratio": 0.25}]


def test_missing_not_applicable_without_tabular() -> None:
    assert missing_values.check(make_ctx(files={"README.md": b"#\n"})).status == "NOT_APPLICABLE"


def test_header_only_file_has_zero_ratios() -> None:
    """Review focus: a csv with a header and no rows must not divide by zero."""
    files = with_schema({"data/t.csv": b"id,v\n"}, schema_doc("data/t.csv", FIELDS))
    datatype = datatype_validity.check(make_ctx(files=files))
    assert (datatype.status, datatype.evidence["files"][0]["sampled_rows"]) == ("PASS", 0)
    missing = missing_values.check(make_ctx(files=files))
    assert (missing.status, missing.evidence["overall_missing_ratio"]) == ("PASS", 0.0)


def test_tsv_uses_tab_delimiter() -> None:
    files = with_schema({"data/t.tsv": b"id\tv\nr1\t1,5\n"}, schema_doc("data/t.tsv", FIELDS))
    outcome = datatype_validity.check(make_ctx(files=files))
    assert outcome.evidence["fields"][0]["field"] == "v"  # "1,5" is one (invalid) number, not two columns
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
uv run pytest apps/api/modules/readiness/tests/test_validators_values.py -q
```
Expected: collection error, `ImportError: cannot import name 'datatype_validity' from 'api.modules.readiness.validators'`.

- [ ] **Step 3: Implement**

`apps/api/modules/readiness/validators/datatype_validity.py` (create):

```python
"""schema.datatype_validity (09 §3.3)."""

from typing import Any

from api.modules.readiness.engine.canonical import ratio
from api.modules.readiness.engine.context import CheckOutcome, EvaluationContext


def evaluable_paths(ctx: EvaluationContext) -> list[str]:
    """Described csv/tsv files, plus every parquet file (its column types exist even when undescribed)."""
    return [
        f.path for f in ctx.tabular if f.path.lower().endswith(".parquet") or ctx.resource(f.path) is not None
    ]


def check(ctx: EvaluationContext) -> CheckOutcome:
    paths = evaluable_paths(ctx)
    if not paths:
        message = "타입을 검사할 수 있는 표 형식 파일이 없습니다."
        return CheckOutcome("NOT_APPLICABLE", message, {"files": [], "fields": []})
    p = ctx.params
    files: list[dict[str, Any]] = []
    fields: list[dict[str, Any]] = []
    encoding_error = False
    worst_field_ratio = worst_malformed_ratio = 0.0
    for path in paths:
        stats = ctx.file_stats(path)
        encoding_error = encoding_error or stats.encoding_error
        files.append(
            {
                "path": path,
                "sampled_rows": stats.sampled_rows,
                "truncated": stats.truncated,
                "malformed_rows": stats.malformed_rows,
                "encoding_error": stats.encoding_error,
            }
        )
        worst_malformed_ratio = max(worst_malformed_ratio, ratio(stats.malformed_rows, stats.rows_read))
        resource = ctx.resource(path)
        declared = {f.name: f.type for f in resource.fields} if resource else {}
        for name in sorted(stats.columns):
            col = stats.columns[name]
            if col.invalid == 0:
                continue
            field_ratio = ratio(col.invalid, col.checked)
            worst_field_ratio = max(worst_field_ratio, field_ratio)
            entry: dict[str, Any] = {
                "path": path,
                "field": name,
                "declared_type": declared.get(name, "string"),
                "checked": col.checked,
                "invalid": col.invalid,
                "invalid_ratio": field_ratio,
                "first_invalid_rows": list(col.first_invalid_rows),
            }
            if stats.parquet_types is not None:
                entry["parquet_type"] = stats.parquet_types.get(name)
            fields.append(entry)
    evidence: dict[str, Any] = {"files": files, "fields": fields}
    if ctx.skipped_tabular:
        evidence["skipped_files"] = ctx.skipped_tabular
    if (
        encoding_error
        or worst_field_ratio > p.datatype_fail_ratio
        or worst_malformed_ratio > p.malformed_rows_fail_ratio
    ):
        message = "타입 규칙을 위반한 값, 형식이 깨진 행 또는 인코딩 오류가 허용 한도를 넘었습니다."
        return CheckOutcome("FAIL", message, evidence)
    if worst_field_ratio > p.datatype_warn_ratio or worst_malformed_ratio > 0:
        return CheckOutcome(
            "WARNING", "일부 값이 선언된 타입과 맞지 않거나 형식이 깨진 행이 있습니다.", evidence
        )
    return CheckOutcome("PASS", "sample의 모든 값이 선언된 타입과 일치합니다.", evidence)
```

`apps/api/modules/readiness/validators/missing_values.py` (create):

```python
"""data.missing_values (09 §3.4)."""

from typing import Any

from api.modules.readiness.engine.canonical import ratio
from api.modules.readiness.engine.context import CheckOutcome, EvaluationContext


def check(ctx: EvaluationContext) -> CheckOutcome:
    if not ctx.tabular:
        return CheckOutcome("NOT_APPLICABLE", "표 형식 데이터 파일이 없어 평가하지 않습니다.", {"fields": []})
    p = ctx.params
    fields: list[dict[str, Any]] = []
    violations: list[dict[str, Any]] = []
    total_cells = total_missing = 0
    worst = 0.0
    for ref in ctx.tabular:
        stats = ctx.file_stats(ref.path)
        resource = ctx.resource(ref.path)
        must_have: set[str] = set()
        if resource is not None:
            must_have = set(resource.primary_key) | {f.name for f in resource.fields if f.required}
        for name in sorted(stats.columns):
            col = stats.columns[name]
            total_cells += stats.sampled_rows
            total_missing += col.missing
            if col.missing == 0:
                continue
            field_ratio = ratio(col.missing, stats.sampled_rows)
            worst = max(worst, field_ratio)
            fields.append({"path": ref.path, "field": name, "missing": col.missing, "ratio": field_ratio})
            if name in must_have:
                violations.append({"path": ref.path, "field": name, "missing": col.missing})
    overall = ratio(total_missing, total_cells)
    evidence: dict[str, Any] = {
        "overall_missing_ratio": overall,
        "fields": fields,
        "required_field_violations": violations,
    }
    if violations or worst > p.missing_fail_ratio:
        message = "필수 필드(primaryKey/required)에 결측이 있거나 결측률 50%를 넘는 필드가 있습니다."
        return CheckOutcome("FAIL", message, evidence)
    if worst > p.missing_warn_ratio or overall > p.missing_overall_warn_ratio:
        return CheckOutcome(
            "WARNING", "결측률이 5%를 넘는 필드가 있거나 전체 결측률이 5%를 넘습니다.", evidence
        )
    return CheckOutcome("PASS", f"결측률이 허용 범위 이내입니다 (전체 {overall:.2%}).", evidence)
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
uv run pytest apps/api/modules/readiness/tests/test_validators_values.py -q
uv run ruff check apps/api/modules/readiness tests/fixtures && uv run ruff format --check apps/api/modules/readiness tests/fixtures
```
Expected: `16 passed`; ruff clean.

- [ ] **Step 5: Commit**

```bash
git add apps/api/modules/readiness/tests/test_validators_values.py apps/api/modules/readiness/validators/datatype_validity.py apps/api/modules/readiness/validators/missing_values.py
git commit -m "feat(readiness): datatype validity and missing value checks" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```


---

### Task 9: UCUM unit parser, bundled dictionaries and semantics.units_codebook

09 §3.5: case-sensitive UCUM syntax against bundled atoms/prefixes; correction hints only from the bundled alias table; codebook codes counted, never shown.

**Files:**
- Create: `apps/api/modules/readiness/dictionaries/ucum_atoms_v1.txt`
- Create: `apps/api/modules/readiness/dictionaries/ucum_prefixes_v1.txt`
- Create: `apps/api/modules/readiness/dictionaries/unit_aliases_v1.csv`
- Create: `apps/api/modules/readiness/engine/units.py`
- Create: `apps/api/modules/readiness/validators/units_codebook.py`
- Test: `apps/api/modules/readiness/tests/test_units.py`

**Interfaces:**
- Consumes: `EvaluationContext` (Task 5), `ratio` (Task 2).
- Produces: `engine.units`: `atoms() -> dict[str, bool]`, `prefixes() -> tuple[str, ...]`, `aliases() -> dict`, `unit_error(unit) -> str | None` (`SYNTAX_ERROR` | `UNKNOWN_ATOM` | `PREFIX_NOT_ALLOWED`), `suggestion(unit) -> str | None`; `validators.units_codebook.check` (+ `numeric_fields(ctx)`).

- [ ] **Step 1: Write the failing test**

`apps/api/modules/readiness/tests/test_units.py` (create):

```python
import io
from typing import Any

import pyarrow as pa
import pyarrow.parquet as pq
import pytest

from api.modules.readiness.engine.context import EvaluationContext
from api.modules.readiness.engine.units import suggestion, unit_error
from api.modules.readiness.tests.builders import make_ctx, schema_doc, with_schema
from api.modules.readiness.tests.helpers import fixture_files
from api.modules.readiness.validators import units_codebook


@pytest.mark.parametrize(
    "unit",
    [
        "Cel",
        "kPa",
        "mg/L",
        "1",
        "m2",
        "cm-1",
        "/s",
        "kg.m/s2",
        "mm[Hg]",
        "{count}",
        "10*3",
        "[degF]",
        "%",
        "ug/L",
        "mg{total}/dL",
        "(kg.m)/s2",
        "K",
    ],
)
def test_valid_ucum(unit: str) -> None:
    assert unit_error(unit) is None


@pytest.mark.parametrize(
    ("unit", "error"),
    [
        ("degC", "UNKNOWN_ATOM"),
        ("kilopascal", "UNKNOWN_ATOM"),
        ("KPA", "UNKNOWN_ATOM"),  # case-sensitive
        ("kmin", "PREFIX_NOT_ALLOWED"),
        ("m.", "SYNTAX_ERROR"),
        ("(m", "SYNTAX_ERROR"),
        ("m s", "SYNTAX_ERROR"),
        ("", "SYNTAX_ERROR"),
        ("m{a", "SYNTAX_ERROR"),
    ],
)
def test_invalid_ucum(unit: str, error: str) -> None:
    assert unit_error(unit) == error


def test_alias_suggestions_come_from_bundled_table() -> None:
    assert (suggestion("degC"), suggestion("kilopascal"), suggestion("zzz")) == ("Cel", "kPa", None)


FIELDS = [
    {"name": "id", "type": "string"},
    {"name": "t", "type": "number", "unit": "Cel"},
    {"name": "p", "type": "number", "unit": "kPa"},
    {"name": "n", "type": "integer", "unit": "1"},
    {"name": "q", "type": "number", "unit": "mg/L"},
    {"name": "r", "type": "number", "unit": "s"},
]
CSV = b"id,t,p,n,q,r\na,1,2,3,4,5\n"


def _ctx(fields: list[dict[str, Any]], codebook: bytes | None = None, csv: bytes = CSV) -> EvaluationContext:
    files = with_schema({"data/t.csv": csv}, schema_doc("data/t.csv", fields))
    if codebook is not None:
        files["_codebook.csv"] = codebook
    return make_ctx(files=files)


def test_units_pass_on_fixture() -> None:
    outcome = units_codebook.check(make_ctx())
    assert outcome.status == "PASS"
    assert (outcome.evidence["numeric_fields"], outcome.evidence["with_valid_unit"]) == (2, 2)


def test_units_fail_matches_invalid_units_fixture() -> None:
    outcome = units_codebook.check(make_ctx(files=fixture_files("invalid_units")))
    assert outcome.status == "FAIL"
    assert outcome.evidence["invalid_unit"] == [
        {
            "path": "data/measurements.csv",
            "field": "pressure_kpa",
            "unit": "kilopascal",
            "error": "UNKNOWN_ATOM",
        },
        {"path": "data/measurements.csv", "field": "temperature_c", "unit": "degC", "error": "UNKNOWN_ATOM"},
    ]
    assert (
        outcome.message
        == "UCUM 단위로 해석할 수 없는 값이 2개 있습니다 (예: pressure_kpa: kilopascal → kPa)."
    )


def test_missing_unit_ratio_boundary() -> None:
    one_missing = [dict(f) for f in FIELDS]
    one_missing[5].pop("unit")  # 1/5 = 20% -> WARNING
    assert units_codebook.check(_ctx(one_missing)).status == "WARNING"
    two_missing = [dict(f) for f in one_missing]
    two_missing[4].pop("unit")  # 2/5 = 40% -> FAIL
    assert units_codebook.check(_ctx(two_missing)).status == "FAIL"


def test_codebook_unit_row_is_a_source_and_conflicts_warn() -> None:
    fields = [dict(f) for f in FIELDS]
    fields[5].pop("unit")
    codebook = b"path,field,code,label,unit,description\ndata/t.csv,r,,,s,\ndata/t.csv,t,,,K,\n"
    outcome = units_codebook.check(_ctx(fields, codebook))
    assert outcome.status == "WARNING"
    assert outcome.evidence["missing_unit"] == []
    assert outcome.evidence["conflicts"] == [
        {"path": "data/t.csv", "field": "t", "schema_unit": "Cel", "codebook_unit": "K"}
    ]


def test_undefined_codebook_codes_warn_with_counts_only() -> None:
    fields = [*FIELDS, {"name": "m", "type": "string"}]
    csv = b"id,t,p,n,q,r,m\na,1,2,3,4,5,AL\nb,1,2,3,4,5,ZN\n"
    codebook = b"path,field,code,label,unit,description\ndata/t.csv,m,AL,Aluminium,,\n"
    outcome = units_codebook.check(_ctx(fields, codebook, csv))
    assert outcome.status == "WARNING"
    assert outcome.evidence["undefined_code_counts"] == [{"path": "data/t.csv", "field": "m", "undefined": 1}]
    assert "ZN" not in str(outcome.evidence)


def test_no_unit_source_at_all_fails() -> None:
    sink = io.BytesIO()
    pq.write_table(pa.table({"x": pa.array([1.5, 2.5])}), sink)
    outcome = units_codebook.check(make_ctx(files={"data/t.parquet": sink.getvalue()}))
    assert (outcome.status, outcome.evidence["numeric_fields"]) == ("FAIL", 1)


def test_not_applicable_without_numeric_fields() -> None:
    assert (
        units_codebook.check(_ctx([{"name": "id", "type": "string"}], csv=b"id\na\n")).status
        == "NOT_APPLICABLE"
    )
    assert units_codebook.check(make_ctx(files={"README.md": b"#\n"})).status == "NOT_APPLICABLE"
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
uv run pytest apps/api/modules/readiness/tests/test_units.py -q
```
Expected: collection error, `ModuleNotFoundError: No module named 'api.modules.readiness.engine.units'`.

- [ ] **Step 3: Implement**

`apps/api/modules/readiness/dictionaries/ucum_atoms_v1.txt` (create):

```text
# UCUM atoms bundled for P0 (case-sensitive "c/s" symbols). Format: <symbol><TAB><metric 1|0>.
# Only metric atoms accept a prefix. Changing this file requires a VALIDATOR_VERSION bump.
m	1
s	1
g	1
rad	1
K	1
C	1
cd	1
mol	1
sr	1
Hz	1
N	1
Pa	1
J	1
W	1
A	1
V	1
F	1
Ohm	1
S	1
Wb	1
Cel	1
T	1
H	1
lm	1
lx	1
Bq	1
Gy	1
Sv	1
kat	1
U	1
l	1
L	1
ar	1
t	1
bar	1
u	1
eV	1
pc	1
cal	1
B	1
bit	1
By	1
Bd	1
eq	1
osm	1
g%	1
dyn	1
erg	1
P	1
St	1
G	1
Mx	1
Oe	1
Ci	1
R	1
mho	1
m[Hg]	1
m[H2O]	1
[iU]	1
[IU]	1
10*	0
10^	0
min	0
h	0
d	0
a	0
wk	0
mo	0
deg	0
'	0
''	0
gon	0
%	0
[ppth]	0
[ppm]	0
[ppb]	0
[pptr]	0
[pH]	0
atm	0
AU	0
[in_i]	0
[ft_i]	0
[yd_i]	0
[mi_i]	0
[lb_av]	0
[oz_av]	0
[degF]	0
[psi]	0
[gal_us]	0
[kn_i]	0
```

`apps/api/modules/readiness/dictionaries/ucum_prefixes_v1.txt` (create):

```text
# UCUM prefixes (case-sensitive). One per line.
Y
Z
E
P
T
G
M
k
h
da
d
c
m
u
n
p
f
a
z
y
```

`apps/api/modules/readiness/dictionaries/unit_aliases_v1.csv` (create):

```csv
alias,ucum
degC,Cel
°C,Cel
celsius,Cel
Celsius,Cel
deg C,Cel
degF,[degF]
°F,[degF]
kilopascal,kPa
kpa,kPa
KPa,kPa
KPA,kPa
pascal,Pa
Pascal,Pa
mpa,MPa
percent,%
pct,%
ppm,[ppm]
ppb,[ppb]
mg/l,mg/L
ug/l,ug/L
µg/L,ug/L
hr,h
hours,h
sec,s
seconds,s
minutes,min
volt,V
ampere,A
kelvin,K
```

`apps/api/modules/readiness/engine/units.py` (create):

```python
"""UCUM case-sensitive syntax check against the bundled atom/prefix dictionaries (09 §3.5).

Grammar (UCUM §2.1 subset): main := ['/'] term ; term := component (('.'|'/') component)* ;
component := '(' term ')' | annotation | factor [annotation] | [prefix] atom [exponent] [annotation].
"""

import csv
import re
from functools import lru_cache
from pathlib import Path

DICT_DIR = Path(__file__).resolve().parents[1] / "dictionaries"
_WORD_STOP = frozenset(".()/{}")
_FACTOR = re.compile(r"[0-9]+")
_SYMBOL_EXPONENT = re.compile(r"(?P<symbol>.*?)(?P<exponent>[+-]?[0-9]+)?")


def _lines(name: str) -> list[str]:
    text = (DICT_DIR / name).read_text(encoding="utf-8")
    return [line for line in text.splitlines() if line and not line.startswith("#")]


@lru_cache(maxsize=1)
def atoms() -> dict[str, bool]:
    """symbol -> metric (only metric atoms take a prefix)."""
    return {sym: metric == "1" for sym, metric in (line.split("\t") for line in _lines("ucum_atoms_v1.txt"))}


@lru_cache(maxsize=1)
def prefixes() -> tuple[str, ...]:
    return tuple(sorted(_lines("ucum_prefixes_v1.txt"), key=lambda p: (-len(p), p)))


@lru_cache(maxsize=1)
def aliases() -> dict[str, str]:
    with (DICT_DIR / "unit_aliases_v1.csv").open(encoding="utf-8", newline="") as fh:
        return {row["alias"]: row["ucum"] for row in csv.DictReader(fh)}


class UnitError(Exception):
    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


class _Parser:
    def __init__(self, text: str) -> None:
        self.text = text
        self.i = 0

    def peek(self) -> str:
        return self.text[self.i] if self.i < len(self.text) else ""

    def parse(self) -> None:
        if self.peek() == "/":
            self.i += 1
        self.term()
        if self.i != len(self.text):
            raise UnitError("SYNTAX_ERROR")

    def term(self) -> None:
        self.component()
        while self.peek() in (".", "/"):
            self.i += 1
            self.component()

    def component(self) -> None:
        char = self.peek()
        if char == "(":
            self.i += 1
            self.term()
            if self.peek() != ")":
                raise UnitError("SYNTAX_ERROR")
            self.i += 1
            return
        if char == "{":
            self.annotation()
            return
        start = self.i
        while self.i < len(self.text) and self.text[self.i] not in _WORD_STOP:
            self.i += 1
        word = self.text[start : self.i]
        if not word:
            raise UnitError("SYNTAX_ERROR")
        if _FACTOR.fullmatch(word) is None:
            self.simple_unit(word)
        if self.peek() == "{":
            self.annotation()

    def annotation(self) -> None:
        end = self.text.find("}", self.i)
        if end == -1 or "{" in self.text[self.i + 1 : end]:
            raise UnitError("SYNTAX_ERROR")
        self.i = end + 1

    @staticmethod
    def simple_unit(word: str) -> None:
        match = _SYMBOL_EXPONENT.fullmatch(word)
        symbol = match.group("symbol") if match else ""
        if not symbol:
            raise UnitError("SYNTAX_ERROR")
        table = atoms()
        if symbol in table:
            return
        for prefix in prefixes():
            rest = symbol[len(prefix) :]
            if symbol.startswith(prefix) and rest in table:
                if not table[rest]:
                    raise UnitError("PREFIX_NOT_ALLOWED")
                return
        raise UnitError("UNKNOWN_ATOM")


def unit_error(unit: str) -> str | None:
    """None when `unit` is a valid UCUM expression, else SYNTAX_ERROR | UNKNOWN_ATOM | PREFIX_NOT_ALLOWED."""
    if unit == "" or any(ch.isspace() for ch in unit):
        return "SYNTAX_ERROR"
    try:
        _Parser(unit).parse()
    except UnitError as exc:
        return exc.code
    return None


def suggestion(unit: str) -> str | None:
    """Deterministic correction hint from unit_aliases_v1.csv only."""
    return aliases().get(unit)
```

`apps/api/modules/readiness/validators/units_codebook.py` (create):

```python
"""semantics.units_codebook (09 §3.5). Unit strings are schema metadata, so evidence may show them."""

from typing import Any

from api.modules.readiness.engine.canonical import ratio
from api.modules.readiness.engine.context import CheckOutcome, EvaluationContext
from api.modules.readiness.engine.units import suggestion, unit_error

NUMERIC_TYPES = ("integer", "number")


def numeric_fields(ctx: EvaluationContext) -> list[tuple[str, str]]:
    """(path, field) of every numeric field in T: declared integer/number, or a numeric undescribed parquet column."""
    found: set[tuple[str, str]] = set()
    for ref in ctx.tabular:
        resource = ctx.resource(ref.path)
        if resource is not None:
            found |= {(ref.path, f.name) for f in resource.fields if f.type in NUMERIC_TYPES}
        elif ref.path.lower().endswith(".parquet"):
            found |= {(ref.path, name) for name in ctx.file_stats(ref.path).parquet_numeric}
    return sorted(found)


def check(ctx: EvaluationContext) -> CheckOutcome:
    fields = numeric_fields(ctx)
    if not fields:
        return CheckOutcome(
            "NOT_APPLICABLE", "숫자형 필드가 없어 단위를 평가하지 않습니다.", {"numeric_fields": 0}
        )
    schema_units = {
        (path, f.name): f.unit
        for path, resource in ctx.schema_doc.resources.items()
        for f in resource.fields
        if f.unit is not None
    }
    codebook_units = ctx.codebook.units
    missing: list[dict[str, str]] = []
    invalid: list[dict[str, str]] = []
    conflicts: list[dict[str, str]] = []
    with_valid = 0
    for key in fields:
        path, name = key
        schema_unit, codebook_unit = schema_units.get(key), codebook_units.get(key)
        if schema_unit is not None and codebook_unit is not None and schema_unit != codebook_unit:
            conflicts.append(
                {"path": path, "field": name, "schema_unit": schema_unit, "codebook_unit": codebook_unit}
            )
        units = [u for u in (schema_unit, codebook_unit) if u is not None]
        if not units:
            missing.append({"path": path, "field": name})
            continue
        bad = [(u, e) for u in dict.fromkeys(units) if (e := unit_error(u)) is not None]
        invalid.extend({"path": path, "field": name, "unit": u, "error": e} for u, e in bad)
        with_valid += not bad
    undefined: list[dict[str, Any]] = []
    for ref in ctx.tabular:
        coded = sorted(f for (p, f) in ctx.codebook.codes if p == ref.path)
        if not coded:
            continue
        stats = ctx.file_stats(ref.path)
        for name in coded:
            col = stats.columns.get(name)
            if col is not None and col.undefined_codes:
                undefined.append({"path": ref.path, "field": name, "undefined": col.undefined_codes})
    missing_ratio = ratio(len(missing), len(fields))
    evidence = {
        "numeric_fields": len(fields),
        "with_valid_unit": with_valid,
        "missing_unit": missing,
        "missing_unit_ratio": missing_ratio,
        "invalid_unit": invalid,
        "conflicts": conflicts,
        "undefined_code_counts": undefined,
    }
    if not ctx.schema_doc.present and not ctx.codebook.present:
        return CheckOutcome("FAIL", "단위 정보 출처(_schema.json, _codebook.csv)가 없습니다.", evidence)
    if invalid:
        first = invalid[0]
        hint = suggestion(first["unit"])
        example = f"{first['field']}: {first['unit']}" + (f" → {hint}" if hint else "")
        message = f"UCUM 단위로 해석할 수 없는 값이 {len(invalid)}개 있습니다 (예: {example})."
        return CheckOutcome("FAIL", message, evidence)
    if missing_ratio > ctx.params.unit_missing_fail_ratio:
        return CheckOutcome(
            "FAIL", f"단위가 없는 숫자형 필드가 {len(missing)}개로 허용 한도를 넘습니다.", evidence
        )
    if missing or conflicts or undefined:
        message = "단위 누락, schema/codebook 단위 충돌 또는 codebook에 없는 코드가 있습니다."
        return CheckOutcome("WARNING", message, evidence)
    return CheckOutcome("PASS", f"숫자형 필드 {len(fields)}개가 모두 유효한 UCUM 단위를 가집니다.", evidence)
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
uv run pytest apps/api/modules/readiness/tests/test_units.py -q
uv run ruff check apps/api/modules/readiness tests/fixtures && uv run ruff format --check apps/api/modules/readiness tests/fixtures
```
Expected: `34 passed`; ruff clean.

- [ ] **Step 5: Commit**

```bash
git add apps/api/modules/readiness/dictionaries/ucum_atoms_v1.txt apps/api/modules/readiness/dictionaries/ucum_prefixes_v1.txt apps/api/modules/readiness/dictionaries/unit_aliases_v1.csv apps/api/modules/readiness/engine/units.py apps/api/modules/readiness/tests/test_units.py apps/api/modules/readiness/validators/units_codebook.py
git commit -m "feat(readiness): UCUM parser and semantics.units_codebook" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```


---

### Task 10: evaluate(), validator registry, selfcheck CLI and golden/determinism tests

Runs a profile's checks sequentially in ordinal order, bounds evidence, aggregates overall (09 §2.4) and hashes the canonical result (09 §4). The golden `result_sha256` values are recorded once here, then every change that moves them must bump `VALIDATOR_VERSION` or a profile version. Covers M05-AT-01 (engine level), AT-02, AT-13 (engine level) and AT-14.

**Files:**
- Modify: `apps/api/modules/readiness/validators/__init__.py`
- Create: `apps/api/modules/readiness/engine/evaluate.py`
- Create: `apps/api/modules/readiness/selfcheck.py`
- Test: `apps/api/modules/readiness/tests/test_golden.py`

**Interfaces:**
- Consumes: all nine validators (Tasks 5-9), `FixtureCatalog` (Task 3), `PROFILES` (Task 1).
- Produces: `validators.VALIDATORS: dict[str, Callable[[EvaluationContext], CheckOutcome]]`; `engine.evaluate`: `Overall`, `CheckResult(check_id, ordinal, severity, status, message, evidence)` + `.to_api()`, `ValidationResult(profile_id, profile_version, validator_version, overall_status, summary, checks, result_sha256)`, `overall_status(checks)`, `summarize(checks) -> dict[str, int]`, `result_sha256(checks, overall, summary) -> str`, `evaluate(version, profile, reader, *, file_timeout_s=None) -> ValidationResult`; `selfcheck.run_fixture(root, name, profile_id)`, `selfcheck.main(argv) -> int`.

- [ ] **Step 1: Write the failing test**

`apps/api/modules/readiness/tests/test_golden.py` (create):

```python
"""Aggregation (09 §2.4), M05-AT-01 at engine level, M05-AT-02 determinism, M05-AT-13, M05-AT-14."""

import ast
import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any

import pytest

from api.modules.readiness.engine import VALIDATOR_VERSION
from api.modules.readiness.engine.evaluate import (
    CheckResult,
    evaluate,
    overall_status,
    result_sha256,
    summarize,
)
from api.modules.readiness.fakes import FIXTURES_ROOT, FixtureCatalog
from api.modules.readiness.profile_registry import PROFILES
from api.modules.readiness.selfcheck import run_fixture
from api.modules.readiness.tests.helpers import FIXTURE_NAMES, ORG_B, clean_snapshot
from api.platform.settings import REPO_ROOT

MODULE_DIR = Path(__file__).resolve().parents[1]


def _check(status: str, severity: str = "REQUIRED", check_id: str = "c") -> CheckResult:
    return CheckResult(check_id, 1, severity, status, "m", {})  # type: ignore[arg-type]


def _expected(name: str, profile_id: str) -> dict[str, Any]:
    path = FIXTURES_ROOT / name / "expected" / f"{profile_id}.json"
    return json.loads(path.read_text(encoding="utf-8"))  # type: ignore[no-any-return]


# ---------------------------------------------------------------- aggregation


@pytest.mark.parametrize(
    ("checks", "expected"),
    [
        ([_check("PASS"), _check("NOT_APPLICABLE")], "PASS"),
        ([_check("PASS"), _check("WARNING")], "WARNING"),
        ([_check("PASS"), _check("FAIL", "RECOMMENDED")], "WARNING"),
        ([_check("WARNING"), _check("FAIL", "REQUIRED")], "FAIL"),
    ],
)
def test_overall_aggregation_09_section_2_4(checks: list[CheckResult], expected: str) -> None:
    assert overall_status(checks) == expected


def test_summary_counts_every_status() -> None:
    checks = [_check("PASS"), _check("PASS"), _check("WARNING"), _check("FAIL"), _check("NOT_APPLICABLE")]
    assert summarize(checks) == {"pass": 2, "warning": 1, "fail": 1, "not_applicable": 1}


def test_result_sha256_covers_checks_overall_and_summary() -> None:
    checks = [_check("PASS")]
    summary = summarize(checks)
    first = result_sha256(checks, "PASS", summary)
    assert first == result_sha256(list(checks), "PASS", dict(summary))
    assert first != result_sha256(checks, "WARNING", summary)
    assert first != result_sha256([_check("PASS", check_id="d")], "PASS", summary)


# ---------------------------------------------------------------- golden


@pytest.mark.parametrize("profile_id", ["GENERIC_BASIC", "TABULAR_ML_BASIC"])
@pytest.mark.parametrize("name", FIXTURE_NAMES)
def test_golden_output(name: str, profile_id: str) -> None:
    expected = _expected(name, profile_id)
    result = run_fixture(FIXTURES_ROOT, name, profile_id)
    assert {c.check_id: c.status for c in result.checks} == expected["checks"]
    assert result.overall_status == expected["overall_status"]
    assert (result.profile_version, result.validator_version) == (
        expected["profile_version"],
        VALIDATOR_VERSION,
    )
    assert expected["validator_version"] == VALIDATOR_VERSION
    assert expected["result_sha256"], "record it: python -m api.modules.readiness.selfcheck --record"
    assert result.result_sha256 == expected["result_sha256"], (
        "result changed: bump VALIDATOR_VERSION (or the profile version) and re-record the golden sha256"
    )


def test_golden_table_09_section_5_6() -> None:
    """The hand-written verdicts, independent of generate.py."""
    overall = {(n, p): _expected(n, p)["overall_status"] for n in FIXTURE_NAMES for p in PROFILES}
    assert overall == {
        ("clean_tabular", "GENERIC_BASIC"): "PASS",
        ("clean_tabular", "TABULAR_ML_BASIC"): "PASS",
        ("missing_metadata", "GENERIC_BASIC"): "FAIL",
        ("missing_metadata", "TABULAR_ML_BASIC"): "FAIL",
        ("invalid_units", "GENERIC_BASIC"): "WARNING",
        ("invalid_units", "TABULAR_ML_BASIC"): "FAIL",
        ("missing_provenance", "GENERIC_BASIC"): "FAIL",
        ("missing_provenance", "TABULAR_ML_BASIC"): "FAIL",
    }
    assert _expected("invalid_units", "TABULAR_ML_BASIC")["checks"]["semantics.units_codebook"] == "FAIL"
    assert _expected("missing_provenance", "GENERIC_BASIC")["checks"]["provenance.presence"] == "FAIL"
    assert _expected("missing_metadata", "GENERIC_BASIC")["checks"]["metadata.completeness"] == "FAIL"
    assert "schema.datatype_validity" not in _expected("clean_tabular", "GENERIC_BASIC")["checks"]


_CHILD = """
import dramatiq
from dramatiq.brokers.stub import StubBroker
dramatiq.set_broker(StubBroker())
from api.modules.readiness.fakes import FIXTURES_ROOT
from api.modules.readiness.selfcheck import run_fixture
print(run_fixture(FIXTURES_ROOT, "clean_tabular", "TABULAR_ML_BASIC").result_sha256)
"""


def test_determinism_across_worker_processes() -> None:
    """M05-AT-02: three separate processes (different hash seeds) -> identical result_sha256 = golden."""
    shas = set()
    for seed in ("1", "2", "random"):
        env = {
            **os.environ,
            "PYTHONPATH": os.pathsep.join(
                [str(REPO_ROOT / "apps"), str(REPO_ROOT / "packages/contracts/python")]
            ),
            "PYTHONHASHSEED": seed,
        }
        out = subprocess.run(
            [sys.executable, "-c", _CHILD], env=env, cwd=REPO_ROOT, capture_output=True, text=True, check=True
        )
        shas.add(out.stdout.strip())
    assert shas == {_expected("clean_tabular", "TABULAR_ML_BASIC")["result_sha256"]}


def test_no_tabular_files_makes_t_dependent_checks_not_applicable() -> None:
    """M05-AT-13 at engine level: README.md + .h5 only."""
    catalog = FixtureCatalog()
    readme = (
        "# Scan\n\n## Provenance\n\n"
        + "빔라인 BL-7에서 2026년 3월 측정한 원시 HDF5 스캔 파일이며 후처리하지 않았다. " * 2
    )
    view = catalog.add_version(
        {"README.md": readme.encode(), "raw/scan.h5": b"\x89HDF\r\n\x1a\n" + bytes(64)},
        clean_snapshot(),
        owner_organization_id=ORG_B,
    )
    result = evaluate(view, PROFILES["TABULAR_ML_BASIC"], catalog)
    statuses = {c.check_id: c.status for c in result.checks}
    for check_id in (
        "schema.presence",
        "schema.datatype_validity",
        "data.missing_values",
        "semantics.units_codebook",
        "semantics.mapping_status",
    ):
        assert statuses[check_id] == "NOT_APPLICABLE", check_id
    assert result.overall_status == "PASS"
    assert result.summary == {"pass": 4, "warning": 0, "fail": 0, "not_applicable": 5}


def test_evidence_and_messages_never_contain_cell_values() -> None:
    """D-018 at engine level: no fixture cell value appears anywhere in any result."""
    lines = (
        (FIXTURES_ROOT / "clean_tabular/files/data/measurements.csv").read_text(encoding="utf-8").splitlines()
    )
    rows = [line.split(",") for line in lines[1:]]
    cells = {cell for row in rows for cell in (row[0], row[3], row[4]) if cell}  # S0001, 101.325, timestamps
    for name in FIXTURE_NAMES:
        for profile_id in PROFILES:
            result = run_fixture(FIXTURES_ROOT, name, profile_id)
            text = json.dumps([c.to_api() for c in result.checks], ensure_ascii=False)
            leaked = sorted(cell for cell in cells if cell in text)
            assert not leaked, f"{name}/{profile_id} leaks {leaked[:3]}"


# ---------------------------------------------------------------- M05-AT-14 lint rules

NETWORK_OR_LLM = {"anthropic", "openai", "httpx", "requests", "urllib", "aiohttp", "socket"}
IMPURE_MODULES = {"random", "secrets", "time", "os", "datetime", "uuid"}
IMPURE_CALLS = {
    "now",
    "utcnow",
    "today",
    "time",
    "time_ns",
    "monotonic",
    "perf_counter",
    "getenv",
    "uuid4",
    "random",
}


def _imports(tree: ast.AST) -> set[str]:
    names: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            names |= {alias.name.split(".")[0] for alias in node.names}
        elif isinstance(node, ast.ImportFrom) and node.module:
            names.add(node.module.split(".")[0])
    return names


def test_module_imports_no_llm_or_http_client() -> None:
    for path in MODULE_DIR.rglob("*.py"):
        if "tests" in path.relative_to(MODULE_DIR).parts:
            continue
        bad = _imports(ast.parse(path.read_text(encoding="utf-8"))) & NETWORK_OR_LLM
        assert not bad, f"{path.relative_to(MODULE_DIR)} imports {bad}"


def test_validators_do_not_read_clock_randomness_or_env() -> None:
    targets = [
        *(MODULE_DIR / "validators").glob("*.py"),
        MODULE_DIR / "engine" / "units.py",
        MODULE_DIR / "engine" / "canonical.py",
        MODULE_DIR / "engine" / "evaluate.py",
    ]
    for path in targets:
        tree = ast.parse(path.read_text(encoding="utf-8"))
        assert not _imports(tree) & IMPURE_MODULES, f"{path.name} imports {_imports(tree) & IMPURE_MODULES}"
        calls = {
            n.func.attr
            for n in ast.walk(tree)
            if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute)
        }
        assert not calls & IMPURE_CALLS, f"{path.name} calls {calls & IMPURE_CALLS}"
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
uv run pytest apps/api/modules/readiness/tests/test_golden.py -q
```
Expected: collection error, `ModuleNotFoundError: No module named 'api.modules.readiness.engine.evaluate'`.

- [ ] **Step 3: Implement**

`apps/api/modules/readiness/validators/__init__.py` (replace the whole file):

```python
"""One file per check (M05 §2). Each exposes check(ctx) -> CheckOutcome and must stay deterministic:
no clock, no randomness, no network, no environment reads (M05-AT-14 enforces this)."""

from collections.abc import Callable

from api.modules.readiness.engine.context import CheckOutcome, EvaluationContext
from api.modules.readiness.validators import (
    datatype_validity,
    file_checksum,
    license_usage,
    mapping_status,
    metadata_completeness,
    missing_values,
    provenance_presence,
    schema_presence,
    units_codebook,
)

Validator = Callable[[EvaluationContext], CheckOutcome]

VALIDATORS: dict[str, Validator] = {
    "metadata.completeness": metadata_completeness.check,
    "schema.presence": schema_presence.check,
    "schema.datatype_validity": datatype_validity.check,
    "data.missing_values": missing_values.check,
    "semantics.units_codebook": units_codebook.check,
    "provenance.presence": provenance_presence.check,
    "policy.license_usage": license_usage.check,
    "integrity.file_checksum": file_checksum.check,
    "semantics.mapping_status": mapping_status.check,
}
```

`apps/api/modules/readiness/engine/evaluate.py` (create):

```python
"""Run a profile's checks in ordinal order over one version and aggregate (09 §2.4, §4)."""

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any, Literal

from api.modules.readiness.catalog_port import CatalogReadPort, VersionView
from api.modules.readiness.engine import VALIDATOR_VERSION
from api.modules.readiness.engine.canonical import bound_evidence, canonical_json, sha256_hex
from api.modules.readiness.engine.context import CheckStatus, EvaluationContext
from api.modules.readiness.profile_registry import Profile, Severity
from api.modules.readiness.validators import VALIDATORS

Overall = Literal["PASS", "WARNING", "FAIL"]


@dataclass(frozen=True)
class CheckResult:
    check_id: str
    ordinal: int
    severity: Severity
    status: CheckStatus
    message: str
    evidence: dict[str, Any]

    def to_api(self) -> dict[str, Any]:
        return {
            "check_id": self.check_id,
            "severity": self.severity,
            "status": self.status,
            "message": self.message,
            "evidence": self.evidence,
        }


@dataclass(frozen=True)
class ValidationResult:
    profile_id: str
    profile_version: str
    validator_version: str
    overall_status: Overall
    summary: dict[str, int]
    checks: tuple[CheckResult, ...]
    result_sha256: str


def overall_status(checks: Sequence[CheckResult]) -> Overall:
    if any(c.status == "FAIL" and c.severity == "REQUIRED" for c in checks):
        return "FAIL"
    if any(c.status in ("FAIL", "WARNING") for c in checks):
        return "WARNING"
    return "PASS"


def summarize(checks: Sequence[CheckResult]) -> dict[str, int]:
    return {
        "pass": sum(c.status == "PASS" for c in checks),
        "warning": sum(c.status == "WARNING" for c in checks),
        "fail": sum(c.status == "FAIL" for c in checks),
        "not_applicable": sum(c.status == "NOT_APPLICABLE" for c in checks),
    }


def result_sha256(checks: Sequence[CheckResult], overall: str, summary: dict[str, int]) -> str:
    document = {"checks": [c.to_api() for c in checks], "overall_status": overall, "summary": summary}
    return sha256_hex(canonical_json(document))


def evaluate(
    version: VersionView, profile: Profile, reader: CatalogReadPort, *, file_timeout_s: float | None = None
) -> ValidationResult:
    """Pure function of (snapshot, manifest, bytes, profile, VALIDATOR_VERSION). Lets the reader's
    StorageUnavailable / ObjectMissing and parsing.FileTimeout propagate: the job maps them to run outcomes."""
    if version.metadata_snapshot is None:
        raise ValueError("only PUBLISHED versions (with a metadata snapshot) can be evaluated")
    ctx = EvaluationContext(
        snapshot=version.metadata_snapshot,
        files=version.files,
        manifest_sha256=version.manifest_sha256,
        reader=reader,
        params=profile.params,
        file_timeout_s=file_timeout_s,
    )
    checks: list[CheckResult] = []
    for spec in profile.checks:  # sequential, ordinal order (M05 §10)
        outcome = VALIDATORS[spec.check_id](ctx)
        checks.append(
            CheckResult(
                check_id=spec.check_id,
                ordinal=spec.ordinal,
                severity=spec.severity,
                status=outcome.status,
                message=outcome.message,
                evidence=bound_evidence(outcome.evidence),
            )
        )
    overall = overall_status(checks)
    summary = summarize(checks)
    return ValidationResult(
        profile_id=profile.profile_id,
        profile_version=profile.version,
        validator_version=VALIDATOR_VERSION,
        overall_status=overall,
        summary=summary,
        checks=tuple(checks),
        result_sha256=result_sha256(checks, overall, summary),
    )
```

`apps/api/modules/readiness/selfcheck.py` (create):

```python
"""Golden self-check: evaluate the 4 fixtures with both profiles and compare with expected/*.json.

    python -m api.modules.readiness.selfcheck [FIXTURES_DIR] [--record]

--record writes result_sha256 into expected/*.json when the statuses match (first approved run, or after a
reviewed change that also bumped VALIDATOR_VERSION or a profile version, 09 §5.6). Exit 1 on any mismatch.
"""

import argparse
import json
import sys
import uuid
from collections.abc import Sequence
from pathlib import Path

from api.modules.readiness.engine.evaluate import ValidationResult, evaluate
from api.modules.readiness.fakes import FIXTURES_ROOT, FixtureCatalog
from api.modules.readiness.profile_registry import PROFILES

FIXTURES = ("clean_tabular", "missing_metadata", "invalid_units", "missing_provenance")


def run_fixture(root: Path, name: str, profile_id: str) -> ValidationResult:
    base = root / name
    snapshot = json.loads((base / "dataset.json").read_text(encoding="utf-8"))
    files: dict[str, Path | bytes] = {
        p.relative_to(base / "files").as_posix(): p
        for p in sorted((base / "files").rglob("*"))
        if p.is_file()
    }
    catalog = FixtureCatalog()
    view = catalog.add_version(files, snapshot, owner_organization_id=uuid.UUID(int=0xB))
    return evaluate(view, PROFILES[profile_id], catalog)


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m api.modules.readiness.selfcheck")
    parser.add_argument("root", nargs="?", type=Path, default=FIXTURES_ROOT)
    parser.add_argument("--record", action="store_true", help="write result_sha256 into expected/*.json")
    args = parser.parse_args(argv)
    failures = 0
    for name in FIXTURES:
        for profile_id in PROFILES:
            target = args.root / name / "expected" / f"{profile_id}.json"
            expected = json.loads(target.read_text(encoding="utf-8"))
            result = run_fixture(args.root, name, profile_id)
            statuses = {c.check_id: c.status for c in result.checks}
            ok = statuses == expected["checks"] and result.overall_status == expected["overall_status"]
            if args.record and ok:
                expected["result_sha256"] = result.result_sha256
                target.write_text(json.dumps(expected, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            ok = ok and expected["result_sha256"] == result.result_sha256
            failures += not ok
            status = "OK  " if ok else "FAIL"
            print(f"{status} {name:<20} {profile_id:<17} {result.overall_status:<8} {result.result_sha256}")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 4: Record the golden result_sha256 (first approved run, 09 §5.6)**

```bash
PYTHONPATH=apps:packages/contracts/python uv run python -m api.modules.readiness.selfcheck --record
PYTHONPATH=apps:packages/contracts/python uv run python -m api.modules.readiness.selfcheck
```
Expected output of both commands (the second must exit 0). If the code was copied verbatim the hashes are exactly these; if a reviewer-approved deviation changed a message or evidence key, the hashes differ but every status/overall column must still match:

```text
OK   clean_tabular        GENERIC_BASIC     PASS     c9b1d738c8f1b586497db3ea0b2ec698ecfb53a86cf1ec5ad17c0ffc3bf1458a
OK   clean_tabular        TABULAR_ML_BASIC  PASS     febe2779ecd6aeff5275fe1ea0bb24c9e55d5bd0320a987ebdf0d4944a7a204b
OK   missing_metadata     GENERIC_BASIC     FAIL     41c0e179a027ede8ecd832777ff421d5bda9ed95b854476a90d43c28a4d47f60
OK   missing_metadata     TABULAR_ML_BASIC  FAIL     22715bc745e7fba50795b77e15c9646755b9232991f9d5dda256758df2ab85b5
OK   invalid_units        GENERIC_BASIC     WARNING  842b191821afeb578a3e707c099f6fa8d9a2fa6e382ccf70268d0815676c0cc5
OK   invalid_units        TABULAR_ML_BASIC  FAIL     1147d0665a6425c824b55f6cfdcfe7694b3f98e8941d28a7c6599f3717cd8ce4
OK   missing_provenance   GENERIC_BASIC     FAIL     cb6382cc9f7a755605b306bd4166733a8328626a6937f5c82692bf15c21b8379
OK   missing_provenance   TABULAR_ML_BASIC  FAIL     2a8d62e64dd98dd44d5b640f6446a069087890090849aba7de85a931b441aaf0
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
uv run pytest apps/api/modules/readiness/tests/test_golden.py -q
uv run ruff check apps/api/modules/readiness tests/fixtures && uv run ruff format --check apps/api/modules/readiness tests/fixtures
```
Expected: `20 passed`; ruff clean.

- [ ] **Step 6: Commit**

```bash
git add apps/api/modules/readiness/engine/evaluate.py apps/api/modules/readiness/selfcheck.py apps/api/modules/readiness/tests/test_golden.py apps/api/modules/readiness/validators/__init__.py tests/fixtures/readiness
git commit -m "feat(readiness): evaluate(), golden results and determinism checks" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```


---

### Task 11: readiness schema migration (tables, partial unique indexes, trigger) and Core tables

M05 §4. `processed_events` is created with `create_processed_events("readiness", per_handler=True)`. `requester_organization_id` is an addition to §4.1 (event actor for manual runs, see Resolved ambiguities). The evidence size check is a 128 KiB backstop because `jsonb::text` adds spaces; the 64 KiB rule is enforced on canonical JSON by `bound_evidence`.

**Files:**
- Create: `apps/api/modules/readiness/migrations/0001_readiness_initial.py`
- Create: `apps/api/modules/readiness/tables.py`
- Modify: `apps/api/modules/readiness/__init__.py`
- Create: `apps/api/modules/readiness/tests/conftest.py`
- Test: `apps/api/modules/readiness/tests/test_migration.py`

**Interfaces:**
- Consumes: `api.platform.migration_helpers.create_processed_events`, `migrated_db` fixture.
- Produces: `tables.validations`, `tables.check_results` (SQLAlchemy Core, schema `readiness`); revision `readiness_0001`; `MODULE.migrations_dir`; conftest fixtures `readiness_db` (session) and `db` (per test, truncates readiness tables + `platform.outbox_events`).

- [ ] **Step 1: Write the failing test**

`apps/api/modules/readiness/tests/conftest.py` (create):

```python
"""Readiness test fixtures: the module's schema migrated on the platform's throwaway Postgres."""

from collections.abc import Iterator

import pytest
from sqlalchemy import create_engine, text

from api.modules.readiness import MODULE
from api.platform.migrate import upgrade_all
from api.platform.testing.fixtures import PgUrls


@pytest.fixture(scope="session")
def readiness_db(migrated_db: PgUrls) -> PgUrls:
    upgrade_all(migrated_db.migrator, [MODULE])
    return migrated_db


@pytest.fixture
def db(readiness_db: PgUrls) -> Iterator[PgUrls]:
    """Empty readiness tables + outbox per test."""
    engine = create_engine(readiness_db.migrator)
    with engine.begin() as conn:
        conn.execute(
            text(
                "TRUNCATE readiness.check_results, readiness.validations, readiness.processed_events, "
                "platform.outbox_events"
            )
        )
    engine.dispose()
    yield readiness_db
```

`apps/api/modules/readiness/tests/test_migration.py` (create):

```python
import uuid
from typing import Any

import pytest
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError, IntegrityError

from api.modules.readiness.tables import check_results, validations
from api.platform.db import session_factory
from api.platform.testing.fixtures import PgUrls


def _row(**overrides: Any) -> dict[str, Any]:
    row = {
        "validation_id": uuid.uuid4(),
        "dataset_version_id": uuid.uuid4(),
        "dataset_id": uuid.uuid4(),
        "owner_organization_id": uuid.uuid4(),
        "profile_id": "GENERIC_BASIC",
        "profile_version": "1.0.0",
        "validator_version": "1.0.0",
        "input_fingerprint": "a" * 64,
        "run_status": "QUEUED",
        "triggered_by": "USER",
        "attempt": 0,
        "correlation_id": uuid.uuid4(),
    }
    return {**row, **overrides}


def _insert(db: PgUrls, *rows: dict[str, Any]) -> None:
    with session_factory(db.app)() as session, session.begin():
        for row in rows:
            session.execute(validations.insert().values(**row))


DONE = {
    "run_status": "COMPLETED",
    "overall_status": "PASS",
    "result_sha256": "b" * 64,
    "completed_at": text("now()"),
}


def test_version_table_lives_in_readiness_schema(db: PgUrls) -> None:
    with session_factory(db.migrator)() as session:
        version = session.execute(text("SELECT version_num FROM readiness.alembic_version")).scalar_one()
    assert version == "readiness_0001"


def test_one_inflight_run_per_version_and_profile(db: PgUrls) -> None:
    first = _row()
    _insert(db, first)
    with pytest.raises(IntegrityError):
        _insert(db, _row(dataset_version_id=first["dataset_version_id"], run_status="RUNNING"))
    _insert(db, _row(dataset_version_id=first["dataset_version_id"], profile_id="TABULAR_ML_BASIC"))


def test_one_completed_result_per_fingerprint(db: PgUrls) -> None:
    first = _row(**DONE)
    _insert(db, first)
    with pytest.raises(IntegrityError):
        _insert(db, _row(dataset_version_id=first["dataset_version_id"], **DONE))


@pytest.mark.parametrize(
    "overrides",
    [
        {"run_status": "COMPLETED"},  # no overall/result/completed_at
        {"run_status": "FAILED"},  # no error
        {"overall_status": "PASS"},  # overall only when COMPLETED
        {"profile_id": "FOO"},
        {"triggered_by": "CRON"},
    ],
)
def test_check_constraints(db: PgUrls, overrides: dict[str, Any]) -> None:
    with pytest.raises(IntegrityError):
        _insert(db, _row(**overrides))


def test_check_results_are_immutable_once_completed(db: PgUrls) -> None:
    row = _row(run_status="RUNNING")
    _insert(db, row)
    result = {
        "validation_id": row["validation_id"],
        "check_id": "metadata.completeness",
        "ordinal": 1,
        "severity": "REQUIRED",
        "status": "PASS",
        "message": "ok",
        "evidence": {},
    }
    with session_factory(db.app)() as session, session.begin():
        session.execute(check_results.insert().values(**result))
        session.execute(
            validations.update().where(validations.c.validation_id == row["validation_id"]).values(**DONE)
        )
    with pytest.raises(DBAPIError, match="immutable"), session_factory(db.app)() as session, session.begin():
        session.execute(check_results.update().values(status="FAIL"))
    with pytest.raises(DBAPIError, match="immutable"), session_factory(db.app)() as session, session.begin():
        session.execute(
            check_results.insert().values(**{**result, "check_id": "schema.presence", "ordinal": 2})
        )


def test_evidence_size_is_capped(db: PgUrls) -> None:
    row = _row(run_status="RUNNING")
    _insert(db, row)
    with pytest.raises(IntegrityError), session_factory(db.app)() as session, session.begin():
        session.execute(
            check_results.insert().values(
                validation_id=row["validation_id"],
                check_id="x",
                ordinal=1,
                severity="REQUIRED",
                status="PASS",
                message="m",
                evidence={"blob": "x" * 140_000},
            )
        )
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
uv run pytest apps/api/modules/readiness/tests/test_migration.py -q
```
Expected: collection error, `ModuleNotFoundError: No module named 'api.modules.readiness.tables'`.

- [ ] **Step 3: Implement**

`apps/api/modules/readiness/migrations/0001_readiness_initial.py` (create):

```python
"""readiness: validations, check_results, processed_events (M05 §4)

Revision ID: readiness_0001
Revises:
"""

import sqlalchemy as sa
from alembic import op
from api.platform.migration_helpers import create_processed_events
from sqlalchemy.dialects.postgresql import JSONB, UUID

revision = "readiness_0001"
down_revision = None
branch_labels = None
depends_on = None

SCHEMA = "readiness"
NOW = sa.text("now()")


def upgrade() -> None:
    op.create_table(
        "validations",
        sa.Column("validation_id", UUID(as_uuid=True), primary_key=True),
        sa.Column("dataset_version_id", UUID(as_uuid=True), nullable=False),
        sa.Column("dataset_id", UUID(as_uuid=True), nullable=False),
        sa.Column("owner_organization_id", UUID(as_uuid=True), nullable=False),
        sa.Column("profile_id", sa.Text, nullable=False),
        sa.Column("profile_version", sa.Text, nullable=False),
        sa.Column("validator_version", sa.Text, nullable=False),
        sa.Column("input_fingerprint", sa.CHAR(64), nullable=False),
        sa.Column("run_status", sa.Text, nullable=False, server_default="QUEUED"),
        sa.Column("overall_status", sa.Text, nullable=True),
        sa.Column("summary", JSONB, nullable=True),
        sa.Column("result_sha256", sa.CHAR(64), nullable=True),
        sa.Column("error", sa.Text, nullable=True),
        sa.Column("triggered_by", sa.Text, nullable=False),
        sa.Column("requested_by", UUID(as_uuid=True), nullable=True),
        sa.Column("requester_organization_id", UUID(as_uuid=True), nullable=True),
        sa.Column("attempt", sa.Integer, nullable=False, server_default="0"),
        sa.Column("correlation_id", UUID(as_uuid=True), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=NOW),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint(
            "profile_id IN ('GENERIC_BASIC','TABULAR_ML_BASIC')", name="ck_validation_profile"
        ),
        sa.CheckConstraint(
            "run_status IN ('QUEUED','RUNNING','COMPLETED','FAILED')", name="ck_validation_run_status"
        ),
        sa.CheckConstraint(
            "overall_status IS NULL OR overall_status IN ('PASS','WARNING','FAIL')",
            name="ck_validation_overall",
        ),
        sa.CheckConstraint("triggered_by IN ('AUTO_ON_PUBLISH','USER')", name="ck_validation_triggered_by"),
        sa.CheckConstraint(
            "(run_status = 'COMPLETED') = (overall_status IS NOT NULL)", name="ck_overall_iff_completed"
        ),
        sa.CheckConstraint(
            "run_status <> 'COMPLETED' OR (overall_status IS NOT NULL AND result_sha256 IS NOT NULL "
            "AND completed_at IS NOT NULL)",
            name="ck_completed",
        ),
        sa.CheckConstraint("run_status <> 'FAILED' OR error IS NOT NULL", name="ck_failed"),
        schema=SCHEMA,
    )
    op.create_index(
        "uq_validation_inflight",
        "validations",
        ["dataset_version_id", "profile_id"],
        unique=True,
        schema=SCHEMA,
        postgresql_where=sa.text("run_status IN ('QUEUED','RUNNING')"),
    )
    op.create_index(
        "uq_validation_reuse",
        "validations",
        ["dataset_version_id", "profile_id", "input_fingerprint"],
        unique=True,
        schema=SCHEMA,
        postgresql_where=sa.text("run_status = 'COMPLETED'"),
    )
    op.create_index(
        "ix_validation_latest",
        "validations",
        ["dataset_version_id", "profile_id", sa.text("created_at DESC")],
        schema=SCHEMA,
    )
    op.create_table(
        "check_results",
        sa.Column(
            "validation_id",
            UUID(as_uuid=True),
            sa.ForeignKey(f"{SCHEMA}.validations.validation_id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("check_id", sa.Text, primary_key=True),
        sa.Column("ordinal", sa.SmallInteger, nullable=False),
        sa.Column("severity", sa.Text, nullable=False),
        sa.Column("status", sa.Text, nullable=False),
        sa.Column("message", sa.Text, nullable=False),
        sa.Column("evidence", JSONB, nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.CheckConstraint("severity IN ('REQUIRED','RECOMMENDED')", name="ck_check_severity"),
        sa.CheckConstraint("status IN ('PASS','WARNING','FAIL','NOT_APPLICABLE')", name="ck_check_status"),
        # the app bounds canonical JSON to 64 KiB (engine.canonical.bound_evidence); jsonb::text adds a space after
        # every ':' and ',' so the database backstop allows twice that
        sa.CheckConstraint("octet_length(evidence::text) <= 131072", name="ck_check_evidence_size"),
        schema=SCHEMA,
    )
    op.execute(
        f"""
        CREATE FUNCTION {SCHEMA}.forbid_write_after_completion() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
          IF EXISTS (SELECT 1 FROM {SCHEMA}.validations v
                     WHERE v.validation_id = NEW.validation_id AND v.run_status = 'COMPLETED') THEN
            RAISE EXCEPTION 'check_results of a COMPLETED validation are immutable'
              USING ERRCODE = 'integrity_constraint_violation';
          END IF;
          RETURN NEW;
        END $$
        """
    )
    op.execute(
        f"CREATE TRIGGER trg_check_results_immutable BEFORE INSERT OR UPDATE ON {SCHEMA}.check_results "
        f"FOR EACH ROW EXECUTE FUNCTION {SCHEMA}.forbid_write_after_completion()"
    )
    create_processed_events(SCHEMA, per_handler=True)


def downgrade() -> None:
    op.drop_table("processed_events", schema=SCHEMA)
    op.drop_table("check_results", schema=SCHEMA)
    op.execute(f"DROP FUNCTION {SCHEMA}.forbid_write_after_completion()")
    op.drop_table("validations", schema=SCHEMA)
```

`apps/api/modules/readiness/tables.py` (create):

```python
"""SQLAlchemy Core tables for readiness.* (DDL lives in migrations/0001_readiness_initial.py)."""

from sqlalchemy import CHAR, Column, DateTime, ForeignKey, Integer, MetaData, SmallInteger, Table, Text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.dialects.postgresql import UUID as PG_UUID

metadata = MetaData(schema="readiness")

validations = Table(
    "validations",
    metadata,
    Column("validation_id", PG_UUID(as_uuid=True), primary_key=True),
    Column("dataset_version_id", PG_UUID(as_uuid=True), nullable=False),
    Column("dataset_id", PG_UUID(as_uuid=True), nullable=False),
    Column("owner_organization_id", PG_UUID(as_uuid=True), nullable=False),
    Column("profile_id", Text, nullable=False),
    Column("profile_version", Text, nullable=False),
    Column("validator_version", Text, nullable=False),
    Column("input_fingerprint", CHAR(64), nullable=False),
    Column("run_status", Text, nullable=False),
    Column("overall_status", Text),
    Column("summary", JSONB),
    Column("result_sha256", CHAR(64)),
    Column("error", Text),
    Column("triggered_by", Text, nullable=False),
    Column("requested_by", PG_UUID(as_uuid=True)),
    Column("requester_organization_id", PG_UUID(as_uuid=True)),
    Column("attempt", Integer, nullable=False),
    Column("correlation_id", PG_UUID(as_uuid=True), nullable=False),
    Column("created_at", DateTime(timezone=True), nullable=False),
    Column("started_at", DateTime(timezone=True)),
    Column("completed_at", DateTime(timezone=True)),
)

check_results = Table(
    "check_results",
    metadata,
    Column("validation_id", PG_UUID(as_uuid=True), ForeignKey(validations.c.validation_id), primary_key=True),
    Column("check_id", Text, primary_key=True),
    Column("ordinal", SmallInteger, nullable=False),
    Column("severity", Text, nullable=False),
    Column("status", Text, nullable=False),
    Column("message", Text, nullable=False),
    Column("evidence", JSONB, nullable=False),
)
```

`apps/api/modules/readiness/__init__.py` (replace the whole file):

```python
"""M05 AI-Ready Pipeline (readiness): deterministic validation of PUBLISHED dataset versions."""

from pathlib import Path

from api.platform.modules import ModuleSpec

MODULE = ModuleSpec(
    name="readiness",
    db_schema="readiness",
    migrations_dir=Path(__file__).parent / "migrations",
)
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
uv run pytest apps/api/modules/readiness/tests/test_migration.py -q
uv run ruff check apps/api/modules/readiness tests/fixtures && uv run ruff format --check apps/api/modules/readiness tests/fixtures
```
Expected: `10 passed`; ruff clean.

- [ ] **Step 5: Commit**

```bash
git add apps/api/modules/readiness/__init__.py apps/api/modules/readiness/migrations/0001_readiness_initial.py apps/api/modules/readiness/tables.py apps/api/modules/readiness/tests/conftest.py apps/api/modules/readiness/tests/test_migration.py
git commit -m "feat(readiness): schema migration with in-flight/reuse indexes and immutability trigger" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```


---

### Task 12: Dramatiq actor, run state machine, events, retries, sweeper and register_worker

M05 §5, §7, §10. The actor is defined at import (the platform configures the broker first, D-036). `run_validation` is the testable body: QUEUED->RUNNING (+ started event), evaluate, then COMPLETED (+ check rows, completed event) or FAILED. Infra errors put the row back to QUEUED and raise `RetryableInfraError` so Dramatiq retries (attempts 1..3, i.e. `max_retries=2`). `enqueue_after_commit` sends the message from the session's `after_commit` hook, so a rolled-back request never enqueues. The conftest binds the actor to a StubBroker (pytest imports the package before the conftest runs).

**Files:**
- Create: `apps/api/modules/readiness/jobs.py`
- Modify: `apps/api/modules/readiness/__init__.py`
- Modify: `apps/api/modules/readiness/tests/conftest.py`
- Create: `apps/api/modules/readiness/tests/dbutil.py`
- Test: `apps/api/modules/readiness/tests/test_jobs.py`

**Interfaces:**
- Consumes: `evaluate` (Task 10), `tables` (Task 11), `FileTimeout` (Task 4), `outbox.write`, `EventActor`, `clock`, `ports`, `Scheduler`.
- Produces: `jobs`: `QUEUE = "readiness"`, `MAX_ATTEMPTS = 3`, `RUNTIME.database_url`, `RetryableInfraError`, `start_run(id) -> RowMapping | None`, `fail_run(id, error, *, from_statuses=("RUNNING",)) -> bool`, `run_validation(id) -> str` (`COMPLETED`/`FAILED`/`SKIPPED`), `run_validation_actor` (`readiness.run_validation`), `enqueue_after_commit(session, id, correlation_id)`, `sweep_stale() -> int`, `register_worker(broker, scheduler)`; conftest fixtures `catalog` (FixtureCatalog provided as both catalog ports); `tests/dbutil.py`: `CORRELATION`, `row`, `events` (asserts every envelope with `assert_valid_event`), `queued_messages`, `drain_jobs`.

- [ ] **Step 1: Write the failing test**

`apps/api/modules/readiness/tests/conftest.py` (replace the whole file):

```python
"""Readiness test fixtures.

The actor binds to the global Dramatiq broker when api.modules.readiness is imported (D-036). pytest's
importlib mode imports this package (as apps.api.modules.readiness) BEFORE running this conftest, so the
actor may already be bound to whatever broker was global then: bind it to our StubBroker explicitly.
"""

from collections.abc import Iterator

import pytest
from dramatiq.brokers.stub import StubBroker
from sqlalchemy import create_engine, text

from api.modules.readiness import MODULE, jobs
from api.modules.readiness.catalog_port import CatalogQueryPort, CatalogReadPort
from api.modules.readiness.fakes import FixtureCatalog
from api.platform import ports
from api.platform.broker import configure_broker
from api.platform.migrate import upgrade_all
from api.platform.settings import Settings
from api.platform.testing.fixtures import PgUrls

STUB_BROKER = configure_broker(Settings(), StubBroker())
if jobs.run_validation_actor.broker is not STUB_BROKER:
    jobs.run_validation_actor.broker = STUB_BROKER
    STUB_BROKER.declare_actor(jobs.run_validation_actor)


@pytest.fixture(scope="session")
def readiness_db(migrated_db: PgUrls) -> PgUrls:
    upgrade_all(migrated_db.migrator, [MODULE])
    return migrated_db


@pytest.fixture
def db(readiness_db: PgUrls) -> Iterator[PgUrls]:
    """Empty readiness tables + outbox + broker per test; the job and the public port use this database."""
    engine = create_engine(readiness_db.migrator)
    with engine.begin() as conn:
        conn.execute(
            text(
                "TRUNCATE readiness.check_results, readiness.validations, readiness.processed_events, "
                "platform.outbox_events"
            )
        )
    engine.dispose()
    STUB_BROKER.flush_all()
    previous = jobs.RUNTIME.database_url
    jobs.RUNTIME.database_url = readiness_db.app
    try:
        yield readiness_db
    finally:
        jobs.RUNTIME.database_url = previous


@pytest.fixture
def catalog() -> FixtureCatalog:
    fake = FixtureCatalog()
    ports.provide(CatalogQueryPort, fake)
    ports.provide(CatalogReadPort, fake)
    return fake
```

`apps/api/modules/readiness/tests/dbutil.py` (create):

```python
"""DB / broker helpers for readiness tests that use the `db` fixture."""

import json
import uuid
from typing import Any

from dramatiq import Worker
from dramatiq.brokers.stub import StubBroker
from sqlalchemy import select

from api.modules.readiness import jobs
from api.modules.readiness.tables import validations
from api.platform.db import session_factory
from api.platform.outbox import outbox_events
from api.platform.testing.contracts import assert_valid_event
from api.platform.testing.fixtures import PgUrls

CORRELATION = uuid.UUID("0199a000-0000-7000-8000-00000000c0de")


def row(db: PgUrls, validation_id: uuid.UUID) -> dict[str, Any]:
    with session_factory(db.app)() as session:
        query = select(validations).where(validations.c.validation_id == validation_id)
        return dict(session.execute(query).mappings().one())


def events(db: PgUrls) -> list[dict[str, Any]]:
    """Every outbox envelope in insert order, each checked against p0_events.schema.json."""
    with session_factory(db.app)() as session:
        envelopes = list(
            session.execute(select(outbox_events.c.envelope).order_by(outbox_events.c.id)).scalars()
        )
    for envelope in envelopes:
        assert_valid_event(envelope)
    return envelopes


def queued_messages() -> list[dict[str, Any]]:
    broker = jobs.run_validation_actor.broker
    assert isinstance(broker, StubBroker)
    return [json.loads(m) for m in list(broker.queues[jobs.QUEUE].queue)]


def drain_jobs() -> None:
    """Process every queued readiness message with a real Dramatiq worker on the actor's (stub) broker."""
    broker = jobs.run_validation_actor.broker
    worker = Worker(broker, worker_timeout=50, worker_threads=2)
    worker.start()
    try:
        broker.join(jobs.QUEUE, fail_fast=True)
        worker.join()
    finally:
        worker.stop()
```

`apps/api/modules/readiness/tests/test_jobs.py` (create):

```python
"""Run state machine (M05 §5), events (§7), retries (M05-AT-10), sweeper and worker wiring (§10)."""

import json
import uuid
from datetime import timedelta
from typing import Any

import pytest
from dramatiq.brokers.stub import StubBroker
from sqlalchemy import select, text, update

from api.modules.readiness import jobs
from api.modules.readiness.catalog_port import StorageUnavailable, VersionView
from api.modules.readiness.engine import VALIDATOR_VERSION
from api.modules.readiness.engine.canonical import (
    EVIDENCE_MAX_BYTES,
    bound_evidence,
    canonical_json,
    input_fingerprint,
)
from api.modules.readiness.engine.evaluate import CheckResult, ValidationResult, summarize
from api.modules.readiness.engine.parsing import FileTimeout
from api.modules.readiness.fakes import FIXTURES_ROOT, FixtureCatalog
from api.modules.readiness.tables import check_results, validations
from api.modules.readiness.tests.dbutil import CORRELATION, drain_jobs, events, queued_messages, row
from api.modules.readiness.tests.helpers import ORG_B, USERS
from api.platform import clock
from api.platform.auth import CurrentUser
from api.platform.db import session_factory
from api.platform.scheduler import Scheduler
from api.platform.testing.fixtures import PgUrls


def insert_queued(
    db: PgUrls, view: VersionView, profile_id: str = "TABULAR_ML_BASIC", requester: CurrentUser | None = None
) -> uuid.UUID:
    """A QUEUED row + its Dramatiq message (sent after commit), as the service would create it."""
    assert view.manifest_sha256 is not None and view.metadata_snapshot is not None
    with session_factory(db.app)() as session, session.begin():
        validation_id = session.execute(
            validations.insert()
            .values(
                validation_id=uuid.uuid4(),
                dataset_version_id=view.dataset_version_id,
                dataset_id=view.dataset_id,
                owner_organization_id=view.owner_organization_id,
                profile_id=profile_id,
                profile_version="1.0.0",
                validator_version=VALIDATOR_VERSION,
                input_fingerprint=input_fingerprint(
                    view.manifest_sha256, view.metadata_snapshot, profile_id, "1.0.0", VALIDATOR_VERSION
                ),
                run_status="QUEUED",
                triggered_by="USER" if requester else "AUTO_ON_PUBLISH",
                requested_by=requester.user_id if requester else None,
                requester_organization_id=requester.organization_id if requester else None,
                attempt=0,
                correlation_id=CORRELATION,
            )
            .returning(validations.c.validation_id)
        ).scalar_one()
        jobs.enqueue_after_commit(session, validation_id, CORRELATION)
    return validation_id  # type: ignore[no-any-return]


# ---------------------------------------------------------------- enqueue after commit


def test_message_is_sent_after_commit_with_correlation_id(db: PgUrls, catalog: FixtureCatalog) -> None:
    vid = insert_queued(db, catalog.add_fixture("clean_tabular", owner_organization_id=ORG_B))
    [message] = queued_messages()
    assert message["actor_name"] == "readiness.run_validation"
    assert message["args"] == [str(vid)]
    assert message["options"]["correlation_id"] == str(CORRELATION)


def test_rolled_back_transaction_sends_nothing(db: PgUrls) -> None:
    with session_factory(db.app)() as session:
        session.begin()
        jobs.enqueue_after_commit(session, uuid.uuid4(), CORRELATION)
        session.rollback()
        session.begin()
        session.commit()  # a later commit on the same session must not resurrect the dropped message
    assert queued_messages() == []


# ---------------------------------------------------------------- run


def test_run_completes_with_golden_result_and_events(db: PgUrls, catalog: FixtureCatalog) -> None:
    vid = insert_queued(db, catalog.add_fixture("clean_tabular", owner_organization_id=ORG_B))
    assert jobs.run_validation(vid) == "COMPLETED"
    stored = row(db, vid)
    golden = json.loads((FIXTURES_ROOT / "clean_tabular/expected/TABULAR_ML_BASIC.json").read_text())
    assert (stored["run_status"], stored["overall_status"], stored["attempt"]) == ("COMPLETED", "PASS", 1)
    assert stored["result_sha256"] == golden["result_sha256"]
    assert stored["summary"] == {"pass": 9, "warning": 0, "fail": 0, "not_applicable": 0}
    assert stored["started_at"] is not None and stored["completed_at"] is not None
    with session_factory(db.app)() as session:
        query = select(check_results.c.ordinal).where(check_results.c.validation_id == vid)
        assert sorted(session.execute(query).scalars()) == list(range(1, 10))
    started, completed = events(db)
    assert started["event_type"] == "readiness.validation.started.v1"
    assert started["actor"] == {"type": "SYSTEM", "user_id": None, "organization_id": None}
    assert completed["event_type"] == "readiness.validation.completed.v1"
    assert completed["actor"]["type"] == "SYSTEM"
    assert completed["payload"]["run_status"] == "COMPLETED"
    assert completed["payload"]["owner_organization_id"] == str(ORG_B)
    assert completed["payload"]["input_fingerprint"] == stored["input_fingerprint"]
    assert {started["correlation_id"], completed["correlation_id"]} == {str(CORRELATION)}


def test_duplicate_delivery_is_skipped(db: PgUrls, catalog: FixtureCatalog) -> None:
    vid = insert_queued(
        db, catalog.add_fixture("clean_tabular", owner_organization_id=ORG_B), "GENERIC_BASIC"
    )
    assert jobs.run_validation(vid) == "COMPLETED"
    assert jobs.run_validation(vid) == "SKIPPED"
    assert len(events(db)) == 2


def test_storage_outage_retries_twice_then_fails(db: PgUrls, catalog: FixtureCatalog) -> None:
    """M05-AT-10 (the recovery half is in test_service.py)."""
    vid = insert_queued(db, catalog.add_fixture("clean_tabular", owner_organization_id=ORG_B))
    catalog.fail_reads = StorageUnavailable("connection refused")
    for attempt in (1, 2):
        with pytest.raises(jobs.RetryableInfraError):
            jobs.run_validation(vid)
        assert (row(db, vid)["run_status"], row(db, vid)["attempt"]) == ("QUEUED", attempt)
    assert jobs.run_validation(vid) == "FAILED"
    failed = row(db, vid)
    assert (failed["run_status"], failed["overall_status"], failed["attempt"]) == ("FAILED", None, 3)
    assert failed["error"] == "STORAGE_UNAVAILABLE: StorageUnavailable after 3 attempts"
    completed = [e for e in events(db) if e["event_type"] == "readiness.validation.completed.v1"]
    assert [e["payload"]["run_status"] for e in completed] == ["FAILED"]
    assert completed[0]["payload"]["overall_status"] is None
    assert completed[0]["payload"]["summary"] == {"pass": 0, "warning": 0, "fail": 0, "not_applicable": 0}


def test_retry_policy_only_retries_infra_errors() -> None:
    assert jobs._retry_when(0, jobs.RetryableInfraError())
    assert jobs._retry_when(1, jobs.RetryableInfraError())
    assert not jobs._retry_when(2, jobs.RetryableInfraError())
    assert not jobs._retry_when(0, ValueError())


def test_missing_object_fails_the_run(db: PgUrls, catalog: FixtureCatalog) -> None:
    view = catalog.add_fixture("clean_tabular", owner_organization_id=ORG_B)
    vid = insert_queued(db, view)
    catalog.delete_object(view.dataset_version_id, "data/measurements.csv")
    assert jobs.run_validation(vid) == "FAILED"
    assert row(db, vid)["error"] == "FILE_NOT_FOUND: data/measurements.csv is missing in storage"


def test_unknown_version_fails_the_run(db: PgUrls, catalog: FixtureCatalog) -> None:
    view = FixtureCatalog().add_fixture("clean_tabular", owner_organization_id=ORG_B)  # not in `catalog`
    vid = insert_queued(db, view)
    assert jobs.run_validation(vid) == "FAILED"
    assert row(db, vid)["error"].startswith("VERSION_NOT_FOUND")


def test_file_timeout_and_crash_fail_without_data_values(
    db: PgUrls, catalog: FixtureCatalog, monkeypatch: pytest.MonkeyPatch
) -> None:
    def timeout(*_: Any, **__: Any) -> Any:
        raise FileTimeout()

    def crash(*_: Any, **__: Any) -> Any:
        raise KeyError("S0001")

    monkeypatch.setattr(jobs, "evaluate", timeout)
    vid = insert_queued(db, catalog.add_fixture("clean_tabular", owner_organization_id=ORG_B))
    jobs.run_validation(vid)
    assert row(db, vid)["error"] == "FILE_TIMEOUT: parsing exceeded 600s"
    monkeypatch.setattr(jobs, "evaluate", crash)
    vid = insert_queued(db, catalog.add_fixture("clean_tabular", owner_organization_id=ORG_B))
    jobs.run_validation(vid)
    assert row(db, vid)["error"] == "INTERNAL_ERROR: KeyError"


def test_worker_runs_user_request_with_user_actor(db: PgUrls, catalog: FixtureCatalog) -> None:
    view = catalog.add_fixture("clean_tabular", owner_organization_id=ORG_B)
    vid = insert_queued(db, view, "GENERIC_BASIC", requester=USERS["b_steward"])
    drain_jobs()
    assert row(db, vid)["run_status"] == "COMPLETED"
    completed = events(db)[-1]
    assert completed["actor"] == {
        "type": "USER",
        "user_id": str(USERS["b_steward"].user_id),
        "organization_id": str(USERS["b_steward"].organization_id),
    }
    assert completed["correlation_id"] == str(CORRELATION)


# ---------------------------------------------------------------- sweeper and wiring


def test_sweeper_fails_stale_queued_jobs_only(db: PgUrls, catalog: FixtureCatalog) -> None:
    stale = insert_queued(
        db, catalog.add_fixture("clean_tabular", owner_organization_id=ORG_B), "GENERIC_BASIC"
    )
    fresh = insert_queued(
        db, catalog.add_fixture("invalid_units", owner_organization_id=ORG_B), "GENERIC_BASIC"
    )
    with session_factory(db.app)() as session, session.begin():
        session.execute(
            update(validations)
            .where(validations.c.validation_id == stale)
            .values(created_at=text("now() - interval '61 minutes'"))
        )
    assert jobs.sweep_stale() == 1
    assert row(db, stale)["error"] == "STALE_JOB: no progress within the allowed time"
    assert row(db, fresh)["run_status"] == "QUEUED"
    assert events(db)[-1]["payload"]["run_status"] == "FAILED"


def test_sweeper_fails_runs_stuck_in_running(db: PgUrls, catalog: FixtureCatalog) -> None:
    vid = insert_queued(
        db, catalog.add_fixture("clean_tabular", owner_organization_id=ORG_B), "GENERIC_BASIC"
    )
    with clock.frozen(clock.now() - timedelta(seconds=jobs._SETTINGS.run_timeout_seconds, minutes=11)):
        jobs.start_run(vid)
    assert jobs.sweep_stale() == 1
    assert row(db, vid)["run_status"] == "FAILED"


def test_register_worker_adds_sweeper_and_checks_broker() -> None:
    scheduler = Scheduler()
    jobs.register_worker(jobs.run_validation_actor.broker, scheduler)
    assert scheduler.job_names == ["readiness.sweep_stale"]
    assert jobs.run_validation_actor.queue_name == "readiness"
    with pytest.raises(RuntimeError, match="broker"):
        jobs.register_worker(StubBroker(), Scheduler())


def test_evidence_at_the_64_kib_bound_is_stored(db: PgUrls, catalog: FixtureCatalog) -> None:
    """Review focus: canonical evidence <= 64 KiB must fit the DB check (jsonb text adds spaces)."""
    view = catalog.add_fixture("clean_tabular", owner_organization_id=ORG_B)
    vid = insert_queued(db, view, "GENERIC_BASIC")
    jobs.start_run(vid)
    entries = [{"path": "data/x.csv", "field": f"f{i:05d}", "missing": 1, "ratio": 0.1} for i in range(1030)]
    evidence = bound_evidence({"fields": entries})
    assert "truncated" not in evidence
    assert 64_000 < len(canonical_json(evidence).encode()) <= EVIDENCE_MAX_BYTES  # jsonb::text is ~73 KB
    check = CheckResult("metadata.completeness", 1, "REQUIRED", "PASS", "m", evidence)
    result = ValidationResult(
        "GENERIC_BASIC", "1.0.0", VALIDATOR_VERSION, "PASS", summarize([check]), (check,), "0" * 64
    )
    assert jobs._complete(vid, result) is True
    assert row(db, vid)["run_status"] == "COMPLETED"
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
uv run pytest apps/api/modules/readiness/tests/test_jobs.py -q
```
Expected: collection error, `ModuleNotFoundError: No module named 'api.modules.readiness.jobs'` (raised while loading conftest).

- [ ] **Step 3: Implement**

`apps/api/modules/readiness/jobs.py` (create):

```python
"""Dramatiq actor `readiness.run_validation`, the stale-job sweeper and enqueue-after-commit (M05 §5, §10).

The actor is defined at import time: the platform sets the broker BEFORE importing modules (D-036).
"""

import logging
import threading
from dataclasses import dataclass
from datetime import timedelta
from typing import Any
from uuid import UUID

import dramatiq
from dramatiq.middleware import TimeLimitExceeded
from sqlalchemy import RowMapping, event, or_, select, update
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session

from api.modules.readiness.catalog_port import (
    CatalogQueryPort,
    CatalogReadPort,
    ObjectMissing,
    StorageUnavailable,
)
from api.modules.readiness.engine.evaluate import ValidationResult, evaluate
from api.modules.readiness.engine.parsing import FileTimeout
from api.modules.readiness.profile_registry import PROFILES
from api.modules.readiness.settings import get_readiness_settings
from api.modules.readiness.tables import check_results, validations
from api.platform import clock, ports
from api.platform.db import session_factory
from api.platform.events import EventActor
from api.platform.generated.event_types import EventType
from api.platform.outbox import outbox
from api.platform.scheduler import Scheduler

logger = logging.getLogger("nais.readiness")
MAX_ATTEMPTS = 3  # first run + 2 retries (M05 §5 / §10 max_retries=2)
QUEUE = "readiness"
STALE_QUEUED_AFTER = timedelta(hours=1)
SWEEP_INTERVAL_S = 600.0
_PENDING = "readiness.pending_jobs"
_LISTENING = "readiness.listening"
_SETTINGS = get_readiness_settings()
_CONCURRENCY = threading.BoundedSemaphore(_SETTINGS.worker_concurrency)
EMPTY_SUMMARY = {"pass": 0, "warning": 0, "fail": 0, "not_applicable": 0}


@dataclass
class Runtime:
    """Tests point the job (and ReadinessQueryPort) at their database; production uses Settings (None)."""

    database_url: str | None = None


RUNTIME = Runtime()


class RetryableInfraError(Exception):
    """Raised after putting the run back to QUEUED so Dramatiq retries the message."""


class _Superseded(Exception):
    """The row left RUNNING while we evaluated (e.g. swept as stale): discard our result."""


def _session() -> Session:
    return session_factory(RUNTIME.database_url)()


# ---------------------------------------------------------------- events


def _actor_for(row: RowMapping) -> EventActor:
    if row["requested_by"] is None:
        return EventActor.system()
    return EventActor(
        type="USER", user_id=row["requested_by"], organization_id=row["requester_organization_id"]
    )


def _write_started(session: Session, row: RowMapping) -> None:
    payload = {
        "validation_id": str(row["validation_id"]),
        "dataset_id": str(row["dataset_id"]),
        "dataset_version_id": str(row["dataset_version_id"]),
        "profile_id": row["profile_id"],
        "profile_version": row["profile_version"],
    }
    outbox.write(
        session,
        EventType.READINESS_VALIDATION_STARTED_V1,
        payload,
        EventActor.system(),
        correlation_id=row["correlation_id"],
    )


def _write_completed(session: Session, row: RowMapping) -> None:
    payload: dict[str, Any] = {
        "validation_id": str(row["validation_id"]),
        "dataset_id": str(row["dataset_id"]),
        "dataset_version_id": str(row["dataset_version_id"]),
        "owner_organization_id": str(row["owner_organization_id"]),
        "profile_id": row["profile_id"],
        "profile_version": row["profile_version"],
        "run_status": row["run_status"],
        "overall_status": row["overall_status"],
        "summary": row["summary"] or EMPTY_SUMMARY,
        "validator_version": row["validator_version"],
        "input_fingerprint": row["input_fingerprint"],
    }
    outbox.write(
        session,
        EventType.READINESS_VALIDATION_COMPLETED_V1,
        payload,
        _actor_for(row),
        correlation_id=row["correlation_id"],
    )


# ---------------------------------------------------------------- state transitions


def start_run(validation_id: UUID) -> RowMapping | None:
    """QUEUED -> RUNNING (attempt+1) + started event. None when not QUEUED (duplicate delivery, already done)."""
    with _session() as session, session.begin():
        row = (
            session.execute(
                update(validations)
                .where(validations.c.validation_id == validation_id, validations.c.run_status == "QUEUED")
                .values(run_status="RUNNING", attempt=validations.c.attempt + 1, started_at=clock.now())
                .returning(validations)
            )
            .mappings()
            .first()
        )
        if row is not None:
            _write_started(session, row)
        return row


def _requeue(validation_id: UUID) -> None:
    """RUNNING -> QUEUED for an infrastructure retry (no event)."""
    with _session() as session, session.begin():
        session.execute(
            update(validations)
            .where(validations.c.validation_id == validation_id, validations.c.run_status == "RUNNING")
            .values(run_status="QUEUED")
        )


def fail_run(validation_id: UUID, error: str, *, from_statuses: tuple[str, ...] = ("RUNNING",)) -> bool:
    """-> FAILED with an error code + short description (never data values) and a completed event."""
    with _session() as session, session.begin():
        row = (
            session.execute(
                update(validations)
                .where(
                    validations.c.validation_id == validation_id, validations.c.run_status.in_(from_statuses)
                )
                .values(run_status="FAILED", error=error[:500], completed_at=clock.now())
                .returning(validations)
            )
            .mappings()
            .first()
        )
        if row is None:
            return False
        _write_completed(session, row)
        return True


def _complete(validation_id: UUID, result: ValidationResult) -> bool:
    """RUNNING -> COMPLETED: check rows first (the trigger forbids them after COMPLETED), then the run row."""
    try:
        with _session() as session, session.begin():
            session.execute(
                check_results.insert(),
                [
                    {
                        "validation_id": validation_id,
                        "check_id": c.check_id,
                        "ordinal": c.ordinal,
                        "severity": c.severity,
                        "status": c.status,
                        "message": c.message,
                        "evidence": c.evidence,
                    }
                    for c in result.checks
                ],
            )
            row = (
                session.execute(
                    update(validations)
                    .where(
                        validations.c.validation_id == validation_id, validations.c.run_status == "RUNNING"
                    )
                    .values(
                        run_status="COMPLETED",
                        overall_status=result.overall_status,
                        summary=result.summary,
                        result_sha256=result.result_sha256,
                        completed_at=clock.now(),
                    )
                    .returning(validations)
                )
                .mappings()
                .first()
            )
            if row is None:
                raise _Superseded()
            _write_completed(session, row)
    except _Superseded:
        logger.warning(
            "validation left RUNNING during evaluation", extra={"validation_id": str(validation_id)}
        )
        return False
    return True


def run_validation(validation_id: UUID) -> str:
    """One delivery of the job. Returns the resulting run_status, or "SKIPPED" when there was nothing to do."""
    row = start_run(validation_id)
    if row is None:
        return "SKIPPED"
    try:
        version = ports.get(CatalogQueryPort).get_version(row["dataset_version_id"])
        if version is None or version.metadata_snapshot is None:
            fail_run(validation_id, "VERSION_NOT_FOUND: dataset version is missing or not published")
            return "FAILED"
        result = evaluate(
            version,
            PROFILES[row["profile_id"]],
            ports.get(CatalogReadPort),
            file_timeout_s=_SETTINGS.file_timeout_seconds,
        )
        completed = _complete(validation_id, result)
    except (StorageUnavailable, OperationalError, ports.PortNotProvided) as exc:
        if row["attempt"] < MAX_ATTEMPTS:
            _requeue(validation_id)
            raise RetryableInfraError(type(exc).__name__) from exc
        fail_run(validation_id, f"STORAGE_UNAVAILABLE: {type(exc).__name__} after {MAX_ATTEMPTS} attempts")
        return "FAILED"
    except ObjectMissing as exc:
        path = exc.args[0] if exc.args else "object"
        fail_run(validation_id, f"FILE_NOT_FOUND: {path} is missing in storage")
        return "FAILED"
    except FileTimeout:
        fail_run(validation_id, f"FILE_TIMEOUT: parsing exceeded {_SETTINGS.file_timeout_seconds}s")
        return "FAILED"
    except Exception as exc:
        logger.exception("readiness evaluation crashed", extra={"validation_id": str(validation_id)})
        fail_run(validation_id, f"INTERNAL_ERROR: {type(exc).__name__}")
        return "FAILED"
    return "COMPLETED" if completed else "SKIPPED"


def _retry_when(retries: int, exc: BaseException) -> bool:
    """Dramatiq retries only infrastructure errors; the DB attempt counter decides when to give up."""
    return isinstance(exc, RetryableInfraError) and retries < MAX_ATTEMPTS - 1


@dramatiq.actor(
    actor_name="readiness.run_validation",
    queue_name=QUEUE,
    max_retries=MAX_ATTEMPTS - 1,
    retry_when=_retry_when,
    min_backoff=1_000,
    max_backoff=30_000,
    time_limit=_SETTINGS.run_timeout_seconds * 1000,
)
def run_validation_actor(validation_id: str) -> None:
    vid = UUID(validation_id)
    with _CONCURRENCY:  # READINESS_WORKER_CONCURRENCY runs per worker process
        try:
            run_validation(vid)
        except TimeLimitExceeded:
            fail_run(vid, f"RUN_TIMEOUT: exceeded {_SETTINGS.run_timeout_seconds}s")


# ---------------------------------------------------------------- enqueue after commit


def _send_pending(session: Session) -> None:
    for validation_id, correlation_id in session.info.pop(_PENDING, []):
        try:
            run_validation_actor.send_with_options(
                args=(str(validation_id),), correlation_id=str(correlation_id)
            )
        except Exception:  # the row stays QUEUED; the sweeper fails it after 1h and a steward can re-run
            logger.exception("could not enqueue readiness job", extra={"validation_id": str(validation_id)})


def _drop_pending(session: Session) -> None:
    session.info.pop(_PENDING, None)


def enqueue_after_commit(session: Session, validation_id: UUID, correlation_id: UUID) -> None:
    """Send the Dramatiq message only once the QUEUED row is committed (never for a rolled-back row)."""
    session.info.setdefault(_PENDING, []).append((validation_id, correlation_id))
    if not session.info.get(_LISTENING):
        event.listen(session, "after_commit", _send_pending)
        event.listen(session, "after_rollback", _drop_pending)
        session.info[_LISTENING] = True


# ---------------------------------------------------------------- sweeper


def sweep_stale() -> int:
    """QUEUED > 1h or RUNNING > run timeout + 10 min -> FAILED(STALE_JOB) + completed event."""
    now = clock.now()
    running_cutoff = now - timedelta(seconds=_SETTINGS.run_timeout_seconds, minutes=10)
    with _session() as session:
        ids: list[UUID] = list(
            session.execute(
                select(validations.c.validation_id).where(
                    or_(
                        (validations.c.run_status == "QUEUED")
                        & (validations.c.created_at < now - STALE_QUEUED_AFTER),
                        (validations.c.run_status == "RUNNING") & (validations.c.started_at < running_cutoff),
                    )
                )
            )
            .scalars()
            .all()
        )
    message = "STALE_JOB: no progress within the allowed time"
    return sum(fail_run(vid, message, from_statuses=("QUEUED", "RUNNING")) for vid in ids)


def register_worker(broker: dramatiq.Broker, scheduler: Scheduler) -> None:
    """ModuleSpec.register_worker: the actor was declared on the broker at import; add the sweeper."""
    if run_validation_actor.broker is not broker:
        raise RuntimeError("configure the Dramatiq broker before importing api.modules.readiness (D-036)")
    scheduler.every(SWEEP_INTERVAL_S, "readiness.sweep_stale", _sweep_job)


def _sweep_job() -> None:
    swept = sweep_stale()
    if swept:
        logger.warning("stale readiness runs failed", extra={"count": swept})
```

`apps/api/modules/readiness/__init__.py` (replace the whole file):

```python
"""M05 AI-Ready Pipeline (readiness): deterministic validation of PUBLISHED dataset versions."""

from pathlib import Path

from api.modules.readiness.jobs import register_worker
from api.platform.modules import ModuleSpec

MODULE = ModuleSpec(
    name="readiness",
    db_schema="readiness",
    migrations_dir=Path(__file__).parent / "migrations",
    register_worker=register_worker,
)
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
uv run pytest apps/api/modules/readiness/tests/test_jobs.py -q
uv run ruff check apps/api/modules/readiness tests/fixtures && uv run ruff format --check apps/api/modules/readiness tests/fixtures
```
Expected: `14 passed`; ruff clean.

- [ ] **Step 5: Commit**

```bash
git add apps/api/modules/readiness/__init__.py apps/api/modules/readiness/jobs.py apps/api/modules/readiness/tests/conftest.py apps/api/modules/readiness/tests/dbutil.py apps/api/modules/readiness/tests/test_jobs.py
git commit -m "feat(readiness): validation actor, state machine, retries and stale sweeper" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```


---

### Task 13: Queueing service (reuse / in-progress / queue) and ReadinessQueryPort

M05 §6.2 steps 5-7 are shared by the API and the publish handler: same fingerprint COMPLETED -> reuse; QUEUED/RUNNING -> in progress; else insert QUEUED inside a SAVEPOINT (a lost race on `uq_validation_inflight` becomes IN_PROGRESS) and enqueue after commit. §8 port is provided by `wire()`.

**Files:**
- Create: `apps/api/modules/readiness/service.py`
- Create: `apps/api/modules/readiness/public.py`
- Modify: `apps/api/modules/readiness/__init__.py`
- Test: `apps/api/modules/readiness/tests/test_service.py`

**Interfaces:**
- Consumes: `jobs.enqueue_after_commit` (Task 12), `input_fingerprint` (Task 2), `is_tabular` (Task 5), tables.
- Produces: `service`: `RequestOutcome(kind: REUSED|IN_PROGRESS|QUEUED, row)`, `fingerprint_for(version, profile)`, `auto_profiles(version) -> list[Profile]`, `request_validation(session, version, profile, *, triggered_by, requester, correlation_id) -> RequestOutcome`, `load_checks(session, ids)`, `latest_per_profile(session, version_id, profile_id | None)`, `latest_overall(...)`, `to_api(row, checks) -> dict` (openapi `ReadinessValidation`); `public.ReadinessQueryPort`, `public.ReadinessQueryService`, `public.wire()`.

- [ ] **Step 1: Write the failing test**

`apps/api/modules/readiness/tests/test_service.py` (create):

```python
"""Queueing rules (M05 §6.2 steps 5-7), auto profile choice (§3.2), reads and ReadinessQueryPort (§8)."""

import uuid
from typing import Any

import pytest

from api.modules.readiness import jobs, service
from api.modules.readiness.catalog_port import StorageUnavailable, VersionView
from api.modules.readiness.engine import VALIDATOR_VERSION
from api.modules.readiness.engine.canonical import input_fingerprint
from api.modules.readiness.fakes import FixtureCatalog
from api.modules.readiness.profile_registry import PROFILES
from api.modules.readiness.public import ReadinessQueryPort, wire
from api.modules.readiness.service import RequestOutcome, auto_profiles, fingerprint_for, request_validation
from api.modules.readiness.tests.dbutil import CORRELATION, queued_messages, row
from api.modules.readiness.tests.helpers import ORG_B, USERS, clean_snapshot
from api.platform import ports
from api.platform.auth import CurrentUser
from api.platform.db import session_factory
from api.platform.testing.fixtures import PgUrls


def request(
    db: PgUrls, view: VersionView, profile_id: str = "TABULAR_ML_BASIC", requester: CurrentUser | None = None
) -> RequestOutcome:
    with session_factory(db.app)() as session, session.begin():
        return request_validation(
            session,
            view,
            PROFILES[profile_id],
            triggered_by="USER" if requester else "AUTO_ON_PUBLISH",
            requester=requester,
            correlation_id=CORRELATION,
        )


def test_fingerprint_uses_manifest_snapshot_and_versions(catalog: FixtureCatalog) -> None:
    view = catalog.add_fixture("clean_tabular", owner_organization_id=ORG_B)
    assert view.manifest_sha256 is not None and view.metadata_snapshot is not None
    expected = input_fingerprint(
        view.manifest_sha256, view.metadata_snapshot, "GENERIC_BASIC", "1.0.0", VALIDATOR_VERSION
    )
    assert fingerprint_for(view, PROFILES["GENERIC_BASIC"]) == expected
    draft = catalog.add_version({}, None, owner_organization_id=ORG_B, status="DRAFT")
    with pytest.raises(ValueError):
        fingerprint_for(draft, PROFILES["GENERIC_BASIC"])


def test_auto_profiles_follow_tabular_set(catalog: FixtureCatalog) -> None:
    tabular = catalog.add_fixture("clean_tabular", owner_organization_id=ORG_B)
    assert [p.profile_id for p in auto_profiles(tabular)] == ["GENERIC_BASIC", "TABULAR_ML_BASIC"]
    files = {"README.md": b"# x\n", "raw/scan.h5": b"\x89HDF", "_notes.csv": b"a\n"}
    other = catalog.add_version(files, clean_snapshot(), owner_organization_id=ORG_B)
    assert [p.profile_id for p in auto_profiles(other)] == ["GENERIC_BASIC"]


def test_request_queues_then_reports_in_progress(db: PgUrls, catalog: FixtureCatalog) -> None:
    view = catalog.add_fixture("clean_tabular", owner_organization_id=ORG_B)
    first = request(db, view, requester=USERS["b_steward"])
    assert first.kind == "QUEUED"
    stored = row(db, first.row["validation_id"])
    assert (stored["run_status"], stored["attempt"], stored["triggered_by"]) == ("QUEUED", 0, "USER")
    assert (stored["requested_by"], stored["correlation_id"]) == (USERS["b_steward"].user_id, CORRELATION)
    second = request(db, view)
    assert (second.kind, second.row["validation_id"]) == ("IN_PROGRESS", first.row["validation_id"])
    assert len(queued_messages()) == 1


def test_completed_result_is_reused_without_new_rows(db: PgUrls, catalog: FixtureCatalog) -> None:
    view = catalog.add_fixture("clean_tabular", owner_organization_id=ORG_B)
    first = request(db, view, "GENERIC_BASIC")
    jobs.run_validation(first.row["validation_id"])
    again = request(db, view, "GENERIC_BASIC")
    assert (again.kind, again.row["validation_id"]) == ("REUSED", first.row["validation_id"])
    assert len(queued_messages()) == 1


def test_failed_run_is_never_reused_and_recovers(db: PgUrls, catalog: FixtureCatalog) -> None:
    """M05-AT-10 second half: after the outage a new request runs to COMPLETED."""
    view = catalog.add_fixture("clean_tabular", owner_organization_id=ORG_B)
    first = request(db, view)
    catalog.fail_reads = StorageUnavailable("down")
    for _ in range(2):
        with pytest.raises(jobs.RetryableInfraError):
            jobs.run_validation(first.row["validation_id"])
    assert jobs.run_validation(first.row["validation_id"]) == "FAILED"
    catalog.fail_reads = None
    retry = request(db, view)
    assert retry.kind == "QUEUED"
    assert jobs.run_validation(retry.row["validation_id"]) == "COMPLETED"


def test_concurrent_insert_race_maps_to_in_progress(
    db: PgUrls, catalog: FixtureCatalog, monkeypatch: pytest.MonkeyPatch
) -> None:
    view = catalog.add_fixture("clean_tabular", owner_organization_id=ORG_B)
    winner = request(db, view)
    real_latest = service._latest
    calls: list[int] = []

    def blind_first_two(
        *args: Any, **kwargs: Any
    ) -> Any:  # the loser's pre-checks ran before the winner's commit
        calls.append(1)
        return None if len(calls) <= 2 else real_latest(*args, **kwargs)

    monkeypatch.setattr(service, "_latest", blind_first_two)
    loser = request(db, view)
    assert (loser.kind, loser.row["validation_id"]) == ("IN_PROGRESS", winner.row["validation_id"])


def test_public_port_reports_latest_completed_overall(db: PgUrls, catalog: FixtureCatalog) -> None:
    wire()
    port = ports.get(ReadinessQueryPort)
    view = catalog.add_fixture("invalid_units", owner_organization_id=ORG_B)
    outcome = request(db, view, "GENERIC_BASIC")
    assert port.get_latest_overall(view.dataset_version_id, "GENERIC_BASIC") is None
    jobs.run_validation(outcome.row["validation_id"])
    assert port.get_latest_overall(view.dataset_version_id, "GENERIC_BASIC") == "WARNING"
    assert port.get_latest_overall(uuid.uuid4(), "GENERIC_BASIC") is None


def test_broker_outage_at_enqueue_keeps_the_committed_row(
    db: PgUrls, catalog: FixtureCatalog, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Review focus: Redis down after commit -> the request still succeeds; the row waits for the sweeper."""

    def boom(*_: Any, **__: Any) -> None:
        raise ConnectionError("redis down")

    monkeypatch.setattr(jobs.run_validation_actor, "send_with_options", boom)
    view = catalog.add_fixture("clean_tabular", owner_organization_id=ORG_B)
    outcome = request(db, view)
    assert outcome.kind == "QUEUED"
    assert row(db, outcome.row["validation_id"])["run_status"] == "QUEUED"
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
uv run pytest apps/api/modules/readiness/tests/test_service.py -q
```
Expected: collection error, `ModuleNotFoundError: No module named 'api.modules.readiness.public'`.

- [ ] **Step 3: Implement**

`apps/api/modules/readiness/service.py` (create):

```python
"""Queueing rules shared by the API (manual run) and the publish handler (auto run): M05 §6.2 steps 5-7,
plus the read queries behind getReadiness and ReadinessQueryPort."""

from dataclasses import dataclass
from typing import Any, Literal
from uuid import UUID

from sqlalchemy import RowMapping, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from api.modules.readiness import jobs
from api.modules.readiness.catalog_port import VersionView
from api.modules.readiness.engine import VALIDATOR_VERSION
from api.modules.readiness.engine.canonical import input_fingerprint
from api.modules.readiness.engine.context import is_tabular
from api.modules.readiness.profile_registry import PROFILE_ORDER, PROFILES, Profile
from api.modules.readiness.tables import check_results, validations
from api.platform.auth import CurrentUser
from api.platform.ids import new_id

TriggeredBy = Literal["AUTO_ON_PUBLISH", "USER"]
INFLIGHT = ("QUEUED", "RUNNING")


@dataclass(frozen=True)
class RequestOutcome:
    kind: Literal["REUSED", "IN_PROGRESS", "QUEUED"]
    row: RowMapping


def fingerprint_for(version: VersionView, profile: Profile) -> str:
    if version.manifest_sha256 is None or version.metadata_snapshot is None:
        raise ValueError("fingerprint needs a PUBLISHED version")
    return input_fingerprint(
        version.manifest_sha256,
        version.metadata_snapshot,
        profile.profile_id,
        profile.version,
        VALIDATOR_VERSION,
    )


def auto_profiles(version: VersionView) -> list[Profile]:
    """GENERIC_BASIC always; TABULAR_ML_BASIC when T is not empty (M05 §3.2)."""
    chosen = [PROFILES["GENERIC_BASIC"]]
    if any(is_tabular(f.path) for f in version.files):
        chosen.append(PROFILES["TABULAR_ML_BASIC"])
    return chosen


def _latest(session: Session, version_id: UUID, profile_id: str, *conditions: Any) -> RowMapping | None:
    query = (
        select(validations)
        .where(
            validations.c.dataset_version_id == version_id,
            validations.c.profile_id == profile_id,
            *conditions,
        )
        .order_by(validations.c.created_at.desc(), validations.c.validation_id.desc())
        .limit(1)
    )
    return session.execute(query).mappings().first()


def request_validation(
    session: Session,
    version: VersionView,
    profile: Profile,
    *,
    triggered_by: TriggeredBy,
    requester: CurrentUser | None,
    correlation_id: UUID,
) -> RequestOutcome:
    """REUSED (same fingerprint COMPLETED) > IN_PROGRESS (QUEUED/RUNNING) > insert QUEUED + enqueue after commit."""
    fingerprint = fingerprint_for(version, profile)
    vid, pid = version.dataset_version_id, profile.profile_id
    reused = _latest(
        session,
        vid,
        pid,
        validations.c.run_status == "COMPLETED",
        validations.c.input_fingerprint == fingerprint,
    )
    if reused is not None:
        return RequestOutcome("REUSED", reused)
    running = _latest(session, vid, pid, validations.c.run_status.in_(INFLIGHT))
    if running is not None:
        return RequestOutcome("IN_PROGRESS", running)
    values = {
        "validation_id": new_id(),
        "dataset_version_id": vid,
        "dataset_id": version.dataset_id,
        "owner_organization_id": version.owner_organization_id,
        "profile_id": pid,
        "profile_version": profile.version,
        "validator_version": VALIDATOR_VERSION,
        "input_fingerprint": fingerprint,
        "run_status": "QUEUED",
        "triggered_by": triggered_by,
        "requested_by": requester.user_id if requester else None,
        "requester_organization_id": requester.organization_id if requester else None,
        "attempt": 0,
        "correlation_id": correlation_id,
    }
    try:
        with session.begin_nested():
            row = (
                session.execute(validations.insert().values(**values).returning(validations)).mappings().one()
            )
    except IntegrityError:  # uq_validation_inflight: a concurrent request won the race
        running = _latest(session, vid, pid, validations.c.run_status.in_(INFLIGHT))
        if running is None:
            raise
        return RequestOutcome("IN_PROGRESS", running)
    jobs.enqueue_after_commit(session, row["validation_id"], correlation_id)
    return RequestOutcome("QUEUED", row)


def load_checks(session: Session, validation_ids: list[UUID]) -> dict[UUID, list[dict[str, Any]]]:
    grouped: dict[UUID, list[dict[str, Any]]] = {vid: [] for vid in validation_ids}
    if not validation_ids:
        return grouped
    rows = session.execute(
        select(check_results)
        .where(check_results.c.validation_id.in_(validation_ids))
        .order_by(check_results.c.validation_id, check_results.c.ordinal)
    ).mappings()
    for r in rows:
        grouped[r["validation_id"]].append(
            {
                "check_id": r["check_id"],
                "severity": r["severity"],
                "status": r["status"],
                "message": r["message"],
                "evidence": r["evidence"],
            }
        )
    return grouped


def latest_per_profile(session: Session, version_id: UUID, profile_id: str | None) -> list[RowMapping]:
    """The most recent validation per profile (any run_status, M05 §6.3), in profile registry order."""
    profile_ids = [profile_id] if profile_id is not None else list(PROFILE_ORDER)
    return [row for pid in profile_ids if (row := _latest(session, version_id, pid)) is not None]


def latest_overall(session: Session, version_id: UUID, profile_id: str) -> str | None:
    row = _latest(session, version_id, profile_id, validations.c.run_status == "COMPLETED")
    return None if row is None else str(row["overall_status"])


def to_api(row: RowMapping, checks: list[dict[str, Any]]) -> dict[str, Any]:
    """openapi ReadinessValidation. requester ids and correlation_id stay internal."""

    def ts(value: Any) -> str | None:
        return value.isoformat() if value is not None else None

    body: dict[str, Any] = {
        "validation_id": str(row["validation_id"]),
        "dataset_version_id": str(row["dataset_version_id"]),
        "profile_id": row["profile_id"],
        "profile_version": row["profile_version"],
        "run_status": row["run_status"],
        "overall_status": row["overall_status"],
        "checks": checks,
        "validator_version": row["validator_version"],
        "input_fingerprint": row["input_fingerprint"],
        "error": row["error"],
        "triggered_by": row["triggered_by"],
        "created_at": ts(row["created_at"]),
        "started_at": ts(row["started_at"]),
        "completed_at": ts(row["completed_at"]),
    }
    if row["summary"] is not None:
        body["summary"] = row["summary"]
    return body
```

`apps/api/modules/readiness/public.py` (create):

```python
"""ReadinessQueryPort (M05 §8): latest COMPLETED overall per version/profile, for other modules (P1 M06)."""

from typing import Literal, Protocol, cast
from uuid import UUID

from api.modules.readiness import jobs
from api.modules.readiness.service import latest_overall
from api.platform import ports
from api.platform.db import session_factory

OverallStatus = Literal["PASS", "WARNING", "FAIL"]


class ReadinessQueryPort(Protocol):
    def get_latest_overall(self, dataset_version_id: UUID, profile_id: str) -> OverallStatus | None: ...


class ReadinessQueryService:
    def get_latest_overall(self, dataset_version_id: UUID, profile_id: str) -> OverallStatus | None:
        with session_factory(jobs.RUNTIME.database_url)() as session:
            return cast(OverallStatus | None, latest_overall(session, dataset_version_id, profile_id))


def wire() -> None:
    ports.provide(ReadinessQueryPort, ReadinessQueryService())
```

`apps/api/modules/readiness/__init__.py` (replace the whole file):

```python
"""M05 AI-Ready Pipeline (readiness): deterministic validation of PUBLISHED dataset versions."""

from pathlib import Path

from api.modules.readiness.jobs import register_worker
from api.modules.readiness.public import wire
from api.platform.modules import ModuleSpec

MODULE = ModuleSpec(
    name="readiness",
    db_schema="readiness",
    migrations_dir=Path(__file__).parent / "migrations",
    wire=wire,
    register_worker=register_worker,
)
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
uv run pytest apps/api/modules/readiness/tests/test_service.py -q
uv run ruff check apps/api/modules/readiness tests/fixtures && uv run ruff format --check apps/api/modules/readiness tests/fixtures
```
Expected: `8 passed`; ruff clean.

- [ ] **Step 5: Commit**

```bash
git add apps/api/modules/readiness/__init__.py apps/api/modules/readiness/public.py apps/api/modules/readiness/service.py apps/api/modules/readiness/tests/test_service.py
git commit -m "feat(readiness): queueing rules and ReadinessQueryPort" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```


---

### Task 14: catalog.dataset.version_published.v1 consumer (auto run)

M05 §3.2 / §7: `@subscribe` + `claim_event(..., handler="on_version_published")`; GENERIC_BASIC always, TABULAR_ML_BASIC when T is not empty; `triggered_by=AUTO_ON_PUBLISH`, correlation id inherited from the publish event. End-to-end through the real outbox relay and a Dramatiq worker: M05-AT-01, AT-11, AT-13.

**Files:**
- Create: `apps/api/modules/readiness/handlers.py`
- Modify: `apps/api/modules/readiness/__init__.py`
- Test: `apps/api/modules/readiness/tests/test_handlers.py`

**Interfaces:**
- Consumes: `service.request_validation/auto_profiles` (Task 13), `api.platform.relay.dispatch_batch`.
- Produces: `handlers.on_version_published`, registered in the global `event_bus.registry` at package import.

- [ ] **Step 1: Write the failing test**

`apps/api/modules/readiness/tests/test_handlers.py` (create):

```python
"""catalog.dataset.version_published.v1 end to end: outbox -> relay -> handler -> Dramatiq worker -> DB.

M05-AT-01 (4 fixtures x 2 profiles vs golden), M05-AT-11 (duplicate delivery), M05-AT-13 (T empty)."""

import json

from sqlalchemy import func, select, table, update

from api.modules.readiness.catalog_port import VersionView
from api.modules.readiness.fakes import FIXTURES_ROOT, FixtureCatalog
from api.modules.readiness.handlers import on_version_published
from api.modules.readiness.tables import check_results, validations
from api.modules.readiness.tests.dbutil import drain_jobs, events
from api.modules.readiness.tests.helpers import FIXTURE_NAMES, ORG_B, clean_snapshot
from api.platform.db import session_factory
from api.platform.event_bus import registry
from api.platform.events import EventActor
from api.platform.outbox import outbox, outbox_events
from api.platform.relay import dispatch_batch
from api.platform.testing.fixtures import PgUrls

processed_events = table("processed_events", schema="readiness")


def publish(db: PgUrls, view: VersionView) -> None:
    """What M03 does on publish: the event goes through the platform outbox."""
    payload = {
        "dataset_id": str(view.dataset_id),
        "dataset_version_id": str(view.dataset_version_id),
        "version_label": view.version_label,
        "owner_organization_id": str(view.owner_organization_id),
        "file_count": len(view.files),
        "total_bytes": sum(f.size_bytes for f in view.files),
        "manifest_sha256": view.manifest_sha256,
    }
    with session_factory(db.app)() as session, session.begin():
        outbox.write(session, "catalog.dataset.version_published.v1", payload, EventActor.system())


def relay(db: PgUrls) -> None:
    assert dispatch_batch(session_factory(db.app), registry).dead == 0


def results(db: PgUrls, view: VersionView) -> dict[str, dict[str, object]]:
    with session_factory(db.app)() as session:
        rows = session.execute(
            select(validations).where(validations.c.dataset_version_id == view.dataset_version_id)
        ).mappings()
        out: dict[str, dict[str, object]] = {}
        for r in rows:
            checks = session.execute(
                select(check_results.c.check_id, check_results.c.status).where(
                    check_results.c.validation_id == r["validation_id"]
                )
            ).all()
            out[r["profile_id"]] = {
                "run_status": r["run_status"],
                "overall_status": r["overall_status"],
                "result_sha256": r["result_sha256"],
                "triggered_by": r["triggered_by"],
                "requested_by": r["requested_by"],
                "checks": dict(checks),
            }
    return out


def test_handler_is_registered_for_the_publish_event() -> None:
    names = registry.table()["catalog.dataset.version_published.v1"]
    assert f"{on_version_published.__module__}.on_version_published" in names


def test_publishing_the_four_fixtures_matches_the_golden_results(db: PgUrls, catalog: FixtureCatalog) -> None:
    """M05-AT-01."""
    views = {name: catalog.add_fixture(name, owner_organization_id=ORG_B) for name in FIXTURE_NAMES}
    for view in views.values():
        publish(db, view)
    relay(db)
    drain_jobs()
    for name, view in views.items():
        got = results(db, view)
        assert set(got) == {"GENERIC_BASIC", "TABULAR_ML_BASIC"}, name
        for profile_id, result in got.items():
            expected = json.loads((FIXTURES_ROOT / name / "expected" / f"{profile_id}.json").read_text())
            assert result["run_status"] == "COMPLETED"
            assert (result["triggered_by"], result["requested_by"]) == ("AUTO_ON_PUBLISH", None)
            assert result["overall_status"] == expected["overall_status"], (name, profile_id)
            assert result["checks"] == expected["checks"], (name, profile_id)
            assert result["result_sha256"] == expected["result_sha256"], (name, profile_id)
    published = [e for e in events(db) if e["event_type"] == "catalog.dataset.version_published.v1"]
    completed = [e for e in events(db) if e["event_type"] == "readiness.validation.completed.v1"]
    assert len(completed) == 8
    assert {e["correlation_id"] for e in completed} == {e["correlation_id"] for e in published}
    assert all(e["actor"]["type"] == "SYSTEM" for e in completed)


def test_duplicate_delivery_creates_one_validation_per_profile(db: PgUrls, catalog: FixtureCatalog) -> None:
    """M05-AT-11: the relay redelivers the same event (at-least-once)."""
    view = catalog.add_fixture("clean_tabular", owner_organization_id=ORG_B)
    publish(db, view)
    relay(db)
    with session_factory(db.app)() as session, session.begin():
        session.execute(update(outbox_events).values(dispatched_at=None))
    relay(db)
    drain_jobs()
    with session_factory(db.app)() as session:
        counts = dict(
            session.execute(
                select(validations.c.profile_id, func.count()).group_by(validations.c.profile_id)
            ).all()
        )
    assert counts == {"GENERIC_BASIC": 1, "TABULAR_ML_BASIC": 1}


def test_version_without_tabular_files_runs_generic_only(db: PgUrls, catalog: FixtureCatalog) -> None:
    """M05-AT-13: README.md + .h5 only."""
    readme = (
        "# Scan\n\n## Provenance\n\n"
        + "빔라인 BL-7에서 2026년 3월 측정한 원시 HDF5 스캔 파일이며 후처리하지 않았다. " * 2
    )
    view = catalog.add_version(
        {"README.md": readme.encode(), "raw/scan.h5": b"\x89HDF\r\n\x1a\n" + bytes(64)},
        clean_snapshot(),
        owner_organization_id=ORG_B,
    )
    publish(db, view)
    relay(db)
    drain_jobs()
    got = results(db, view)
    assert set(got) == {"GENERIC_BASIC"}
    checks = got["GENERIC_BASIC"]["checks"]
    assert isinstance(checks, dict)
    assert [
        checks[c] for c in ("schema.presence", "semantics.units_codebook", "semantics.mapping_status")
    ] == ["NOT_APPLICABLE"] * 3


def test_unknown_version_is_ignored(db: PgUrls, catalog: FixtureCatalog) -> None:
    ghost = FixtureCatalog().add_fixture("clean_tabular", owner_organization_id=ORG_B)
    publish(db, ghost)
    relay(db)
    with session_factory(db.app)() as session:
        assert session.execute(select(func.count()).select_from(validations)).scalar_one() == 0


def test_missing_catalog_port_retries_the_event_instead_of_dropping_it(db: PgUrls) -> None:
    """Review focus: worker started without M03 wired -> relay retries, the claim is rolled back."""
    view = FixtureCatalog().add_fixture("clean_tabular", owner_organization_id=ORG_B)
    publish(db, view)  # no `catalog` fixture: CatalogQueryPort is not provided
    result = dispatch_batch(session_factory(db.app), registry)
    assert (result.dispatched, result.retried) == (0, 1)
    with session_factory(db.app)() as session:
        assert session.execute(select(func.count()).select_from(processed_events)).scalar_one() == 0
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
uv run pytest apps/api/modules/readiness/tests/test_handlers.py -q
```
Expected: collection error, `ModuleNotFoundError: No module named 'api.modules.readiness.handlers'`.

- [ ] **Step 3: Implement**

`apps/api/modules/readiness/handlers.py` (create):

```python
"""catalog.dataset.version_published.v1 -> auto-queue GENERIC_BASIC (+ TABULAR_ML_BASIC when T is not empty)."""

import logging
from uuid import UUID

from sqlalchemy.orm import Session

from api.modules.readiness.catalog_port import CatalogQueryPort
from api.modules.readiness.service import auto_profiles, request_validation
from api.platform import ports
from api.platform.event_bus import claim_event, subscribe
from api.platform.events import EventEnvelope
from api.platform.generated.event_types import EventType

logger = logging.getLogger("nais.readiness")
HANDLER = "on_version_published"


@subscribe(EventType.CATALOG_DATASET_VERSION_PUBLISHED_V1)
def on_version_published(session: Session, event: EventEnvelope) -> None:
    if not claim_event(session, "readiness", event, handler=HANDLER):
        return
    version = ports.get(CatalogQueryPort).get_version(UUID(event.payload["dataset_version_id"]))
    if version is None or version.status != "PUBLISHED":
        logger.warning("published version not found; nothing queued", extra={"event_id": str(event.event_id)})
        return
    for profile in auto_profiles(version):
        request_validation(
            session,
            version,
            profile,
            triggered_by="AUTO_ON_PUBLISH",
            requester=None,
            correlation_id=event.correlation_id,
        )
```

`apps/api/modules/readiness/__init__.py` (replace the whole file):

```python
"""M05 AI-Ready Pipeline (readiness): deterministic validation of PUBLISHED dataset versions."""

from pathlib import Path

from api.modules.readiness import handlers  # noqa: F401  - registers @subscribe handlers at import
from api.modules.readiness.jobs import register_worker
from api.modules.readiness.public import wire
from api.platform.modules import ModuleSpec

MODULE = ModuleSpec(
    name="readiness",
    db_schema="readiness",
    migrations_dir=Path(__file__).parent / "migrations",
    wire=wire,
    register_worker=register_worker,
)
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
uv run pytest apps/api/modules/readiness/tests/test_handlers.py -q
uv run ruff check apps/api/modules/readiness tests/fixtures && uv run ruff format --check apps/api/modules/readiness tests/fixtures
```
Expected: `6 passed`; ruff clean.

- [ ] **Step 5: Commit**

```bash
git add apps/api/modules/readiness/__init__.py apps/api/modules/readiness/handlers.py apps/api/modules/readiness/tests/test_handlers.py
git commit -m "feat(readiness): auto-run on catalog.dataset.version_published.v1" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```


---

### Task 15: HTTP API: listReadinessProfiles, startReadinessValidation, getReadiness

M05 §6 and §9, responses checked with `assert_matches_response`. Order of checks for POST: 404 (unknown or invisible) -> 403 -> 409 not published -> 422 profile -> 200 reuse / 409 in progress / 202 queued. GET returns the latest run per profile whatever its status; DRAFT or invisible -> 404. Covers M05-AT-03..09 and AT-12.

**Files:**
- Create: `apps/api/modules/readiness/router.py`
- Modify: `apps/api/modules/readiness/__init__.py`
- Modify: `apps/api/modules/readiness/tests/conftest.py`
- Test: `apps/api/modules/readiness/tests/test_api.py`

**Interfaces:**
- Consumes: `service` (Task 13), `CurrentUserDep`, `SessionDep`, `ApiError`, `correlation_id()`.
- Produces: `router.router` mounted by `MODULE.router`; conftest `client` fixture with `FakeIssuer` tokens.

- [ ] **Step 1: Write the failing test**

`apps/api/modules/readiness/tests/conftest.py` (replace the whole file):

```python
"""Readiness test fixtures.

The actor binds to the global Dramatiq broker when api.modules.readiness is imported (D-036). pytest's
importlib mode imports this package (as apps.api.modules.readiness) BEFORE running this conftest, so the
actor may already be bound to whatever broker was global then: bind it to our StubBroker explicitly.
"""

from collections.abc import Iterator
from typing import Any
from uuid import UUID

import pytest
from dramatiq.brokers.stub import StubBroker
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, text

from api.modules.readiness import MODULE, jobs
from api.modules.readiness.catalog_port import CatalogQueryPort, CatalogReadPort
from api.modules.readiness.fakes import FixtureCatalog
from api.modules.readiness.tests.helpers import USERS
from api.platform import ports
from api.platform.auth import CurrentUser, PrincipalResolver, TokenVerifier, get_token_verifier
from api.platform.broker import configure_broker
from api.platform.migrate import upgrade_all
from api.platform.settings import Settings
from api.platform.testing.app import create_test_app
from api.platform.testing.fixtures import PgUrls
from api.platform.testing.tokens import FakeIssuer

STUB_BROKER = configure_broker(Settings(), StubBroker())
if jobs.run_validation_actor.broker is not STUB_BROKER:
    jobs.run_validation_actor.broker = STUB_BROKER
    STUB_BROKER.declare_actor(jobs.run_validation_actor)


@pytest.fixture(scope="session")
def readiness_db(migrated_db: PgUrls) -> PgUrls:
    upgrade_all(migrated_db.migrator, [MODULE])
    return migrated_db


@pytest.fixture
def db(readiness_db: PgUrls) -> Iterator[PgUrls]:
    """Empty readiness tables + outbox + broker per test; the job and the public port use this database."""
    engine = create_engine(readiness_db.migrator)
    with engine.begin() as conn:
        conn.execute(
            text(
                "TRUNCATE readiness.check_results, readiness.validations, readiness.processed_events, "
                "platform.outbox_events"
            )
        )
    engine.dispose()
    STUB_BROKER.flush_all()
    previous = jobs.RUNTIME.database_url
    jobs.RUNTIME.database_url = readiness_db.app
    try:
        yield readiness_db
    finally:
        jobs.RUNTIME.database_url = previous


@pytest.fixture
def catalog() -> FixtureCatalog:
    fake = FixtureCatalog()
    ports.provide(CatalogQueryPort, fake)
    ports.provide(CatalogReadPort, fake)
    return fake


class FakePrincipals:
    """PrincipalResolver stand-in for M01: token `sub` is a key of helpers.USERS."""

    def resolve(self, claims: dict[str, Any], correlation_id: UUID) -> CurrentUser:
        return USERS[claims["sub"]]


@pytest.fixture
def client(db: PgUrls, catalog: FixtureCatalog) -> TestClient:
    issuer = FakeIssuer()
    app = create_test_app(modules=[MODULE], settings=Settings(database_url=db.app), broker=STUB_BROKER)
    app.dependency_overrides[get_token_verifier] = lambda: TokenVerifier(
        issuer=issuer.issuer, audience=issuer.audience, jwk_client=issuer.jwk_client()
    )
    ports.provide(PrincipalResolver, FakePrincipals())
    test_client = TestClient(app, raise_server_exceptions=False)
    test_client.issuer = issuer  # type: ignore[attr-defined]
    return test_client
```

`apps/api/modules/readiness/tests/test_api.py` (create):

```python
"""HTTP contract and authorization (M05 §6, §9): M05-AT-03..09, M05-AT-12."""

import dataclasses
import uuid
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, select, update

from api.modules.readiness import jobs
from api.modules.readiness.catalog_port import VersionView
from api.modules.readiness.fakes import FIXTURES_ROOT, FixtureCatalog
from api.modules.readiness.tables import validations
from api.modules.readiness.tests.dbutil import events, queued_messages
from api.modules.readiness.tests.helpers import ORG_B, clean_snapshot
from api.platform.db import session_factory
from api.platform.testing.contracts import assert_matches_response
from api.platform.testing.fixtures import PgUrls


def auth(client: TestClient, user: str) -> dict[str, str]:
    """Bearer token from the fixture's FakeIssuer; `sub` is a key of helpers.USERS (see conftest.FakePrincipals)."""
    return {"Authorization": f"Bearer {client.issuer.token(sub=user)}"}  # type: ignore[attr-defined]


def start(client: TestClient, version_id: Any, user: str, profile_id: str = "TABULAR_ML_BASIC") -> Any:
    return client.post(
        f"/api/v1/dataset-versions/{version_id}/readiness-validations",
        json={"profile_id": profile_id},
        headers=auth(client, user),
    )


def readiness(client: TestClient, version_id: Any, user: str, **params: str) -> Any:
    return client.get(
        f"/api/v1/dataset-versions/{version_id}/readiness", params=params, headers=auth(client, user)
    )


def error_code(response: Any) -> str:
    return str(response.json()["error"]["code"])


def run_all(db: PgUrls) -> None:
    with session_factory(db.app)() as session:
        ids = session.execute(select(validations.c.validation_id).where(validations.c.run_status == "QUEUED"))
        for vid in list(ids.scalars()):
            jobs.run_validation(vid)


# ---------------------------------------------------------------- listReadinessProfiles


def test_list_profiles_for_any_authenticated_user(client: TestClient) -> None:
    response = client.get("/api/v1/readiness-profiles", headers=auth(client, "a_researcher"))
    assert response.status_code == 200
    assert_matches_response("listReadinessProfiles", 200, response.json())
    assert [p["profile_id"] for p in response.json()["items"]] == ["GENERIC_BASIC", "TABULAR_ML_BASIC"]


def test_list_profiles_requires_a_token(client: TestClient) -> None:
    response = client.get("/api/v1/readiness-profiles")
    assert (response.status_code, error_code(response)) == (401, "UNAUTHENTICATED")
    assert_matches_response("listReadinessProfiles", 401, response.json())  # declared since contract 1.2.0 (M00)


# ---------------------------------------------------------------- startReadinessValidation


def test_steward_starts_a_validation(client: TestClient, catalog: FixtureCatalog, db: PgUrls) -> None:
    view = catalog.add_fixture("clean_tabular", owner_organization_id=ORG_B)
    response = start(client, view.dataset_version_id, "b_steward")
    assert response.status_code == 202
    body = response.json()
    assert_matches_response("startReadinessValidation", 202, body)
    assert (body["run_status"], body["triggered_by"], body["checks"]) == ("QUEUED", "USER", [])
    assert body["overall_status"] is None
    assert len(queued_messages()) == 1


def test_platform_admin_may_start(client: TestClient, catalog: FixtureCatalog) -> None:
    view = catalog.add_fixture("clean_tabular", owner_organization_id=ORG_B)
    assert start(client, view.dataset_version_id, "admin").status_code == 202


def test_completed_result_is_reused(client: TestClient, catalog: FixtureCatalog, db: PgUrls) -> None:
    """M05-AT-03."""
    view = catalog.add_fixture("clean_tabular", owner_organization_id=ORG_B)
    first = start(client, view.dataset_version_id, "b_steward").json()
    run_all(db)
    outbox_before = len(events(db))
    response = start(client, view.dataset_version_id, "b_steward")
    assert response.status_code == 200
    body = response.json()
    assert_matches_response("startReadinessValidation", 200, body)
    assert body["validation_id"] == first["validation_id"]
    assert (body["run_status"], body["overall_status"], len(body["checks"])) == ("COMPLETED", "PASS", 9)
    with session_factory(db.app)() as session:
        assert session.execute(select(func.count()).select_from(validations)).scalar_one() == 1
    assert len(events(db)) == outbox_before
    assert len(queued_messages()) == 1  # only the first request enqueued a job


def test_running_validation_blocks_a_second_request(
    client: TestClient, catalog: FixtureCatalog, db: PgUrls
) -> None:
    """M05-AT-04."""
    view = catalog.add_fixture("clean_tabular", owner_organization_id=ORG_B)
    first = start(client, view.dataset_version_id, "b_steward").json()
    with session_factory(db.app)() as session, session.begin():
        session.execute(update(validations).values(run_status="RUNNING", attempt=1))
    response = start(client, view.dataset_version_id, "b_steward")
    assert response.status_code == 409
    assert_matches_response("startReadinessValidation", 409, response.json())
    assert error_code(response) == "READINESS_VALIDATION_IN_PROGRESS"
    assert response.json()["error"]["details"] == {"validation_id": first["validation_id"]}


def test_draft_version_is_rejected(client: TestClient, catalog: FixtureCatalog) -> None:
    """M05-AT-05."""
    draft = catalog.add_version({}, None, owner_organization_id=ORG_B, status="DRAFT")
    response = start(client, draft.dataset_version_id, "b_steward")
    assert (response.status_code, error_code(response)) == (409, "DATASET_VERSION_NOT_PUBLISHED")


@pytest.mark.parametrize("user", ["a_researcher", "a_steward", "b_researcher"])
def test_non_owner_steward_is_forbidden(client: TestClient, catalog: FixtureCatalog, user: str) -> None:
    """M05-AT-06 (+ same-org non-steward, other-org steward)."""
    view = catalog.add_fixture("clean_tabular", owner_organization_id=ORG_B)
    response = start(client, view.dataset_version_id, user)
    assert (response.status_code, error_code(response)) == (403, "FORBIDDEN")
    assert_matches_response("startReadinessValidation", 403, response.json())


def test_unknown_profile_is_rejected(client: TestClient, catalog: FixtureCatalog) -> None:
    """M05-AT-07."""
    view = catalog.add_fixture("clean_tabular", owner_organization_id=ORG_B)
    response = start(client, view.dataset_version_id, "b_steward", profile_id="FOO")
    assert (response.status_code, error_code(response)) == (422, "READINESS_PROFILE_UNKNOWN")
    assert_matches_response("startReadinessValidation", 422, response.json())


def test_extra_body_fields_are_rejected(client: TestClient, catalog: FixtureCatalog) -> None:
    view = catalog.add_fixture("clean_tabular", owner_organization_id=ORG_B)
    response = client.post(
        f"/api/v1/dataset-versions/{view.dataset_version_id}/readiness-validations",
        json={"profile_id": "GENERIC_BASIC", "reuse": False},
        headers=auth(client, "b_steward"),
    )
    assert (response.status_code, error_code(response)) == (422, "VALIDATION_FAILED")


def test_unknown_or_invisible_version_is_404(client: TestClient, catalog: FixtureCatalog) -> None:
    internal = catalog.add_fixture("invalid_units", owner_organization_id=ORG_B, access_level="INTERNAL")
    for response in (
        start(client, internal.dataset_version_id, "a_steward"),
        start(client, "0199a000-0000-7000-8000-000000000000", "b_steward"),
    ):
        assert (response.status_code, error_code(response)) == (404, "NOT_FOUND")
        assert_matches_response("startReadinessValidation", 404, response.json())  # declared since 1.2.0 (M00)


def test_tabular_profile_on_non_tabular_version_is_allowed(
    client: TestClient, catalog: FixtureCatalog
) -> None:
    view = catalog.add_version({"README.md": b"# x\n"}, clean_snapshot(), owner_organization_id=ORG_B)
    assert start(client, view.dataset_version_id, "b_steward").status_code == 202


# ---------------------------------------------------------------- getReadiness


def _completed(client: TestClient, catalog: FixtureCatalog, db: PgUrls, **kwargs: Any) -> VersionView:
    view = catalog.add_fixture("clean_tabular", owner_organization_id=ORG_B, **kwargs)
    for profile_id in ("GENERIC_BASIC", "TABULAR_ML_BASIC"):
        assert start(client, view.dataset_version_id, "b_steward", profile_id).status_code == 202
    run_all(db)
    return view


def test_get_readiness_returns_latest_per_profile(
    client: TestClient, catalog: FixtureCatalog, db: PgUrls
) -> None:
    view = _completed(client, catalog, db)
    response = readiness(client, view.dataset_version_id, "a_researcher")
    assert response.status_code == 200
    assert_matches_response("getReadiness", 200, response.json())
    items = response.json()["items"]
    assert [i["profile_id"] for i in items] == ["GENERIC_BASIC", "TABULAR_ML_BASIC"]
    assert [c["check_id"] for c in items[1]["checks"]][:2] == ["metadata.completeness", "provenance.presence"]
    assert items[1]["summary"] == {"pass": 9, "warning": 0, "fail": 0, "not_applicable": 0}
    only = readiness(client, view.dataset_version_id, "a_researcher", profile_id="GENERIC_BASIC").json()[
        "items"
    ]
    assert [i["profile_id"] for i in only] == ["GENERIC_BASIC"]


def test_latest_includes_in_flight_and_failed_runs(
    client: TestClient, catalog: FixtureCatalog, db: PgUrls
) -> None:
    view = catalog.add_fixture("clean_tabular", owner_organization_id=ORG_B)
    start(client, view.dataset_version_id, "b_steward")
    [item] = readiness(client, view.dataset_version_id, "b_steward").json()["items"]
    assert (item["run_status"], item["checks"]) == ("QUEUED", [])
    jobs.fail_run(uuid.UUID(item["validation_id"]), "STALE_JOB: test", from_statuses=("QUEUED",))
    [item] = readiness(client, view.dataset_version_id, "b_steward").json()["items"]
    assert (item["run_status"], item["overall_status"], item["error"]) == ("FAILED", None, "STALE_JOB: test")
    assert_matches_response("getReadiness", 200, {"items": [item]})


def test_no_results_and_unknown_profile(client: TestClient, catalog: FixtureCatalog) -> None:
    view = catalog.add_fixture("clean_tabular", owner_organization_id=ORG_B)
    assert readiness(client, view.dataset_version_id, "b_steward").json() == {"items": []}
    response = readiness(client, view.dataset_version_id, "b_steward", profile_id="GENERIC_BASIC")
    assert (response.status_code, error_code(response)) == (404, "READINESS_NOT_AVAILABLE")
    assert_matches_response("getReadiness", 404, response.json())


def test_draft_version_readiness_is_404(client: TestClient, catalog: FixtureCatalog) -> None:
    draft = catalog.add_version({}, None, owner_organization_id=ORG_B, status="DRAFT")
    response = readiness(client, draft.dataset_version_id, "b_steward")
    assert (response.status_code, error_code(response)) == (404, "NOT_FOUND")


def test_internal_dataset_is_404_for_other_institutions(
    client: TestClient, catalog: FixtureCatalog, db: PgUrls
) -> None:
    """M05-AT-08."""
    view = _completed(client, catalog, db, access_level="INTERNAL")
    response = readiness(client, view.dataset_version_id, "a_researcher")
    assert (response.status_code, error_code(response)) == (404, "NOT_FOUND")
    assert readiness(client, view.dataset_version_id, "b_researcher").status_code == 200


def test_controlled_evidence_never_leaks_cell_values(
    client: TestClient, catalog: FixtureCatalog, db: PgUrls
) -> None:
    """M05-AT-09: grant-less Institute A user reads Institute B CONTROLLED results."""
    view = _completed(client, catalog, db)
    assert view.metadata_snapshot is not None and view.metadata_snapshot["access_level"] == "CONTROLLED"
    response = readiness(client, view.dataset_version_id, "a_researcher")
    assert response.status_code == 200
    text = response.text
    csv_lines = (FIXTURES_ROOT / "clean_tabular/files/data/measurements.csv").read_text().splitlines()[1:]
    cells = {
        cell for line in csv_lines for cell in (line.split(",")[0], line.split(",")[3], line.split(",")[4])
    }
    cells.discard("")
    assert {"S0001", "101.325", "2026-01-01T00:01:00Z"} <= cells
    assert sorted(cell for cell in cells | {"Aluminium"} if cell in text) == []


def test_snapshot_not_live_metadata_is_evaluated(
    client: TestClient, catalog: FixtureCatalog, db: PgUrls
) -> None:
    """M05-AT-12: a later PATCH of the live dataset changes nothing for the published version."""
    view = catalog.add_fixture("missing_provenance", owner_organization_id=ORG_B)
    start(client, view.dataset_version_id, "b_steward", "GENERIC_BASIC")
    run_all(db)
    before = readiness(client, view.dataset_version_id, "b_steward").json()
    catalog.live_metadata[view.dataset_id]["provenance"] = "나중에 추가한 출처 설명입니다. " * 5
    response = start(client, view.dataset_version_id, "b_steward", "GENERIC_BASIC")
    assert response.status_code == 200  # same fingerprint -> reused, not re-run
    after = readiness(client, view.dataset_version_id, "b_steward").json()
    assert after == before
    assert after["items"][0]["overall_status"] == "FAIL"


def test_withdrawn_version_keeps_results_but_rejects_new_runs(
    client: TestClient, catalog: FixtureCatalog, db: PgUrls
) -> None:
    """Review focus: WITHDRAWN is not DRAFT - results stay readable, new runs need PUBLISHED."""
    view = _completed(client, catalog, db)
    catalog.replace_view(dataclasses.replace(view, status="WITHDRAWN"))
    assert len(readiness(client, view.dataset_version_id, "b_steward").json()["items"]) == 2
    response = start(client, view.dataset_version_id, "b_steward", "GENERIC_BASIC")
    assert (response.status_code, error_code(response)) == (409, "DATASET_VERSION_NOT_PUBLISHED")
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
uv run pytest apps/api/modules/readiness/tests/test_api.py -q
```
Expected: FAIL - no import error this time - the tests run and fail because no readiness route is mounted yet (`MODULE` has no `router`): requests answer `404 NOT_FOUND`.

- [ ] **Step 3: Implement**

`apps/api/modules/readiness/router.py` (create):

```python
"""HTTP surface (M05 §6): listReadinessProfiles, startReadinessValidation, getReadiness."""

from typing import Any
from uuid import UUID

from fastapi import APIRouter, Response
from pydantic import BaseModel, ConfigDict

from api.modules.readiness.catalog_port import CatalogQueryPort, VersionView
from api.modules.readiness.profile_registry import PROFILE_ORDER, PROFILES
from api.modules.readiness.service import latest_per_profile, load_checks, request_validation, to_api
from api.platform import ports
from api.platform.auth import CurrentUser, CurrentUserDep
from api.platform.context import correlation_id
from api.platform.db import SessionDep
from api.platform.errors import ApiError
from api.platform.generated.error_codes import ErrorCode

router = APIRouter(tags=["readiness"])


class StartValidationBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    profile_id: str


def _catalog() -> CatalogQueryPort:
    try:
        return ports.get(CatalogQueryPort)
    except ports.PortNotProvided as exc:
        raise ApiError(ErrorCode.DEPENDENCY_UNAVAILABLE, "Catalog module is not installed.") from exc


def _visible_version(user: CurrentUser, version_id: UUID) -> VersionView:
    catalog = _catalog()
    version = catalog.get_version(version_id)
    if version is None or not catalog.is_visible(user, version.dataset_id):
        raise ApiError(ErrorCode.NOT_FOUND)
    return version


@router.get("/readiness-profiles")
def list_readiness_profiles(user: CurrentUserDep) -> dict[str, Any]:
    return {"items": [PROFILES[name].to_api() for name in PROFILE_ORDER]}


@router.post("/dataset-versions/{version_id}/readiness-validations", status_code=202)
def start_readiness_validation(
    version_id: UUID, body: StartValidationBody, user: CurrentUserDep, session: SessionDep, response: Response
) -> dict[str, Any]:
    version = _visible_version(user, version_id)
    if not (user.is_platform_admin or user.has_org_role(version.owner_organization_id, "DATA_STEWARD")):
        raise ApiError(ErrorCode.FORBIDDEN)
    if version.status != "PUBLISHED":
        raise ApiError(ErrorCode.DATASET_VERSION_NOT_PUBLISHED)
    profile = PROFILES.get(body.profile_id)
    if profile is None:
        raise ApiError(ErrorCode.READINESS_PROFILE_UNKNOWN, details={"profile_id": body.profile_id})
    outcome = request_validation(
        session, version, profile, triggered_by="USER", requester=user, correlation_id=correlation_id()
    )
    validation_id = outcome.row["validation_id"]
    if outcome.kind == "IN_PROGRESS":
        raise ApiError(
            ErrorCode.READINESS_VALIDATION_IN_PROGRESS, details={"validation_id": str(validation_id)}
        )
    if outcome.kind == "REUSED":
        response.status_code = 200
        return to_api(outcome.row, load_checks(session, [validation_id])[validation_id])
    return to_api(outcome.row, [])


@router.get("/dataset-versions/{version_id}/readiness")
def get_readiness(
    version_id: UUID, user: CurrentUserDep, session: SessionDep, profile_id: str | None = None
) -> dict[str, Any]:
    version = _visible_version(user, version_id)
    if version.status == "DRAFT":
        raise ApiError(ErrorCode.NOT_FOUND)
    rows = latest_per_profile(session, version_id, profile_id)
    if profile_id is not None and not rows:
        raise ApiError(ErrorCode.READINESS_NOT_AVAILABLE)
    checks = load_checks(session, [r["validation_id"] for r in rows])
    return {"items": [to_api(r, checks[r["validation_id"]]) for r in rows]}
```

`apps/api/modules/readiness/__init__.py` (replace the whole file):

```python
"""M05 AI-Ready Pipeline (readiness): deterministic validation of PUBLISHED dataset versions."""

from pathlib import Path

from api.modules.readiness import handlers  # noqa: F401  - registers @subscribe handlers at import
from api.modules.readiness.jobs import register_worker
from api.modules.readiness.public import wire
from api.modules.readiness.router import router
from api.platform.modules import ModuleSpec

MODULE = ModuleSpec(
    name="readiness",
    db_schema="readiness",
    router=router,
    migrations_dir=Path(__file__).parent / "migrations",
    wire=wire,
    register_worker=register_worker,
)
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
uv run pytest apps/api/modules/readiness/tests/test_api.py -q
uv run ruff check apps/api/modules/readiness tests/fixtures && uv run ruff format --check apps/api/modules/readiness tests/fixtures
```
Expected: `22 passed`; ruff clean.

- [ ] **Step 5: Commit**

```bash
git add apps/api/modules/readiness/__init__.py apps/api/modules/readiness/router.py apps/api/modules/readiness/tests/conftest.py apps/api/modules/readiness/tests/test_api.py
git commit -m "feat(readiness): readiness profiles, start validation and get readiness endpoints" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```


---

### Task 16: Module README, 1 GB performance test (AT-15), running-stack verification

Deliverables §13.1 and §13.7, M05-AT-15, and the stack check. Readiness has no seed rows (10_SEED_DATA §1 step 4: runs are triggered by M03's publish events), so the seed step only proves `seed` still runs with the module installed.

**Files:**
- Create: `apps/api/modules/readiness/README.md`
- Test: `apps/api/modules/readiness/tests/test_perf.py`

**Interfaces:**
- Consumes: everything above.
- Produces: `README.md`, `tests/test_perf.py` (opt-in `READINESS_PERF=1`).

- [ ] **Step 1: Write `README.md`**

`apps/api/modules/readiness/README.md` (create):

```markdown
# readiness (M05 AI-Ready Pipeline)

Deterministic "Evidence over Score" checks for PUBLISHED dataset versions. Spec: `NAIS_PRD/modules/M05_ai_ready.md`;
rules, thresholds and golden fixtures: `NAIS_PRD/09_AI_READY_RULES.md`. No LLM and no network call ever decides a
verdict (M05-AT-14 checks the imports).

## Layout
| Path | What |
|---|---|
| `profiles/*.yaml` | `GENERIC_BASIC@1.0.0`, `TABULAR_ML_BASIC@1.0.0`: checks, severities, parameters (09 §2) |
| `validators/` | one file per check (09 §3), each `check(ctx) -> CheckOutcome` |
| `engine/` | parsing (csv/parquet sample stats), UCUM parser, canonical JSON + fingerprints, `evaluate()` |
| `dictionaries/` | bundled UCUM atoms/prefixes, unit aliases, SPDX ids |
| `schemas/table_schema_subset_v1.json` | the `_schema.json` subset (09 §1.2) |
| `service.py`, `router.py` | queueing rules and the 3 operations of the `readiness` tag |
| `handlers.py`, `jobs.py` | `catalog.dataset.version_published.v1` consumer, Dramatiq actor `readiness.run_validation` (queue `readiness`), `readiness.sweep_stale` (10 min) |
| `catalog_port.py`, `fakes.py` | re-export of M03's `api.modules.catalog.public` (`VersionView`/`FileRef`/ports/errors); `FixtureCatalog` fake for tests and `selfcheck` |
| `tests/fixtures/readiness/` (repo root) | 4 fixtures, `generate.py`, `fixtures.lock`, golden `expected/*.json` |

## Version policy (09 §4)
- `VALIDATOR_VERSION` (`engine/__init__.py`) changes when rule code, a bundled dictionary, or a parser library major
  version changes. A profile's `version` changes when its checks, severities or parameters change.
- `input_fingerprint = sha256(manifest_sha256|metadata_snapshot_sha256|profile_id|profile_version|validator_version)`
  (D-029). Same fingerprint + COMPLETED => the result is reused, never re-run.
- `result_sha256` = sha256 of canonical JSON of `checks + overall_status + summary`. Golden values live in
  `tests/fixtures/readiness/*/expected/*.json`; `test_golden.py` fails when a result changes. After a reviewed rule
  change: bump the version, then `uv run python -m api.modules.readiness.selfcheck --record` and commit.

## Run outcomes
`run_status=FAILED` means "could not validate" (storage down after 3 attempts, `FILE_NOT_FOUND`, `FILE_TIMEOUT`,
`RUN_TIMEOUT`, `STALE_JOB`, `INTERNAL_ERROR`, `VERSION_NOT_FOUND`); it is never reused and a steward may re-run.
A check `FAIL` means the data does not meet the rule; the run is `COMPLETED`.

## Integration notes
- **M03**: readiness looks up `CatalogQueryPort` and `CatalogReadPort` from `api.modules.catalog.public` (D-038; M03's
  wiring provides them in api and worker). `open_stream` raises the public `ObjectMissing` on 404 and
  `StorageUnavailable` on connection errors. Fixture `files/**` bytes come from `api.modules.catalog.seed_files` (W1-D5). `readiness_overall` = latest COMPLETED `TABULAR_ML_BASIC`, else
  `GENERIC_BASIC` (D-028); FAILED runs never count.
- **M09**: `readiness.validation.completed.v1` -> audit `READINESS_VALIDATION_COMPLETED`; actor is `USER` for manual runs
  (requester id + org), `SYSTEM` for auto runs; `correlation_id` is the request trace or the publish event's.
- **M10**: show `checks[]` in profile order with `status`, `severity`, `message`; render `evidence` as key/value
  tables (counts, ratios, paths, field names, declared units, row numbers only - never cell values, D-018).
- Env (07 §5; listed in `.env.example` by the M00 kickoff): `READINESS_RUN_TIMEOUT_SECONDS=1800`, `READINESS_FILE_TIMEOUT_SECONDS=600`,
  `READINESS_WORKER_CONCURRENCY=2`.
```

- [ ] **Step 2: Write `test_perf.py`**

`apps/api/modules/readiness/tests/test_perf.py` (create):

```python
"""M05-AT-15: a 1 GB csv finishes within the run timeout with truncated=true (sample limits).

Opt-in (writes ~1 GB to tmp):  READINESS_PERF=1 uv run pytest apps/api/modules/readiness/tests/test_perf.py
READINESS_PERF_BYTES overrides the size (default 1 GiB).
"""

import os
import time
from pathlib import Path

import pytest

from api.modules.readiness.engine.evaluate import evaluate
from api.modules.readiness.fakes import FixtureCatalog
from api.modules.readiness.profile_registry import PROFILES
from api.modules.readiness.settings import ReadinessSettings
from api.modules.readiness.tests.helpers import ORG_B, clean_snapshot, fixture_files

pytestmark = pytest.mark.skipif(os.environ.get("READINESS_PERF") != "1", reason="set READINESS_PERF=1")


def _write_big_csv(path: Path, size: int) -> None:
    source = fixture_files()["data/measurements.csv"].decode().splitlines()
    header, rows = source[0], source[1:]
    block = ("\n".join(rows) + "\n").encode()
    with path.open("wb") as fh:
        fh.write((header + "\n").encode())
        while fh.tell() < size:
            fh.write(block)


def test_one_gigabyte_csv_is_sampled_and_completes(tmp_path: Path) -> None:
    size = int(os.environ.get("READINESS_PERF_BYTES", str(1 << 30)))
    big = tmp_path / "measurements.csv"
    _write_big_csv(big, size)
    files: dict[str, Path | bytes] = {
        k: v for k, v in fixture_files().items() if k != "data/measurements.csv"
    }
    files["data/measurements.csv"] = big
    catalog = FixtureCatalog()
    view = catalog.add_version(files, clean_snapshot(), owner_organization_id=ORG_B)
    started = time.monotonic()
    result = evaluate(view, PROFILES["TABULAR_ML_BASIC"], catalog, file_timeout_s=600)
    elapsed = time.monotonic() - started
    datatype = next(c for c in result.checks if c.check_id == "schema.datatype_validity")
    [file_evidence] = datatype.evidence["files"]
    assert file_evidence["truncated"] is True
    assert file_evidence["sampled_rows"] == PROFILES["TABULAR_ML_BASIC"].params.sample_max_rows
    assert result.overall_status == "PASS"  # repeated rows are valid data; checksum covers all 1 GB
    assert elapsed < ReadinessSettings().run_timeout_seconds
```

- [ ] **Step 3: Run the opt-in 1 GB test once (M05-AT-15)**

```bash
uv run pytest apps/api/modules/readiness/tests/test_perf.py -q        # 1 skipped by default
READINESS_PERF=1 uv run pytest apps/api/modules/readiness/tests/test_perf.py -q --durations=1
```
Expected: `1 passed` in well under a minute (about 5 s on the dev server), `truncated=true`, `sampled_rows=100000`.

- [ ] **Step 4: Whole suite, lint, contracts**

```bash
uv run pytest -q
uv run ruff check apps/api/modules/readiness tests/fixtures && uv run ruff format --check apps/api/modules/readiness tests/fixtures
scripts/nais contracts-check
```
Expected: all tests pass (the planner's scratch run with only platform + readiness was `343 passed, 1 skipped`; M01-M03 tests are now also present, so the total is higher), ruff clean, contracts unchanged (readiness does not touch `NAIS_PRD/contracts`; contract 1.2.0 comes from M00).

- [ ] **Step 5: Commit**

```bash
git add apps/api/modules/readiness/README.md apps/api/modules/readiness/tests/test_perf.py
git commit -m "docs(readiness): module README and 1 GB performance test" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 6: Verify against the running stack (do not `docker compose down`, do not delete volumes)**

```bash
# rebuild the image with the module + pyarrow, restart only api and worker
docker compose up -d --build api worker
# migrate + seed through the platform CLI
docker compose run --rm --no-deps api python -m api.platform.cli migrate
docker compose run --rm --no-deps api python -m api.platform.cli seed
docker compose exec -T postgres psql -U nais -d nais -c "\dt readiness.*"
docker compose exec -T postgres psql -U nais -d nais -tc "SELECT version_num FROM readiness.alembic_version"
# routes are mounted behind the 21051 gateway
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:21051/api/v1/readiness-profiles
curl -s http://localhost:21051/api/v1/openapi.json | python3 -c "import json,sys; print(sorted(p for p in json.load(sys.stdin)['paths'] if 'readiness' in p))"
# the worker registered the handler, the actor queue and the sweeper
docker compose logs worker --since 10m | grep '"event subscriptions"' | tail -1
# golden self-check inside the production image (fixtures are not in the image: mount them read-only)
docker compose run --rm --no-deps -v "$PWD/tests/fixtures/readiness:/fixtures:ro" api python -m api.modules.readiness.selfcheck /fixtures
```

Expected:
- `migrate` prints `migrated platform` and `migrated readiness` (plus any other module already merged); `seed` exits 0
  (readiness contributes no rows).
- `\dt readiness.*` lists `alembic_version`, `check_results`, `processed_events`, `validations`; version `readiness_0001`.
- `curl .../readiness-profiles` without a token prints `401` (UNAUTHENTICATED envelope). With a Keycloak token it
  answers `200` (M01's `PrincipalResolver` is merged before M05 per the execution order).
- openapi paths: `['/api/v1/dataset-versions/{version_id}/readiness', '/api/v1/dataset-versions/{version_id}/readiness-validations', '/api/v1/readiness-profiles']`.
- The worker's `event subscriptions` log line maps `catalog.dataset.version_published.v1` to
  `api.modules.readiness.handlers.on_version_published`, and the worker stays up (`docker compose ps worker`).
- `selfcheck /fixtures` prints eight `OK` lines (same hashes as Task 10) and exits 0 - the production image
  (with its pyarrow wheel) reproduces the golden results.
- The seed-check item "seed dataset 4개의 readiness 결과가 golden output과 일치" (10_SEED_DATA §7) becomes checkable when M03
  publishes the seed datasets; nothing else to do in this module.

No commit in this step unless a fix was needed (then commit it with the trailer).


---

## Self-Review

**Spec coverage (M05 §12 acceptance tests):**

| ID | Where |
|---|---|
| M05-AT-01 | Task 14 `test_publishing_the_four_fixtures_matches_the_golden_results` (outbox -> relay -> handler -> Dramatiq worker -> DB, 4 fixtures x 2 profiles vs `expected/*.json`); engine level Task 10 `test_golden_output` |
| M05-AT-02 | Task 10 `test_determinism_across_worker_processes` (3 processes, different `PYTHONHASHSEED`, equal to golden) |
| M05-AT-03 | Task 15 `test_completed_result_is_reused` (200, same id, no new row/event/message) |
| M05-AT-04 | Task 15 `test_running_validation_blocks_a_second_request` |
| M05-AT-05 | Task 15 `test_draft_version_is_rejected` |
| M05-AT-06 | Task 15 `test_non_owner_steward_is_forbidden` |
| M05-AT-07 | Task 15 `test_unknown_profile_is_rejected` |
| M05-AT-08 | Task 15 `test_internal_dataset_is_404_for_other_institutions` |
| M05-AT-09 | Task 15 `test_controlled_evidence_never_leaks_cell_values` (+ Task 10 engine-level scan of all 8 results) |
| M05-AT-10 | Task 12 `test_storage_outage_retries_twice_then_fails` + Task 13 `test_failed_run_is_never_reused_and_recovers` |
| M05-AT-11 | Task 14 `test_duplicate_delivery_creates_one_validation_per_profile` |
| M05-AT-12 | Task 15 `test_snapshot_not_live_metadata_is_evaluated` |
| M05-AT-13 | Task 14 `test_version_without_tabular_files_runs_generic_only` + Task 10 engine-level NA test |
| M05-AT-14 | Task 10 `test_module_imports_no_llm_or_http_client`, `test_validators_do_not_read_clock_randomness_or_env` |
| M05-AT-15 | Task 16 `test_perf.py` (opt-in, run once in Task 16 Step 3) |

Other sections: §4 data model and trigger -> Task 11; §5 state machine -> Task 12; §6 API -> Tasks 13/15; §7 events -> Tasks 12/14; §8 port -> Task 13; §9 matrix -> Task 15; §10 jobs (actor, handler, sweeper, parse cache, file timeout, streaming) -> Tasks 4/5/12/14; §11 env -> Task 1; §13 deliverables -> README (Task 16), migrations (11), validators + boundary tests (5-9), profiles/dictionaries/subset schema (1/5/9), fixtures + generate.py + lock + golden (3/10), integration notes (README). 09 §1-§5 -> Tasks 2-10.

**Placeholder scan:** no TBD/TODO; every code step has the full file; the only value produced at execution time (golden `result_sha256`) has a recording command and the expected hashes.

**Type consistency:** names used across tasks (`EvaluationContext`, `CheckOutcome`, `FileStats`, `ValidationResult`, `RequestOutcome`, `run_validation`, `enqueue_after_commit`, `FixtureCatalog.add_fixture/add_version/replace_view/delete_object`) were checked by running the tasks in order.

## Contract/shared changes needed

Items formerly listed here are resolved by the controller decisions:

1. ~~openapi 404/401/503 for readiness operations~~ — added by M00 kickoff (contract 1.2.0, W1-D3); the 401/404 tests call `assert_matches_response`.
2. ~~`.env.example` `READINESS_*` keys~~ — added by M00 kickoff (W1-D4) with the code defaults `1800` / `600` / `2`; this plan does not touch `.env.example`.
3. ~~M03 port location~~ — W1-D1/D-038: M03 owns `ObjectMissing`, `StorageUnavailable`, `FileRef`, `VersionView`, `CatalogQueryPort`, `CatalogReadPort` in `api.modules.catalog.public`; `readiness/catalog_port.py` is a re-export. Fixture bytes: W1-D5, M03 `seed_files.fixture_files` is the single source and `fixtures.lock` pins the 09-conformant bytes.
4. **Doc alignment**: 09 §4 `input_fingerprint` formula should include `metadata_snapshot_sha256` (D-029); M05 §4.1 should list `requester_organization_id`; M05 §4.2 evidence DB backstop is 128 KiB of `jsonb::text` (64 KiB canonical rule unchanged).
