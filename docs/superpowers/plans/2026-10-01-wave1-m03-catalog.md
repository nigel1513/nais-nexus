# M03 Data Catalog & Versioning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `catalog` module: datasets with policy, immutable dataset versions, presigned (multipart) uploads with server-side sha256/type/archive verification, an OpenSearch-backed faceted search with D-012 visibility, event consumers for readiness results, and the `CatalogQueryPort` / `StoragePort` / `CatalogReadPort` used by M04/M05.

**Architecture:** One package `apps/api/modules/catalog` plugged in through `ModuleSpec`. PostgreSQL (`catalog` schema, Alembic, DB triggers for immutability) is the system of record; OpenSearch is a rebuildable read model fed by `catalog.index_queue` and a 2 s worker drain. Everything that talks to the outside (object storage, OpenSearch, identity, malware scanner, verification queue) sits behind a small interface inside a frozen `CatalogDeps` container that `wire()` registers in `api.platform.ports`; tests swap in fakes or real test services.

**Tech Stack:** Python 3.13, FastAPI, SQLAlchemy 2 Core + Alembic, psycopg 3, boto3 (SeaweedFS S3), httpx (OpenSearch REST, no extra client library), Dramatiq (verify actor), pytest + testcontainers (Postgres, OpenSearch).

**Spec:** `NAIS_PRD/modules/M03_data_catalog.md` (binding), with `NAIS_PRD/contracts/openapi.yaml`, `NAIS_PRD/contracts/events/p0_events.schema.json`, `NAIS_PRD/contracts/error_codes.json`, `NAIS_PRD/11_DECISION_LOG.md` (D-011, D-012, D-013, D-014, D-018, D-024, D-028, D-029), `NAIS_PRD/07_RUNTIME_ENVIRONMENT.md`, `NAIS_PRD/10_SEED_DATA.md`, `NAIS_PRD/09_AI_READY_RULES.md` §5. When they disagree, `contracts/` wins.

## Global Constraints

- Owned paths only: `apps/api/modules/catalog/**`, `infra/opensearch/**`. No other file is changed by this plan (no `pyproject.toml` change is needed: httpx, boto3, testcontainers are already dependencies).
- Every table, index and constraint lives in schema `catalog`; every `op.*` call passes `schema="catalog"`; no FK to another schema (`owner_organization_id`, `created_by` are plain uuid).
- Alembic version table `catalog.alembic_version` (platform does this via `ModuleSpec.migrations_dir` + `db_schema`).
- IDs: `api.platform.ids.new_id()` (UUIDv7). Time: `api.platform.clock.now()` (UTC, freezable in tests). All timestamps `timestamptz`.
- Write endpoints take `session: SessionDep`; never call `session.commit()`. Events only through `api.platform.outbox.outbox.write(session, ...)` in the same session.
- Consumers: `create_processed_events("catalog", per_handler=True)` + `claim_event(session, "catalog", event, handler="<name>")`.
- Produced events (exact): `catalog.dataset.created.v1`, `catalog.dataset.access_level_changed.v1`, `catalog.dataset.policy_changed.v1`, `catalog.dataset.version_published.v1`. Consumed: `readiness.validation.completed.v1`, `identity.organization.created.v1`.
- Error codes only from `error_codes.json`. failure_code → API code: `CHECKSUM_MISMATCH`/`SIZE_MISMATCH` → `UPLOAD_CHECKSUM_MISMATCH`, `TYPE_MISMATCH` → `FILE_TYPE_NOT_ALLOWED`, `ARCHIVE_UNSAFE` → `UPLOAD_ARCHIVE_UNSAFE`, `MALWARE_DETECTED` → `MALWARE_DETECTED`.
- Env defaults (M03 §11): `NAIS_PUBLIC_BASE_URL=http://localhost:21051`, `STORAGE_PRESIGN_TTL_SECONDS=300`, `UPLOAD_URL_TTL_SECONDS=3600`, `UPLOAD_SESSION_TTL_SECONDS=3600`, `STORAGE_MULTIPART_THRESHOLD_BYTES=67108864`, `CATALOG_SYNC_VERIFY_MAX_BYTES=268435456`, `OPENSEARCH_URL=http://opensearch:9200` (in-container; code default `http://nais:nais@localhost:21056` for the host like platform `Settings`), `CATALOG_INDEX_ALIAS=nais-datasets`, `MALWARE_SCANNER=noop`.
- Limits: file ≤ 50 GiB (53687091200), ≤ 10,000 files per version, ≤ 500 files per session request (openapi), multipart part size 64 MiB, ≤ 10,000 parts, session TTL 1 h, zip: ≤ 10,000 entries, ≤ 20 GiB declared uncompressed, per-entry ratio ≤ 100, no absolute/`..`/symlink entries.
- Presigned URLs: public endpoint `NAIS_PUBLIC_BASE_URL`, path-style, SigV4, region `us-east-1` (`api.platform.storage.public_client`); server-side calls use `internal_client`. Single PUT signs `Content-Type` and `x-amz-checksum-sha256` (base64 of the declared sha256).
- The catalog HTTP API never returns a download URL, a storage bucket or a storage key. Download URLs only via `StoragePort.presign_get` (attachment disposition, TTL 300 s).
- OpenSearch index `nais-datasets-v1` behind alias `nais-datasets`; visibility is a query `filter` (never post-filter): `status=ACTIVE AND ((access_level IN [PUBLIC,CONTROLLED,SENSITIVE] AND has_published_version) OR owner_organization_id = caller org)`; tie-breaker `dataset_id`; `track_total_hits=10000`; OpenSearch failure → `503 DEPENDENCY_UNAVAILABLE`, no DB fallback.
- `manifest_sha256 = sha256("".join(f"{path}\t{size}\t{sha256}\n" for files sorted by UTF-8 path bytes))`.
- Every API test response is checked with `api.platform.testing.contracts.assert_matches_response` when openapi declares that status; every emitted event with `assert_valid_event`.
- Commit trailer on every commit: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never run `docker compose down` or delete volumes; restarting/rebuilding `api` and `worker` is fine.
- Test commands run from the repo root: `uv run pytest apps/api/modules/catalog/tests/<file> -v`. Postgres/OpenSearch tests skip when Docker is unavailable; SeaweedFS tests skip when the dev stack (gateway 21051, storage 21053/21054) is down.

## Review Focus

1. **Stale PENDING path after an unswept session expiry** — a steward whose upload session expired (sweeper not yet run) and who starts a new session for the same path expects it to work, not `409 CONFLICT`. Pinned in Task 9 (`test_pending_path_of_expired_session_is_reused`).
2. **Search cursor that does not belong to the current sort, or is tampered** — expected `422 VALIDATION_FAILED` (`reason=INVALID_CURSOR`), never a 500 from OpenSearch. Pinned in Task 14 (`test_cursor_from_another_sort_is_rejected`, `test_garbage_cursor_is_rejected`).
3. **PATCH that changes nothing policy-relevant (same values, or purposes merely reordered)** — expected no `access_level_changed`/`policy_changed` event (audit noise). Pinned in Task 7 (`test_noop_and_reordered_purposes_emit_no_policy_events`).
4. **`completeUploadSession` called twice (double click / retry)** — expected second call `409 CONFLICT`, no second multipart completion, file state unchanged. Pinned in Task 11 (`test_second_complete_is_conflict`).
5. **A FAILED readiness run arriving after a COMPLETED one for the same profile** — expected `readiness_overall` to keep the COMPLETED value (D-028 "latest COMPLETED"). Pinned in Task 15 (`test_failed_run_does_not_erase_completed_result`).

## Decisions taken while planning (spec ambiguities and test infrastructure)

- **OpenSearch tests: testcontainers OpenSearch (`opensearchproject/opensearch:2.19.1`, the image compose runs).** Visibility (D-012) is enforced *inside the OpenSearch query*, and AT-24 depends on the analyzer; a fake search adapter would only test itself. A recording fake is used only where OpenSearch semantics are irrelevant (API tests that do not search) and a failing fake for drain back-off. The stock image has no `analysis-nori`, so tests exercise the spec's fallback analyzer (`standard` + `lowercase` + `cjk_bigram`, verified to split `전해질` into `전해`/`해질`); an opt-in test (`NAIS_TEST_NORI=1`) builds `infra/opensearch/Dockerfile` and checks the nori analyzer.
- **S3 tests: the running dev stack's SeaweedFS through host ports 21053/21054 (nais/nais) and the 21051 gateway, not moto.** AT-05/06/07 are about the real presign path: gateway `Host` preservation, SeaweedFS rejecting a tampered body via the signed `x-amz-checksum-sha256` header (verified while planning: 400 BadDigest), presigned `UploadPart`, `response-content-disposition`. moto does not reproduce the gateway or SeaweedFS behaviour. Tests use random `datasets/test-<uuid>/` or `datasets/<new dataset id>/` prefixes and delete them afterwards. Service logic (checksum mismatch, zip bombs, sweeper) is covered faster by an in-memory `MemoryObjectStore` behind the same `ObjectStore` interface.
- **WITHDRAWN datasets remain visible (GET/PATCH) to the owner organization** and are hidden from everyone in search; otherwise §6.4 ("WITHDRAWN dataset: only status → ACTIVE allowed") would be unreachable (§6.3 says "same rules as search", which would 404 the steward).
- **PLATFORM_ADMIN can GET any dataset and all its versions** (§9 matrix "O"/"전체"); search stays D-012 only ("전체 조회 옵션 없음(P0)").
- **`catalog.index_queue` gets an extra column `next_attempt_at`** to implement the §10 exponential back-off; the spec's three columns are kept.
- **A FAILED readiness run never overwrites a COMPLETED summary of the same profile** (D-028 "latest COMPLETED"), and older `occurred_at` never overwrites newer.
- **AT-21: changing CONTROLLED → PUBLIC also emits `policy_changed.v1`** because `approval_required` flips true → false (§6.4 lists approval_required changes as policy changes). The test asserts exactly one `access_level_changed.v1`.
- **`processed_events` uses `per_handler=True`** (Wave 1 brief) instead of the spec's single-PK table; two handlers, two claim names.
- **`getUploadSession` for a non-steward returns 404** (openapi declares only 404 for it); other visible-but-forbidden writes return 403 as §9 says.
- **Closed upload sessions omit `files[].upload`** (openapi operation description + §6.6). The schema still marks `upload` required; tests validate closed-session bodies with a documented bridging helper until the contract is fixed (see "Contract/shared changes needed").
- **`api.modules.catalog.ports` re-exports `public.py`** because M04 §3 imports `from api.modules.catalog.ports import ...` while M03 §8 names `public.py`.
- **Identity mock-first:** `wire()` uses M01's `IdentityQueryPort` from `api.modules.identity.public` when that module exists, else `FakeIdentityPort` (NAIS / Institute A / Institute B with the seed UUIDs and codes).
- **Plan code was executed while planning** (scratch copy of the repo, not committed): all catalog tests plus the
  platform and contract suites passed (375 passed, incl. SeaweedFS e2e through the gateway, `NAIS_PERF=1` AT-20 and
  `NAIS_TEST_NORI=1`), `ruff check --fix` + `ruff format` clean, `mypy` clean. Two facts found that way are baked in:
  PostgreSQL regexes cap `{m,n}` at 255 (the path CHECK uses `char_length`), and FastAPI 0.142 mounts included routers
  lazily (the AT-18 test reads `app.openapi()`, not `app.routes`).
- **Seed files are generated in code** (`seed_files.py`, formulas of 09 §5) because `tests/fixtures/readiness` (M05) is neither available yet nor inside the api image.

---
## File Structure

All paths are owned by M03 (`module_ownership.json`). There is **no** shared-file change in this plan.

```text
apps/api/modules/catalog/
  __init__.py              MODULE = ModuleSpec(...); imports handlers + jobs so they register at import time
  README.md                module doc + integration notes for M04/M05 (deliverable 1, 9)
  settings.py              CatalogSettings (M03 §11 env)
  domain.py                pure rules: policy, paths, allow list, manifest, keys (no I/O)
  tables.py                SQLAlchemy Core tables of schema catalog
  migrations/catalog_0001_initial.py   tables, checks, indexes, immutability triggers, processed_events
  repo.py                  shared queries (load dataset/version/files, readiness_overall, enqueue_index)
  access.py                visibility (D-012) and steward checks
  schemas.py               request bodies (Pydantic)
  views.py                 response bodies (dicts matching openapi components)
  errors.py                storage failures -> ApiError(DEPENDENCY_UNAVAILABLE)
  interfaces.py            internal ports: OrganizationLookup, MalwareScannerPort, VerificationQueue, SearchIndex
  objects.py               ObjectStore protocol, S3ObjectStore (boto3), StorageRegistry (org code -> store)
  adapters/__init__.py
  adapters/identity.py     FakeIdentityPort, IdentityQueryAdapter (M01 public port)
  adapters/malware.py      NoopScanner, build_scanner
  adapters/queue.py        DramatiqVerificationQueue
  deps.py                  CatalogDeps container + FastAPI dependency
  wiring.py                build_default_deps(), install(), wire()
  verification.py          sha256 streaming, type sniffing, zip central-directory checks, apply_outcome
  jobs.py                  verify actor, upload-session sweeper, stale re-queue, register_worker
  handlers.py              readiness.validation.completed.v1 / identity.organization.created.v1 consumers
  public.py                M03 §8 dataclasses + CatalogQueryPort / StoragePort / CatalogReadPort
  ports.py                 alias of public.py (M04 imports this path)
  public_impl.py           implementations of the three public ports
  reindex.py               python -m api.modules.catalog.reindex (new index + alias swap)
  seed.py, seed_data.py, seed_files.py   10_SEED_DATA §5 datasets (fixed UUIDs, idempotent)
  testing.py               MemoryObjectStore, memory_registry, recording fakes (test support shipped with module)
  router.py                aggregates routes/*
  routes/__init__.py
  routes/datasets.py       createDataset, getDataset, getDatasetPolicy
  routes/dataset_update.py updateDataset
  routes/versions.py       listDatasetVersions, createDatasetVersion, getDatasetVersion
  routes/uploads.py        createUploadSession, getUploadSession
  routes/completion.py     completeUploadSession, deleteDraftFile
  routes/publish.py        publishDatasetVersion
  routes/search.py         searchDatasets
  service/__init__.py
  service/datasets.py      create/get dataset, policy view, insert_dataset (reused by seed)
  service/dataset_update.py  updateDataset with optimistic lock + events
  service/versions.py      version create/list/get, version_response
  service/uploads.py       upload session create/get, presign instructions
  service/completion.py    complete session, delete draft file
  service/publish.py       publish (manifest, snapshot, event), finalize_publish (reused by seed)
  service/search.py        searchDatasets orchestration
  search/__init__.py
  search/index_body.py     nais-datasets-v1 settings/mappings (nori + fallback)
  search/opensearch.py     OpenSearchIndex (httpx): ensure, bulk, search, refresh, alias swap
  search/documents.py      DB -> search document
  search/drain.py          index_queue drain with back-off
  search/query.py          SearchParams, query DSL builder, cursor, response mapping
  tests/__init__.py
  tests/conftest.py        StubBroker first, then imports fixture modules
  tests/fixtures_db.py     catalog_db (migrations), db (truncate)
  tests/fixtures_storage.py  seaweed_registry, s3_prefixes (dev stack SeaweedFS)
  tests/fixtures_search.py opensearch_url (testcontainer), search_index
  tests/fixtures_api.py    deps, api, search_api
  tests/support.py         constants + raw SQL helpers
  tests/support_api.py     users, FakePrincipalResolver, CatalogApi client, assert_error, dataset helpers
  tests/support_upload.py  upload helpers, closed-session contract bridge
  tests/test_*.py          one file per task (named in each task)
infra/opensearch/
  Dockerfile               opensearch 2.19.1 + analysis-nori
  nais-datasets-v1.json    index body with nori analyzer (generated from search/index_body.py)
  nais-datasets-v1.fallback.json  index body with standard+cjk_bigram analyzer
```

Task order and dependencies: 1 domain → 2 schema → 3 storage → 4 OpenSearch client → 5 deps/wiring/test harness → 6–8 datasets & versions API → 9–11 uploads & verification → 12 publish → 13 indexing → 14 search API → 15 consumers → 16 public ports → 17 worker jobs → 18 seed + live verification.

---
### Task 1: Module skeleton, settings and pure domain rules

**Files:**
- Create: `apps/api/modules/catalog/__init__.py`
- Create: `apps/api/modules/catalog/settings.py`
- Create: `apps/api/modules/catalog/domain.py`
- Create: `apps/api/modules/catalog/tests/__init__.py` (empty)
- Test: `apps/api/modules/catalog/tests/test_domain.py`

**Interfaces:**
- Consumes: `api.platform.modules.ModuleSpec`.
- Produces:
  - `CatalogSettings` (pydantic-settings) fields: `nais_public_base_url: str`, `opensearch_url: str`, `catalog_index_alias: str`, `storage_org_codes: str` (+ property `storage_org_code_list -> list[str]`), `storage_presign_ttl_seconds: int`, `upload_url_ttl_seconds: int`, `upload_session_ttl_seconds: int`, `storage_multipart_threshold_bytes: int`, `catalog_multipart_part_size_bytes: int`, `catalog_sync_verify_max_bytes: int`, `malware_scanner: str`, `catalog_index_batch_size: int`, `catalog_opensearch_timeout_seconds: float`; `get_catalog_settings() -> CatalogSettings`.
  - `domain`: constants `ACCESS_LEVELS`, `PURPOSES`, `APPROVAL_LEVELS`, `DATA_STEWARD`, `ORG_ADMIN`, `DEFAULT_MAX_GRANT_DAYS=180`, `SENSITIVE_MAX_GRANT_DAYS=30`, `MAX_FILE_BYTES`, `MAX_FILES_PER_VERSION`, `MAX_PARTS`, `FAILURE_CODES`, `FAILURE_ERROR_CODES`, `ALLOWED_MEDIA_TYPES: dict[str, str]`, `SNAPSHOT_FIELDS`; `class InvalidPolicy(ValueError)`; `@dataclass(frozen=True) Policy(access_level, allowed_purposes: tuple[str, ...], approval_required, max_grant_days)` with `as_event() -> dict`; `build_policy(access_level: str, allowed_purposes: Iterable[str], max_grant_days: int | None) -> Policy`; `normalize_purposes(Iterable[str]) -> tuple[str, ...]`; `normalize_keywords(Iterable[str]) -> list[str]`; `path_problem(path: str) -> str | None` (reasons `LENGTH`, `CHARACTERS`, `ABSOLUTE`, `EMPTY_SEGMENT`, `DOT_SEGMENT`); `extension(path) -> str`; `basename(path) -> str`; `media_type_allowed(path, media_type) -> bool`; `canonical_media_type(media_type) -> str`; `manifest_sha256(files: Iterable[tuple[str, int, str]]) -> str`; `storage_key(dataset_id, version_id, path) -> str`; `checksum_b64(sha256_hex) -> str`; `part_count(size, part_size) -> int`.

- [ ] **Step 1: Write the failing tests**

`apps/api/modules/catalog/tests/__init__.py`: empty file.

`apps/api/modules/catalog/tests/test_domain.py`:

```python
import hashlib

import pytest

from api.modules.catalog.domain import (
    FAILURE_CODES,
    FAILURE_ERROR_CODES,
    InvalidPolicy,
    basename,
    build_policy,
    checksum_b64,
    extension,
    manifest_sha256,
    media_type_allowed,
    normalize_keywords,
    part_count,
    path_problem,
    storage_key,
)
from api.modules.catalog.settings import CatalogSettings
from api.platform.generated.error_codes import HTTP_STATUS, ErrorCode

A, B, C = "a" * 64, "b" * 64, "c" * 64


def test_failure_codes_map_to_contract_error_codes() -> None:  # deliverable 5: error code mapping
    assert set(FAILURE_ERROR_CODES) <= set(FAILURE_CODES)
    assert FAILURE_ERROR_CODES == {
        "CHECKSUM_MISMATCH": "UPLOAD_CHECKSUM_MISMATCH",
        "SIZE_MISMATCH": "UPLOAD_CHECKSUM_MISMATCH",
        "TYPE_MISMATCH": "FILE_TYPE_NOT_ALLOWED",
        "ARCHIVE_UNSAFE": "UPLOAD_ARCHIVE_UNSAFE",
        "MALWARE_DETECTED": "MALWARE_DETECTED",
    }
    for code in FAILURE_ERROR_CODES.values():
        assert HTTP_STATUS[ErrorCode(code)] == 422
    for code in ("DATASET_VERSION_IMMUTABLE", "DATASET_VERSION_INCOMPLETE", "DATASET_VERSION_LABEL_EXISTS", "UPLOAD_SESSION_EXPIRED"):
        assert HTTP_STATUS[ErrorCode(code)] == 409
    assert HTTP_STATUS[ErrorCode("INVALID_POLICY")] == 422 and HTTP_STATUS[ErrorCode("FILE_TOO_LARGE")] == 422


def test_manifest_sorts_by_utf8_path_and_ignores_input_order() -> None:
    files = [("data/b.csv", 10, B), ("README.md", 5, A), ("data/a.csv", 7, C)]
    text = f"README.md\t5\t{A}\ndata/a.csv\t7\t{C}\ndata/b.csv\t10\t{B}\n"
    assert manifest_sha256(files) == hashlib.sha256(text.encode("utf-8")).hexdigest()
    assert manifest_sha256(list(reversed(files))) == manifest_sha256(files)


@pytest.mark.parametrize(
    ("path", "reason"),
    [
        ("../etc/passwd", "DOT_SEGMENT"),
        ("a/../b.csv", "DOT_SEGMENT"),
        ("./a.csv", "DOT_SEGMENT"),
        ("/abs.csv", "ABSOLUTE"),
        ("a//b.csv", "EMPTY_SEGMENT"),
        ("dir/", "EMPTY_SEGMENT"),
        ("a b.csv", "CHARACTERS"),
        ("a\x00.csv", "CHARACTERS"),
        ("a\\b.csv", "CHARACTERS"),
        ("", "LENGTH"),
        ("a" * 513, "LENGTH"),
    ],
)
def test_unsafe_paths_are_rejected(path: str, reason: str) -> None:
    assert path_problem(path) == reason


@pytest.mark.parametrize("path", ["data/a.csv", "README.md", "_schema.json", "a/b/c.d.parquet", "x..y.txt"])
def test_safe_paths_are_accepted(path: str) -> None:
    assert path_problem(path) is None


def test_allow_list_matches_extension_and_media_type() -> None:
    assert media_type_allowed("data/a.csv", "text/csv")
    assert media_type_allowed("data/A.CSV", "Text/CSV")
    assert media_type_allowed("x.hdf5", "application/x-hdf5")
    assert media_type_allowed("x.h5", "application/x-hdf5")
    assert media_type_allowed("t.parquet", "application/vnd.apache.parquet")
    assert not media_type_allowed("run.exe", "application/octet-stream")
    assert not media_type_allowed("data/a.csv", "application/json")
    assert not media_type_allowed("data/a.csv", "text/csv; charset=utf-8")
    assert not media_type_allowed(".csv", "text/csv")
    assert extension("a/b.tar.zip") == ".zip"
    assert basename("data/sub/a.csv") == "a.csv"


def test_controlled_requires_approval_and_normalizes_purposes() -> None:
    policy = build_policy("CONTROLLED", ["AI_TRAINING", "ACADEMIC_RESEARCH", "AI_TRAINING"], None)
    assert policy.approval_required is True
    assert policy.max_grant_days == 180
    assert policy.allowed_purposes == ("ACADEMIC_RESEARCH", "AI_TRAINING")


@pytest.mark.parametrize("level", ["PUBLIC", "INTERNAL"])
def test_public_and_internal_do_not_require_approval(level: str) -> None:
    assert build_policy(level, ["EDUCATION"], 90).approval_required is False


def test_sensitive_defaults_to_30_days_and_rejects_longer() -> None:
    assert build_policy("SENSITIVE", ["ACADEMIC_RESEARCH"], None).max_grant_days == 30
    assert build_policy("SENSITIVE", ["ACADEMIC_RESEARCH"], 30).approval_required is True
    with pytest.raises(InvalidPolicy, match="30"):
        build_policy("SENSITIVE", ["ACADEMIC_RESEARCH"], 60)


@pytest.mark.parametrize(("purposes", "days"), [([], 10), (["MINING"], 10), (["EDUCATION"], 0), (["EDUCATION"], 366)])
def test_invalid_policies(purposes: list[str], days: int) -> None:
    with pytest.raises(InvalidPolicy):
        build_policy("PUBLIC", purposes, days)


def test_policy_event_shape() -> None:
    assert build_policy("CONTROLLED", ["AI_TRAINING"], 90).as_event() == {
        "allowed_purposes": ["AI_TRAINING"],
        "approval_required": True,
        "max_grant_days": 90,
    }


def test_small_helpers() -> None:
    assert storage_key("d", "v", "data/a.csv") == "datasets/d/v/data/a.csv"
    assert checksum_b64(hashlib.sha256(b"").hexdigest()) == "47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU="
    assert part_count(100 * 1024 * 1024, 64 * 1024 * 1024) == 2
    assert part_count(64 * 1024 * 1024, 64 * 1024 * 1024) == 1
    assert normalize_keywords([" a", "a", "", "b ", "  "]) == ["a", "b"]


def test_settings_defaults_and_env_override(monkeypatch: pytest.MonkeyPatch) -> None:
    settings = CatalogSettings()
    assert settings.storage_multipart_threshold_bytes == 67108864
    assert settings.catalog_multipart_part_size_bytes == 67108864
    assert settings.catalog_sync_verify_max_bytes == 268435456
    assert (settings.upload_url_ttl_seconds, settings.upload_session_ttl_seconds) == (3600, 3600)
    assert settings.storage_presign_ttl_seconds == 300
    assert settings.catalog_index_alias == "nais-datasets"
    assert settings.malware_scanner == "noop"
    monkeypatch.setenv("UPLOAD_URL_TTL_SECONDS", "60")
    monkeypatch.setenv("STORAGE_ORG_CODES", "inst-a, inst-b")
    assert CatalogSettings().upload_url_ttl_seconds == 60
    assert CatalogSettings().storage_org_code_list == ["inst-a", "inst-b"]
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `uv run pytest apps/api/modules/catalog/tests/test_domain.py -v`
Expected: collection error `ModuleNotFoundError: No module named 'api.modules.catalog'`.

- [ ] **Step 3: Implement**

`apps/api/modules/catalog/__init__.py`:

```python
"""M03 Data Catalog & Versioning. Spec: NAIS_PRD/modules/M03_data_catalog.md."""

from api.platform.modules import ModuleSpec

MODULE = ModuleSpec(name="catalog", db_schema="catalog")
```

`apps/api/modules/catalog/settings.py`:

```python
"""Catalog configuration (M03 §11). Env names are the field names upper-cased."""

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict

MIB = 1024 * 1024


class CatalogSettings(BaseSettings):
    model_config = SettingsConfigDict(extra="ignore")

    nais_public_base_url: str = "http://localhost:21051"
    opensearch_url: str = "http://nais:nais@localhost:21056"
    catalog_index_alias: str = "nais-datasets"
    storage_org_codes: str = "nais,inst-a,inst-b"
    storage_presign_ttl_seconds: int = 300
    upload_url_ttl_seconds: int = 3600
    upload_session_ttl_seconds: int = 3600
    storage_multipart_threshold_bytes: int = 64 * MIB
    catalog_multipart_part_size_bytes: int = 64 * MIB
    catalog_sync_verify_max_bytes: int = 256 * MIB
    malware_scanner: str = "noop"
    catalog_index_batch_size: int = 200
    catalog_opensearch_timeout_seconds: float = 5.0

    @property
    def storage_org_code_list(self) -> list[str]:
        return [code.strip() for code in self.storage_org_codes.split(",") if code.strip()]


@lru_cache(maxsize=1)
def get_catalog_settings() -> CatalogSettings:
    return CatalogSettings()
```

`apps/api/modules/catalog/domain.py`:

```python
"""Pure catalog rules (M03 §4, §6). No I/O here."""

import base64
import hashlib
import math
import re
from collections.abc import Iterable
from dataclasses import dataclass
from typing import Any
from uuid import UUID

ACCESS_LEVELS: tuple[str, ...] = ("PUBLIC", "INTERNAL", "CONTROLLED", "SENSITIVE")
PURPOSES: tuple[str, ...] = (
    "ACADEMIC_RESEARCH",
    "AI_TRAINING",
    "COMMERCIAL_RESEARCH",
    "EDUCATION",
    "PUBLIC_INTEREST",
)
APPROVAL_LEVELS = frozenset({"CONTROLLED", "SENSITIVE"})
DATA_STEWARD = "DATA_STEWARD"
ORG_ADMIN = "ORG_ADMIN"
DEFAULT_MAX_GRANT_DAYS = 180
SENSITIVE_MAX_GRANT_DAYS = 30
MAX_FILE_BYTES = 50 * 1024**3
MAX_FILES_PER_VERSION = 10_000
MAX_PARTS = 10_000
MAX_PATH_LENGTH = 512

FAILURE_CODES: tuple[str, ...] = (
    "OBJECT_MISSING",
    "SIZE_MISMATCH",
    "CHECKSUM_MISMATCH",
    "TYPE_MISMATCH",
    "ARCHIVE_UNSAFE",
    "MALWARE_DETECTED",
    "SESSION_EXPIRED",
)
FAILURE_ERROR_CODES: dict[str, str] = {
    "CHECKSUM_MISMATCH": "UPLOAD_CHECKSUM_MISMATCH",
    "SIZE_MISMATCH": "UPLOAD_CHECKSUM_MISMATCH",
    "TYPE_MISMATCH": "FILE_TYPE_NOT_ALLOWED",
    "ARCHIVE_UNSAFE": "UPLOAD_ARCHIVE_UNSAFE",
    "MALWARE_DETECTED": "MALWARE_DETECTED",
}

ALLOWED_MEDIA_TYPES: dict[str, str] = {
    ".csv": "text/csv",
    ".tsv": "text/tab-separated-values",
    ".json": "application/json",
    ".jsonl": "application/x-ndjson",
    ".txt": "text/plain",
    ".md": "text/markdown",
    ".parquet": "application/vnd.apache.parquet",
    ".h5": "application/x-hdf5",
    ".hdf5": "application/x-hdf5",
    ".nc": "application/x-netcdf",
    ".zip": "application/zip",
}

# Dataset fields frozen into dataset_versions.metadata_snapshot at publish (M03 §6.9, D-029).
SNAPSHOT_FIELDS: tuple[str, ...] = (
    "access_level",
    "allowed_purposes",
    "contact_email",
    "description",
    "domain",
    "keywords",
    "license",
    "max_grant_days",
    "provenance",
    "title",
    "usage_policy",
)

_PATH_CHARS = re.compile(r"^[A-Za-z0-9._/-]+$")


class InvalidPolicy(ValueError):
    pass


@dataclass(frozen=True)
class Policy:
    access_level: str
    allowed_purposes: tuple[str, ...]
    approval_required: bool
    max_grant_days: int

    def as_event(self) -> dict[str, Any]:
        """The contract `DatasetPolicy` shape used in catalog.dataset.policy_changed.v1."""
        return {
            "allowed_purposes": list(self.allowed_purposes),
            "approval_required": self.approval_required,
            "max_grant_days": self.max_grant_days,
        }


def normalize_purposes(purposes: Iterable[str]) -> tuple[str, ...]:
    chosen = set(purposes)
    unknown = chosen - set(PURPOSES)
    if unknown:
        raise InvalidPolicy(f"unknown purposes: {', '.join(sorted(unknown))}")
    return tuple(p for p in PURPOSES if p in chosen)


def build_policy(access_level: str, allowed_purposes: Iterable[str], max_grant_days: int | None) -> Policy:
    """Normalize and validate a dataset policy. approval_required is derived, never requested (M03 §6.1)."""
    if access_level not in ACCESS_LEVELS:
        raise InvalidPolicy(f"unknown access level {access_level!r}")
    purposes = normalize_purposes(allowed_purposes)
    if not purposes:
        raise InvalidPolicy("allowed_purposes must contain at least one purpose")
    if max_grant_days is None:
        days = SENSITIVE_MAX_GRANT_DAYS if access_level == "SENSITIVE" else DEFAULT_MAX_GRANT_DAYS
    else:
        days = max_grant_days
    if not 1 <= days <= 365:
        raise InvalidPolicy("max_grant_days must be between 1 and 365")
    if access_level == "SENSITIVE" and days > SENSITIVE_MAX_GRANT_DAYS:
        raise InvalidPolicy("SENSITIVE datasets allow at most 30 grant days")
    return Policy(access_level, purposes, access_level in APPROVAL_LEVELS, days)


def normalize_keywords(keywords: Iterable[str]) -> list[str]:
    return list(dict.fromkeys(k.strip() for k in keywords if k.strip()))


def path_problem(path: str) -> str | None:
    """None for a safe relative manifest path, else a reason code for details.fields[].reason."""
    if not 1 <= len(path) <= MAX_PATH_LENGTH:
        return "LENGTH"
    if not _PATH_CHARS.fullmatch(path):
        return "CHARACTERS"
    if path.startswith("/"):
        return "ABSOLUTE"
    if "//" in path or path.endswith("/"):
        return "EMPTY_SEGMENT"
    if any(segment in (".", "..") for segment in path.split("/")):
        return "DOT_SEGMENT"
    return None


def basename(path: str) -> str:
    return path.rsplit("/", 1)[-1]


def extension(path: str) -> str:
    name = basename(path)
    dot = name.rfind(".")
    return name[dot:].lower() if dot > 0 else ""


def canonical_media_type(media_type: str) -> str:
    return media_type.strip().lower()


def media_type_allowed(path: str, media_type: str) -> bool:
    expected = ALLOWED_MEDIA_TYPES.get(extension(path))
    return expected is not None and canonical_media_type(media_type) == expected


def manifest_sha256(files: Iterable[tuple[str, int, str]]) -> str:
    """M03 §4.9: deterministic over the sorted (path, size, sha256) lines."""
    lines = sorted(files, key=lambda item: item[0].encode("utf-8"))
    text = "".join(f"{path}\t{size}\t{sha}\n" for path, size, sha in lines)
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def storage_key(dataset_id: UUID | str, version_id: UUID | str, path: str) -> str:
    return f"datasets/{dataset_id}/{version_id}/{path}"


def checksum_b64(sha256_hex: str) -> str:
    return base64.b64encode(bytes.fromhex(sha256_hex)).decode("ascii")


def part_count(size: int, part_size: int) -> int:
    return max(1, math.ceil(size / part_size))
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `uv run pytest apps/api/modules/catalog/tests/test_domain.py -v`
Expected: all PASS.

- [ ] **Step 5: Lint and commit**

```bash
uv run ruff check --fix apps/api/modules/catalog && uv run ruff format apps/api/modules/catalog
git add apps/api/modules/catalog
git commit -m "feat(catalog): module skeleton, settings and pure domain rules

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 2: `catalog` schema migration, Core tables and DB test fixtures

**Files:**
- Create: `apps/api/modules/catalog/migrations/catalog_0001_initial.py`
- Create: `apps/api/modules/catalog/tables.py`
- Modify: `apps/api/modules/catalog/__init__.py` (add `migrations_dir`)
- Create: `apps/api/modules/catalog/tests/conftest.py`
- Create: `apps/api/modules/catalog/tests/fixtures_db.py`
- Create: `apps/api/modules/catalog/tests/support.py`
- Test: `apps/api/modules/catalog/tests/test_migration.py`

**Interfaces:**
- Consumes: `api.platform.migrate.upgrade_all`, `api.platform.migration_helpers.create_processed_events`, fixture `migrated_db: PgUrls` (`superuser`, `migrator`, `app` URLs).
- Produces:
  - Tables (SQLAlchemy `Table`, `MetaData(schema="catalog")`): `datasets`, `dataset_versions`, `dataset_files`, `upload_sessions`, `readiness_summaries`, `index_queue` (with extra `next_attempt_at`), plus `catalog.processed_events (event_id, handler)`.
  - DB triggers `trg_versions_immutable` (BEFORE UPDATE OR DELETE on dataset_versions) and `trg_files_immutable` (BEFORE INSERT OR UPDATE OR DELETE on dataset_files); both raise SQLSTATE 23000 with a message containing `immutable`.
  - Fixtures: `catalog_db` (session scope, migrated), `db` (function scope, truncates catalog tables and `platform.outbox_events`).
  - `tests/support.py`: `ORG_NAIS`, `ORG_A`, `ORG_B`, `seed_user_id(suffix) -> UUID`, `rows(urls, sql, **params) -> list[dict]`, `execute(urls, sql, **params) -> int`, `outbox_events(urls, event_type=None) -> list[dict]`, `insert_dataset(urls, *, owner=ORG_B, access_level="CONTROLLED", status="ACTIVE", title=..., max_grant_days=180) -> UUID`, `insert_version(urls, dataset_id, *, label="v1", published=False, files=(), file_status="VERIFIED", published_at=None) -> UUID`, `insert_file(urls, version_id, *, path, size=10, sha=..., status="VERIFIED") -> UUID`, `enqueue(urls, dataset_id) -> None`.

- [ ] **Step 1: Write the failing test**

`apps/api/modules/catalog/tests/conftest.py`:

```python
"""Catalog test fixtures.

A Dramatiq StubBroker is installed as the global broker so nothing in the catalog tests reaches Redis
(DramatiqVerificationQueue sends through dramatiq.get_broker()). Fixture modules are imported below and
registered by name.
"""

from dramatiq.brokers.stub import StubBroker

from api.platform.broker import configure_broker
from api.platform.settings import Settings

configure_broker(Settings(), StubBroker())

from api.modules.catalog.tests.fixtures_db import catalog_db, db  # noqa: E402, F401
```

`apps/api/modules/catalog/tests/fixtures_db.py`:

```python
from collections.abc import Iterator

import pytest
from sqlalchemy import create_engine, text

from api.modules.catalog import MODULE
from api.platform.migrate import upgrade_all
from api.platform.testing.fixtures import PgUrls

TRUNCATE = (
    "catalog.dataset_files",
    "catalog.upload_sessions",
    "catalog.dataset_versions",
    "catalog.datasets",
    "catalog.readiness_summaries",
    "catalog.index_queue",
    "catalog.processed_events",
    "platform.outbox_events",
)


@pytest.fixture(scope="session")
def catalog_db(migrated_db: PgUrls) -> PgUrls:
    upgrade_all(migrated_db.migrator, [MODULE])
    return migrated_db


@pytest.fixture
def db(catalog_db: PgUrls) -> Iterator[PgUrls]:
    """Empty catalog tables + outbox. TRUNCATE (as owner) bypasses the row-level immutability triggers."""
    engine = create_engine(catalog_db.migrator)
    with engine.begin() as conn:
        conn.execute(text(f"TRUNCATE {', '.join(TRUNCATE)} CASCADE"))
    engine.dispose()
    yield catalog_db
```

`apps/api/modules/catalog/tests/support.py`:

```python
"""Constants and raw-SQL helpers shared by catalog tests."""

from collections.abc import Sequence
from datetime import datetime
from typing import Any
from uuid import UUID

from sqlalchemy import text

from api.modules.catalog.domain import manifest_sha256, storage_key
from api.platform.db import session_factory
from api.platform.ids import new_id
from api.platform.testing.fixtures import PgUrls

ORG_NAIS = UUID("00000000-0000-7000-8000-000000000001")
ORG_A = UUID("00000000-0000-7000-8000-00000000000a")
ORG_B = UUID("00000000-0000-7000-8000-00000000000b")
SHA_A = "a" * 64


def seed_user_id(suffix: str) -> UUID:
    return UUID(f"00000000-0000-7000-8000-00000000{suffix}")


def rows(urls: PgUrls, sql: str, **params: Any) -> list[dict[str, Any]]:
    with session_factory(urls.app)() as session:
        return [dict(row) for row in session.execute(text(sql), params).mappings().all()]


def execute(urls: PgUrls, sql: str, **params: Any) -> int:
    with session_factory(urls.app)() as session, session.begin():
        return int(session.execute(text(sql), params).rowcount)  # type: ignore[attr-defined]


def outbox_events(urls: PgUrls, event_type: str | None = None) -> list[dict[str, Any]]:
    sql = "SELECT envelope FROM platform.outbox_events"
    if event_type:
        sql += " WHERE event_type = :event_type"
    return [row["envelope"] for row in rows(urls, sql + " ORDER BY id", event_type=event_type)]


def insert_dataset(
    urls: PgUrls,
    *,
    owner: UUID = ORG_B,
    access_level: str = "CONTROLLED",
    status: str = "ACTIVE",
    title: str = "Seeded dataset",
    max_grant_days: int = 180,
) -> UUID:
    dataset_id = new_id()
    execute(
        urls,
        "INSERT INTO catalog.datasets (dataset_id, owner_organization_id, title, access_level, license,"
        " allowed_purposes, approval_required, max_grant_days, status, created_by)"
        " VALUES (:id, :owner, :title, :level, 'CC-BY-4.0', ARRAY['ACADEMIC_RESEARCH'], :approval, :days,"
        " :status, :owner)",
        id=dataset_id,
        owner=owner,
        title=title,
        level=access_level,
        approval=access_level in ("CONTROLLED", "SENSITIVE"),
        days=max_grant_days,
        status=status,
    )
    return dataset_id


def _upload_session(urls: PgUrls, version_id: UUID) -> UUID:
    session_id = new_id()
    execute(
        urls,
        "INSERT INTO catalog.upload_sessions (upload_session_id, dataset_version_id, status, created_by,"
        " expires_at) VALUES (:id, :v, 'COMPLETED', :v, now() + interval '1 hour')",
        id=session_id,
        v=version_id,
    )
    return session_id


def insert_file(
    urls: PgUrls,
    version_id: UUID,
    *,
    path: str,
    size: int = 10,
    sha: str = SHA_A,
    status: str = "VERIFIED",
    bucket: str = "nais-inst-b",
) -> UUID:
    dataset_id = rows(urls, "SELECT dataset_id FROM catalog.dataset_versions WHERE dataset_version_id = :v", v=version_id)[0][
        "dataset_id"
    ]
    file_id = new_id()
    execute(
        urls,
        "INSERT INTO catalog.dataset_files (file_id, dataset_version_id, upload_session_id, path, size_bytes, sha256,"
        " media_type, storage_bucket, storage_key, status) VALUES (:id, :v, :s, :path, :size, :sha, 'text/csv',"
        " :bucket, :key, :status)",
        id=file_id,
        v=version_id,
        s=_upload_session(urls, version_id),
        path=path,
        size=size,
        sha=sha,
        bucket=bucket,
        key=storage_key(dataset_id, version_id, path),
        status=status,
    )
    return file_id


def insert_version(
    urls: PgUrls,
    dataset_id: UUID,
    *,
    label: str = "v1",
    published: bool = False,
    files: Sequence[tuple[str, int, str]] = (),
    file_status: str = "VERIFIED",
    published_at: datetime | None = None,
) -> UUID:
    """A version inserted straight into the DB; published=True goes DRAFT -> PUBLISHED like the service does."""
    version_id = new_id()
    execute(
        urls,
        "INSERT INTO catalog.dataset_versions (dataset_version_id, dataset_id, version_label, created_by)"
        " VALUES (:v, :d, :label, :d)",
        v=version_id,
        d=dataset_id,
        label=label,
    )
    for path, size, sha in files:
        insert_file(urls, version_id, path=path, size=size, sha=sha, status=file_status)
    if published:
        execute(
            urls,
            "UPDATE catalog.dataset_versions SET status = 'PUBLISHED', manifest_sha256 = :manifest,"
            " metadata_snapshot = CAST(:snapshot AS jsonb), file_count = :count, total_bytes = :total,"
            " published_at = COALESCE(CAST(:at AS timestamptz), now()), published_by = :d"
            " WHERE dataset_version_id = :v",
            manifest=manifest_sha256(files),
            snapshot="{}",
            count=len(files),
            total=sum(size for _, size, _ in files),
            at=published_at,
            d=dataset_id,
            v=version_id,
        )
    return version_id


def enqueue(urls: PgUrls, dataset_id: UUID) -> None:
    execute(
        urls,
        "INSERT INTO catalog.index_queue (dataset_id) VALUES (:id)"
        " ON CONFLICT (dataset_id) DO UPDATE SET next_attempt_at = now(), attempts = 0",
        id=dataset_id,
    )
```

`apps/api/modules/catalog/tests/test_migration.py`:

```python
import pytest
from sqlalchemy.exc import DBAPIError

from api.modules.catalog.tests.support import (
    SHA_A,
    execute,
    insert_dataset,
    insert_file,
    insert_version,
    rows,
)
from api.platform.testing.fixtures import PgUrls


def test_catalog_schema_is_migrated_with_its_own_version_table(db: PgUrls) -> None:
    assert rows(db, "SELECT version_num FROM catalog.alembic_version") == [{"version_num": "catalog_0001"}]
    tables = {r["table_name"] for r in rows(db, "SELECT table_name FROM information_schema.tables WHERE table_schema = 'catalog'")}
    assert {
        "datasets",
        "dataset_versions",
        "dataset_files",
        "upload_sessions",
        "readiness_summaries",
        "index_queue",
        "processed_events",
    } <= tables


def test_published_version_rejects_every_change_but_withdrawal(db: PgUrls) -> None:  # M03-AT-12 (DB part)
    dataset_id = insert_dataset(db)
    version_id = insert_version(db, dataset_id, published=True, files=[("data/a.csv", 10, SHA_A)])
    for sql in (
        "UPDATE catalog.dataset_versions SET change_note = 'x' WHERE dataset_version_id = :v",
        "UPDATE catalog.dataset_versions SET status = 'DRAFT' WHERE dataset_version_id = :v",
        "DELETE FROM catalog.dataset_versions WHERE dataset_version_id = :v",
    ):
        with pytest.raises(DBAPIError, match="immutable"):
            execute(db, sql, v=version_id)
    assert execute(db, "UPDATE catalog.dataset_versions SET status = 'WITHDRAWN', updated_at = now() WHERE dataset_version_id = :v", v=version_id) == 1
    with pytest.raises(DBAPIError, match="immutable"):
        execute(db, "UPDATE catalog.dataset_versions SET status = 'PUBLISHED' WHERE dataset_version_id = :v", v=version_id)


def test_files_of_a_published_version_are_immutable(db: PgUrls) -> None:
    version_id = insert_version(db, insert_dataset(db), published=True, files=[("data/a.csv", 10, SHA_A)])
    with pytest.raises(DBAPIError, match="immutable"):
        execute(db, "UPDATE catalog.dataset_files SET size_bytes = 11 WHERE dataset_version_id = :v", v=version_id)
    with pytest.raises(DBAPIError, match="immutable"):
        execute(db, "DELETE FROM catalog.dataset_files WHERE dataset_version_id = :v", v=version_id)
    with pytest.raises(DBAPIError, match="immutable"):
        insert_file(db, version_id, path="data/b.csv")


def test_draft_files_can_change(db: PgUrls) -> None:
    version_id = insert_version(db, insert_dataset(db))
    insert_file(db, version_id, path="data/a.csv", status="PENDING")
    assert execute(db, "UPDATE catalog.dataset_files SET status = 'FAILED', failure_code = 'OBJECT_MISSING' WHERE dataset_version_id = :v", v=version_id) == 1
    assert execute(db, "DELETE FROM catalog.dataset_files WHERE dataset_version_id = :v", v=version_id) == 1


def test_sensitive_datasets_are_capped_at_30_days_by_the_database(db: PgUrls) -> None:
    with pytest.raises(DBAPIError, match="ck_datasets_sensitive_max_days"):
        insert_dataset(db, access_level="SENSITIVE", max_grant_days=60)


def test_published_version_needs_manifest_and_snapshot(db: PgUrls) -> None:
    dataset_id = insert_dataset(db)
    with pytest.raises(DBAPIError, match="ck_versions_published"):
        execute(
            db,
            "INSERT INTO catalog.dataset_versions (dataset_version_id, dataset_id, version_label, status, created_by)"
            " VALUES (gen_random_uuid(), :d, 'v9', 'PUBLISHED', :d)",
            d=dataset_id,
        )


def test_version_labels_are_unique_per_dataset(db: PgUrls) -> None:
    dataset_id = insert_dataset(db)
    insert_version(db, dataset_id, label="v1")
    with pytest.raises(DBAPIError, match="uq_versions_label"):
        insert_version(db, dataset_id, label="v1")
    insert_version(db, insert_dataset(db), label="v1")


@pytest.mark.parametrize("path", ["../x.csv", "/x.csv", "a//x.csv", "a/./x.csv"])
def test_unsafe_file_paths_are_rejected_by_the_database(db: PgUrls, path: str) -> None:
    version_id = insert_version(db, insert_dataset(db))
    with pytest.raises(DBAPIError, match="ck_files_path"):
        insert_file(db, version_id, path=path)
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `uv run pytest apps/api/modules/catalog/tests/test_migration.py -v`
Expected: FAIL — `catalog_db` cannot migrate (`ModuleSpec` has no `migrations_dir`, so `catalog.alembic_version` does not exist: `relation "catalog.alembic_version" does not exist`).

- [ ] **Step 3: Implement the migration, tables and module wiring**

`apps/api/modules/catalog/__init__.py`:

```python
"""M03 Data Catalog & Versioning. Spec: NAIS_PRD/modules/M03_data_catalog.md."""

from pathlib import Path

from api.platform.modules import ModuleSpec

MODULE = ModuleSpec(
    name="catalog",
    db_schema="catalog",
    migrations_dir=Path(__file__).parent / "migrations",
)
```

`apps/api/modules/catalog/migrations/catalog_0001_initial.py`:

```python
"""catalog initial schema (M03 §4)

Revision ID: catalog_0001
Revises:
"""

from typing import Any

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import ARRAY, JSONB, UUID

from api.platform.migration_helpers import create_processed_events

revision = "catalog_0001"
down_revision = None
branch_labels = None
depends_on = None

S = "catalog"
NOW = sa.text("now()")
PURPOSES = "ARRAY['ACADEMIC_RESEARCH','AI_TRAINING','COMMERCIAL_RESEARCH','EDUCATION','PUBLIC_INTEREST']::text[]"
FAILURES = "('OBJECT_MISSING','SIZE_MISMATCH','CHECKSUM_MISMATCH','TYPE_MISMATCH','ARCHIVE_UNSAFE','MALWARE_DETECTED','SESSION_EXPIRED')"


def _uuid(name: str, *args: Any, **kw: Any) -> sa.Column[Any]:
    return sa.Column(name, UUID(as_uuid=True), *args, **kw)


def _ts(name: str, *, nullable: bool = False, now: bool = False) -> sa.Column[Any]:
    return sa.Column(name, sa.DateTime(timezone=True), nullable=nullable, server_default=NOW if now else None)


VERSIONS_FUNCTION = """
CREATE FUNCTION catalog.versions_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'DRAFT' THEN
      RAISE EXCEPTION 'dataset version % is % and immutable', OLD.dataset_version_id, OLD.status
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status = 'PUBLISHED' THEN
    IF NEW.status = 'WITHDRAWN' AND
       (NEW.dataset_version_id, NEW.dataset_id, NEW.version_label, NEW.change_note, NEW.file_count,
        NEW.total_bytes, NEW.manifest_sha256, NEW.metadata_snapshot, NEW.published_at, NEW.published_by,
        NEW.created_by, NEW.created_at)
       IS NOT DISTINCT FROM
       (OLD.dataset_version_id, OLD.dataset_id, OLD.version_label, OLD.change_note, OLD.file_count,
        OLD.total_bytes, OLD.manifest_sha256, OLD.metadata_snapshot, OLD.published_at, OLD.published_by,
        OLD.created_by, OLD.created_at) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'dataset version % is PUBLISHED and immutable', OLD.dataset_version_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.status = 'WITHDRAWN' THEN
    RAISE EXCEPTION 'dataset version % is WITHDRAWN and immutable', OLD.dataset_version_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$
"""

VERSIONS_TRIGGER = """
CREATE TRIGGER trg_versions_immutable BEFORE UPDATE OR DELETE ON catalog.dataset_versions
FOR EACH ROW EXECUTE FUNCTION catalog.versions_immutable()
"""

FILES_FUNCTION = """
CREATE FUNCTION catalog.files_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  version_status text;
  target uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    target = NEW.dataset_version_id;
  ELSE
    target = OLD.dataset_version_id;
  END IF;
  SELECT status INTO version_status FROM catalog.dataset_versions WHERE dataset_version_id = target;
  IF version_status IS NOT NULL AND version_status <> 'DRAFT' THEN
    RAISE EXCEPTION 'files of dataset version % are immutable (%)', target, version_status
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$
"""

FILES_TRIGGER = """
CREATE TRIGGER trg_files_immutable BEFORE INSERT OR UPDATE OR DELETE ON catalog.dataset_files
FOR EACH ROW EXECUTE FUNCTION catalog.files_immutable()
"""


def upgrade() -> None:
    op.create_table(
        "datasets",
        _uuid("dataset_id", primary_key=True),
        _uuid("owner_organization_id", nullable=False),
        sa.Column("title", sa.Text, nullable=False),
        sa.Column("description", sa.Text, nullable=False, server_default=""),
        sa.Column("keywords", ARRAY(sa.Text), nullable=False, server_default=sa.text("'{}'::text[]")),
        sa.Column("domain", sa.Text),
        sa.Column("access_level", sa.Text, nullable=False),
        sa.Column("license", sa.Text, nullable=False),
        sa.Column("usage_policy", sa.Text),
        sa.Column("allowed_purposes", ARRAY(sa.Text), nullable=False),
        sa.Column("approval_required", sa.Boolean, nullable=False, server_default=sa.true()),
        sa.Column("max_grant_days", sa.Integer, nullable=False, server_default="180"),
        sa.Column("contact_email", sa.Text),
        sa.Column("provenance", sa.Text),
        sa.Column("status", sa.Text, nullable=False, server_default="ACTIVE"),
        _uuid("created_by", nullable=False),
        _ts("created_at", now=True),
        _ts("updated_at", now=True),
        sa.Column("row_version", sa.Integer, nullable=False, server_default="1"),
        sa.CheckConstraint("char_length(title) BETWEEN 3 AND 300", name="ck_datasets_title"),
        sa.CheckConstraint("char_length(description) <= 20000", name="ck_datasets_description"),
        sa.CheckConstraint("cardinality(keywords) <= 30", name="ck_datasets_keywords"),
        sa.CheckConstraint(
            "access_level IN ('PUBLIC','INTERNAL','CONTROLLED','SENSITIVE')", name="ck_datasets_access_level"
        ),
        sa.CheckConstraint("char_length(license) >= 1", name="ck_datasets_license"),
        sa.CheckConstraint(
            "usage_policy IS NULL OR char_length(usage_policy) <= 10000", name="ck_datasets_usage_policy"
        ),
        sa.CheckConstraint(
            f"cardinality(allowed_purposes) >= 1 AND allowed_purposes <@ {PURPOSES}", name="ck_datasets_purposes"
        ),
        sa.CheckConstraint(
            "approval_required OR access_level NOT IN ('CONTROLLED','SENSITIVE')", name="ck_datasets_approval"
        ),
        sa.CheckConstraint("max_grant_days BETWEEN 1 AND 365", name="ck_datasets_max_grant_days"),
        sa.CheckConstraint("provenance IS NULL OR char_length(provenance) <= 10000", name="ck_datasets_provenance"),
        sa.CheckConstraint("status IN ('ACTIVE','WITHDRAWN')", name="ck_datasets_status"),
        sa.CheckConstraint(
            "access_level <> 'SENSITIVE' OR max_grant_days <= 30", name="ck_datasets_sensitive_max_days"
        ),
        schema=S,
    )
    op.create_index("ix_datasets_owner_org", "datasets", ["owner_organization_id"], schema=S)
    op.create_index("ix_datasets_status", "datasets", ["status"], schema=S)

    op.create_table(
        "dataset_versions",
        _uuid("dataset_version_id", primary_key=True),
        _uuid("dataset_id", sa.ForeignKey("catalog.datasets.dataset_id"), nullable=False),
        sa.Column("version_label", sa.Text, nullable=False),
        sa.Column("status", sa.Text, nullable=False, server_default="DRAFT"),
        sa.Column("change_note", sa.Text),
        sa.Column("file_count", sa.Integer, nullable=False, server_default="0"),
        sa.Column("total_bytes", sa.BigInteger, nullable=False, server_default="0"),
        sa.Column("manifest_sha256", sa.CHAR(64)),
        sa.Column("metadata_snapshot", JSONB),
        _ts("published_at", nullable=True),
        _uuid("published_by"),
        _uuid("created_by", nullable=False),
        _ts("created_at", now=True),
        _ts("updated_at", now=True),
        sa.UniqueConstraint("dataset_id", "version_label", name="uq_versions_label"),
        sa.CheckConstraint(r"version_label ~ '^[A-Za-z0-9._-]{1,32}$'", name="ck_versions_label"),
        sa.CheckConstraint("status IN ('DRAFT','PUBLISHED','WITHDRAWN')", name="ck_versions_status"),
        sa.CheckConstraint("change_note IS NULL OR char_length(change_note) <= 2000", name="ck_versions_note"),
        sa.CheckConstraint("file_count >= 0 AND total_bytes >= 0", name="ck_versions_counts"),
        sa.CheckConstraint(
            "status = 'DRAFT' OR (manifest_sha256 IS NOT NULL AND published_at IS NOT NULL"
            " AND metadata_snapshot IS NOT NULL)",
            name="ck_versions_published",
        ),
        schema=S,
    )
    op.create_index(
        "ix_versions_dataset", "dataset_versions", ["dataset_id", sa.text("created_at DESC")], schema=S
    )

    op.create_table(
        "upload_sessions",
        _uuid("upload_session_id", primary_key=True),
        _uuid("dataset_version_id", sa.ForeignKey("catalog.dataset_versions.dataset_version_id"), nullable=False),
        sa.Column("status", sa.Text, nullable=False, server_default="OPEN"),
        _uuid("created_by", nullable=False),
        _ts("expires_at"),
        _ts("completed_at", nullable=True),
        _ts("created_at", now=True),
        sa.CheckConstraint("status IN ('OPEN','COMPLETED','EXPIRED')", name="ck_sessions_status"),
        schema=S,
    )
    op.create_index(
        "ix_sessions_open",
        "upload_sessions",
        ["expires_at"],
        schema=S,
        postgresql_where=sa.text("status = 'OPEN'"),
    )

    op.create_table(
        "dataset_files",
        _uuid("file_id", primary_key=True),
        _uuid("dataset_version_id", sa.ForeignKey("catalog.dataset_versions.dataset_version_id"), nullable=False),
        _uuid("upload_session_id", sa.ForeignKey("catalog.upload_sessions.upload_session_id"), nullable=False),
        sa.Column("path", sa.Text, nullable=False),
        sa.Column("size_bytes", sa.BigInteger, nullable=False),
        sa.Column("sha256", sa.CHAR(64), nullable=False),
        sa.Column("media_type", sa.Text, nullable=False),
        sa.Column("storage_bucket", sa.Text, nullable=False),
        sa.Column("storage_key", sa.Text, nullable=False),
        sa.Column("multipart_upload_id", sa.Text),
        sa.Column("part_size_bytes", sa.BigInteger),
        sa.Column("status", sa.Text, nullable=False, server_default="PENDING"),
        sa.Column("failure_code", sa.Text),
        sa.Column("scan_status", sa.Text, nullable=False, server_default="SKIPPED"),
        _ts("verified_at", nullable=True),
        _ts("created_at", now=True),
        _ts("updated_at", now=True),
        sa.UniqueConstraint("dataset_version_id", "path", name="uq_files_path"),
        sa.CheckConstraint(
            r"char_length(path) BETWEEN 1 AND 512 AND path ~ '^[A-Za-z0-9._/-]+$'"
            r" AND path !~ '(^/|//|/$|(^|/)\.\.?(/|$))'",
            name="ck_files_path",
        ),
        sa.CheckConstraint("size_bytes BETWEEN 1 AND 53687091200", name="ck_files_size"),
        sa.CheckConstraint("sha256 ~ '^[a-f0-9]{64}$'", name="ck_files_sha256"),
        sa.CheckConstraint("status IN ('PENDING','UPLOADED','VERIFIED','FAILED')", name="ck_files_status"),
        sa.CheckConstraint(f"failure_code IS NULL OR failure_code IN {FAILURES}", name="ck_files_failure_code"),
        sa.CheckConstraint("scan_status IN ('CLEAN','INFECTED','SKIPPED')", name="ck_files_scan_status"),
        schema=S,
    )
    op.create_index("ix_files_session", "dataset_files", ["upload_session_id"], schema=S)
    op.create_index(
        "ix_files_status",
        "dataset_files",
        ["status"],
        schema=S,
        postgresql_where=sa.text("status IN ('PENDING','UPLOADED')"),
    )

    op.create_table(
        "readiness_summaries",
        _uuid("dataset_version_id", primary_key=True),
        sa.Column("profile_id", sa.Text, primary_key=True),
        _uuid("dataset_id", nullable=False),
        _uuid("validation_id", nullable=False),
        sa.Column("run_status", sa.Text, nullable=False),
        sa.Column("overall_status", sa.Text),
        _ts("completed_at"),
        _uuid("source_event_id", nullable=False),
        sa.CheckConstraint("run_status IN ('COMPLETED','FAILED')", name="ck_readiness_run_status"),
        sa.CheckConstraint(
            "overall_status IS NULL OR overall_status IN ('PASS','WARNING','FAIL')", name="ck_readiness_overall"
        ),
        schema=S,
    )

    op.create_table(
        "index_queue",
        _uuid("dataset_id", primary_key=True),
        _ts("enqueued_at", now=True),
        sa.Column("attempts", sa.Integer, nullable=False, server_default="0"),
        _ts("next_attempt_at", now=True),
        schema=S,
    )
    op.create_index("ix_index_queue_due", "index_queue", ["next_attempt_at"], schema=S)

    create_processed_events(S, per_handler=True)

    for statement in (VERSIONS_FUNCTION, VERSIONS_TRIGGER, FILES_FUNCTION, FILES_TRIGGER):
        op.execute(statement)


def downgrade() -> None:
    for table in (
        "processed_events",
        "index_queue",
        "readiness_summaries",
        "dataset_files",
        "upload_sessions",
        "dataset_versions",
        "datasets",
    ):
        op.drop_table(table, schema=S)
    op.execute("DROP FUNCTION IF EXISTS catalog.files_immutable()")
    op.execute("DROP FUNCTION IF EXISTS catalog.versions_immutable()")
```

`apps/api/modules/catalog/tables.py`:

```python
"""SQLAlchemy Core view of the catalog schema (DDL lives in migrations/)."""

from typing import Any

from sqlalchemy import BigInteger, Boolean, Column, DateTime, Integer, MetaData, Table, Text
from sqlalchemy.dialects.postgresql import ARRAY, JSONB, UUID

metadata = MetaData(schema="catalog")


def _uuid(name: str, primary_key: bool = False) -> Column[Any]:
    return Column(name, UUID(as_uuid=True), primary_key=primary_key)


def _ts(name: str) -> Column[Any]:
    return Column(name, DateTime(timezone=True))


datasets = Table(
    "datasets",
    metadata,
    _uuid("dataset_id", primary_key=True),
    _uuid("owner_organization_id"),
    Column("title", Text),
    Column("description", Text),
    Column("keywords", ARRAY(Text)),
    Column("domain", Text),
    Column("access_level", Text),
    Column("license", Text),
    Column("usage_policy", Text),
    Column("allowed_purposes", ARRAY(Text)),
    Column("approval_required", Boolean),
    Column("max_grant_days", Integer),
    Column("contact_email", Text),
    Column("provenance", Text),
    Column("status", Text),
    _uuid("created_by"),
    _ts("created_at"),
    _ts("updated_at"),
    Column("row_version", Integer),
)

dataset_versions = Table(
    "dataset_versions",
    metadata,
    _uuid("dataset_version_id", primary_key=True),
    _uuid("dataset_id"),
    Column("version_label", Text),
    Column("status", Text),
    Column("change_note", Text),
    Column("file_count", Integer),
    Column("total_bytes", BigInteger),
    Column("manifest_sha256", Text),
    Column("metadata_snapshot", JSONB),
    _ts("published_at"),
    _uuid("published_by"),
    _uuid("created_by"),
    _ts("created_at"),
    _ts("updated_at"),
)

upload_sessions = Table(
    "upload_sessions",
    metadata,
    _uuid("upload_session_id", primary_key=True),
    _uuid("dataset_version_id"),
    Column("status", Text),
    _uuid("created_by"),
    _ts("expires_at"),
    _ts("completed_at"),
    _ts("created_at"),
)

dataset_files = Table(
    "dataset_files",
    metadata,
    _uuid("file_id", primary_key=True),
    _uuid("dataset_version_id"),
    _uuid("upload_session_id"),
    Column("path", Text),
    Column("size_bytes", BigInteger),
    Column("sha256", Text),
    Column("media_type", Text),
    Column("storage_bucket", Text),
    Column("storage_key", Text),
    Column("multipart_upload_id", Text),
    Column("part_size_bytes", BigInteger),
    Column("status", Text),
    Column("failure_code", Text),
    Column("scan_status", Text),
    _ts("verified_at"),
    _ts("created_at"),
    _ts("updated_at"),
)

readiness_summaries = Table(
    "readiness_summaries",
    metadata,
    _uuid("dataset_version_id", primary_key=True),
    Column("profile_id", Text, primary_key=True),
    _uuid("dataset_id"),
    _uuid("validation_id"),
    Column("run_status", Text),
    Column("overall_status", Text),
    _ts("completed_at"),
    _uuid("source_event_id"),
)

index_queue = Table(
    "index_queue",
    metadata,
    _uuid("dataset_id", primary_key=True),
    _ts("enqueued_at"),
    Column("attempts", Integer),
    _ts("next_attempt_at"),
)
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `uv run pytest apps/api/modules/catalog/tests/test_migration.py apps/api/modules/catalog/tests/test_domain.py -v`
Expected: all PASS. Also check the offline SQL renders: `PYTHONPATH=apps uv run python -c "from api.platform.migrate import upgrade_all; from api.modules.catalog import MODULE; upgrade_all('postgresql+psycopg://x@localhost/nais', [MODULE], sql=True)" | grep -c 'CREATE TRIGGER'` → `2`.

- [ ] **Step 5: Commit**

```bash
uv run ruff check --fix apps/api/modules/catalog && uv run ruff format apps/api/modules/catalog
git add apps/api/modules/catalog
git commit -m "feat(catalog): catalog schema with immutability triggers and DB test fixtures

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 3: Object storage layer (SeaweedFS S3 + in-memory fake)

**Files:**
- Create: `apps/api/modules/catalog/objects.py`
- Create: `apps/api/modules/catalog/testing.py`
- Create: `apps/api/modules/catalog/tests/fixtures_storage.py`
- Modify: `apps/api/modules/catalog/tests/conftest.py` (import storage fixtures)
- Test: `apps/api/modules/catalog/tests/test_objects.py`, `apps/api/modules/catalog/tests/test_s3_storage.py`

**Interfaces:**
- Consumes: `api.platform.storage.StorageConfig`, `StorageNotConfigured`, `load_storage_config`, `internal_client`, `public_client`, `ensure_buckets`.
- Produces:
  - `objects.StorageUnavailable(RuntimeError)`, `objects.ObjectMissing(LookupError)`, `objects.MultipartFailed(RuntimeError)`.
  - `objects.ObjectStore` Protocol: `bucket: str`; `head(key) -> int | None`; `open_stream(key, byte_range: tuple[int, int] | None = None) -> BinaryIO` (inclusive range; `ObjectMissing` if absent); `read_range(key, start, end) -> bytes`; `put(key, data: bytes, content_type) -> None`; `delete(key) -> None` (idempotent); `create_multipart(key, content_type) -> str`; `complete_multipart(key, upload_id, parts: Sequence[tuple[int, str]]) -> None` (`MultipartFailed` on 4xx); `abort_multipart(key, upload_id) -> None` (idempotent); `presign_put(key, content_type, checksum_b64, ttl) -> tuple[str, dict[str, str]]`; `presign_part(key, upload_id, part_number, ttl) -> str`; `presign_get(key, filename, ttl) -> str`.
  - `objects.S3ObjectStore(cfg: StorageConfig, public_base_url: str)`.
  - `objects.StorageRegistry(environ: Mapping[str, str], public_base_url: str, org_codes: Sequence[str], factory: Callable[[StorageConfig, str], ObjectStore] = S3ObjectStore)` with `is_configured(org_code) -> bool`, `config(org_code) -> StorageConfig`, `for_org(org_code) -> ObjectStore`, `for_bucket(bucket) -> ObjectStore` (both raise `StorageNotConfigured`).
  - `testing.MemoryObjectStore(bucket, public_base_url=...)` with test helper `upload_part(key, upload_id, part_number, data) -> str` (quoted MD5 ETag) and inspection attributes `objects: dict[str, bytes]`, `uploads`, `aborted: list[str]`, `presigned_gets: list[tuple[str, str, int]]`; `testing.memory_registry(codes=("nais", "inst-a", "inst-b")) -> StorageRegistry`; `testing.memory_store(registry, org_code) -> MemoryObjectStore`; `testing.MEMORY_BUCKETS`.
  - Fixtures: `seaweed_registry` (session; skips if the dev stack is down), `s3_prefixes` (list; every prefix appended is deleted from both buckets at teardown), constants `SEAWEED_ENV`, `GATEWAY_URL` in `fixtures_storage`.

- [ ] **Step 1: Write the failing tests**

Append to `apps/api/modules/catalog/tests/conftest.py` (last line):

```python
from api.modules.catalog.tests.fixtures_storage import s3_prefixes, seaweed_registry  # noqa: E402, F401
```

`apps/api/modules/catalog/tests/fixtures_storage.py`:

```python
"""Real SeaweedFS of the running dev stack (host ports 21053/21054, gateway 21051), D-034/D-037."""

import os
from collections.abc import Iterator

import httpx
import pytest

from api.modules.catalog.objects import StorageRegistry
from api.platform.storage import ensure_buckets, internal_client, load_storage_config

GATEWAY_URL = os.environ.get("NAIS_TEST_GATEWAY_URL", "http://localhost:21051")
SEAWEED_ENV = {
    "STORAGE_INST_A_ENDPOINT": os.environ.get("NAIS_TEST_STORAGE_A", "http://localhost:21053"),
    "STORAGE_INST_A_BUCKET": "nais-inst-a",
    "STORAGE_INST_A_ACCESS_KEY": "nais",
    "STORAGE_INST_A_SECRET_KEY": "nais",
    "STORAGE_INST_B_ENDPOINT": os.environ.get("NAIS_TEST_STORAGE_B", "http://localhost:21054"),
    "STORAGE_INST_B_BUCKET": "nais-inst-b",
    "STORAGE_INST_B_ACCESS_KEY": "nais",
    "STORAGE_INST_B_SECRET_KEY": "nais",
}
CODES = ("inst-a", "inst-b")


@pytest.fixture(scope="session")
def seaweed_registry() -> StorageRegistry:
    try:
        httpx.get(f"{GATEWAY_URL}/healthz", timeout=2).raise_for_status()
        ensure_buckets(list(CODES), SEAWEED_ENV)
    except Exception as exc:  # stack not running on this host
        pytest.skip(f"dev stack gateway/storage unavailable: {exc}")
    return StorageRegistry(SEAWEED_ENV, GATEWAY_URL, CODES)


@pytest.fixture
def s3_prefixes(seaweed_registry: StorageRegistry) -> Iterator[list[str]]:
    prefixes: list[str] = []
    yield prefixes
    for code in CODES:
        cfg = load_storage_config(code, SEAWEED_ENV)
        client = internal_client(cfg)
        for prefix in prefixes:
            listed = client.list_objects_v2(Bucket=cfg.bucket, Prefix=prefix)
            for item in listed.get("Contents", []):
                client.delete_object(Bucket=cfg.bucket, Key=item["Key"])
```

`apps/api/modules/catalog/tests/test_objects.py`:

```python
import pytest

from api.modules.catalog.objects import MultipartFailed, ObjectMissing, S3ObjectStore, StorageUnavailable
from api.modules.catalog.testing import MemoryObjectStore, memory_registry, memory_store
from api.platform.storage import StorageConfig, StorageNotConfigured


def test_registry_maps_org_codes_and_buckets() -> None:
    registry = memory_registry(("inst-a", "inst-b"))
    assert registry.is_configured("inst-b") and not registry.is_configured("nais")
    assert registry.for_org("inst-b").bucket == "nais-inst-b"
    assert registry.for_bucket("nais-inst-a") is registry.for_org("inst-a")
    with pytest.raises(StorageNotConfigured):
        registry.for_org("nais")
    with pytest.raises(StorageNotConfigured):
        registry.for_bucket("nais-platform")
    assert not registry.is_configured("BAD CODE")


def test_memory_store_objects_and_ranges() -> None:
    store = MemoryObjectStore("nais-inst-b")
    store.put("k", b"0123456789", "text/plain")
    assert store.head("k") == 10 and store.head("missing") is None
    assert store.read_range("k", 2, 4) == b"234"
    assert store.open_stream("k", (8, 9)).read() == b"89"
    store.delete("k")
    store.delete("k")
    with pytest.raises(ObjectMissing):
        store.open_stream("k")


def test_memory_multipart_checks_etags_and_records_aborts() -> None:
    store = memory_store(memory_registry(), "inst-b")
    upload_id = store.create_multipart("big.csv", "text/csv")
    etag1 = store.upload_part("big.csv", upload_id, 1, b"ab")
    etag2 = store.upload_part("big.csv", upload_id, 2, b"cd")
    with pytest.raises(MultipartFailed):
        store.complete_multipart("big.csv", upload_id, [(1, etag1), (2, '"bogus"')])
    store.complete_multipart("big.csv", upload_id, [(2, etag2), (1, etag1)])
    assert store.objects["big.csv"] == b"abcd"
    second = store.create_multipart("other.csv", "text/csv")
    store.abort_multipart("other.csv", second)
    store.abort_multipart("other.csv", second)
    assert store.aborted == [second]


def test_memory_presigned_urls_point_at_the_gateway() -> None:
    store = MemoryObjectStore("nais-inst-b")
    url, headers = store.presign_put("datasets/d/v/a.csv", "text/csv", "c2hh", 3600)
    assert url.startswith("http://localhost:21051/nais-inst-b/datasets/d/v/a.csv?")
    assert headers == {"Content-Type": "text/csv", "x-amz-checksum-sha256": "c2hh"}
    assert "partNumber=3" in store.presign_part("k", "u", 3, 60)


def test_s3_store_translates_connection_failures() -> None:
    store = S3ObjectStore(StorageConfig("inst-b", "http://127.0.0.1:9", "nais-inst-b", "k", "s"), "http://localhost:21051")
    with pytest.raises(StorageUnavailable):
        store.head("anything")
```

`apps/api/modules/catalog/tests/test_s3_storage.py`:

```python
"""Against the dev stack's SeaweedFS through the 21051 gateway (skips when the stack is down)."""

import base64
import hashlib
import uuid

import httpx
import pytest

from api.modules.catalog.objects import MultipartFailed, StorageRegistry

CSV = b"sample_id,value\nS0001,1.0\n"


def _b64(data: bytes) -> str:
    return base64.b64encode(hashlib.sha256(data).digest()).decode()


@pytest.fixture
def prefix(s3_prefixes: list[str]) -> str:
    value = f"datasets/test-{uuid.uuid4()}/"
    s3_prefixes.append(value)
    return value


def test_presigned_put_goes_through_the_gateway_and_rejects_tampering(
    seaweed_registry: StorageRegistry, prefix: str
) -> None:
    store = seaweed_registry.for_org("inst-b")
    key = f"{prefix}data/a.csv"
    url, headers = store.presign_put(key, "text/csv", _b64(CSV), 300)
    assert url.startswith(f"http://localhost:21051/nais-inst-b/{key}?")
    assert httpx.put(url, content=b"tampered!", headers=headers, timeout=30).status_code == 400
    assert store.head(key) is None
    assert httpx.put(url, content=CSV, headers=headers, timeout=30).status_code == 200
    assert store.head(key) == len(CSV)
    assert store.read_range(key, 0, 8) == CSV[:9]


def test_presigned_multipart_upload_and_complete(seaweed_registry: StorageRegistry, prefix: str) -> None:
    store = seaweed_registry.for_org("inst-a")
    key = f"{prefix}big.csv"
    part1, part2 = b"a" * (5 * 1024 * 1024), b"b" * 1024
    upload_id = store.create_multipart(key, "text/csv")
    etags = []
    for number, data in ((1, part1), (2, part2)):
        response = httpx.put(store.presign_part(key, upload_id, number, 300), content=data, timeout=60)
        assert response.status_code == 200, response.text
        etags.append((number, response.headers["etag"]))
    with pytest.raises(MultipartFailed):
        store.complete_multipart(key, upload_id, [(1, '"0000"'), (2, etags[1][1])])
    store.complete_multipart(key, upload_id, etags)
    assert store.head(key) == len(part1) + len(part2)
    stream = store.open_stream(key, (len(part1) - 1, len(part1)))
    assert stream.read() == b"ab"


def test_presigned_get_downloads_as_attachment(seaweed_registry: StorageRegistry, prefix: str) -> None:
    store = seaweed_registry.for_org("inst-b")
    key = f"{prefix}data/a.csv"
    store.put(key, CSV, "text/csv")
    response = httpx.get(store.presign_get(key, "a.csv", 60), timeout=30)
    assert response.status_code == 200 and response.content == CSV
    assert response.headers["content-disposition"] == 'attachment; filename="a.csv"'


def test_missing_objects_and_idempotent_cleanup(seaweed_registry: StorageRegistry, prefix: str) -> None:
    store = seaweed_registry.for_org("inst-b")
    assert store.head(f"{prefix}nothing.csv") is None
    store.delete(f"{prefix}nothing.csv")
    upload_id = store.create_multipart(f"{prefix}x.csv", "text/csv")
    store.abort_multipart(f"{prefix}x.csv", upload_id)
    store.abort_multipart(f"{prefix}x.csv", upload_id)
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `uv run pytest apps/api/modules/catalog/tests/test_objects.py apps/api/modules/catalog/tests/test_s3_storage.py -v`
Expected: collection error `No module named 'api.modules.catalog.objects'`.

- [ ] **Step 3: Implement**

`apps/api/modules/catalog/objects.py`:

```python
"""Object storage for the catalog (M03 §4.8, §6.6). Built on api.platform.storage (D-024).

Internal client = HEAD, hashing, multipart complete (compose network). Public client = presigning only, so browsers
reach the bucket through the :21051 gateway (path-style, SigV4, us-east-1).
"""

import threading
from collections.abc import Callable, Iterator, Mapping, Sequence
from contextlib import contextmanager
from typing import Any, BinaryIO, Protocol, cast

from botocore.exceptions import BotoCoreError, ClientError

from api.platform.storage import (
    StorageConfig,
    StorageNotConfigured,
    internal_client,
    load_storage_config,
    public_client,
)

_MISSING = frozenset({"404", "NoSuchKey", "NotFound", "NoSuchUpload"})


class StorageUnavailable(RuntimeError):
    """Storage unreachable, 5xx, or credentials rejected. Maps to 503 DEPENDENCY_UNAVAILABLE."""


class ObjectMissing(LookupError):
    pass


class MultipartFailed(RuntimeError):
    """CompleteMultipartUpload rejected (unknown upload id, wrong ETag, missing part)."""


class ObjectStore(Protocol):
    bucket: str

    def head(self, key: str) -> int | None: ...
    def open_stream(self, key: str, byte_range: tuple[int, int] | None = None) -> BinaryIO: ...
    def read_range(self, key: str, start: int, end: int) -> bytes: ...
    def put(self, key: str, data: bytes, content_type: str) -> None: ...
    def delete(self, key: str) -> None: ...
    def create_multipart(self, key: str, content_type: str) -> str: ...
    def complete_multipart(self, key: str, upload_id: str, parts: Sequence[tuple[int, str]]) -> None: ...
    def abort_multipart(self, key: str, upload_id: str) -> None: ...
    def presign_put(self, key: str, content_type: str, checksum_b64: str, ttl: int) -> tuple[str, dict[str, str]]: ...
    def presign_part(self, key: str, upload_id: str, part_number: int, ttl: int) -> str: ...
    def presign_get(self, key: str, filename: str, ttl: int) -> str: ...


def _code(exc: ClientError) -> str:
    return str(exc.response.get("Error", {}).get("Code", ""))


def _status(exc: ClientError) -> int:
    return int(exc.response.get("ResponseMetadata", {}).get("HTTPStatusCode", 0) or 0)


@contextmanager
def _translate() -> Iterator[None]:
    """Connection problems, 5xx and auth failures become StorageUnavailable; other ClientErrors propagate."""
    try:
        yield
    except BotoCoreError as exc:
        raise StorageUnavailable(str(exc)) from exc
    except ClientError as exc:
        if _status(exc) >= 500 or _status(exc) in (401, 403):
            raise StorageUnavailable(str(exc)) from exc
        raise


class S3ObjectStore:
    def __init__(self, cfg: StorageConfig, public_base_url: str) -> None:
        self.bucket = cfg.bucket
        self._internal: Any = internal_client(cfg)
        self._public: Any = public_client(cfg, public_base_url)

    def head(self, key: str) -> int | None:
        try:
            with _translate():
                return int(self._internal.head_object(Bucket=self.bucket, Key=key)["ContentLength"])
        except ClientError as exc:
            if _code(exc) in _MISSING:
                return None
            raise

    def open_stream(self, key: str, byte_range: tuple[int, int] | None = None) -> BinaryIO:
        params: dict[str, Any] = {"Bucket": self.bucket, "Key": key}
        if byte_range is not None:
            params["Range"] = f"bytes={byte_range[0]}-{byte_range[1]}"
        try:
            with _translate():
                return cast(BinaryIO, self._internal.get_object(**params)["Body"])
        except ClientError as exc:
            if _code(exc) in _MISSING:
                raise ObjectMissing(key) from exc
            raise

    def read_range(self, key: str, start: int, end: int) -> bytes:
        body = self.open_stream(key, (start, end))
        try:
            with _translate():
                return body.read()
        finally:
            body.close()

    def put(self, key: str, data: bytes, content_type: str) -> None:
        with _translate():
            self._internal.put_object(Bucket=self.bucket, Key=key, Body=data, ContentType=content_type)

    def delete(self, key: str) -> None:
        with _translate():
            self._internal.delete_object(Bucket=self.bucket, Key=key)

    def create_multipart(self, key: str, content_type: str) -> str:
        with _translate():
            response = self._internal.create_multipart_upload(Bucket=self.bucket, Key=key, ContentType=content_type)
        return str(response["UploadId"])

    def complete_multipart(self, key: str, upload_id: str, parts: Sequence[tuple[int, str]]) -> None:
        try:
            with _translate():
                self._internal.complete_multipart_upload(
                    Bucket=self.bucket,
                    Key=key,
                    UploadId=upload_id,
                    MultipartUpload={"Parts": [{"PartNumber": n, "ETag": etag} for n, etag in sorted(parts)]},
                )
        except ClientError as exc:
            raise MultipartFailed(f"{_code(exc)}: {exc}") from exc

    def abort_multipart(self, key: str, upload_id: str) -> None:
        try:
            with _translate():
                self._internal.abort_multipart_upload(Bucket=self.bucket, Key=key, UploadId=upload_id)
        except ClientError as exc:
            if _code(exc) not in _MISSING:
                raise

    def presign_put(self, key: str, content_type: str, checksum_b64: str, ttl: int) -> tuple[str, dict[str, str]]:
        url = self._public.generate_presigned_url(
            "put_object",
            Params={"Bucket": self.bucket, "Key": key, "ContentType": content_type, "ChecksumSHA256": checksum_b64},
            ExpiresIn=ttl,
        )
        return str(url), {"Content-Type": content_type, "x-amz-checksum-sha256": checksum_b64}

    def presign_part(self, key: str, upload_id: str, part_number: int, ttl: int) -> str:
        return str(
            self._public.generate_presigned_url(
                "upload_part",
                Params={"Bucket": self.bucket, "Key": key, "UploadId": upload_id, "PartNumber": part_number},
                ExpiresIn=ttl,
            )
        )

    def presign_get(self, key: str, filename: str, ttl: int) -> str:
        return str(
            self._public.generate_presigned_url(
                "get_object",
                Params={
                    "Bucket": self.bucket,
                    "Key": key,
                    "ResponseContentDisposition": f'attachment; filename="{filename}"',
                },
                ExpiresIn=ttl,
            )
        )


StoreFactory = Callable[[StorageConfig, str], ObjectStore]


class StorageRegistry:
    """Organization code -> ObjectStore, from STORAGE_<CODE>_* variables (D-024)."""

    def __init__(
        self,
        environ: Mapping[str, str],
        public_base_url: str,
        org_codes: Sequence[str],
        factory: StoreFactory = S3ObjectStore,
    ) -> None:
        self._environ = dict(environ)
        self._public_base_url = public_base_url
        self._org_codes = tuple(org_codes)
        self._factory = factory
        self._stores: dict[str, ObjectStore] = {}
        self._lock = threading.Lock()

    def config(self, org_code: str) -> StorageConfig:
        try:
            return load_storage_config(org_code, self._environ)
        except ValueError as exc:
            raise StorageNotConfigured(str(exc)) from exc

    def is_configured(self, org_code: str) -> bool:
        try:
            self.config(org_code)
        except StorageNotConfigured:
            return False
        return True

    def for_org(self, org_code: str) -> ObjectStore:
        with self._lock:
            store = self._stores.get(org_code)
            if store is None:
                store = self._factory(self.config(org_code), self._public_base_url)
                self._stores[org_code] = store
            return store

    def for_bucket(self, bucket: str) -> ObjectStore:
        for code in self._org_codes:
            if self.is_configured(code) and self.config(code).bucket == bucket:
                return self.for_org(code)
        raise StorageNotConfigured(f"no storage configuration for bucket {bucket!r}")
```

`apps/api/modules/catalog/testing.py`:

```python
"""Test doubles for the catalog (used by tests and by other modules' tests; never wired at runtime)."""

import hashlib
import io
import uuid
from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import BinaryIO

from api.modules.catalog.objects import MultipartFailed, ObjectMissing, StorageRegistry

MEMORY_PUBLIC_BASE_URL = "http://localhost:21051"
MEMORY_BUCKETS = {"nais": "nais-platform", "inst-a": "nais-inst-a", "inst-b": "nais-inst-b"}


def _etag(data: bytes) -> str:
    return f'"{hashlib.md5(data, usedforsecurity=False).hexdigest()}"'


@dataclass
class _Upload:
    key: str
    content_type: str
    parts: dict[int, bytes] = field(default_factory=dict)


class MemoryObjectStore:
    def __init__(self, bucket: str, public_base_url: str = MEMORY_PUBLIC_BASE_URL) -> None:
        self.bucket = bucket
        self._base = public_base_url.rstrip("/")
        self.objects: dict[str, bytes] = {}
        self.content_types: dict[str, str] = {}
        self.uploads: dict[str, _Upload] = {}
        self.aborted: list[str] = []
        self.presigned_gets: list[tuple[str, str, int]] = []

    def _get(self, key: str) -> bytes:
        try:
            return self.objects[key]
        except KeyError:
            raise ObjectMissing(key) from None

    def head(self, key: str) -> int | None:
        data = self.objects.get(key)
        return None if data is None else len(data)

    def open_stream(self, key: str, byte_range: tuple[int, int] | None = None) -> BinaryIO:
        data = self._get(key)
        if byte_range is not None:
            data = data[byte_range[0] : byte_range[1] + 1]
        return io.BytesIO(data)

    def read_range(self, key: str, start: int, end: int) -> bytes:
        return self._get(key)[start : end + 1]

    def put(self, key: str, data: bytes, content_type: str) -> None:
        self.objects[key] = bytes(data)
        self.content_types[key] = content_type

    def delete(self, key: str) -> None:
        self.objects.pop(key, None)

    def create_multipart(self, key: str, content_type: str) -> str:
        upload_id = uuid.uuid4().hex
        self.uploads[upload_id] = _Upload(key, content_type)
        return upload_id

    def upload_part(self, key: str, upload_id: str, part_number: int, data: bytes) -> str:
        """What a client does with a presigned UploadPart URL. Returns the part ETag."""
        upload = self.uploads.get(upload_id)
        if upload is None or upload.key != key:
            raise MultipartFailed("NoSuchUpload")
        upload.parts[part_number] = bytes(data)
        return _etag(data)

    def complete_multipart(self, key: str, upload_id: str, parts: Sequence[tuple[int, str]]) -> None:
        upload = self.uploads.get(upload_id)
        if upload is None or upload.key != key:
            raise MultipartFailed("NoSuchUpload")
        chunks = []
        for number, etag in sorted(parts):
            data = upload.parts.get(number)
            if data is None or etag.strip('"') != _etag(data).strip('"'):
                raise MultipartFailed(f"InvalidPart {number}")
            chunks.append(data)
        self.put(key, b"".join(chunks), upload.content_type)
        del self.uploads[upload_id]

    def abort_multipart(self, key: str, upload_id: str) -> None:
        if self.uploads.pop(upload_id, None) is not None:
            self.aborted.append(upload_id)

    def presign_put(self, key: str, content_type: str, checksum_b64: str, ttl: int) -> tuple[str, dict[str, str]]:
        url = f"{self._base}/{self.bucket}/{key}?X-Amz-Expires={ttl}&X-Amz-Signature=memory"
        return url, {"Content-Type": content_type, "x-amz-checksum-sha256": checksum_b64}

    def presign_part(self, key: str, upload_id: str, part_number: int, ttl: int) -> str:
        return (
            f"{self._base}/{self.bucket}/{key}?partNumber={part_number}&uploadId={upload_id}"
            f"&X-Amz-Expires={ttl}&X-Amz-Signature=memory"
        )

    def presign_get(self, key: str, filename: str, ttl: int) -> str:
        self.presigned_gets.append((key, filename, ttl))
        return (
            f"{self._base}/{self.bucket}/{key}?response-content-disposition=attachment"
            f"&X-Amz-Expires={ttl}&X-Amz-Signature=memory"
        )


def memory_env(codes: Sequence[str]) -> dict[str, str]:
    env: dict[str, str] = {}
    for code in codes:
        prefix = "STORAGE_" + code.upper().replace("-", "_")
        env[f"{prefix}_ENDPOINT"] = f"memory://{code}"
        env[f"{prefix}_BUCKET"] = MEMORY_BUCKETS[code]
        env[f"{prefix}_ACCESS_KEY"] = "nais"
        env[f"{prefix}_SECRET_KEY"] = "nais"
    return env


def memory_registry(codes: Sequence[str] = ("nais", "inst-a", "inst-b")) -> StorageRegistry:
    return StorageRegistry(
        memory_env(codes),
        MEMORY_PUBLIC_BASE_URL,
        codes,
        factory=lambda cfg, base: MemoryObjectStore(cfg.bucket, base),
    )


def memory_store(registry: StorageRegistry, org_code: str) -> MemoryObjectStore:
    store = registry.for_org(org_code)
    assert isinstance(store, MemoryObjectStore)
    return store
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `uv run pytest apps/api/modules/catalog/tests/test_objects.py apps/api/modules/catalog/tests/test_s3_storage.py -v`
Expected: all PASS (the `test_s3_storage.py` tests SKIP only if the dev stack is down; on the dev server they must PASS).

- [ ] **Step 5: Commit**

```bash
uv run ruff check --fix apps/api/modules/catalog && uv run ruff format apps/api/modules/catalog
git add apps/api/modules/catalog
git commit -m "feat(catalog): object storage layer with presign, multipart and in-memory fake

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 4: OpenSearch index definition, client and `infra/opensearch`

**Files:**
- Create: `apps/api/modules/catalog/search/__init__.py` (empty)
- Create: `apps/api/modules/catalog/search/index_body.py`
- Create: `apps/api/modules/catalog/search/opensearch.py`
- Create: `infra/opensearch/Dockerfile`
- Create (generated): `infra/opensearch/nais-datasets-v1.json`, `infra/opensearch/nais-datasets-v1.fallback.json`
- Create: `apps/api/modules/catalog/tests/fixtures_search.py`
- Modify: `apps/api/modules/catalog/tests/conftest.py` (import search fixtures)
- Test: `apps/api/modules/catalog/tests/test_opensearch_index.py`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `index_body.INDEX_VERSION = 1`, `index_body.MAPPINGS`, `index_body.index_body(*, nori: bool) -> dict`.
  - `opensearch.SearchUnavailable(RuntimeError)` (network error, 5xx, failed bulk item), `opensearch.SearchRejected(ValueError)` (400 on `_search`, e.g. bad `search_after`).
  - `opensearch.OpenSearchIndex(base_url: str, alias: str, *, timeout: float = 5.0)`: attribute `alias`; `ensure() -> None` (creates `<alias>-v1` with the nori body if the `analysis-nori` plugin is installed, else the fallback, then the alias; idempotent and race-safe); `nori_available() -> bool`; `create_index(name) -> None`; `bulk(upserts: Sequence[Mapping[Any, Any]], deletes: Sequence[str], *, index: str | None = None) -> None` (upsert id = `dataset_id`; deleting a missing doc is fine); `search(body: Mapping[Any, Any]) -> dict`; `refresh() -> None`; `next_index_name() -> str`; `swap_alias(new_index) -> list[str]` (atomic, returns previous indices).
  - Fixtures: `opensearch_url` (session; testcontainer `opensearchproject/opensearch:2.19.1`; skips without Docker), `search_index` (fresh `OpenSearchIndex` with a random alias; deletes its indices afterwards).

- [ ] **Step 1: Write the failing tests**

Append to `apps/api/modules/catalog/tests/conftest.py`:

```python
from api.modules.catalog.tests.fixtures_search import opensearch_url, search_index  # noqa: E402, F401
```

`apps/api/modules/catalog/tests/fixtures_search.py`:

```python
"""Throwaway OpenSearch (same image as compose) so D-012 filters and analyzers are tested for real."""

import time
import uuid
from collections.abc import Iterator

import httpx
import pytest

from api.modules.catalog.search.opensearch import OpenSearchIndex

OPENSEARCH_IMAGE = "opensearchproject/opensearch:2.19.1"


def start_opensearch(image: str) -> tuple[object, str]:
    from testcontainers.core.container import DockerContainer

    container = (
        DockerContainer(image)
        .with_env("discovery.type", "single-node")
        .with_env("DISABLE_SECURITY_PLUGIN", "true")
        .with_env("DISABLE_INSTALL_DEMO_CONFIG", "true")
        .with_env("OPENSEARCH_JAVA_OPTS", "-Xms512m -Xmx512m")
        .with_exposed_ports(9200)
    )
    container.start()
    url = f"http://{container.get_container_host_ip()}:{container.get_exposed_port(9200)}"
    deadline = time.monotonic() + 180
    while True:
        try:
            if httpx.get(f"{url}/_cluster/health", timeout=2).status_code == 200:
                return container, url
        except httpx.HTTPError:
            pass
        if time.monotonic() > deadline:
            container.stop()
            raise RuntimeError("OpenSearch container did not become ready in 180 s")
        time.sleep(1)


@pytest.fixture(scope="session")
def opensearch_url() -> Iterator[str]:
    try:
        container, url = start_opensearch(OPENSEARCH_IMAGE)
    except Exception as exc:  # docker missing or daemon not reachable
        pytest.skip(f"OpenSearch container unavailable: {exc}")
    try:
        yield url
    finally:
        container.stop()  # type: ignore[attr-defined]


@pytest.fixture
def search_index(opensearch_url: str) -> Iterator[OpenSearchIndex]:
    index = OpenSearchIndex(opensearch_url, f"test-{uuid.uuid4().hex[:12]}")
    yield index
    listed = httpx.get(f"{opensearch_url}/_cat/indices/{index.alias}-v*", params={"format": "json"}, timeout=10)
    for item in listed.json() if listed.status_code == 200 else []:
        httpx.delete(f"{opensearch_url}/{item['index']}", timeout=10)
```

`apps/api/modules/catalog/tests/test_opensearch_index.py`:

```python
import json
import os
import uuid
from typing import Any

import httpx
import pytest

from api.modules.catalog.search.index_body import index_body
from api.modules.catalog.search.opensearch import OpenSearchIndex, SearchRejected, SearchUnavailable
from api.platform.settings import REPO_ROOT

INFRA = REPO_ROOT / "infra" / "opensearch"


def make_doc(**overrides: Any) -> dict[str, Any]:
    doc: dict[str, Any] = {
        "dataset_id": str(uuid.uuid4()),
        "title": "Battery Cycling Measurements",
        "description": "Cycling data",
        "snippet": "Cycling data",
        "keywords": ["battery"],
        "domain": "materials",
        "access_level": "CONTROLLED",
        "owner_organization_id": str(uuid.uuid4()),
        "owner_organization_name": "Institute B",
        "allowed_purposes": ["ACADEMIC_RESEARCH"],
        "license": "CC-BY-4.0",
        "status": "ACTIVE",
        "has_published_version": True,
        "latest_version_id": str(uuid.uuid4()),
        "latest_version_label": "v1",
        "readiness_overall": None,
        "published_at": "2026-10-01T00:00:00+00:00",
        "updated_at": "2026-10-01T00:00:00+00:00",
    }
    doc.update(overrides)
    return doc


def test_infra_templates_match_the_code() -> None:
    assert json.loads((INFRA / "nais-datasets-v1.json").read_text(encoding="utf-8")) == index_body(nori=True)
    assert json.loads((INFRA / "nais-datasets-v1.fallback.json").read_text(encoding="utf-8")) == index_body(nori=False)
    assert "analysis-nori" in (INFRA / "Dockerfile").read_text(encoding="utf-8")


def test_ensure_creates_versioned_index_behind_alias_with_fallback_analyzer(
    search_index: OpenSearchIndex, opensearch_url: str
) -> None:
    search_index.ensure()
    concrete = f"{search_index.alias}-v1"
    assert list(httpx.get(f"{opensearch_url}/_alias/{search_index.alias}").json()) == [concrete]
    settings = httpx.get(f"{opensearch_url}/{concrete}/_settings").json()[concrete]["settings"]["index"]
    assert settings["analysis"]["analyzer"]["ko_en"]["tokenizer"] == "standard"  # stock image has no nori
    search_index.ensure()
    OpenSearchIndex(opensearch_url, search_index.alias).ensure()  # second process: no error, no new index
    assert list(httpx.get(f"{opensearch_url}/_alias/{search_index.alias}").json()) == [concrete]


def test_korean_title_matches_a_partial_word(search_index: OpenSearchIndex) -> None:  # M03-AT-24 (index level)
    doc = make_doc(title="고분자 전해질 막 측정")
    search_index.bulk([doc, make_doc(title="Unrelated")], [])
    search_index.refresh()
    result = search_index.search({"query": {"multi_match": {"query": "전해질", "fields": ["title^3"]}}})
    assert [hit["_id"] for hit in result["hits"]["hits"]] == [doc["dataset_id"]]


def test_bulk_upserts_and_deletes(search_index: OpenSearchIndex) -> None:
    doc = make_doc()
    search_index.bulk([doc], [])
    search_index.bulk([{**doc, "title": "Renamed"}], [str(uuid.uuid4())])  # deleting an unknown id is fine
    search_index.refresh()
    hits = search_index.search({"query": {"ids": {"values": [doc["dataset_id"]]}}})["hits"]["hits"]
    assert [h["_source"]["title"] for h in hits] == ["Renamed"]
    search_index.bulk([], [doc["dataset_id"]])
    search_index.refresh()
    assert search_index.search({"query": {"match_all": {}}})["hits"]["hits"] == []


def test_strict_mapping_rejects_unknown_fields(search_index: OpenSearchIndex) -> None:
    with pytest.raises(SearchUnavailable, match="failures"):
        search_index.bulk([make_doc(unexpected="x")], [])


def test_bad_search_after_is_rejected(search_index: OpenSearchIndex) -> None:
    search_index.ensure()
    with pytest.raises(SearchRejected):
        search_index.search(
            {"query": {"match_all": {}}, "sort": [{"dataset_id": "asc"}], "search_after": ["a", "b", "c"]}
        )


def test_unreachable_cluster_raises_search_unavailable() -> None:
    with pytest.raises(SearchUnavailable):
        OpenSearchIndex("http://127.0.0.1:9", "nais-datasets", timeout=0.5).search({"query": {"match_all": {}}})


def test_credentials_in_the_url_become_basic_auth() -> None:
    index = OpenSearchIndex("http://nais:secret@localhost:21056/", "nais-datasets")
    assert index._client.auth is not None
    assert str(index._client.base_url).rstrip("/") == "http://localhost:21056"


def test_next_index_name_and_atomic_alias_swap(search_index: OpenSearchIndex, opensearch_url: str) -> None:
    search_index.ensure()
    assert search_index.next_index_name() == f"{search_index.alias}-v2"
    search_index.create_index(f"{search_index.alias}-v2")
    assert search_index.swap_alias(f"{search_index.alias}-v2") == [f"{search_index.alias}-v1"]
    assert list(httpx.get(f"{opensearch_url}/_alias/{search_index.alias}").json()) == [f"{search_index.alias}-v2"]
    assert search_index.next_index_name() == f"{search_index.alias}-v3"


@pytest.mark.skipif(os.environ.get("NAIS_TEST_NORI") != "1", reason="set NAIS_TEST_NORI=1 to build infra/opensearch")
def test_nori_image_uses_the_nori_analyzer() -> None:
    from testcontainers.core.image import DockerImage

    from api.modules.catalog.tests.fixtures_search import start_opensearch

    with DockerImage(path=str(INFRA), tag="nais/opensearch-nori:test"):
        container, url = start_opensearch("nais/opensearch-nori:test")
        try:
            index = OpenSearchIndex(url, "nori-check")
            assert index.nori_available()
            index.ensure()
            analyzer = httpx.get(f"{url}/nori-check-v1/_settings").json()["nori-check-v1"]["settings"]["index"]
            assert analyzer["analysis"]["analyzer"]["ko_en"]["tokenizer"] == "nori_mixed"
            doc = make_doc(title="고분자 전해질 막 측정")
            index.bulk([doc], [])
            index.refresh()
            hits = index.search({"query": {"multi_match": {"query": "전해질", "fields": ["title^3"]}}})
            assert [h["_id"] for h in hits["hits"]["hits"]] == [doc["dataset_id"]]
        finally:
            container.stop()  # type: ignore[attr-defined]
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `uv run pytest apps/api/modules/catalog/tests/test_opensearch_index.py -v`
Expected: collection error `No module named 'api.modules.catalog.search'`.

- [ ] **Step 3: Implement**

`apps/api/modules/catalog/search/__init__.py`: empty file.

`apps/api/modules/catalog/search/index_body.py`:

```python
"""nais-datasets-v1 definition (M03 §10). infra/opensearch/*.json are generated from this module."""

import copy
from typing import Any

INDEX_VERSION = 1


def _text() -> dict[str, Any]:
    return {"type": "text", "analyzer": "ko_en"}


MAPPINGS: dict[str, Any] = {
    "dynamic": "strict",
    "properties": {
        "dataset_id": {"type": "keyword"},
        "title": {**_text(), "fields": {"raw": {"type": "keyword", "normalizer": "lc"}}},
        "description": _text(),
        "snippet": {"type": "keyword", "index": False},
        "keywords": {"type": "keyword", "normalizer": "lc", "fields": {"text": _text()}},
        "domain": {"type": "keyword"},
        "access_level": {"type": "keyword"},
        "owner_organization_id": {"type": "keyword"},
        "owner_organization_name": {"type": "keyword", "fields": {"text": _text()}},
        "allowed_purposes": {"type": "keyword"},
        "license": {"type": "keyword"},
        "status": {"type": "keyword"},
        "has_published_version": {"type": "boolean"},
        "latest_version_id": {"type": "keyword"},
        "latest_version_label": {"type": "keyword"},
        "readiness_overall": {"type": "keyword"},
        "published_at": {"type": "date"},
        "updated_at": {"type": "date"},
    },
}


def _analysis(nori: bool) -> dict[str, Any]:
    normalizer = {"lc": {"type": "custom", "filter": ["lowercase"]}}
    if nori:
        return {
            "analyzer": {
                "ko_en": {
                    "type": "custom",
                    "tokenizer": "nori_mixed",
                    "filter": ["lowercase", "nori_part_of_speech", "nori_readingform"],
                }
            },
            "tokenizer": {"nori_mixed": {"type": "nori_tokenizer", "decompound_mode": "mixed"}},
            "normalizer": normalizer,
        }
    # Fallback when analysis-nori is not installed: same index name, weaker Korean morphology (M03 §10).
    return {
        "analyzer": {"ko_en": {"type": "custom", "tokenizer": "standard", "filter": ["lowercase", "cjk_bigram"]}},
        "normalizer": normalizer,
    }


def index_body(*, nori: bool) -> dict[str, Any]:
    return {
        "settings": {"number_of_shards": 1, "analysis": _analysis(nori)},
        "mappings": copy.deepcopy(MAPPINGS),
    }
```

`apps/api/modules/catalog/search/opensearch.py`:

```python
"""Minimal OpenSearch REST client over httpx (no extra dependency). The alias is what readers and writers use."""

import json
import logging
import re
import threading
from collections.abc import Mapping, Sequence
from typing import Any

import httpx

from api.modules.catalog.search.index_body import INDEX_VERSION, index_body

logger = logging.getLogger("nais.catalog.search")


class SearchUnavailable(RuntimeError):
    pass


class SearchRejected(ValueError):
    pass


def _client_for(url: str, timeout: float) -> httpx.Client:
    parsed = httpx.URL(url)
    auth = (parsed.username, parsed.password) if parsed.username else None
    port = f":{parsed.port}" if parsed.port else ""
    base = f"{parsed.scheme}://{parsed.host}{port}{parsed.path.rstrip('/')}"
    return httpx.Client(base_url=base, auth=auth, timeout=timeout)


class OpenSearchIndex:
    def __init__(self, base_url: str, alias: str, *, timeout: float = 5.0) -> None:
        self.alias = alias
        self._client = _client_for(base_url, timeout)
        self._ready = False
        self._lock = threading.Lock()

    def _request(self, method: str, path: str, **kwargs: Any) -> httpx.Response:
        try:
            response = self._client.request(method, path, **kwargs)
        except httpx.HTTPError as exc:
            raise SearchUnavailable(f"{method} {path}: {exc}") from exc
        if response.status_code >= 500:
            raise SearchUnavailable(f"{method} {path}: HTTP {response.status_code} {response.text[:300]}")
        return response

    @staticmethod
    def _ok(response: httpx.Response) -> httpx.Response:
        if response.status_code >= 400:
            raise SearchUnavailable(f"HTTP {response.status_code}: {response.text[:500]}")
        return response

    def nori_available(self) -> bool:
        plugins = self._ok(self._request("GET", "/_cat/plugins", params={"format": "json"})).json()
        return any(plugin.get("component") == "analysis-nori" for plugin in plugins)

    def create_index(self, name: str) -> None:
        nori = self.nori_available()
        if not nori:
            logger.warning("analysis-nori not installed; using the fallback analyzer", extra={"index": name})
        response = self._request("PUT", f"/{name}", json=index_body(nori=nori))
        if response.status_code == 400 and "resource_already_exists_exception" in response.text:
            return
        self._ok(response)

    def ensure(self) -> None:
        if self._ready:
            return
        with self._lock:
            if self._ready:
                return
            if self._request("HEAD", f"/_alias/{self.alias}").status_code != 200:
                first = f"{self.alias}-v{INDEX_VERSION}"
                self.create_index(first)
                self._ok(
                    self._request("POST", "/_aliases", json={"actions": [{"add": {"index": first, "alias": self.alias}}]})
                )
            self._ready = True

    def bulk(
        self, upserts: Sequence[Mapping[Any, Any]], deletes: Sequence[str], *, index: str | None = None
    ) -> None:
        self.ensure()
        target = index or self.alias
        lines: list[str] = []
        for doc in upserts:
            lines.append(json.dumps({"index": {"_index": target, "_id": str(doc["dataset_id"])}}))
            lines.append(json.dumps(doc, ensure_ascii=False, default=str))
        for dataset_id in deletes:
            lines.append(json.dumps({"delete": {"_index": target, "_id": str(dataset_id)}}))
        if not lines:
            return
        response = self._ok(
            self._request(
                "POST",
                "/_bulk",
                content="\n".join(lines) + "\n",
                headers={"Content-Type": "application/x-ndjson"},
            )
        )
        body = response.json()
        if body.get("errors"):
            failed = [
                result
                for item in body.get("items", [])
                for action, result in item.items()
                if result.get("status", 200) >= 300 and not (action == "delete" and result.get("status") == 404)
            ]
            if failed:
                raise SearchUnavailable(f"bulk request had {len(failed)} failures: {failed[:3]}")

    def search(self, body: Mapping[Any, Any]) -> dict[str, Any]:
        self.ensure()
        response = self._request("POST", f"/{self.alias}/_search", json=dict(body))
        if response.status_code == 400:
            raise SearchRejected(response.text[:500])
        result: dict[str, Any] = self._ok(response).json()
        return result

    def refresh(self) -> None:
        self.ensure()
        self._ok(self._request("POST", f"/{self.alias}/_refresh"))

    def next_index_name(self) -> str:
        response = self._request("GET", f"/_cat/indices/{self.alias}-v*", params={"format": "json", "h": "index"})
        names = [item["index"] for item in response.json()] if response.status_code == 200 else []
        pattern = re.compile(rf"^{re.escape(self.alias)}-v(\d+)$")
        numbers = [int(match.group(1)) for name in names if (match := pattern.match(name))]
        return f"{self.alias}-v{max(numbers, default=0) + 1}"

    def swap_alias(self, new_index: str) -> list[str]:
        response = self._request("GET", f"/_alias/{self.alias}")
        current = sorted(response.json()) if response.status_code == 200 else []
        actions: list[dict[str, Any]] = [{"remove": {"index": name, "alias": self.alias}} for name in current]
        actions.append({"add": {"index": new_index, "alias": self.alias}})
        self._ok(self._request("POST", "/_aliases", json={"actions": actions}))
        self._ready = True
        return current
```

`infra/opensearch/Dockerfile`:

```dockerfile
# OpenSearch with the Korean analyzer (M03 §2, §10). Without it the catalog falls back to cjk_bigram.
FROM opensearchproject/opensearch:2.19.1
RUN /usr/share/opensearch/bin/opensearch-plugin install --batch analysis-nori
```

Generate the two committed index bodies from the code (never edit them by hand):

```bash
PYTHONPATH=apps uv run python - <<'PY'
import json
from api.modules.catalog.search.index_body import index_body
for name, nori in (("nais-datasets-v1.json", True), ("nais-datasets-v1.fallback.json", False)):
    with open(f"infra/opensearch/{name}", "w", encoding="utf-8") as fh:
        fh.write(json.dumps(index_body(nori=nori), indent=2, ensure_ascii=False) + "\n")
PY
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `uv run pytest apps/api/modules/catalog/tests/test_opensearch_index.py -v`
Expected: all PASS except `test_nori_image_uses_the_nori_analyzer` (SKIPPED unless `NAIS_TEST_NORI=1`; run it once with `NAIS_TEST_NORI=1` if the host can download the plugin).

- [ ] **Step 5: Commit**

```bash
uv run ruff check --fix apps/api/modules/catalog && uv run ruff format apps/api/modules/catalog
git add apps/api/modules/catalog infra/opensearch
git commit -m "feat(catalog): nais-datasets-v1 index definition, OpenSearch client, nori image

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 5: Internal ports, adapters, `CatalogDeps` wiring and the API test harness

**Files:**
- Create: `apps/api/modules/catalog/interfaces.py`
- Create: `apps/api/modules/catalog/adapters/__init__.py` (empty), `adapters/identity.py`, `adapters/malware.py`, `adapters/queue.py`
- Create: `apps/api/modules/catalog/deps.py`
- Create: `apps/api/modules/catalog/wiring.py`
- Create: `apps/api/modules/catalog/router.py`
- Create: `apps/api/modules/catalog/routes/__init__.py` (empty), `apps/api/modules/catalog/service/__init__.py` (empty)
- Modify: `apps/api/modules/catalog/__init__.py` (router + wire)
- Modify: `apps/api/modules/catalog/testing.py` (recording fakes)
- Create: `apps/api/modules/catalog/tests/support_api.py`, `apps/api/modules/catalog/tests/fixtures_api.py`
- Modify: `apps/api/modules/catalog/tests/conftest.py`
- Test: `apps/api/modules/catalog/tests/test_wiring.py`

**Interfaces:**
- Consumes: `StorageRegistry` (Task 3), `OpenSearchIndex`, `SearchUnavailable` (Task 4), `CatalogSettings`, `get_catalog_settings` (Task 1), `api.platform.ports`, `api.platform.db.session_factory`, `api.platform.auth.{CurrentUser, PrincipalResolver, TokenVerifier, get_token_verifier}`, `api.platform.testing.{app.create_test_app, tokens.FakeIssuer}`.
- Produces:
  - `interfaces.OrganizationSummary(organization_id: UUID, code: str, name: str, type: str)`; Protocols `OrganizationLookup` (`get_organization_summary(id) -> OrganizationSummary | None`, `get_organization_summaries(ids) -> dict[UUID, OrganizationSummary]`), `MalwareScannerPort` (`scan(bucket, key) -> ScanResult`), `ScanResult(status: Literal["CLEAN","INFECTED","SKIPPED"], detail: str | None = None)`, `VerificationQueue` (`enqueue(file_ids: Sequence[UUID]) -> None`), `SearchIndex` (same methods as `OpenSearchIndex`: `alias`, `ensure`, `bulk`, `search`, `refresh`, `create_index`, `next_index_name`, `swap_alias`).
  - `adapters.identity.FakeIdentityPort`, `adapters.identity.IdentityQueryAdapter(port_type)`, `adapters.identity.SEED_ORGANIZATIONS`; `adapters.malware.NoopScanner`, `adapters.malware.build_scanner(name) -> MalwareScannerPort`; `adapters.queue.DramatiqVerificationQueue` (sends `api.modules.catalog.jobs.verify_file_actor`, created in Task 11).
  - `deps.CatalogDeps` (frozen dataclass: `settings`, `session_factory: Callable[[], Session]`, `storage: StorageRegistry`, `organizations: OrganizationLookup`, `scanner: MalwareScannerPort`, `verification: VerificationQueue`, `search: SearchIndex`); `deps.get_deps() -> CatalogDeps` (raises `ApiError(DEPENDENCY_UNAVAILABLE)` if not wired); `deps.CatalogDepsDep` (FastAPI `Annotated` dependency).
  - `wiring.build_default_deps(settings=None) -> CatalogDeps`, `wiring.install(deps) -> None` (Task 16 extends it to the public ports), `wiring.wire() -> None`, `wiring.default_organization_lookup() -> OrganizationLookup`.
  - `router.router` (aggregating `APIRouter`; later tasks add `routes/*`).
  - `testing.RecordingVerificationQueue` (`.enqueued: list[UUID]`), `testing.RecordingSearchIndex` (`.docs: dict[str, dict]`, `.bulk_calls: int`; `search()` raises `SearchUnavailable`).
  - Test harness `support_api`: `USERS: dict[str, CurrentUser]` with keys `platform.admin`, `a.admin`, `a.researcher`, `a.steward`, `b.admin`, `b.researcher`, `b.steward` (seed UUIDs); `FakePrincipalResolver`; `CatalogApi` with `.deps`, `.use(deps)`, `.get/.post/.patch/.delete(user: str | None, path: str, **kw) -> httpx.Response` (path without `/api/v1`); `make_api(urls, deps) -> CatalogApi`; `assert_error(response, status, code) -> dict`; `dataset_body(owner=ORG_B, **overrides) -> dict`; `create_dataset(api, user="b.steward", **overrides) -> dict`.
  - Fixtures `deps` (memory storage, FakeIdentityPort, NoopScanner, recording queue and search), `api`, `search_api` (api whose `deps.search` is the real `search_index`).

- [ ] **Step 1: Write the failing tests**

Append to `apps/api/modules/catalog/tests/conftest.py`:

```python
from api.modules.catalog.tests.fixtures_api import api, deps, search_api  # noqa: E402, F401
```

`apps/api/modules/catalog/tests/test_wiring.py`:

```python
import types
from typing import Any, Protocol
from uuid import UUID

import pytest

from api.modules.catalog import MODULE, wiring
from api.modules.catalog.adapters.identity import FakeIdentityPort
from api.modules.catalog.adapters.malware import NoopScanner, build_scanner
from api.modules.catalog.adapters.queue import DramatiqVerificationQueue
from api.modules.catalog.deps import CatalogDeps, get_deps
from api.modules.catalog.interfaces import OrganizationSummary
from api.modules.catalog.objects import StorageRegistry
from api.modules.catalog.search.opensearch import OpenSearchIndex
from api.modules.catalog.tests.support import ORG_A, ORG_B, ORG_NAIS
from api.platform import ports
from api.platform.errors import ApiError
from api.platform.generated.error_codes import ErrorCode
from api.platform.testing.app import create_test_app


def test_wire_registers_default_deps() -> None:
    wiring.wire()
    deps = ports.get(CatalogDeps)
    assert isinstance(deps.search, OpenSearchIndex) and deps.search.alias == "nais-datasets"
    assert isinstance(deps.storage, StorageRegistry)
    assert isinstance(deps.scanner, NoopScanner)
    assert isinstance(deps.verification, DramatiqVerificationQueue)


def test_catalog_module_mounts_on_the_test_app() -> None:
    app = create_test_app(modules=[MODULE])
    assert [spec.name for spec in app.state.modules] == ["catalog"]
    assert ports.get(CatalogDeps) is not None


def test_get_deps_without_wiring_is_dependency_unavailable() -> None:
    with pytest.raises(ApiError) as caught:
        get_deps()
    assert caught.value.code == ErrorCode.DEPENDENCY_UNAVAILABLE


def test_fake_identity_knows_the_seed_organizations() -> None:
    fake = FakeIdentityPort()
    assert fake.get_organization_summary(ORG_B) == OrganizationSummary(ORG_B, "inst-b", "Institute B", "RESEARCH_INSTITUTE")
    assert fake.get_organization_summary(ORG_NAIS).code == "nais"  # type: ignore[union-attr]
    assert set(fake.get_organization_summaries([ORG_A, ORG_B, UUID(int=1)])) == {ORG_A, ORG_B}


def test_lookup_falls_back_to_the_fake_without_identity_module(monkeypatch: pytest.MonkeyPatch) -> None:
    def missing(name: str) -> Any:
        raise ModuleNotFoundError(f"No module named {name!r}", name="api.modules.identity")

    monkeypatch.setattr(wiring, "_import", missing)
    assert isinstance(wiring.default_organization_lookup(), FakeIdentityPort)


def test_lookup_uses_the_identity_public_port_when_installed(monkeypatch: pytest.MonkeyPatch) -> None:
    class IdentityQueryPort(Protocol):
        def get_organization_summary(self, organization_id: UUID) -> Any: ...

    class Impl:
        def get_organization_summary(self, organization_id: UUID) -> Any:
            if organization_id != ORG_B:
                return None
            return types.SimpleNamespace(
                organization_id=ORG_B, code="inst-b", name="Institute B", type=types.SimpleNamespace(value="RESEARCH_INSTITUTE")
            )

    public = types.ModuleType("api.modules.identity.public")
    public.IdentityQueryPort = IdentityQueryPort  # type: ignore[attr-defined]
    monkeypatch.setattr(wiring, "_import", lambda name: public)
    ports.provide(IdentityQueryPort, Impl())
    lookup = wiring.default_organization_lookup()
    expected = OrganizationSummary(ORG_B, "inst-b", "Institute B", "RESEARCH_INSTITUTE")
    assert lookup.get_organization_summary(ORG_B) == expected
    assert lookup.get_organization_summaries([ORG_B, ORG_A, ORG_B]) == {ORG_B: expected}


def test_scanner_selection() -> None:
    assert build_scanner("noop").scan("nais-inst-b", "k").status == "SKIPPED"
    with pytest.raises(ValueError, match="clamav"):
        build_scanner("clamav")
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `uv run pytest apps/api/modules/catalog/tests/test_wiring.py -v`
Expected: collection error `No module named 'api.modules.catalog.tests.fixtures_api'`.

- [ ] **Step 3: Implement**

`apps/api/modules/catalog/interfaces.py`:

```python
"""Ports the catalog consumes (M03 §3.1) and internal seams. Implementations: adapters/, objects.py, search/."""

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Literal, Protocol
from uuid import UUID


@dataclass(frozen=True)
class OrganizationSummary:
    organization_id: UUID
    code: str
    name: str
    type: str


class OrganizationLookup(Protocol):
    """M03 §3.1 IdentityPort. The organization code selects the storage (STORAGE_<CODE>_*, D-024)."""

    def get_organization_summary(self, organization_id: UUID) -> OrganizationSummary | None: ...
    def get_organization_summaries(self, ids: Sequence[UUID]) -> dict[UUID, OrganizationSummary]: ...


ScanStatus = Literal["CLEAN", "INFECTED", "SKIPPED"]


@dataclass(frozen=True)
class ScanResult:
    status: ScanStatus
    detail: str | None = None


class MalwareScannerPort(Protocol):
    def scan(self, bucket: str, key: str) -> ScanResult: ...


class VerificationQueue(Protocol):
    """Schedules asynchronous verification (catalog.verify_file). Call only after the DB commit."""

    def enqueue(self, file_ids: Sequence[UUID]) -> None: ...


class SearchIndex(Protocol):
    alias: str

    def ensure(self) -> None: ...
    def bulk(self, upserts: Sequence[Mapping[Any, Any]], deletes: Sequence[str], *, index: str | None = None) -> None: ...
    def search(self, body: Mapping[Any, Any]) -> dict[str, Any]: ...
    def refresh(self) -> None: ...
    def create_index(self, name: str) -> None: ...
    def next_index_name(self) -> str: ...
    def swap_alias(self, new_index: str) -> list[str]: ...
```

`apps/api/modules/catalog/adapters/__init__.py`: empty file.

`apps/api/modules/catalog/adapters/identity.py`:

```python
"""Organization lookup: M01's public IdentityQueryPort when installed, else a fixed fake (Wave 1 mock-first)."""

from collections.abc import Sequence
from typing import Any
from uuid import UUID

from api.modules.catalog.interfaces import OrganizationSummary
from api.platform import ports
from api.platform.errors import ApiError
from api.platform.generated.error_codes import ErrorCode

SEED_ORGANIZATIONS: tuple[OrganizationSummary, ...] = (
    OrganizationSummary(UUID("00000000-0000-7000-8000-000000000001"), "nais", "NAIS", "PLATFORM_OPERATOR"),
    OrganizationSummary(UUID("00000000-0000-7000-8000-00000000000a"), "inst-a", "Institute A", "RESEARCH_INSTITUTE"),
    OrganizationSummary(UUID("00000000-0000-7000-8000-00000000000b"), "inst-b", "Institute B", "RESEARCH_INSTITUTE"),
)


class FakeIdentityPort:
    def __init__(self, organizations: Sequence[OrganizationSummary] = SEED_ORGANIZATIONS) -> None:
        self._by_id = {org.organization_id: org for org in organizations}

    def get_organization_summary(self, organization_id: UUID) -> OrganizationSummary | None:
        return self._by_id.get(organization_id)

    def get_organization_summaries(self, ids: Sequence[UUID]) -> dict[UUID, OrganizationSummary]:
        return {org_id: self._by_id[org_id] for org_id in ids if org_id in self._by_id}


def _convert(summary: Any) -> OrganizationSummary:
    kind = getattr(summary, "type", "")
    return OrganizationSummary(
        organization_id=UUID(str(summary.organization_id)),
        code=str(summary.code),
        name=str(summary.name),
        type=str(getattr(kind, "value", kind)),
    )


class IdentityQueryAdapter:
    """Wraps M01's IdentityQueryPort (looked up per call, so wiring order does not matter)."""

    def __init__(self, port_type: type[Any]) -> None:
        self._port_type = port_type

    def _port(self) -> Any:
        try:
            return ports.get(self._port_type)
        except ports.PortNotProvided as exc:
            raise ApiError(ErrorCode.DEPENDENCY_UNAVAILABLE, "Identity module is not wired.") from exc

    def get_organization_summary(self, organization_id: UUID) -> OrganizationSummary | None:
        summary = self._port().get_organization_summary(organization_id)
        return None if summary is None else _convert(summary)

    def get_organization_summaries(self, ids: Sequence[UUID]) -> dict[UUID, OrganizationSummary]:
        result: dict[UUID, OrganizationSummary] = {}
        for org_id in dict.fromkeys(ids):
            summary = self.get_organization_summary(org_id)
            if summary is not None:
                result[org_id] = summary
        return result
```

`apps/api/modules/catalog/adapters/malware.py`:

```python
"""Malware scan extension point (M03 §6.6). P0 ships only the no-op scanner."""

from api.modules.catalog.interfaces import MalwareScannerPort, ScanResult


class NoopScanner:
    def scan(self, bucket: str, key: str) -> ScanResult:
        return ScanResult("SKIPPED")


def build_scanner(name: str) -> MalwareScannerPort:
    if name == "noop":
        return NoopScanner()
    raise ValueError(f"MALWARE_SCANNER={name!r} is not supported in P0 (use 'noop'; clamav is P1)")
```

`apps/api/modules/catalog/adapters/queue.py`:

```python
"""Dramatiq-backed VerificationQueue: one catalog.verify_file message per file (M03 §10).

Messages go to the broker configured *now* (dramatiq.get_broker()), not to the broker the actor happened to bind
when the module was imported: under pytest the package is imported before any broker is configured.
"""

from collections.abc import Sequence
from uuid import UUID

import dramatiq

from api.platform.context import correlation_id


class DramatiqVerificationQueue:
    def enqueue(self, file_ids: Sequence[UUID]) -> None:
        from api.modules.catalog.jobs import verify_file_actor  # jobs.py defines the actor (Task 11)

        broker = dramatiq.get_broker()
        if verify_file_actor.actor_name not in broker.get_declared_actors():
            broker.declare_actor(verify_file_actor)
        for file_id in file_ids:
            broker.enqueue(
                verify_file_actor.message_with_options(args=(str(file_id),), correlation_id=str(correlation_id()))
            )
```

`apps/api/modules/catalog/deps.py`:

```python
"""Everything the catalog talks to, in one container registered in api.platform.ports by wire()."""

from collections.abc import Callable
from dataclasses import dataclass
from typing import Annotated

from fastapi import Depends
from sqlalchemy.orm import Session

from api.modules.catalog.interfaces import MalwareScannerPort, OrganizationLookup, SearchIndex, VerificationQueue
from api.modules.catalog.objects import StorageRegistry
from api.modules.catalog.settings import CatalogSettings
from api.platform import ports
from api.platform.errors import ApiError
from api.platform.generated.error_codes import ErrorCode


@dataclass(frozen=True)
class CatalogDeps:
    settings: CatalogSettings
    session_factory: Callable[[], Session]
    storage: StorageRegistry
    organizations: OrganizationLookup
    scanner: MalwareScannerPort
    verification: VerificationQueue
    search: SearchIndex


def get_deps() -> CatalogDeps:
    try:
        return ports.get(CatalogDeps)
    except ports.PortNotProvided as exc:
        raise ApiError(ErrorCode.DEPENDENCY_UNAVAILABLE, "Catalog module is not wired.") from exc


CatalogDepsDep = Annotated[CatalogDeps, Depends(get_deps)]
```

`apps/api/modules/catalog/wiring.py`:

```python
"""ModuleSpec.wire(): build the default CatalogDeps and register the catalog's ports."""

import importlib
import logging
import os
from types import ModuleType

from api.modules.catalog.adapters.identity import FakeIdentityPort, IdentityQueryAdapter
from api.modules.catalog.adapters.malware import build_scanner
from api.modules.catalog.adapters.queue import DramatiqVerificationQueue
from api.modules.catalog.deps import CatalogDeps
from api.modules.catalog.interfaces import OrganizationLookup
from api.modules.catalog.objects import StorageRegistry
from api.modules.catalog.search.opensearch import OpenSearchIndex
from api.modules.catalog.settings import CatalogSettings, get_catalog_settings
from api.platform import ports
from api.platform.db import session_factory

logger = logging.getLogger("nais.catalog")
IDENTITY_PUBLIC = "api.modules.identity.public"


def _import(name: str) -> ModuleType:
    return importlib.import_module(name)


def default_organization_lookup() -> OrganizationLookup:
    try:
        public = _import(IDENTITY_PUBLIC)
    except ModuleNotFoundError as exc:
        if exc.name not in {"api.modules.identity", IDENTITY_PUBLIC}:
            raise
        logger.warning("identity module not installed; catalog uses FakeIdentityPort (Wave 1 mock-first)")
        return FakeIdentityPort()
    return IdentityQueryAdapter(public.IdentityQueryPort)


def build_default_deps(settings: CatalogSettings | None = None) -> CatalogDeps:
    settings = settings or get_catalog_settings()
    return CatalogDeps(
        settings=settings,
        session_factory=session_factory(),
        storage=StorageRegistry(os.environ, settings.nais_public_base_url, settings.storage_org_code_list),
        organizations=default_organization_lookup(),
        scanner=build_scanner(settings.malware_scanner),
        verification=DramatiqVerificationQueue(),
        search=OpenSearchIndex(
            settings.opensearch_url,
            settings.catalog_index_alias,
            timeout=settings.catalog_opensearch_timeout_seconds,
        ),
    )


def install(deps: CatalogDeps) -> None:
    ports.provide(CatalogDeps, deps)


def wire() -> None:
    install(build_default_deps())
```

`apps/api/modules/catalog/router.py`:

```python
"""All catalog routes (mounted under /api/v1 by the platform)."""

from fastapi import APIRouter

router = APIRouter()
```

`apps/api/modules/catalog/routes/__init__.py` and `apps/api/modules/catalog/service/__init__.py`: empty files.

`apps/api/modules/catalog/__init__.py`:

```python
"""M03 Data Catalog & Versioning. Spec: NAIS_PRD/modules/M03_data_catalog.md."""

from pathlib import Path

from api.modules.catalog.router import router
from api.modules.catalog.wiring import wire
from api.platform.modules import ModuleSpec

MODULE = ModuleSpec(
    name="catalog",
    db_schema="catalog",
    router=router,
    migrations_dir=Path(__file__).parent / "migrations",
    wire=wire,
)
```

In `apps/api/modules/catalog/testing.py`, replace the import block at the top with:

```python
import hashlib
import io
import uuid
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any, BinaryIO
from uuid import UUID

from api.modules.catalog.objects import MultipartFailed, ObjectMissing, StorageRegistry
from api.modules.catalog.search.opensearch import SearchUnavailable
```

and append:

```python
class RecordingVerificationQueue:
    def __init__(self) -> None:
        self.enqueued: list[UUID] = []

    def enqueue(self, file_ids: Sequence[UUID]) -> None:
        self.enqueued.extend(file_ids)


class RecordingSearchIndex:
    """SearchIndex double for tests that do not exercise OpenSearch semantics."""

    alias = "recording"

    def __init__(self) -> None:
        self.docs: dict[str, dict[str, Any]] = {}
        self.bulk_calls = 0

    def ensure(self) -> None:
        return None

    def bulk(self, upserts: Sequence[Mapping[Any, Any]], deletes: Sequence[str], *, index: str | None = None) -> None:
        self.bulk_calls += 1
        for doc in upserts:
            self.docs[str(doc["dataset_id"])] = dict(doc)
        for dataset_id in deletes:
            self.docs.pop(str(dataset_id), None)

    def search(self, body: Mapping[Any, Any]) -> dict[str, Any]:
        raise SearchUnavailable("RecordingSearchIndex does not search; use the search_index fixture")

    def refresh(self) -> None:
        return None

    def create_index(self, name: str) -> None:
        return None

    def next_index_name(self) -> str:
        return "recording-v2"

    def swap_alias(self, new_index: str) -> list[str]:
        return []
```

`apps/api/modules/catalog/tests/support_api.py`:

```python
"""API client for catalog tests: FakeIssuer tokens resolved to seed users by FakePrincipalResolver."""

from dataclasses import dataclass
from typing import Any
from uuid import UUID

import httpx
from fastapi.testclient import TestClient

from api.modules.catalog import MODULE
from api.modules.catalog.deps import CatalogDeps
from api.modules.catalog.tests.support import ORG_A, ORG_B, ORG_NAIS, seed_user_id
from api.modules.catalog.wiring import install
from api.platform import ports
from api.platform.auth import CurrentUser, PrincipalResolver, TokenVerifier, get_token_verifier
from api.platform.errors import ApiError
from api.platform.generated.error_codes import ErrorCode
from api.platform.settings import Settings
from api.platform.testing.app import create_test_app
from api.platform.testing.fixtures import PgUrls
from api.platform.testing.tokens import FakeIssuer


def _user(suffix: str, org: UUID, roles: tuple[str, ...] = (), platform: tuple[str, ...] = ()) -> CurrentUser:
    return CurrentUser(
        user_id=seed_user_id(suffix),
        organization_id=org,
        org_roles=frozenset(roles),
        platform_roles=frozenset(platform),
        session_id=f"session-{suffix}",
        display_name=suffix,
    )


USERS: dict[str, CurrentUser] = {
    "platform.admin": _user("0101", ORG_NAIS, ("ORG_ADMIN",), ("PLATFORM_ADMIN",)),
    "a.admin": _user("0a01", ORG_A, ("ORG_ADMIN",)),
    "a.researcher": _user("0a02", ORG_A),
    "a.steward": _user("0a03", ORG_A, ("DATA_STEWARD",)),
    "b.admin": _user("0b01", ORG_B, ("ORG_ADMIN",)),
    "b.researcher": _user("0b02", ORG_B),
    "b.steward": _user("0b03", ORG_B, ("DATA_STEWARD",)),
}


class FakePrincipalResolver:
    def resolve(self, claims: dict[str, Any], correlation_id: UUID) -> CurrentUser:
        user = USERS.get(str(claims.get("sub")))
        if user is None:
            raise ApiError(ErrorCode.UNAUTHENTICATED)
        return user


@dataclass
class CatalogApi:
    client: TestClient
    issuer: FakeIssuer
    deps: CatalogDeps

    def use(self, deps: CatalogDeps) -> None:
        self.deps = deps
        install(deps)

    def request(self, method: str, user: str | None, path: str, **kwargs: Any) -> httpx.Response:
        headers = dict(kwargs.pop("headers", None) or {})
        if user is not None:
            headers["Authorization"] = f"Bearer {self.issuer.token(sub=user)}"
        return self.client.request(method, f"/api/v1{path}", headers=headers, **kwargs)

    def get(self, user: str | None, path: str, **kwargs: Any) -> httpx.Response:
        return self.request("GET", user, path, **kwargs)

    def post(self, user: str | None, path: str, **kwargs: Any) -> httpx.Response:
        return self.request("POST", user, path, **kwargs)

    def patch(self, user: str | None, path: str, **kwargs: Any) -> httpx.Response:
        return self.request("PATCH", user, path, **kwargs)

    def delete(self, user: str | None, path: str, **kwargs: Any) -> httpx.Response:
        return self.request("DELETE", user, path, **kwargs)


def make_api(urls: PgUrls, deps: CatalogDeps) -> CatalogApi:
    issuer = FakeIssuer()
    app = create_test_app(modules=[MODULE], settings=Settings(database_url=urls.app))
    verifier = TokenVerifier(issuer=issuer.issuer, audience=issuer.audience, jwk_client=issuer.jwk_client())
    app.dependency_overrides[get_token_verifier] = lambda: verifier
    ports.provide(PrincipalResolver, FakePrincipalResolver())
    install(deps)
    return CatalogApi(TestClient(app, raise_server_exceptions=False), issuer, deps)


def assert_error(response: httpx.Response, status: int, code: str) -> dict[str, Any]:
    """For statuses openapi does not declare for the operation (see plan: Contract/shared changes needed)."""
    assert response.status_code == status, response.text
    body = response.json()
    assert set(body) == {"error"}, body
    assert body["error"]["code"] == code, body
    assert body["error"]["trace_id"]
    error: dict[str, Any] = body["error"]
    return error


def dataset_body(owner: UUID = ORG_B, **overrides: Any) -> dict[str, Any]:
    body: dict[str, Any] = {
        "owner_organization_id": str(owner),
        "title": "Battery Cycling Measurements",
        "description": "Charge/discharge cycling of pouch cells.",
        "keywords": ["battery", "cycling"],
        "domain": "materials",
        "access_level": "CONTROLLED",
        "license": "CC-BY-4.0",
        "allowed_purposes": ["ACADEMIC_RESEARCH", "AI_TRAINING"],
    }
    body.update(overrides)
    return body


def create_dataset(api: CatalogApi, user: str = "b.steward", **overrides: Any) -> dict[str, Any]:
    owner = ORG_A if user.startswith("a.") else ORG_B
    response = api.post(user, "/datasets", json=dataset_body(owner, **overrides))
    assert response.status_code == 201, response.text
    created: dict[str, Any] = response.json()
    return created
```

`apps/api/modules/catalog/tests/fixtures_api.py`:

```python
from dataclasses import replace

import pytest

from api.modules.catalog.adapters.identity import FakeIdentityPort
from api.modules.catalog.adapters.malware import NoopScanner
from api.modules.catalog.deps import CatalogDeps
from api.modules.catalog.search.opensearch import OpenSearchIndex
from api.modules.catalog.settings import CatalogSettings
from api.modules.catalog.testing import RecordingSearchIndex, RecordingVerificationQueue, memory_registry
from api.modules.catalog.tests.support_api import CatalogApi, make_api
from api.platform.db import session_factory
from api.platform.testing.fixtures import PgUrls


@pytest.fixture
def deps(db: PgUrls) -> CatalogDeps:
    return CatalogDeps(
        settings=CatalogSettings(),
        session_factory=session_factory(db.app),
        storage=memory_registry(),
        organizations=FakeIdentityPort(),
        scanner=NoopScanner(),
        verification=RecordingVerificationQueue(),
        search=RecordingSearchIndex(),
    )


@pytest.fixture
def api(db: PgUrls, deps: CatalogDeps) -> CatalogApi:
    return make_api(db, deps)


@pytest.fixture
def search_api(api: CatalogApi, search_index: OpenSearchIndex) -> CatalogApi:
    api.use(replace(api.deps, search=search_index))
    return api
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `uv run pytest apps/api/modules/catalog/tests -v`
Expected: all PASS (S3 tests SKIP only if the stack is down).

- [ ] **Step 5: Commit**

```bash
uv run ruff check --fix apps/api/modules/catalog && uv run ruff format apps/api/modules/catalog
git add apps/api/modules/catalog
git commit -m "feat(catalog): internal ports, adapters, CatalogDeps wiring and API test harness

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 6: Datasets API — `createDataset`, `getDataset`, `getDatasetPolicy` (D-012, D-013)

**Files:**
- Create: `apps/api/modules/catalog/repo.py`
- Create: `apps/api/modules/catalog/access.py`
- Create: `apps/api/modules/catalog/schemas.py`
- Create: `apps/api/modules/catalog/views.py`
- Create: `apps/api/modules/catalog/service/datasets.py`
- Create: `apps/api/modules/catalog/routes/datasets.py`
- Modify: `apps/api/modules/catalog/router.py`
- Test: `apps/api/modules/catalog/tests/test_datasets_api.py`

**Interfaces:**
- Consumes: `CatalogDeps`, `CatalogDepsDep` (Task 5), tables (Task 2), `build_policy`, `InvalidPolicy`, `normalize_keywords`, `DATA_STEWARD`, `ORG_ADMIN` (Task 1), `api.platform.db.SessionDep`, `api.platform.auth.{CurrentUser, CurrentUserDep}`, `outbox`, `EventActor`, `ApiError`, `ErrorCode`.
- Produces:
  - `repo`: `load_dataset(session, dataset_id, *, for_update=False) -> RowMapping | None` (row + `has_published_version: bool`), `load_version(session, version_id, *, for_update=False) -> RowMapping | None`, `files_of_versions(session, version_ids) -> dict[UUID, list[RowMapping]]` (path order by UTF-8 bytes via `COLLATE "C"`), `latest_published_version(session, dataset_id) -> RowMapping | None`, `readiness_overall(session, version_ids) -> dict[UUID, str | None]` (TABULAR_ML_BASIC COMPLETED, else GENERIC_BASIC COMPLETED, else None), `enqueue_index(session, dataset_id) -> None`, `must(row, what) -> RowMapping`, `rowcount(result) -> int`, `PRIMARY_PROFILES`.
  - `access`: `is_steward(user, owner_org_id) -> bool`, `can_see_all_versions(user, owner_org_id) -> bool`, `can_see_dataset(user, ds) -> bool`, `can_see_version(user, ds, version) -> bool`, `not_found(what) -> ApiError`, `visible_dataset(session, user, dataset_id, *, for_update=False) -> RowMapping`, `require_steward(user, ds) -> None`, `steward_version(session, user, version_id, *, for_update=False) -> tuple[RowMapping, RowMapping]` (version, dataset), `require_draft(version) -> None`.
  - `schemas`: `DatasetCreateIn`, `DatasetUpdateIn`, `VersionCreateIn`, `UploadFileIn`, `UploadSessionCreateIn`, `PartEtagIn`, `FilePartsIn`, `UploadCompleteIn`, literals `AccessLevelIn`, `PurposeIn`, `ReadinessIn`, `SortIn`.
  - `views`: `policy_view(ds)`, `version_summary(version, readiness)`, `dataset_view(ds, *, org_name, latest, latest_readiness)`, `file_view(f)`, `version_view(version, files, readiness)` — all return `dict[str, Any]` (UUID/datetime values; FastAPI serializes them).
  - `service.datasets`: `insert_dataset(session, *, dataset_id, owner, created_by, fields: Mapping[Any, Any], policy: Policy, actor: EventActor) -> None` (row + `catalog.dataset.created.v1` + index queue; reused by seed), `dataset_response(session, deps, ds) -> dict`, `create_dataset(session, deps, user, body) -> dict`, `get_dataset(session, deps, user, dataset_id) -> dict`, `get_policy(session, user, dataset_id) -> dict`, `policy_or_error(access_level, purposes, max_grant_days) -> Policy`.
  - Routes `POST /datasets` (`createDataset`, 201), `GET /datasets/{dataset_id}` (`getDataset`), `GET /datasets/{dataset_id}/policy` (`getDatasetPolicy`).

- [ ] **Step 1: Write the failing tests**

`apps/api/modules/catalog/tests/test_datasets_api.py`:

```python
from dataclasses import replace
from uuid import UUID, uuid4

import pytest

from api.modules.catalog.testing import memory_registry
from api.modules.catalog.tests.support import ORG_A, ORG_B, SHA_A, execute, insert_version, outbox_events, rows
from api.modules.catalog.tests.support_api import USERS, CatalogApi, assert_error, create_dataset, dataset_body
from api.platform.testing.contracts import assert_matches_response, assert_valid_event
from api.platform.testing.fixtures import PgUrls


def test_at01_steward_creates_controlled_dataset(api: CatalogApi, db: PgUrls) -> None:
    response = api.post("b.steward", "/datasets", json=dataset_body())
    assert response.status_code == 201, response.text
    body = response.json()
    assert_matches_response("createDataset", 201, body)
    assert body["policy"] == {
        "dataset_id": body["dataset_id"],
        "owner_organization_id": str(ORG_B),
        "access_level": "CONTROLLED",
        "allowed_purposes": ["ACADEMIC_RESEARCH", "AI_TRAINING"],
        "approval_required": True,
        "max_grant_days": 180,
    }
    assert body["owner_organization_name"] == "Institute B"
    assert body["status"] == "ACTIVE" and body["latest_published_version"] is None
    assert body["created_by"] == str(USERS["b.steward"].user_id)
    events = outbox_events(db, "catalog.dataset.created.v1")
    assert len(events) == 1
    assert_valid_event(events[0])
    assert events[0]["payload"] == {
        "dataset_id": body["dataset_id"],
        "owner_organization_id": str(ORG_B),
        "title": body["title"],
        "access_level": "CONTROLLED",
    }
    assert events[0]["actor"] == {"type": "USER", "user_id": str(USERS["b.steward"].user_id), "organization_id": str(ORG_B)}
    assert [r["dataset_id"] for r in rows(db, "SELECT dataset_id FROM catalog.index_queue")] == [UUID(body["dataset_id"])]


@pytest.mark.parametrize("user", ["b.researcher", "b.admin", "platform.admin"])
def test_at02_only_the_owner_org_steward_can_create(api: CatalogApi, db: PgUrls, user: str) -> None:
    response = api.post(user, "/datasets", json=dataset_body())
    assert response.status_code == 403
    assert_matches_response("createDataset", 403, response.json())
    assert response.json()["error"]["code"] == "FORBIDDEN"
    assert outbox_events(db) == []
    assert rows(db, "SELECT dataset_id FROM catalog.datasets") == []


def test_at03_steward_of_another_org_is_forbidden(api: CatalogApi) -> None:
    response = api.post("a.steward", "/datasets", json=dataset_body(ORG_B))
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "FORBIDDEN"


def test_at04_sensitive_with_60_days_is_invalid_policy(api: CatalogApi, db: PgUrls) -> None:
    response = api.post("b.steward", "/datasets", json=dataset_body(access_level="SENSITIVE", max_grant_days=60))
    assert response.status_code == 422
    assert_matches_response("createDataset", 422, response.json())
    assert response.json()["error"]["code"] == "INVALID_POLICY"
    assert outbox_events(db) == []


def test_sensitive_defaults_to_30_days_and_public_needs_no_approval(api: CatalogApi) -> None:
    sensitive = create_dataset(api, access_level="SENSITIVE")
    assert (sensitive["policy"]["max_grant_days"], sensitive["policy"]["approval_required"]) == (30, True)
    public = create_dataset(api, access_level="PUBLIC", max_grant_days=365)
    assert (public["policy"]["max_grant_days"], public["policy"]["approval_required"]) == (365, False)


def test_organization_without_storage_is_rejected(api: CatalogApi) -> None:
    api.use(replace(api.deps, storage=memory_registry(("nais", "inst-a"))))
    response = api.post("b.steward", "/datasets", json=dataset_body())
    assert response.status_code == 422
    assert_matches_response("createDataset", 422, response.json())
    assert response.json()["error"]["details"]["fields"] == [
        {"field": "owner_organization_id", "reason": "STORAGE_NOT_CONFIGURED"}
    ]


@pytest.mark.parametrize(
    "overrides",
    [
        {"title": "ab"},
        {"unexpected": 1},
        {"domain": None},
        {"allowed_purposes": ["AI_TRAINING", "AI_TRAINING"]},
        {"allowed_purposes": []},
        {"keywords": ["x" * 51]},
        {"contact_email": "not-an-email"},
        {"license": ""},
    ],
)
def test_invalid_bodies_are_validation_failed(api: CatalogApi, overrides: dict[str, object]) -> None:
    response = api.post("b.steward", "/datasets", json=dataset_body(**overrides))
    assert response.status_code == 422
    assert_matches_response("createDataset", 422, response.json())
    assert response.json()["error"]["code"] == "VALIDATION_FAILED"


def test_missing_token_is_unauthenticated(api: CatalogApi) -> None:
    assert_error(api.post(None, "/datasets", json=dataset_body()), 401, "UNAUTHENTICATED")


def test_at15_internal_dataset_is_visible_to_owner_org_only(api: CatalogApi) -> None:  # M03-AT-15 (GET)
    dataset_id = create_dataset(api, access_level="INTERNAL")["dataset_id"]
    for user in ("b.researcher", "b.steward", "b.admin", "platform.admin"):
        response = api.get(user, f"/datasets/{dataset_id}")
        assert response.status_code == 200, user
        assert_matches_response("getDataset", 200, response.json())
    response = api.get("a.researcher", f"/datasets/{dataset_id}")
    assert response.status_code == 404
    assert_matches_response("getDataset", 404, response.json())


def test_at17_controlled_dataset_is_visible_to_others_only_once_published(api: CatalogApi, db: PgUrls) -> None:
    dataset_id = create_dataset(api)["dataset_id"]
    assert api.get("a.researcher", f"/datasets/{dataset_id}").status_code == 404
    version_id = insert_version(db, UUID(dataset_id), published=True, files=[("data/a.csv", 10, SHA_A)])
    response = api.get("a.researcher", f"/datasets/{dataset_id}")
    assert response.status_code == 200
    body = response.json()
    assert_matches_response("getDataset", 200, body)
    latest = body["latest_published_version"]
    assert (latest["dataset_version_id"], latest["status"], latest["readiness_overall"]) == (str(version_id), "PUBLISHED", None)


def test_internal_published_dataset_stays_hidden_from_other_orgs(api: CatalogApi, db: PgUrls) -> None:
    dataset_id = create_dataset(api, access_level="INTERNAL")["dataset_id"]
    insert_version(db, UUID(dataset_id), published=True, files=[("data/a.csv", 10, SHA_A)])
    assert api.get("a.researcher", f"/datasets/{dataset_id}").status_code == 404


def test_withdrawn_dataset_is_visible_only_to_the_owner_org(api: CatalogApi, db: PgUrls) -> None:
    dataset_id = create_dataset(api)["dataset_id"]
    insert_version(db, UUID(dataset_id), published=True, files=[("data/a.csv", 10, SHA_A)])
    execute(db, "UPDATE catalog.datasets SET status = 'WITHDRAWN' WHERE dataset_id = :id", id=dataset_id)
    assert api.get("a.researcher", f"/datasets/{dataset_id}").status_code == 404
    response = api.get("b.steward", f"/datasets/{dataset_id}")
    assert response.status_code == 200 and response.json()["status"] == "WITHDRAWN"


def test_policy_view_follows_dataset_visibility(api: CatalogApi, db: PgUrls) -> None:
    created = create_dataset(api)
    response = api.get("b.researcher", f"/datasets/{created['dataset_id']}/policy")
    assert response.status_code == 200
    assert_matches_response("getDatasetPolicy", 200, response.json())
    assert response.json() == created["policy"]
    response = api.get("a.researcher", f"/datasets/{created['dataset_id']}/policy")
    assert response.status_code == 404
    assert_matches_response("getDatasetPolicy", 404, response.json())


def test_unknown_dataset_is_404(api: CatalogApi) -> None:
    assert api.get("b.steward", f"/datasets/{uuid4()}").status_code == 404


def test_datasets_of_other_orgs_are_created_in_their_own_org_only(api: CatalogApi) -> None:
    created = create_dataset(api, user="a.steward")
    assert created["owner_organization_id"] == str(ORG_A)
    assert created["owner_organization_name"] == "Institute A"
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `uv run pytest apps/api/modules/catalog/tests/test_datasets_api.py -v`
Expected: FAIL — `POST /api/v1/datasets` returns 404 (no route yet).

- [ ] **Step 3: Implement**

`apps/api/modules/catalog/repo.py`:

```python
"""Queries shared by services, jobs and public ports."""

from collections.abc import Sequence
from typing import Any, cast
from uuid import UUID

from sqlalchemy import CursorResult, Result, exists, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.engine import RowMapping
from sqlalchemy.orm import Session

from api.modules.catalog.tables import dataset_files, dataset_versions, datasets, index_queue, readiness_summaries
from api.platform import clock

PRIMARY_PROFILES: tuple[str, ...] = ("TABULAR_ML_BASIC", "GENERIC_BASIC")  # D-028 order


def must(row: RowMapping | None, what: str) -> RowMapping:
    if row is None:
        raise RuntimeError(f"{what} disappeared inside its own transaction")
    return row


def rowcount(result: Result[Any]) -> int:
    return int(cast(CursorResult[Any], result).rowcount)


def load_dataset(session: Session, dataset_id: UUID, *, for_update: bool = False) -> RowMapping | None:
    published = (
        exists()
        .where(dataset_versions.c.dataset_id == datasets.c.dataset_id, dataset_versions.c.status == "PUBLISHED")
        .label("has_published_version")
    )
    stmt = select(datasets, published).where(datasets.c.dataset_id == dataset_id)
    if for_update:
        stmt = stmt.with_for_update(of=datasets)
    return session.execute(stmt).mappings().first()


def load_version(session: Session, version_id: UUID, *, for_update: bool = False) -> RowMapping | None:
    stmt = select(dataset_versions).where(dataset_versions.c.dataset_version_id == version_id)
    if for_update:
        stmt = stmt.with_for_update()
    return session.execute(stmt).mappings().first()


def files_of_versions(session: Session, version_ids: Sequence[UUID]) -> dict[UUID, list[RowMapping]]:
    result: dict[UUID, list[RowMapping]] = {version_id: [] for version_id in version_ids}
    if not version_ids:
        return result
    stmt = (
        select(dataset_files)
        .where(dataset_files.c.dataset_version_id.in_(list(version_ids)))
        .order_by(dataset_files.c.dataset_version_id, dataset_files.c.path.collate("C"))
    )
    for row in session.execute(stmt).mappings():
        result[row["dataset_version_id"]].append(row)
    return result


def latest_published_version(session: Session, dataset_id: UUID) -> RowMapping | None:
    stmt = (
        select(dataset_versions)
        .where(dataset_versions.c.dataset_id == dataset_id, dataset_versions.c.status == "PUBLISHED")
        .order_by(dataset_versions.c.published_at.desc(), dataset_versions.c.dataset_version_id.desc())
        .limit(1)
    )
    return session.execute(stmt).mappings().first()


def readiness_overall(session: Session, version_ids: Sequence[UUID]) -> dict[UUID, str | None]:
    """M03 §4.5 primary profile rule: TABULAR_ML_BASIC COMPLETED, else GENERIC_BASIC COMPLETED, else None."""
    result: dict[UUID, str | None] = {version_id: None for version_id in version_ids}
    if not version_ids:
        return result
    stmt = select(
        readiness_summaries.c.dataset_version_id,
        readiness_summaries.c.profile_id,
        readiness_summaries.c.overall_status,
    ).where(
        readiness_summaries.c.dataset_version_id.in_(list(version_ids)),
        readiness_summaries.c.run_status == "COMPLETED",
        readiness_summaries.c.profile_id.in_(PRIMARY_PROFILES),
    )
    by_version: dict[UUID, dict[str, str | None]] = {}
    for row in session.execute(stmt):
        by_version.setdefault(row.dataset_version_id, {})[row.profile_id] = row.overall_status
    for version_id, profiles in by_version.items():
        for profile in PRIMARY_PROFILES:
            if profile in profiles:
                result[version_id] = profiles[profile]
                break
    return result


def enqueue_index(session: Session, dataset_id: UUID) -> None:
    """M03 §4.6: in the same transaction as the data change; the drain job indexes and deletes the row."""
    now = clock.now()
    stmt = pg_insert(index_queue).values(dataset_id=dataset_id, enqueued_at=now, attempts=0, next_attempt_at=now)
    session.execute(
        stmt.on_conflict_do_update(
            index_elements=[index_queue.c.dataset_id],
            set_={"enqueued_at": now, "attempts": 0, "next_attempt_at": now},
        )
    )
```

`apps/api/modules/catalog/access.py`:

```python
"""Who may see and change what (M03 §6, §9; D-011, D-012, D-013). Invisible -> 404, visible but not allowed -> 403."""

from collections.abc import Mapping
from typing import Any
from uuid import UUID

from sqlalchemy.engine import RowMapping
from sqlalchemy.orm import Session

from api.modules.catalog.domain import DATA_STEWARD, ORG_ADMIN
from api.modules.catalog.repo import load_dataset, load_version, must
from api.platform.auth import CurrentUser
from api.platform.errors import ApiError
from api.platform.generated.error_codes import ErrorCode


def is_steward(user: CurrentUser, owner_organization_id: UUID) -> bool:
    return user.has_org_role(owner_organization_id, DATA_STEWARD)


def can_see_all_versions(user: CurrentUser, owner_organization_id: UUID) -> bool:
    return (
        user.is_platform_admin
        or user.has_org_role(owner_organization_id, DATA_STEWARD)
        or user.has_org_role(owner_organization_id, ORG_ADMIN)
    )


def can_see_dataset(user: CurrentUser, ds: Mapping[Any, Any]) -> bool:
    """D-012 metadata visibility, evaluated on the DB row (same rule as the search filter, plus owner/admin
    access to WITHDRAWN datasets so the steward can reactivate them)."""
    if user.is_platform_admin or user.organization_id == ds["owner_organization_id"]:
        return True
    return ds["status"] == "ACTIVE" and ds["access_level"] != "INTERNAL" and bool(ds["has_published_version"])


def can_see_version(user: CurrentUser, ds: Mapping[Any, Any], version: Mapping[Any, Any]) -> bool:
    return can_see_dataset(user, ds) and (
        version["status"] == "PUBLISHED" or can_see_all_versions(user, ds["owner_organization_id"])
    )


def not_found(what: str = "Resource") -> ApiError:
    return ApiError(ErrorCode.NOT_FOUND, f"{what} not found.")


def visible_dataset(session: Session, user: CurrentUser, dataset_id: UUID, *, for_update: bool = False) -> RowMapping:
    ds = load_dataset(session, dataset_id, for_update=for_update)
    if ds is None or not can_see_dataset(user, ds):
        raise not_found("Dataset")
    return ds


def require_steward(user: CurrentUser, ds: Mapping[Any, Any]) -> None:
    if not is_steward(user, ds["owner_organization_id"]):
        raise ApiError(ErrorCode.FORBIDDEN, "Only a DATA_STEWARD of the owner organization can do this.")


def steward_version(
    session: Session, user: CurrentUser, version_id: UUID, *, for_update: bool = False
) -> tuple[RowMapping, RowMapping]:
    version = load_version(session, version_id, for_update=for_update)
    if version is None:
        raise not_found("Dataset version")
    ds = must(load_dataset(session, version["dataset_id"]), "dataset")
    if not can_see_version(user, ds, version):
        raise not_found("Dataset version")
    require_steward(user, ds)
    return version, ds


def require_draft(version: Mapping[Any, Any]) -> None:
    if version["status"] != "DRAFT":
        raise ApiError(
            ErrorCode.DATASET_VERSION_IMMUTABLE, f"Dataset version is {version['status']} and cannot be modified."
        )
```

`apps/api/modules/catalog/schemas.py`:

```python
"""Request bodies (openapi components). Explicit null is rejected: the contract types are non-nullable."""

from typing import Annotated, Any, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, EmailStr, Field, StringConstraints, field_validator, model_validator

AccessLevelIn = Literal["PUBLIC", "INTERNAL", "CONTROLLED", "SENSITIVE"]
PurposeIn = Literal["ACADEMIC_RESEARCH", "AI_TRAINING", "COMMERCIAL_RESEARCH", "EDUCATION", "PUBLIC_INTEREST"]
ReadinessIn = Literal["PASS", "WARNING", "FAIL"]
SortIn = Literal["relevance", "updated_desc", "title_asc"]

Title = Annotated[str, StringConstraints(min_length=3, max_length=300)]
Description = Annotated[str, StringConstraints(max_length=20000)]
Keyword = Annotated[str, StringConstraints(min_length=1, max_length=50)]
Keywords = Annotated[list[Keyword], Field(max_length=30)]
LongText = Annotated[str, StringConstraints(max_length=10000)]
License = Annotated[str, StringConstraints(min_length=1, max_length=200)]
Purposes = Annotated[list[PurposeIn], Field(min_length=1)]
GrantDays = Annotated[int, Field(ge=1, le=365)]


class StrictIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    @model_validator(mode="before")
    @classmethod
    def _no_nulls(cls, data: Any) -> Any:
        if isinstance(data, dict):
            nulls = sorted(key for key, value in data.items() if value is None)
            if nulls:
                raise ValueError(f"null is not allowed for: {', '.join(nulls)}")
        return data


def _unique(values: list[str]) -> list[str]:
    if len(set(values)) != len(values):
        raise ValueError("allowed_purposes must be unique")
    return values


class DatasetCreateIn(StrictIn):
    owner_organization_id: UUID
    title: Title
    description: Description
    keywords: Keywords = Field(default_factory=list)
    domain: str | None = None
    access_level: AccessLevelIn
    license: License
    usage_policy: LongText | None = None
    allowed_purposes: Purposes
    max_grant_days: GrantDays | None = None
    contact_email: EmailStr | None = None
    provenance: LongText | None = None

    @field_validator("allowed_purposes")
    @classmethod
    def _purposes_unique(cls, value: list[str]) -> list[str]:
        return _unique(value)


class DatasetUpdateIn(StrictIn):
    title: Title | None = None
    description: Description | None = None
    keywords: Keywords | None = None
    domain: str | None = None
    access_level: AccessLevelIn | None = None
    license: License | None = None
    usage_policy: LongText | None = None
    allowed_purposes: Purposes | None = None
    max_grant_days: GrantDays | None = None
    contact_email: EmailStr | None = None
    provenance: LongText | None = None
    status: Literal["ACTIVE", "WITHDRAWN"] | None = None

    @field_validator("allowed_purposes")
    @classmethod
    def _purposes_unique(cls, value: list[str] | None) -> list[str] | None:
        return None if value is None else _unique(value)

    @model_validator(mode="after")
    def _not_empty(self) -> "DatasetUpdateIn":
        if not self.model_fields_set:
            raise ValueError("at least one field is required")
        return self


class VersionCreateIn(StrictIn):
    version_label: Annotated[str, StringConstraints(pattern=r"^[A-Za-z0-9._-]{1,32}$")]
    change_note: Annotated[str, StringConstraints(max_length=2000)] | None = None


class UploadFileIn(StrictIn):
    path: Annotated[str, StringConstraints(pattern=r"^[A-Za-z0-9._/-]{1,512}$")]
    size_bytes: Annotated[int, Field(ge=1)]  # the 50 GiB limit is FILE_TOO_LARGE, checked by the service
    sha256: Annotated[str, StringConstraints(pattern=r"^[a-f0-9]{64}$")]
    media_type: Annotated[str, StringConstraints(min_length=1, max_length=255)]


class UploadSessionCreateIn(StrictIn):
    files: Annotated[list[UploadFileIn], Field(min_length=1, max_length=500)]


class PartEtagIn(BaseModel):
    part_number: Annotated[int, Field(ge=1)]
    etag: Annotated[str, StringConstraints(min_length=1)]


class FilePartsIn(BaseModel):
    file_id: UUID
    etags: list[PartEtagIn]


class UploadCompleteIn(StrictIn):
    parts: list[FilePartsIn] = Field(default_factory=list)
```

`apps/api/modules/catalog/views.py`:

```python
"""Response bodies matching openapi components. Storage bucket/key and URLs never appear here (M03 §6.6)."""

from collections.abc import Mapping, Sequence
from typing import Any


def policy_view(ds: Mapping[Any, Any]) -> dict[str, Any]:
    return {
        "dataset_id": ds["dataset_id"],
        "owner_organization_id": ds["owner_organization_id"],
        "access_level": ds["access_level"],
        "allowed_purposes": list(ds["allowed_purposes"]),
        "approval_required": ds["approval_required"],
        "max_grant_days": ds["max_grant_days"],
    }


def version_summary(version: Mapping[Any, Any], readiness: str | None) -> dict[str, Any]:
    return {
        "dataset_version_id": version["dataset_version_id"],
        "version_label": version["version_label"],
        "status": version["status"],
        "published_at": version["published_at"],
        "readiness_overall": readiness,
    }


def dataset_view(
    ds: Mapping[Any, Any],
    *,
    org_name: str | None,
    latest: Mapping[Any, Any] | None,
    latest_readiness: str | None,
) -> dict[str, Any]:
    body: dict[str, Any] = {
        "dataset_id": ds["dataset_id"],
        "owner_organization_id": ds["owner_organization_id"],
        "title": ds["title"],
        "description": ds["description"],
        "keywords": list(ds["keywords"]),
        "domain": ds["domain"],
        "access_level": ds["access_level"],
        "license": ds["license"],
        "usage_policy": ds["usage_policy"],
        "contact_email": ds["contact_email"],
        "provenance": ds["provenance"],
        "policy": policy_view(ds),
        "status": ds["status"],
        "latest_published_version": None if latest is None else version_summary(latest, latest_readiness),
        "created_by": ds["created_by"],
        "created_at": ds["created_at"],
        "updated_at": ds["updated_at"],
    }
    if org_name:
        body["owner_organization_name"] = org_name
    return body


def file_view(f: Mapping[Any, Any]) -> dict[str, Any]:
    return {
        "file_id": f["file_id"],
        "path": f["path"],
        "size_bytes": f["size_bytes"],
        "sha256": f["sha256"],
        "media_type": f["media_type"],
        "status": f["status"],
    }


def version_view(
    version: Mapping[Any, Any], files: Sequence[Mapping[Any, Any]], readiness: str | None
) -> dict[str, Any]:
    return {
        **version_summary(version, readiness),
        "dataset_id": version["dataset_id"],
        "change_note": version["change_note"],
        "files": [file_view(f) for f in files],
        "file_count": len(files),
        "total_bytes": sum(int(f["size_bytes"]) for f in files),
        "manifest_sha256": version["manifest_sha256"],
        "created_at": version["created_at"],
    }
```

`apps/api/modules/catalog/service/datasets.py`:

```python
"""createDataset / getDataset / getDatasetPolicy (M03 §6.1, §6.3, §6.5)."""

from collections.abc import Mapping
from typing import Any
from uuid import UUID

from sqlalchemy import insert
from sqlalchemy.engine import RowMapping
from sqlalchemy.orm import Session

from api.modules.catalog.access import is_steward, visible_dataset
from api.modules.catalog.deps import CatalogDeps
from api.modules.catalog.domain import InvalidPolicy, Policy, build_policy, normalize_keywords
from api.modules.catalog.repo import enqueue_index, latest_published_version, load_dataset, must, readiness_overall
from api.modules.catalog.schemas import DatasetCreateIn
from api.modules.catalog.tables import datasets
from api.modules.catalog.views import dataset_view, policy_view
from api.platform import clock
from api.platform.auth import CurrentUser
from api.platform.errors import ApiError
from api.platform.events import EventActor
from api.platform.generated.error_codes import ErrorCode
from api.platform.ids import new_id
from api.platform.outbox import outbox


def policy_or_error(access_level: str, purposes: Any, max_grant_days: int | None) -> Policy:
    try:
        return build_policy(access_level, purposes, max_grant_days)
    except InvalidPolicy as exc:
        raise ApiError(ErrorCode.INVALID_POLICY, str(exc)) from exc


def insert_dataset(
    session: Session,
    *,
    dataset_id: UUID,
    owner: UUID,
    created_by: UUID,
    fields: Mapping[Any, Any],
    policy: Policy,
    actor: EventActor,
) -> None:
    now = clock.now()
    session.execute(
        insert(datasets).values(
            dataset_id=dataset_id,
            owner_organization_id=owner,
            title=fields["title"],
            description=fields.get("description") or "",
            keywords=normalize_keywords(fields.get("keywords") or []),
            domain=fields.get("domain"),
            access_level=policy.access_level,
            license=fields["license"],
            usage_policy=fields.get("usage_policy"),
            allowed_purposes=list(policy.allowed_purposes),
            approval_required=policy.approval_required,
            max_grant_days=policy.max_grant_days,
            contact_email=fields.get("contact_email"),
            provenance=fields.get("provenance"),
            status="ACTIVE",
            created_by=created_by,
            created_at=now,
            updated_at=now,
            row_version=1,
        )
    )
    outbox.write(
        session,
        "catalog.dataset.created.v1",
        {
            "dataset_id": str(dataset_id),
            "owner_organization_id": str(owner),
            "title": fields["title"],
            "access_level": policy.access_level,
        },
        actor,
    )
    enqueue_index(session, dataset_id)


def dataset_response(session: Session, deps: CatalogDeps, ds: RowMapping) -> dict[str, Any]:
    latest = latest_published_version(session, ds["dataset_id"])
    readiness = readiness_overall(session, [latest["dataset_version_id"]]) if latest else {}
    org = deps.organizations.get_organization_summary(ds["owner_organization_id"])
    return dataset_view(
        ds,
        org_name=org.name if org else None,
        latest=latest,
        latest_readiness=readiness.get(latest["dataset_version_id"]) if latest else None,
    )


def create_dataset(session: Session, deps: CatalogDeps, user: CurrentUser, body: DatasetCreateIn) -> dict[str, Any]:
    owner = body.owner_organization_id
    if not is_steward(user, owner):
        raise ApiError(ErrorCode.FORBIDDEN, "Only a DATA_STEWARD of the owner organization can create datasets.")
    policy = policy_or_error(body.access_level, body.allowed_purposes, body.max_grant_days)
    org = deps.organizations.get_organization_summary(owner)
    if org is None or not deps.storage.is_configured(org.code):
        raise ApiError(
            ErrorCode.VALIDATION_FAILED,
            "The owner organization has no storage configured.",
            {"fields": [{"field": "owner_organization_id", "reason": "STORAGE_NOT_CONFIGURED"}]},
        )
    dataset_id = new_id()
    insert_dataset(
        session,
        dataset_id=dataset_id,
        owner=owner,
        created_by=user.user_id,
        fields=body.model_dump(exclude={"owner_organization_id", "access_level", "allowed_purposes", "max_grant_days"}),
        policy=policy,
        actor=EventActor.for_user(user),
    )
    return dataset_response(session, deps, must(load_dataset(session, dataset_id), "dataset"))


def get_dataset(session: Session, deps: CatalogDeps, user: CurrentUser, dataset_id: UUID) -> dict[str, Any]:
    return dataset_response(session, deps, visible_dataset(session, user, dataset_id))


def get_policy(session: Session, user: CurrentUser, dataset_id: UUID) -> dict[str, Any]:
    return policy_view(visible_dataset(session, user, dataset_id))
```

`apps/api/modules/catalog/routes/datasets.py`:

```python
from typing import Any
from uuid import UUID

from fastapi import APIRouter

from api.modules.catalog.deps import CatalogDepsDep
from api.modules.catalog.schemas import DatasetCreateIn
from api.modules.catalog.service import datasets as service
from api.platform.auth import CurrentUserDep
from api.platform.db import SessionDep

router = APIRouter(tags=["catalog"])


@router.post("/datasets", operation_id="createDataset", status_code=201)
def create_dataset(
    body: DatasetCreateIn, session: SessionDep, user: CurrentUserDep, deps: CatalogDepsDep
) -> dict[str, Any]:
    return service.create_dataset(session, deps, user, body)


@router.get("/datasets/{dataset_id}", operation_id="getDataset")
def get_dataset(dataset_id: UUID, session: SessionDep, user: CurrentUserDep, deps: CatalogDepsDep) -> dict[str, Any]:
    return service.get_dataset(session, deps, user, dataset_id)


@router.get("/datasets/{dataset_id}/policy", operation_id="getDatasetPolicy")
def get_dataset_policy(dataset_id: UUID, session: SessionDep, user: CurrentUserDep) -> dict[str, Any]:
    return service.get_policy(session, user, dataset_id)
```

`apps/api/modules/catalog/router.py`:

```python
"""All catalog routes (mounted under /api/v1 by the platform)."""

from fastapi import APIRouter

from api.modules.catalog.routes import datasets

router = APIRouter()
router.include_router(datasets.router)
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `uv run pytest apps/api/modules/catalog/tests/test_datasets_api.py -v`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
uv run ruff check --fix apps/api/modules/catalog && uv run ruff format apps/api/modules/catalog
git add apps/api/modules/catalog
git commit -m "feat(catalog): create/get dataset and policy view with D-012 visibility

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 7: `updateDataset` — optimistic lock, policy re-validation, policy/access-level events

**Files:**
- Create: `apps/api/modules/catalog/service/dataset_update.py`
- Create: `apps/api/modules/catalog/routes/dataset_update.py`
- Modify: `apps/api/modules/catalog/router.py`
- Test: `apps/api/modules/catalog/tests/test_dataset_update.py`

**Interfaces:**
- Consumes: `visible_dataset`, `require_steward` (Task 6), `policy_or_error`, `dataset_response` (Task 6), `Policy`, `normalize_purposes`, `normalize_keywords` (Task 1), `enqueue_index`, `load_dataset`, `must`, `rowcount` (Task 6), `DatasetUpdateIn`.
- Produces: `service.dataset_update.update_dataset(session, deps, user, dataset_id, body) -> dict`; route `PATCH /datasets/{dataset_id}` (`updateDataset`). Events: `catalog.dataset.access_level_changed.v1` when access_level changes; `catalog.dataset.policy_changed.v1` when `allowed_purposes` (as a set), `approval_required` or `max_grant_days` change; both share the request correlation id. Always re-enqueues the dataset for indexing.

- [ ] **Step 1: Write the failing tests**

`apps/api/modules/catalog/tests/test_dataset_update.py`:

```python
from uuid import UUID

import pytest

from api.modules.catalog.service import dataset_update
from api.modules.catalog.tests.support import SHA_A, execute, insert_version, outbox_events, rows
from api.modules.catalog.tests.support_api import CatalogApi, assert_error, create_dataset
from api.platform.testing.contracts import assert_matches_response, assert_valid_event
from api.platform.testing.fixtures import PgUrls


def _clear_outbox(db: PgUrls) -> None:
    execute(db, "DELETE FROM platform.outbox_events")


def test_at21_controlled_to_public_emits_access_level_changed(api: CatalogApi, db: PgUrls) -> None:
    dataset_id = create_dataset(api)["dataset_id"]
    _clear_outbox(db)
    response = api.patch("b.steward", f"/datasets/{dataset_id}", json={"access_level": "PUBLIC"})
    assert response.status_code == 200, response.text
    body = response.json()
    assert_matches_response("updateDataset", 200, body)
    assert (body["access_level"], body["policy"]["approval_required"]) == ("PUBLIC", False)
    changed = outbox_events(db, "catalog.dataset.access_level_changed.v1")
    assert len(changed) == 1
    assert_valid_event(changed[0])
    assert changed[0]["payload"]["previous_access_level"] == "CONTROLLED"
    assert changed[0]["payload"]["access_level"] == "PUBLIC"
    # approval_required flipped true -> false, which §6.4 counts as a policy change
    policy = outbox_events(db, "catalog.dataset.policy_changed.v1")
    assert len(policy) == 1
    assert_valid_event(policy[0])
    assert policy[0]["payload"]["previous"]["approval_required"] is True
    assert policy[0]["payload"]["current"]["approval_required"] is False
    assert changed[0]["correlation_id"] == policy[0]["correlation_id"]


def test_purpose_change_emits_policy_changed_only(api: CatalogApi, db: PgUrls) -> None:
    dataset_id = create_dataset(api)["dataset_id"]
    _clear_outbox(db)
    response = api.patch("b.steward", f"/datasets/{dataset_id}", json={"allowed_purposes": ["EDUCATION"], "max_grant_days": 90})
    assert response.status_code == 200
    assert outbox_events(db, "catalog.dataset.access_level_changed.v1") == []
    [event] = outbox_events(db, "catalog.dataset.policy_changed.v1")
    assert event["payload"]["previous"] == {"allowed_purposes": ["ACADEMIC_RESEARCH", "AI_TRAINING"], "approval_required": True, "max_grant_days": 180}
    assert event["payload"]["current"] == {"allowed_purposes": ["EDUCATION"], "approval_required": True, "max_grant_days": 90}


def test_noop_and_reordered_purposes_emit_no_policy_events(api: CatalogApi, db: PgUrls) -> None:  # Review Focus 3
    dataset_id = create_dataset(api)["dataset_id"]
    _clear_outbox(db)
    same = {"access_level": "CONTROLLED", "allowed_purposes": ["AI_TRAINING", "ACADEMIC_RESEARCH"], "max_grant_days": 180}
    assert api.patch("b.steward", f"/datasets/{dataset_id}", json=same).status_code == 200
    assert api.patch("b.steward", f"/datasets/{dataset_id}", json={"title": "Renamed dataset"}).status_code == 200
    assert outbox_events(db) == []
    assert rows(db, "SELECT count(*) AS n FROM catalog.index_queue")[0]["n"] == 1


def test_raising_to_sensitive_with_long_grants_is_invalid_policy(api: CatalogApi) -> None:
    dataset_id = create_dataset(api)["dataset_id"]
    response = api.patch("b.steward", f"/datasets/{dataset_id}", json={"access_level": "SENSITIVE"})
    assert response.status_code == 422
    assert_matches_response("updateDataset", 422, response.json())
    assert response.json()["error"]["code"] == "INVALID_POLICY"
    ok = api.patch("b.steward", f"/datasets/{dataset_id}", json={"access_level": "SENSITIVE", "max_grant_days": 30})
    assert ok.status_code == 200 and ok.json()["policy"]["max_grant_days"] == 30


def test_published_snapshot_is_not_touched_by_updates(api: CatalogApi, db: PgUrls) -> None:
    dataset_id = create_dataset(api)["dataset_id"]
    version_id = insert_version(db, UUID(dataset_id), published=True, files=[("data/a.csv", 10, SHA_A)])
    assert api.patch("b.steward", f"/datasets/{dataset_id}", json={"title": "Changed later"}).status_code == 200
    snapshot = rows(db, "SELECT metadata_snapshot FROM catalog.dataset_versions WHERE dataset_version_id = :v", v=version_id)
    assert snapshot == [{"metadata_snapshot": {}}]


def test_non_steward_gets_403_and_invisible_dataset_404(api: CatalogApi) -> None:
    dataset_id = create_dataset(api, access_level="INTERNAL")["dataset_id"]
    response = api.patch("b.researcher", f"/datasets/{dataset_id}", json={"title": "Nope nope"})
    assert response.status_code == 403
    assert_matches_response("updateDataset", 403, response.json())
    assert_error(api.patch("a.steward", f"/datasets/{dataset_id}", json={"title": "Nope nope"}), 404, "NOT_FOUND")


def test_withdrawn_dataset_can_only_be_reactivated(api: CatalogApi, db: PgUrls) -> None:
    dataset_id = create_dataset(api)["dataset_id"]
    response = api.patch("b.steward", f"/datasets/{dataset_id}", json={"status": "WITHDRAWN"})
    assert response.status_code == 200 and response.json()["status"] == "WITHDRAWN"
    assert_error(api.patch("b.steward", f"/datasets/{dataset_id}", json={"title": "Edited while withdrawn"}), 409, "CONFLICT")
    assert_error(
        api.patch("b.steward", f"/datasets/{dataset_id}", json={"status": "ACTIVE", "title": "Both at once"}), 409, "CONFLICT"
    )
    response = api.patch("b.steward", f"/datasets/{dataset_id}", json={"status": "ACTIVE"})
    assert response.status_code == 200 and response.json()["status"] == "ACTIVE"


@pytest.mark.parametrize("body", [{}, {"title": None}, {"row_version": 3}, {"allowed_purposes": []}])
def test_invalid_patch_bodies(api: CatalogApi, body: dict[str, object]) -> None:
    dataset_id = create_dataset(api)["dataset_id"]
    response = api.patch("b.steward", f"/datasets/{dataset_id}", json=body)
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "VALIDATION_FAILED"


def test_concurrent_modification_is_a_conflict(api: CatalogApi, db: PgUrls, monkeypatch: pytest.MonkeyPatch) -> None:
    dataset_id = create_dataset(api)["dataset_id"]
    original = dataset_update.visible_dataset

    def racing(session, user, did, **kwargs):  # type: ignore[no-untyped-def]
        row = original(session, user, did, **kwargs)
        execute(db, "UPDATE catalog.datasets SET row_version = row_version + 1 WHERE dataset_id = :id", id=did)
        return row

    monkeypatch.setattr(dataset_update, "visible_dataset", racing)
    assert_error(api.patch("b.steward", f"/datasets/{dataset_id}", json={"title": "Lost update"}), 409, "CONFLICT")
    title = rows(db, "SELECT title FROM catalog.datasets WHERE dataset_id = :id", id=dataset_id)[0]["title"]
    assert title == "Battery Cycling Measurements"
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `uv run pytest apps/api/modules/catalog/tests/test_dataset_update.py -v`
Expected: collection error `cannot import name 'dataset_update'`.

- [ ] **Step 3: Implement**

`apps/api/modules/catalog/service/dataset_update.py`:

```python
"""updateDataset (M03 §6.4): steward only, row_version compare-and-swap, policy events, index refresh.

Existing grants are never changed here (openapi); PUBLISHED metadata_snapshot is never changed (DB trigger).
"""

from typing import Any
from uuid import UUID

from sqlalchemy import update
from sqlalchemy.orm import Session

from api.modules.catalog.access import require_steward, visible_dataset
from api.modules.catalog.deps import CatalogDeps
from api.modules.catalog.domain import Policy, normalize_keywords, normalize_purposes
from api.modules.catalog.repo import enqueue_index, load_dataset, must, rowcount
from api.modules.catalog.schemas import DatasetUpdateIn
from api.modules.catalog.service.datasets import dataset_response, policy_or_error
from api.modules.catalog.tables import datasets
from api.platform import clock
from api.platform.auth import CurrentUser
from api.platform.errors import ApiError
from api.platform.events import EventActor
from api.platform.generated.error_codes import ErrorCode
from api.platform.outbox import outbox

POLICY_INPUTS = ("access_level", "allowed_purposes", "max_grant_days")


def update_dataset(
    session: Session, deps: CatalogDeps, user: CurrentUser, dataset_id: UUID, body: DatasetUpdateIn
) -> dict[str, Any]:
    ds = visible_dataset(session, user, dataset_id)
    require_steward(user, ds)
    changes = body.model_dump(exclude_unset=True)
    if ds["status"] == "WITHDRAWN" and changes != {"status": "ACTIVE"}:
        raise ApiError(ErrorCode.CONFLICT, "A WITHDRAWN dataset can only be reactivated with {\"status\": \"ACTIVE\"}.")

    previous = Policy(
        ds["access_level"],
        normalize_purposes(ds["allowed_purposes"]),
        ds["approval_required"],
        ds["max_grant_days"],
    )
    policy = policy_or_error(
        changes.get("access_level", ds["access_level"]),
        changes.get("allowed_purposes", ds["allowed_purposes"]),
        changes.get("max_grant_days", ds["max_grant_days"]),
    )
    values: dict[str, Any] = {key: value for key, value in changes.items() if key not in POLICY_INPUTS}
    if "keywords" in values:
        values["keywords"] = normalize_keywords(values["keywords"])
    values.update(
        access_level=policy.access_level,
        allowed_purposes=list(policy.allowed_purposes),
        approval_required=policy.approval_required,
        max_grant_days=policy.max_grant_days,
        updated_at=clock.now(),
        row_version=ds["row_version"] + 1,
    )
    result = session.execute(
        update(datasets)
        .where(datasets.c.dataset_id == dataset_id, datasets.c.row_version == ds["row_version"])
        .values(**values)
    )
    if rowcount(result) != 1:
        raise ApiError(ErrorCode.CONFLICT, "The dataset was modified concurrently; reload it and retry.")

    actor = EventActor.for_user(user)
    owner = str(ds["owner_organization_id"])
    if policy.access_level != previous.access_level:
        outbox.write(
            session,
            "catalog.dataset.access_level_changed.v1",
            {
                "dataset_id": str(dataset_id),
                "owner_organization_id": owner,
                "previous_access_level": previous.access_level,
                "access_level": policy.access_level,
            },
            actor,
        )
    if policy.as_event() != previous.as_event():
        outbox.write(
            session,
            "catalog.dataset.policy_changed.v1",
            {
                "dataset_id": str(dataset_id),
                "owner_organization_id": owner,
                "previous": previous.as_event(),
                "current": policy.as_event(),
            },
            actor,
        )
    enqueue_index(session, dataset_id)
    return dataset_response(session, deps, must(load_dataset(session, dataset_id), "dataset"))
```

`apps/api/modules/catalog/routes/dataset_update.py`:

```python
from typing import Any
from uuid import UUID

from fastapi import APIRouter

from api.modules.catalog.deps import CatalogDepsDep
from api.modules.catalog.schemas import DatasetUpdateIn
from api.modules.catalog.service import dataset_update as service
from api.platform.auth import CurrentUserDep
from api.platform.db import SessionDep

router = APIRouter(tags=["catalog"])


@router.patch("/datasets/{dataset_id}", operation_id="updateDataset")
def update_dataset(
    dataset_id: UUID, body: DatasetUpdateIn, session: SessionDep, user: CurrentUserDep, deps: CatalogDepsDep
) -> dict[str, Any]:
    return service.update_dataset(session, deps, user, dataset_id, body)
```

`apps/api/modules/catalog/router.py`:

```python
"""All catalog routes (mounted under /api/v1 by the platform)."""

from fastapi import APIRouter

from api.modules.catalog.routes import dataset_update, datasets

router = APIRouter()
for sub in (datasets.router, dataset_update.router):
    router.include_router(sub)
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `uv run pytest apps/api/modules/catalog/tests/test_dataset_update.py apps/api/modules/catalog/tests/test_datasets_api.py -v`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
uv run ruff check --fix apps/api/modules/catalog && uv run ruff format apps/api/modules/catalog
git add apps/api/modules/catalog
git commit -m "feat(catalog): updateDataset with optimistic lock and policy/access-level events

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 8: Versions API — `createDatasetVersion`, `listDatasetVersions`, `getDatasetVersion`

**Files:**
- Create: `apps/api/modules/catalog/service/versions.py`
- Create: `apps/api/modules/catalog/routes/versions.py`
- Modify: `apps/api/modules/catalog/router.py`
- Modify: `apps/api/modules/catalog/tests/support_api.py` (append `new_draft`)
- Test: `apps/api/modules/catalog/tests/test_versions_api.py`

**Interfaces:**
- Consumes: `visible_dataset`, `require_steward`, `can_see_all_versions`, `can_see_version`, `not_found` (Task 6), `load_version`, `load_dataset`, `files_of_versions`, `readiness_overall`, `must` (Task 6), `version_view` (Task 6), `VersionCreateIn`.
- Produces: `service.versions.version_response(session, version) -> dict`, `create_version(session, user, dataset_id, body) -> dict`, `list_versions(session, user, dataset_id) -> dict` (`{"items": [...]}`, newest first), `get_version(session, user, version_id) -> dict`; routes `POST /datasets/{dataset_id}/versions` (201), `GET /datasets/{dataset_id}/versions`, `GET /dataset-versions/{version_id}`; test helper `support_api.new_draft(api, user="b.steward", **dataset_overrides) -> tuple[str, str]` (dataset_id, version_id).

- [ ] **Step 1: Write the failing tests**

Append to `apps/api/modules/catalog/tests/support_api.py`:

```python
def new_draft(api: CatalogApi, user: str = "b.steward", **dataset_overrides: Any) -> tuple[str, str]:
    dataset_id = create_dataset(api, user, **dataset_overrides)["dataset_id"]
    response = api.post(user, f"/datasets/{dataset_id}/versions", json={"version_label": "v1"})
    assert response.status_code == 201, response.text
    return dataset_id, response.json()["dataset_version_id"]
```

`apps/api/modules/catalog/tests/test_versions_api.py`:

```python
from uuid import UUID, uuid4

import pytest

from api.modules.catalog.tests.support import SHA_A, execute, insert_file, insert_version
from api.modules.catalog.tests.support_api import CatalogApi, assert_error, create_dataset, new_draft
from api.platform.testing.contracts import assert_matches_response
from api.platform.testing.fixtures import PgUrls


def test_steward_creates_a_draft_version(api: CatalogApi) -> None:
    dataset_id = create_dataset(api)["dataset_id"]
    response = api.post("b.steward", f"/datasets/{dataset_id}/versions", json={"version_label": "2026.09", "change_note": "first"})
    assert response.status_code == 201, response.text
    body = response.json()
    assert_matches_response("createDatasetVersion", 201, body)
    assert (body["status"], body["files"], body["file_count"], body["manifest_sha256"]) == ("DRAFT", [], 0, None)
    assert body["dataset_id"] == dataset_id and body["change_note"] == "first"


def test_at13_new_version_after_publish_and_label_reuse(api: CatalogApi, db: PgUrls) -> None:
    dataset_id = create_dataset(api)["dataset_id"]
    insert_version(db, UUID(dataset_id), label="v1", published=True, files=[("data/a.csv", 10, SHA_A)])
    response = api.post("b.steward", f"/datasets/{dataset_id}/versions", json={"version_label": "v2"})
    assert response.status_code == 201
    response = api.post("b.steward", f"/datasets/{dataset_id}/versions", json={"version_label": "v1"})
    assert response.status_code == 409
    assert_matches_response("createDatasetVersion", 409, response.json())
    assert response.json()["error"]["code"] == "DATASET_VERSION_LABEL_EXISTS"


def test_several_drafts_may_coexist(api: CatalogApi) -> None:
    dataset_id = create_dataset(api)["dataset_id"]
    for label in ("a", "b"):
        assert api.post("b.steward", f"/datasets/{dataset_id}/versions", json={"version_label": label}).status_code == 201


def test_withdrawn_dataset_gets_no_new_versions(api: CatalogApi, db: PgUrls) -> None:
    dataset_id = create_dataset(api)["dataset_id"]
    execute(db, "UPDATE catalog.datasets SET status = 'WITHDRAWN' WHERE dataset_id = :id", id=dataset_id)
    response = api.post("b.steward", f"/datasets/{dataset_id}/versions", json={"version_label": "v1"})
    assert response.status_code == 409
    assert response.json()["error"]["code"] == "CONFLICT"


@pytest.mark.parametrize("label", ["", "has space", "x" * 33, "ü"])
def test_bad_labels_are_rejected(api: CatalogApi, label: str) -> None:
    dataset_id = create_dataset(api)["dataset_id"]
    response = api.post("b.steward", f"/datasets/{dataset_id}/versions", json={"version_label": label})
    assert response.status_code == 422


def test_version_creation_permissions(api: CatalogApi) -> None:
    dataset_id = create_dataset(api, access_level="INTERNAL")["dataset_id"]
    response = api.post("b.researcher", f"/datasets/{dataset_id}/versions", json={"version_label": "v1"})
    assert response.status_code == 403
    assert_matches_response("createDatasetVersion", 403, response.json())
    assert_error(api.post("a.steward", f"/datasets/{dataset_id}/versions", json={"version_label": "v1"}), 404, "NOT_FOUND")


def test_list_versions_by_role(api: CatalogApi, db: PgUrls) -> None:
    dataset_id, draft_id = new_draft(api)
    published_id = insert_version(db, UUID(dataset_id), label="v0", published=True, files=[("data/a.csv", 10, SHA_A)])
    expectations = {
        "b.steward": {draft_id, str(published_id)},
        "b.admin": {draft_id, str(published_id)},
        "platform.admin": {draft_id, str(published_id)},
        "b.researcher": {str(published_id)},
        "a.researcher": {str(published_id)},
    }
    for user, expected in expectations.items():
        response = api.get(user, f"/datasets/{dataset_id}/versions")
        assert response.status_code == 200, user
        assert_matches_response("listDatasetVersions", 200, response.json())
        assert {item["dataset_version_id"] for item in response.json()["items"]} == expected, user


def test_list_versions_of_invisible_dataset_is_404(api: CatalogApi) -> None:
    dataset_id, _ = new_draft(api)
    assert_error(api.get("a.researcher", f"/datasets/{dataset_id}/versions"), 404, "NOT_FOUND")


def test_at17_draft_version_is_404_for_non_stewards(api: CatalogApi) -> None:  # M03-AT-17 (GET v-draft)
    _, version_id = new_draft(api)
    for user in ("a.researcher", "b.researcher"):
        response = api.get(user, f"/dataset-versions/{version_id}")
        assert response.status_code == 404, user
        assert_matches_response("getDatasetVersion", 404, response.json())
    assert api.get("b.steward", f"/dataset-versions/{version_id}").status_code == 200


def test_version_manifest_has_no_storage_details(api: CatalogApi, db: PgUrls) -> None:
    dataset_id = create_dataset(api)["dataset_id"]
    version_id = insert_version(db, UUID(dataset_id), published=True, files=[("data/b.csv", 20, SHA_A), ("B.csv", 10, SHA_A)])
    response = api.get("a.researcher", f"/dataset-versions/{version_id}")
    assert response.status_code == 200
    body = response.json()
    assert_matches_response("getDatasetVersion", 200, body)
    assert [f["path"] for f in body["files"]] == ["B.csv", "data/b.csv"]
    assert (body["file_count"], body["total_bytes"]) == (2, 30)
    assert "storage" not in response.text and "nais-inst-b" not in response.text and "datasets/" not in response.text


def test_draft_files_are_listed_with_their_status(api: CatalogApi, db: PgUrls) -> None:
    _, version_id = new_draft(api)
    insert_file(db, UUID(version_id), path="data/a.csv", status="FAILED")
    body = api.get("b.steward", f"/dataset-versions/{version_id}").json()
    assert [(f["path"], f["status"]) for f in body["files"]] == [("data/a.csv", "FAILED")]


def test_unknown_version_is_404(api: CatalogApi) -> None:
    assert api.get("b.steward", f"/dataset-versions/{uuid4()}").status_code == 404
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `uv run pytest apps/api/modules/catalog/tests/test_versions_api.py -v`
Expected: FAIL — version routes return 404 (`new_draft` asserts 201).

- [ ] **Step 3: Implement**

`apps/api/modules/catalog/service/versions.py`:

```python
"""Dataset versions (M03 §5.1, §6.6): DRAFT creation, listing and detail with the file manifest."""

from typing import Any
from uuid import UUID

from sqlalchemy import insert, select
from sqlalchemy.engine import RowMapping
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from api.modules.catalog.access import (
    can_see_all_versions,
    can_see_version,
    not_found,
    require_steward,
    visible_dataset,
)
from api.modules.catalog.repo import files_of_versions, load_dataset, load_version, must, readiness_overall
from api.modules.catalog.schemas import VersionCreateIn
from api.modules.catalog.tables import dataset_versions
from api.modules.catalog.views import version_view
from api.platform import clock
from api.platform.auth import CurrentUser
from api.platform.errors import ApiError
from api.platform.generated.error_codes import ErrorCode
from api.platform.ids import new_id


def _label_exists() -> ApiError:
    return ApiError(ErrorCode.DATASET_VERSION_LABEL_EXISTS, "This version label is already used in the dataset.")


def version_response(session: Session, version: RowMapping) -> dict[str, Any]:
    version_id = version["dataset_version_id"]
    files = files_of_versions(session, [version_id])[version_id]
    readiness = readiness_overall(session, [version_id])[version_id] if version["status"] == "PUBLISHED" else None
    return version_view(version, files, readiness)


def create_version(session: Session, user: CurrentUser, dataset_id: UUID, body: VersionCreateIn) -> dict[str, Any]:
    ds = visible_dataset(session, user, dataset_id, for_update=True)
    require_steward(user, ds)
    if ds["status"] != "ACTIVE":
        raise ApiError(ErrorCode.CONFLICT, "WITHDRAWN datasets cannot get new versions.")
    duplicate = session.execute(
        select(dataset_versions.c.dataset_version_id).where(
            dataset_versions.c.dataset_id == dataset_id, dataset_versions.c.version_label == body.version_label
        )
    ).first()
    if duplicate is not None:
        raise _label_exists()
    version_id = new_id()
    now = clock.now()
    try:
        with session.begin_nested():
            session.execute(
                insert(dataset_versions).values(
                    dataset_version_id=version_id,
                    dataset_id=dataset_id,
                    version_label=body.version_label,
                    status="DRAFT",
                    change_note=body.change_note,
                    created_by=user.user_id,
                    created_at=now,
                    updated_at=now,
                )
            )
    except IntegrityError as exc:
        raise _label_exists() from exc
    return version_response(session, must(load_version(session, version_id), "version"))


def list_versions(session: Session, user: CurrentUser, dataset_id: UUID) -> dict[str, Any]:
    ds = visible_dataset(session, user, dataset_id)
    stmt = select(dataset_versions).where(dataset_versions.c.dataset_id == dataset_id)
    if not can_see_all_versions(user, ds["owner_organization_id"]):
        stmt = stmt.where(dataset_versions.c.status == "PUBLISHED")
    versions = session.execute(
        stmt.order_by(dataset_versions.c.created_at.desc(), dataset_versions.c.dataset_version_id.desc())
    ).mappings().all()
    ids = [v["dataset_version_id"] for v in versions]
    files = files_of_versions(session, ids)
    readiness = readiness_overall(session, [v["dataset_version_id"] for v in versions if v["status"] == "PUBLISHED"])
    return {
        "items": [
            version_view(v, files[v["dataset_version_id"]], readiness.get(v["dataset_version_id"])) for v in versions
        ]
    }


def get_version(session: Session, user: CurrentUser, version_id: UUID) -> dict[str, Any]:
    version = load_version(session, version_id)
    if version is None:
        raise not_found("Dataset version")
    ds = must(load_dataset(session, version["dataset_id"]), "dataset")
    if not can_see_version(user, ds, version):
        raise not_found("Dataset version")
    return version_response(session, version)
```

`apps/api/modules/catalog/routes/versions.py`:

```python
from typing import Any
from uuid import UUID

from fastapi import APIRouter

from api.modules.catalog.schemas import VersionCreateIn
from api.modules.catalog.service import versions as service
from api.platform.auth import CurrentUserDep
from api.platform.db import SessionDep

router = APIRouter(tags=["catalog"])


@router.get("/datasets/{dataset_id}/versions", operation_id="listDatasetVersions")
def list_dataset_versions(dataset_id: UUID, session: SessionDep, user: CurrentUserDep) -> dict[str, Any]:
    return service.list_versions(session, user, dataset_id)


@router.post("/datasets/{dataset_id}/versions", operation_id="createDatasetVersion", status_code=201)
def create_dataset_version(
    dataset_id: UUID, body: VersionCreateIn, session: SessionDep, user: CurrentUserDep
) -> dict[str, Any]:
    return service.create_version(session, user, dataset_id, body)


@router.get("/dataset-versions/{version_id}", operation_id="getDatasetVersion")
def get_dataset_version(version_id: UUID, session: SessionDep, user: CurrentUserDep) -> dict[str, Any]:
    return service.get_version(session, user, version_id)
```

`apps/api/modules/catalog/router.py`:

```python
"""All catalog routes (mounted under /api/v1 by the platform)."""

from fastapi import APIRouter

from api.modules.catalog.routes import dataset_update, datasets, versions

router = APIRouter()
for sub in (datasets.router, dataset_update.router, versions.router):
    router.include_router(sub)
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `uv run pytest apps/api/modules/catalog/tests/test_versions_api.py -v`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
uv run ruff check --fix apps/api/modules/catalog && uv run ruff format apps/api/modules/catalog
git add apps/api/modules/catalog
git commit -m "feat(catalog): dataset versions create/list/get with role-based visibility

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 9: Upload sessions — `createUploadSession` (presigned PUT / multipart) and `getUploadSession`

**Files:**
- Create: `apps/api/modules/catalog/errors.py`
- Create: `apps/api/modules/catalog/service/uploads.py`
- Create: `apps/api/modules/catalog/routes/uploads.py`
- Modify: `apps/api/modules/catalog/router.py`
- Create: `apps/api/modules/catalog/tests/support_upload.py`
- Test: `apps/api/modules/catalog/tests/test_upload_sessions_api.py`

**Interfaces:**
- Consumes: `steward_version`, `require_draft`, `is_steward`, `not_found` (Task 6), `ObjectStore`, `StorageUnavailable`, `MultipartFailed` (Task 3), domain helpers `path_problem`, `media_type_allowed`, `canonical_media_type`, `storage_key`, `checksum_b64`, `part_count`, `MAX_FILE_BYTES`, `MAX_FILES_PER_VERSION`, `MAX_PARTS` (Task 1), `UploadSessionCreateIn`.
- Produces:
  - `errors.dependency_errors()` context manager: `StorageUnavailable`/`StorageNotConfigured` → `ApiError(DEPENDENCY_UNAVAILABLE)`.
  - `service.uploads.create_upload_session(session, deps, user, version_id, body) -> dict` (201 body), `get_upload_session(session, deps, user, upload_session_id) -> dict`, `upload_session_response(session, deps, upload_session_id) -> dict` (URLs only while the session is OPEN and unexpired and the file is PENDING), `upload_instructions(store, file_row, ttl) -> dict`, `org_store(deps, ds) -> ObjectStore`, `abort_quietly(store, key, upload_id) -> None`.
  - Routes `POST /dataset-versions/{version_id}/upload-session` (201), `GET /upload-sessions/{upload_session_id}`.
  - `support_upload`: `sha(data) -> str`, `file_spec(path, data) -> dict`, `start_upload(api, version_id, files: dict[str, bytes], user="b.steward") -> dict`, `file_row(db, file_id) -> dict`, `put_uploaded(api, db, session_body, contents: dict[str, bytes], org="inst-b") -> dict` (stores bytes in the memory store; returns the `completeUploadSession` body with multipart ETags), `complete(api, upload_session_id, body=None, user="b.steward") -> httpx.Response`, `upload_files(api, db, version_id, files, user="b.steward", org="inst-b") -> dict`, `assert_upload_session_matches(operation_id, status, body)` (contract bridge for closed sessions).

- [ ] **Step 1: Write the failing tests**

`apps/api/modules/catalog/tests/support_upload.py`:

```python
"""Upload helpers for tests that use the in-memory object store."""

import hashlib
from typing import Any
from uuid import UUID

import httpx

from api.modules.catalog.domain import ALLOWED_MEDIA_TYPES, extension
from api.modules.catalog.testing import memory_store
from api.modules.catalog.tests.support import rows
from api.modules.catalog.tests.support_api import CatalogApi
from api.platform.testing.contracts import assert_matches_response
from api.platform.testing.fixtures import PgUrls

CLOSED_UPLOAD_PLACEHOLDER = {"method": "PUT", "url": "http://omitted.invalid/"}


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def file_spec(path: str, data: bytes) -> dict[str, Any]:
    return {"path": path, "size_bytes": len(data), "sha256": sha(data), "media_type": ALLOWED_MEDIA_TYPES[extension(path)]}


def start_upload(api: CatalogApi, version_id: str, files: dict[str, bytes], user: str = "b.steward") -> dict[str, Any]:
    body = {"files": [file_spec(path, data) for path, data in files.items()]}
    response = api.post(user, f"/dataset-versions/{version_id}/upload-session", json=body)
    assert response.status_code == 201, response.text
    created: dict[str, Any] = response.json()
    return created


def file_row(db: PgUrls, file_id: str | UUID) -> dict[str, Any]:
    return rows(db, "SELECT * FROM catalog.dataset_files WHERE file_id = :id", id=file_id)[0]


def put_uploaded(
    api: CatalogApi, db: PgUrls, session_body: dict[str, Any], contents: dict[str, bytes], org: str = "inst-b"
) -> dict[str, Any]:
    """Do what the browser does with the presigned URLs, against the memory store."""
    store = memory_store(api.deps.storage, org)
    parts: list[dict[str, Any]] = []
    for item in session_body["files"]:
        data = contents[item["path"]]
        row = file_row(db, item["file_id"])
        if item["upload"]["method"] == "PUT":
            store.put(row["storage_key"], data, row["media_type"])
            continue
        size = item["upload"]["part_size_bytes"]
        etags = [
            {
                "part_number": part["part_number"],
                "etag": store.upload_part(
                    row["storage_key"],
                    row["multipart_upload_id"],
                    part["part_number"],
                    data[(part["part_number"] - 1) * size : part["part_number"] * size],
                ),
            }
            for part in item["upload"]["parts"]
        ]
        parts.append({"file_id": item["file_id"], "etags": etags})
    return {"parts": parts}


def complete(
    api: CatalogApi, upload_session_id: str, body: dict[str, Any] | None = None, user: str = "b.steward"
) -> httpx.Response:
    return api.post(user, f"/upload-sessions/{upload_session_id}/complete", json=body or {})


def upload_files(
    api: CatalogApi, db: PgUrls, version_id: str, files: dict[str, bytes], user: str = "b.steward", org: str = "inst-b"
) -> dict[str, Any]:
    session_body = start_upload(api, version_id, files, user)
    response = complete(api, session_body["upload_session_id"], put_uploaded(api, db, session_body, files, org), user)
    assert response.status_code == 200, response.text
    result: dict[str, Any] = response.json()
    return result


def assert_upload_session_matches(operation_id: str, status: int, body: dict[str, Any]) -> None:
    """openapi marks files[].upload as required, yet the same contract says URLs are omitted once a session is
    COMPLETED/EXPIRED. Until the contract change lands (plan: Contract/shared changes needed), closed sessions are
    validated with a placeholder in place of the omitted upload instructions."""
    if body["status"] == "OPEN":
        assert_matches_response(operation_id, status, body)
        return
    assert all("upload" not in item for item in body["files"]), body
    patched = {**body, "files": [{**item, "upload": CLOSED_UPLOAD_PLACEHOLDER} for item in body["files"]]}
    assert_matches_response(operation_id, status, patched)
```

`apps/api/modules/catalog/tests/test_upload_sessions_api.py`:

```python
import base64
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from urllib.parse import urlsplit
from uuid import UUID, uuid4

import pytest

from api.modules.catalog.service import uploads
from api.modules.catalog.settings import CatalogSettings
from api.modules.catalog.testing import memory_store
from api.modules.catalog.tests.support import SHA_A, execute, insert_file, insert_version, rows
from api.modules.catalog.tests.support_api import CatalogApi, assert_error, create_dataset, new_draft
from api.modules.catalog.tests.support_upload import assert_upload_session_matches, file_row, file_spec, sha, start_upload
from api.platform import clock
from api.platform.testing.contracts import assert_matches_response
from api.platform.testing.fixtures import PgUrls

KIB_CSV = b"a,b\n" + b"1,2\n" * 255
MIB = 1024 * 1024


def test_small_file_gets_a_presigned_put_on_the_gateway(api: CatalogApi, db: PgUrls) -> None:  # M03-AT-05 (session)
    dataset_id, version_id = new_draft(api)
    now = datetime(2026, 10, 1, 9, 0, tzinfo=UTC)
    with clock.frozen(now):
        body = start_upload(api, version_id, {"data/a.csv": KIB_CSV})
    assert_matches_response("createUploadSession", 201, body)
    assert body["status"] == "OPEN" and body["expires_at"].startswith("2026-10-01T10:00:00")
    [item] = body["files"]
    assert item["status"] == "PENDING"
    upload = item["upload"]
    assert upload["method"] == "PUT"
    url = urlsplit(upload["url"])
    assert url.netloc == "localhost:21051"
    assert url.path == f"/nais-inst-b/datasets/{dataset_id}/{version_id}/data/a.csv"
    assert upload["headers"] == {
        "Content-Type": "text/csv",
        "x-amz-checksum-sha256": base64.b64encode(bytes.fromhex(sha(KIB_CSV))).decode(),
    }
    row = file_row(db, item["file_id"])
    assert (row["storage_bucket"], row["storage_key"]) == ("nais-inst-b", f"datasets/{dataset_id}/{version_id}/data/a.csv")
    assert row["multipart_upload_id"] is None


def test_files_above_64_mib_use_multipart(api: CatalogApi, db: PgUrls) -> None:  # M03-AT-06 (session)
    _, version_id = new_draft(api)
    spec = {"path": "data/big.csv", "size_bytes": 100 * MIB, "sha256": SHA_A, "media_type": "text/csv"}
    response = api.post("b.steward", f"/dataset-versions/{version_id}/upload-session", json={"files": [spec]})
    assert response.status_code == 201, response.text
    assert_matches_response("createUploadSession", 201, response.json())
    upload = response.json()["files"][0]["upload"]
    assert upload["method"] == "MULTIPART" and upload["part_size_bytes"] == 64 * MIB
    assert [p["part_number"] for p in upload["parts"]] == [1, 2]
    row = file_row(db, response.json()["files"][0]["file_id"])
    assert row["multipart_upload_id"] in memory_store(api.deps.storage, "inst-b").uploads


@pytest.mark.parametrize(
    ("path", "media_type"),
    [("tools/run.exe", "application/octet-stream"), ("data/a.csv", "application/json"), ("data/a.csv", "text/csv; charset=utf-8")],
)
def test_at08_disallowed_types_create_nothing(api: CatalogApi, db: PgUrls, path: str, media_type: str) -> None:
    _, version_id = new_draft(api)
    spec = {"path": path, "size_bytes": 10, "sha256": SHA_A, "media_type": media_type}
    response = api.post("b.steward", f"/dataset-versions/{version_id}/upload-session", json={"files": [file_spec("ok.csv", b"x"), spec]})
    assert response.status_code == 422
    assert_matches_response("createUploadSession", 422, response.json())
    assert response.json()["error"]["code"] == "FILE_TYPE_NOT_ALLOWED"
    assert rows(db, "SELECT file_id FROM catalog.dataset_files") == []
    assert rows(db, "SELECT upload_session_id FROM catalog.upload_sessions") == []


def test_media_type_case_is_ignored(api: CatalogApi, db: PgUrls) -> None:
    _, version_id = new_draft(api)
    spec = {**file_spec("data/a.csv", KIB_CSV), "media_type": "Text/CSV"}
    response = api.post("b.steward", f"/dataset-versions/{version_id}/upload-session", json={"files": [spec]})
    assert response.status_code == 201
    assert file_row(db, response.json()["files"][0]["file_id"])["media_type"] == "text/csv"


@pytest.mark.parametrize("path", ["../etc/passwd", "a/../../b.csv", "./a.csv", "a//b.csv"])
def test_at10_path_traversal_is_validation_failed(api: CatalogApi, db: PgUrls, path: str) -> None:
    _, version_id = new_draft(api)
    spec = {"path": path, "size_bytes": 10, "sha256": SHA_A, "media_type": "text/csv"}
    response = api.post("b.steward", f"/dataset-versions/{version_id}/upload-session", json={"files": [spec]})
    assert response.status_code == 422
    assert_matches_response("createUploadSession", 422, response.json())
    error = response.json()["error"]
    assert error["code"] == "VALIDATION_FAILED"
    assert error["details"]["fields"][0]["field"] == "files.0.path"
    assert rows(db, "SELECT file_id FROM catalog.dataset_files") == []


def test_duplicate_paths_in_one_request_are_rejected(api: CatalogApi) -> None:
    _, version_id = new_draft(api)
    spec = file_spec("data/a.csv", KIB_CSV)
    response = api.post("b.steward", f"/dataset-versions/{version_id}/upload-session", json={"files": [spec, spec]})
    assert response.status_code == 422
    assert response.json()["error"]["details"]["fields"] == [{"field": "files.1.path", "reason": "DUPLICATE_PATH"}]


def test_files_above_50_gib_are_too_large(api: CatalogApi) -> None:
    _, version_id = new_draft(api)
    spec = {"path": "huge.parquet", "size_bytes": 50 * 1024**3 + 1, "sha256": SHA_A, "media_type": "application/vnd.apache.parquet"}
    response = api.post("b.steward", f"/dataset-versions/{version_id}/upload-session", json={"files": [spec]})
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "FILE_TOO_LARGE"


def test_version_file_limit(api: CatalogApi, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(uploads, "MAX_FILES_PER_VERSION", 2)
    _, version_id = new_draft(api)
    start_upload(api, version_id, {"a.csv": b"1"})
    spec = [file_spec("b.csv", b"2"), file_spec("c.csv", b"3")]
    response = api.post("b.steward", f"/dataset-versions/{version_id}/upload-session", json={"files": spec})
    assert response.status_code == 422
    assert response.json()["error"]["details"]["fields"] == [{"field": "files", "reason": "TOO_MANY_FILES"}]


def test_existing_paths_conflict_but_failed_paths_are_reused(api: CatalogApi, db: PgUrls) -> None:
    _, version_id = new_draft(api)
    first = start_upload(api, version_id, {"data/a.csv": KIB_CSV})
    response = api.post("b.steward", f"/dataset-versions/{version_id}/upload-session", json={"files": [file_spec("data/a.csv", KIB_CSV)]})
    assert response.status_code == 409
    assert_matches_response("createUploadSession", 409, response.json())
    assert response.json()["error"]["details"]["paths"] == ["data/a.csv"]
    file_id = first["files"][0]["file_id"]
    execute(db, "UPDATE catalog.dataset_files SET status = 'FAILED', failure_code = 'CHECKSUM_MISMATCH' WHERE file_id = :id", id=file_id)
    again = start_upload(api, version_id, {"data/a.csv": b"new,content\n"})
    assert again["files"][0]["file_id"] == file_id
    row = file_row(db, file_id)
    assert (row["status"], row["failure_code"], row["upload_session_id"]) == ("PENDING", None, UUID(again["upload_session_id"]))
    assert row["sha256"] == sha(b"new,content\n")
    execute(db, "UPDATE catalog.dataset_files SET status = 'VERIFIED' WHERE file_id = :id", id=file_id)
    assert api.post("b.steward", f"/dataset-versions/{version_id}/upload-session", json={"files": [file_spec("data/a.csv", KIB_CSV)]}).status_code == 409


def test_pending_path_of_expired_session_is_reused(api: CatalogApi, db: PgUrls) -> None:  # Review Focus 1
    _, version_id = new_draft(api)
    first = start_upload(api, version_id, {"data/a.csv": KIB_CSV})
    with clock.frozen(datetime.now(UTC) + timedelta(hours=2)):
        again = start_upload(api, version_id, {"data/a.csv": KIB_CSV})
    assert again["files"][0]["file_id"] == first["files"][0]["file_id"]
    assert again["upload_session_id"] != first["upload_session_id"]


def test_at12_published_version_is_immutable(api: CatalogApi, db: PgUrls) -> None:  # M03-AT-12 (API part)
    dataset_id = create_dataset(api)["dataset_id"]
    version_id = insert_version(db, UUID(dataset_id), published=True, files=[("data/a.csv", 10, SHA_A)])
    response = api.post("b.steward", f"/dataset-versions/{version_id}/upload-session", json={"files": [file_spec("b.csv", b"x")]})
    assert response.status_code == 409
    assert_matches_response("createUploadSession", 409, response.json())
    assert response.json()["error"]["code"] == "DATASET_VERSION_IMMUTABLE"


def test_upload_session_permissions(api: CatalogApi) -> None:
    _, version_id = new_draft(api)
    body = {"files": [file_spec("a.csv", b"x")]}
    response = api.post("b.admin", f"/dataset-versions/{version_id}/upload-session", json=body)
    assert response.status_code == 403
    assert_matches_response("createUploadSession", 403, response.json())
    assert_error(api.post("a.steward", f"/dataset-versions/{version_id}/upload-session", json=body), 404, "NOT_FOUND")
    assert_error(api.post("b.steward", f"/dataset-versions/{uuid4()}/upload-session", json=body), 404, "NOT_FOUND")


def test_get_upload_session_renews_urls_only_while_open(api: CatalogApi, db: PgUrls) -> None:
    _, version_id = new_draft(api)
    created = start_upload(api, version_id, {"data/a.csv": KIB_CSV})
    response = api.get("b.steward", f"/upload-sessions/{created['upload_session_id']}")
    assert response.status_code == 200
    assert_upload_session_matches("getUploadSession", 200, response.json())
    assert response.json()["files"][0]["upload"]["method"] == "PUT"
    execute(db, "UPDATE catalog.upload_sessions SET status = 'COMPLETED' WHERE upload_session_id = :id", id=created["upload_session_id"])
    closed = api.get("b.steward", f"/upload-sessions/{created['upload_session_id']}").json()
    assert_upload_session_matches("getUploadSession", 200, closed)
    assert "upload" not in closed["files"][0]


def test_get_upload_session_is_steward_only(api: CatalogApi) -> None:
    _, version_id = new_draft(api)
    created = start_upload(api, version_id, {"data/a.csv": KIB_CSV})
    for user in ("b.researcher", "a.steward"):
        response = api.get(user, f"/upload-sessions/{created['upload_session_id']}")
        assert response.status_code == 404
        assert_matches_response("getUploadSession", 404, response.json())


def test_storage_outage_is_dependency_unavailable(api: CatalogApi) -> None:
    _, version_id = new_draft(api)
    api.use(replace(api.deps, settings=CatalogSettings(storage_multipart_threshold_bytes=1)))
    store = memory_store(api.deps.storage, "inst-b")

    def broken(key: str, content_type: str) -> str:
        from api.modules.catalog.objects import StorageUnavailable

        raise StorageUnavailable("storage-b down")

    store.create_multipart = broken  # type: ignore[method-assign]
    response = api.post("b.steward", f"/dataset-versions/{version_id}/upload-session", json={"files": [file_spec("a.csv", b"xy")]})
    assert_error(response, 503, "DEPENDENCY_UNAVAILABLE")


def test_uploaded_path_conflicts(api: CatalogApi, db: PgUrls) -> None:
    _, version_id = new_draft(api)
    insert_file(db, UUID(version_id), path="data/z.csv", status="UPLOADED")
    response = api.post("b.steward", f"/dataset-versions/{version_id}/upload-session", json={"files": [file_spec("data/z.csv", b"x")]})
    assert response.status_code == 409
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `uv run pytest apps/api/modules/catalog/tests/test_upload_sessions_api.py -v`
Expected: collection error `cannot import name 'uploads' from 'api.modules.catalog.service'`.

- [ ] **Step 3: Implement**

`apps/api/modules/catalog/errors.py`:

```python
"""Map storage failures to the contract error envelope."""

from collections.abc import Iterator
from contextlib import contextmanager

from api.modules.catalog.objects import StorageUnavailable
from api.platform.errors import ApiError
from api.platform.generated.error_codes import ErrorCode
from api.platform.storage import StorageNotConfigured


@contextmanager
def dependency_errors() -> Iterator[None]:
    try:
        yield
    except StorageUnavailable as exc:
        raise ApiError(ErrorCode.DEPENDENCY_UNAVAILABLE, "Object storage is temporarily unavailable.") from exc
    except StorageNotConfigured as exc:
        raise ApiError(ErrorCode.DEPENDENCY_UNAVAILABLE, "Object storage is not configured for this organization.") from exc
```

`apps/api/modules/catalog/service/uploads.py`:

```python
"""Upload sessions (M03 §5.2, §5.3, §6.6): validation, presigned PUT / multipart instructions."""

import logging
from collections.abc import Mapping, Sequence
from datetime import timedelta
from typing import Any
from uuid import UUID

from sqlalchemy import func, insert, select, update
from sqlalchemy.engine import RowMapping
from sqlalchemy.orm import Session

from api.modules.catalog.access import is_steward, not_found, require_draft, steward_version
from api.modules.catalog.deps import CatalogDeps
from api.modules.catalog.domain import (
    MAX_FILE_BYTES,
    MAX_FILES_PER_VERSION,
    MAX_PARTS,
    canonical_media_type,
    checksum_b64,
    media_type_allowed,
    part_count,
    path_problem,
    storage_key,
)
from api.modules.catalog.errors import dependency_errors
from api.modules.catalog.objects import MultipartFailed, ObjectStore, StorageUnavailable
from api.modules.catalog.repo import load_dataset, load_version, must
from api.modules.catalog.schemas import UploadFileIn, UploadSessionCreateIn
from api.modules.catalog.settings import CatalogSettings
from api.modules.catalog.tables import dataset_files, upload_sessions
from api.platform import clock
from api.platform.auth import CurrentUser
from api.platform.errors import ApiError
from api.platform.generated.error_codes import ErrorCode
from api.platform.ids import new_id
from api.platform.storage import StorageNotConfigured

logger = logging.getLogger("nais.catalog.uploads")


def org_store(deps: CatalogDeps, ds: Mapping[Any, Any]) -> ObjectStore:
    org = deps.organizations.get_organization_summary(ds["owner_organization_id"])
    if org is None:
        raise StorageNotConfigured(f"unknown organization {ds['owner_organization_id']}")
    return deps.storage.for_org(org.code)


def abort_quietly(store: ObjectStore, key: str, upload_id: str) -> None:
    try:
        store.abort_multipart(key, upload_id)
    except (StorageUnavailable, MultipartFailed):
        logger.warning("could not abort multipart upload", extra={"storage_key": key}, exc_info=True)


def _validate_files(files: Sequence[UploadFileIn], settings: CatalogSettings) -> None:
    fields: list[dict[str, str]] = []
    seen: set[str] = set()
    for index, spec in enumerate(files):
        problem = path_problem(spec.path)
        if problem is None and spec.path in seen:
            problem = "DUPLICATE_PATH"
        if problem is not None:
            fields.append({"field": f"files.{index}.path", "reason": problem})
        seen.add(spec.path)
    if fields:
        raise ApiError(ErrorCode.VALIDATION_FAILED, "Invalid file path.", {"fields": fields})
    bad_types = [
        {"path": spec.path, "media_type": spec.media_type}
        for spec in files
        if not media_type_allowed(spec.path, spec.media_type)
    ]
    if bad_types:
        raise ApiError(ErrorCode.FILE_TYPE_NOT_ALLOWED, "File type is not in the allow list.", {"files": bad_types})
    too_large = [
        {"path": spec.path, "size_bytes": spec.size_bytes}
        for spec in files
        if spec.size_bytes > MAX_FILE_BYTES
        or part_count(spec.size_bytes, settings.catalog_multipart_part_size_bytes) > MAX_PARTS
    ]
    if too_large:
        raise ApiError(
            ErrorCode.FILE_TOO_LARGE, "File exceeds the per-file limit.", {"files": too_large, "max_bytes": MAX_FILE_BYTES}
        )


def upload_instructions(store: ObjectStore, f: Mapping[Any, Any], ttl: int) -> dict[str, Any]:
    if f["multipart_upload_id"]:
        part_size = int(f["part_size_bytes"])
        return {
            "method": "MULTIPART",
            "part_size_bytes": part_size,
            "parts": [
                {"part_number": n, "url": store.presign_part(f["storage_key"], f["multipart_upload_id"], n, ttl)}
                for n in range(1, part_count(int(f["size_bytes"]), part_size) + 1)
            ],
        }
    url, headers = store.presign_put(f["storage_key"], f["media_type"], checksum_b64(f["sha256"].strip()), ttl)
    return {"method": "PUT", "url": url, "headers": headers}


def upload_session_response(session: Session, deps: CatalogDeps, upload_session_id: UUID) -> dict[str, Any]:
    sess = must(
        session.execute(
            select(upload_sessions).where(upload_sessions.c.upload_session_id == upload_session_id)
        ).mappings().first(),
        "upload session",
    )
    files = session.execute(
        select(dataset_files)
        .where(dataset_files.c.upload_session_id == upload_session_id)
        .order_by(dataset_files.c.path.collate("C"))
    ).mappings().all()
    is_open = sess["status"] == "OPEN" and sess["expires_at"] > clock.now()
    items: list[dict[str, Any]] = []
    for f in files:
        item: dict[str, Any] = {
            "file_id": f["file_id"],
            "path": f["path"],
            "status": f["status"],
            "failure_code": f["failure_code"],
        }
        if is_open and f["status"] == "PENDING":
            store = deps.storage.for_bucket(f["storage_bucket"])
            item["upload"] = upload_instructions(store, f, deps.settings.upload_url_ttl_seconds)
        items.append(item)
    return {
        "upload_session_id": sess["upload_session_id"],
        "dataset_version_id": sess["dataset_version_id"],
        "status": sess["status"],
        "expires_at": sess["expires_at"],
        "files": items,
    }


def _existing_rows(session: Session, version_id: UUID, paths: Sequence[str]) -> dict[str, RowMapping]:
    stmt = (
        select(
            dataset_files,
            upload_sessions.c.status.label("session_status"),
            upload_sessions.c.expires_at.label("session_expires_at"),
        )
        .select_from(
            dataset_files.join(upload_sessions, dataset_files.c.upload_session_id == upload_sessions.c.upload_session_id)
        )
        .where(dataset_files.c.dataset_version_id == version_id, dataset_files.c.path.in_(list(paths)))
    )
    return {row["path"]: row for row in session.execute(stmt).mappings()}


def create_upload_session(
    session: Session, deps: CatalogDeps, user: CurrentUser, version_id: UUID, body: UploadSessionCreateIn
) -> dict[str, Any]:
    version, ds = steward_version(session, user, version_id, for_update=True)
    require_draft(version)
    settings = deps.settings
    _validate_files(body.files, settings)
    now = clock.now()
    paths = [spec.path for spec in body.files]
    existing = _existing_rows(session, version_id, paths)
    conflicts = sorted(
        path
        for path, row in existing.items()
        if row["status"] in ("UPLOADED", "VERIFIED")
        or (row["status"] == "PENDING" and row["session_status"] == "OPEN" and row["session_expires_at"] > now)
    )
    if conflicts:
        raise ApiError(ErrorCode.CONFLICT, "These paths already exist in the version.", {"paths": conflicts})
    others = session.execute(
        select(func.count())
        .select_from(dataset_files)
        .where(dataset_files.c.dataset_version_id == version_id, dataset_files.c.path.not_in(paths))
    ).scalar_one()
    if int(others) + len(paths) > MAX_FILES_PER_VERSION:
        raise ApiError(
            ErrorCode.VALIDATION_FAILED,
            f"A version holds at most {MAX_FILES_PER_VERSION} files.",
            {"fields": [{"field": "files", "reason": "TOO_MANY_FILES"}]},
        )
    with dependency_errors():
        store = org_store(deps, ds)
        upload_session_id = new_id()
        session.execute(
            insert(upload_sessions).values(
                upload_session_id=upload_session_id,
                dataset_version_id=version_id,
                status="OPEN",
                created_by=user.user_id,
                expires_at=now + timedelta(seconds=settings.upload_session_ttl_seconds),
                created_at=now,
            )
        )
        for spec in body.files:
            key = storage_key(ds["dataset_id"], version_id, spec.path)
            media_type = canonical_media_type(spec.media_type)
            multipart = spec.size_bytes > settings.storage_multipart_threshold_bytes
            values: dict[str, Any] = {
                "upload_session_id": upload_session_id,
                "size_bytes": spec.size_bytes,
                "sha256": spec.sha256,
                "media_type": media_type,
                "storage_bucket": store.bucket,
                "storage_key": key,
                "multipart_upload_id": store.create_multipart(key, media_type) if multipart else None,
                "part_size_bytes": settings.catalog_multipart_part_size_bytes if multipart else None,
                "status": "PENDING",
                "failure_code": None,
                "scan_status": "SKIPPED",
                "verified_at": None,
                "updated_at": now,
            }
            old = existing.get(spec.path)
            if old is None:
                session.execute(
                    insert(dataset_files).values(
                        file_id=new_id(), dataset_version_id=version_id, path=spec.path, created_at=now, **values
                    )
                )
                continue
            if old["status"] == "PENDING" and old["multipart_upload_id"]:
                abort_quietly(store, old["storage_key"], old["multipart_upload_id"])
            session.execute(update(dataset_files).where(dataset_files.c.file_id == old["file_id"]).values(**values))
        return upload_session_response(session, deps, upload_session_id)


def get_upload_session(
    session: Session, deps: CatalogDeps, user: CurrentUser, upload_session_id: UUID
) -> dict[str, Any]:
    sess = session.execute(
        select(upload_sessions).where(upload_sessions.c.upload_session_id == upload_session_id)
    ).mappings().first()
    if sess is None:
        raise not_found("Upload session")
    version = must(load_version(session, sess["dataset_version_id"]), "version")
    ds = must(load_dataset(session, version["dataset_id"]), "dataset")
    if not is_steward(user, ds["owner_organization_id"]):
        raise not_found("Upload session")
    with dependency_errors():
        return upload_session_response(session, deps, upload_session_id)
```

`apps/api/modules/catalog/routes/uploads.py`:

```python
from typing import Any
from uuid import UUID

from fastapi import APIRouter

from api.modules.catalog.deps import CatalogDepsDep
from api.modules.catalog.schemas import UploadSessionCreateIn
from api.modules.catalog.service import uploads as service
from api.platform.auth import CurrentUserDep
from api.platform.db import SessionDep

router = APIRouter(tags=["catalog"])


@router.post("/dataset-versions/{version_id}/upload-session", operation_id="createUploadSession", status_code=201)
def create_upload_session(
    version_id: UUID, body: UploadSessionCreateIn, session: SessionDep, user: CurrentUserDep, deps: CatalogDepsDep
) -> dict[str, Any]:
    return service.create_upload_session(session, deps, user, version_id, body)


@router.get("/upload-sessions/{upload_session_id}", operation_id="getUploadSession")
def get_upload_session(
    upload_session_id: UUID, session: SessionDep, user: CurrentUserDep, deps: CatalogDepsDep
) -> dict[str, Any]:
    return service.get_upload_session(session, deps, user, upload_session_id)
```

`apps/api/modules/catalog/router.py`:

```python
"""All catalog routes (mounted under /api/v1 by the platform)."""

from fastapi import APIRouter

from api.modules.catalog.routes import dataset_update, datasets, uploads, versions

router = APIRouter()
for sub in (datasets.router, dataset_update.router, versions.router, uploads.router):
    router.include_router(sub)
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `uv run pytest apps/api/modules/catalog/tests/test_upload_sessions_api.py -v`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
uv run ruff check --fix apps/api/modules/catalog && uv run ruff format apps/api/modules/catalog
git add apps/api/modules/catalog
git commit -m "feat(catalog): upload sessions with presigned PUT and multipart instructions

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 10: Verification engine — server-side sha256, type sniffing, archive-bomb defence, malware hook

**Files:**
- Create: `apps/api/modules/catalog/verification.py`
- Test: `apps/api/modules/catalog/tests/test_verification.py`

**Interfaces:**
- Consumes: `ObjectStore`, `ObjectMissing`, `StorageUnavailable` (Task 3), `MalwareScannerPort`, `ScanResult` (Task 5), `extension` (Task 1), `dataset_files`, `rowcount`.
- Produces:
  - `Outcome(status: Literal["VERIFIED","FAILED"], failure_code: str | None = None, scan_status: str = "SKIPPED")` with property `failed`.
  - `sniff(ext: str, head: bytes, tail: bytes, size: int) -> bool`.
  - `RangeReader(store, key, size)` — seekable `io.RawIOBase` over ranged GETs.
  - `zip_is_safe(store, key, size) -> bool` (central directory only, never decompresses).
  - `evaluate_object(store, *, key, size, sha256, path, scanner) -> Outcome` (order: size → sha256 → type → zip → scan).
  - `apply_outcome(session, file_id, outcome) -> bool` (updates only rows still `UPLOADED`; True if it did).
  - `verify_in_session(session, deps, file_row) -> Outcome` (evaluate + apply + delete the object on failure).
  - Limits as module constants: `SNIFF_BYTES=8192`, `ZIP_MAX_ENTRIES=10000`, `ZIP_MAX_UNCOMPRESSED=20 GiB`, `ZIP_MAX_RATIO=100`, `ZIP_MAX_CENTRAL_DIRECTORY=32 MiB`.

- [ ] **Step 1: Write the failing tests**

`apps/api/modules/catalog/tests/test_verification.py`:

```python
import hashlib
import io
import stat
import zipfile
from uuid import UUID

import pytest

from api.modules.catalog import verification
from api.modules.catalog.interfaces import ScanResult
from api.modules.catalog.testing import MemoryObjectStore
from api.modules.catalog.tests.support import insert_dataset, insert_file, insert_version, rows
from api.modules.catalog.verification import Outcome, RangeReader, apply_outcome, evaluate_object
from api.platform.db import session_factory
from api.platform.testing.fixtures import PgUrls

HDF5 = b"\x89HDF\r\n\x1a\n"


class Scanner:
    def __init__(self, status: str = "CLEAN") -> None:
        self.status = status

    def scan(self, bucket: str, key: str) -> ScanResult:
        return ScanResult(self.status)  # type: ignore[arg-type]


def run(path: str, data: bytes, *, declared: bytes | None = None, size: int | None = None, scanner: Scanner | None = None) -> Outcome:
    store = MemoryObjectStore("nais-inst-b")
    store.put("k", data, "application/octet-stream")
    reference = data if declared is None else declared
    return evaluate_object(
        store,
        key="k",
        size=len(reference) if size is None else size,
        sha256=hashlib.sha256(reference).hexdigest(),
        path=path,
        scanner=scanner or Scanner("SKIPPED"),
    )


def make_zip(entries: dict[str, bytes], *, compression: int = zipfile.ZIP_STORED) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", compression=compression) as archive:
        for name, content in entries.items():
            archive.writestr(zipfile.ZipInfo(name), content, compress_type=compression)
    return buffer.getvalue()


@pytest.mark.parametrize(
    ("path", "data"),
    [
        ("a.csv", b"a,b\n1,2\n"),
        ("a.csv", b"\xef\xbb\xbfa,b\n"),
        ("a.tsv", "이름\t값\n".encode()),
        ("a.json", b'  \n {"a": 1}'),
        ("a.json", b"[1, 2]"),
        ("a.jsonl", b'{"a":1}\n{"a":2}\n'),
        ("a.txt", b"hello"),
        ("README.md", "# 제목\n".encode()),
        ("t.parquet", b"PAR1" + b"\x00" * 16 + b"PAR1"),
        ("x.h5", HDF5 + b"rest"),
        ("x.hdf5", HDF5 + b"rest"),
        ("x.nc", b"CDF\x01rest"),
        ("x.nc", b"CDF\x02rest"),
        ("x.nc", HDF5 + b"rest"),
    ],
)
def test_valid_files_are_verified(path: str, data: bytes) -> None:
    assert run(path, data) == Outcome("VERIFIED", None, "SKIPPED")


def test_utf8_character_split_at_the_sniff_boundary_is_fine() -> None:
    assert run("a.txt", "가".encode() * 5000).status == "VERIFIED"


@pytest.mark.parametrize(
    ("path", "data"),
    [
        ("a.csv", b"a,b\x00\n"),
        ("a.csv", b"\xff\xfe\xfa"),
        ("a.json", b"hello"),
        ("a.json", b"   "),
        ("t.parquet", b"PAR1" + b"\x00" * 16 + b"XXXX"),
        ("t.parquet", b"PAR1"),
        ("x.h5", b"not hdf5 at all"),
        ("x.nc", b"CDF\x05rest"),
        ("a.zip", b"not a zip file"),
    ],
)
def test_type_mismatch(path: str, data: bytes) -> None:
    assert run(path, data) == Outcome("FAILED", "TYPE_MISMATCH")


def test_checksum_size_and_missing_object() -> None:
    assert run("a.csv", b"a,b\n", declared=b"x,y\n") == Outcome("FAILED", "CHECKSUM_MISMATCH")
    assert run("a.csv", b"a,b\n", size=99) == Outcome("FAILED", "SIZE_MISMATCH")
    empty = MemoryObjectStore("b")
    outcome = evaluate_object(empty, key="gone", size=1, sha256="0" * 64, path="a.csv", scanner=Scanner())
    assert outcome == Outcome("FAILED", "OBJECT_MISSING")


def test_malware_hook() -> None:
    assert run("a.csv", b"a,b\n", scanner=Scanner("INFECTED")) == Outcome("FAILED", "MALWARE_DETECTED", "INFECTED")
    assert run("a.csv", b"a,b\n", scanner=Scanner("CLEAN")) == Outcome("VERIFIED", None, "CLEAN")


def test_safe_zip_is_verified() -> None:
    assert run("bundle.zip", make_zip({"data/a.csv": b"a,b\n1,2\n", "README.md": b"# x"})).status == "VERIFIED"


def test_at09_compression_ratio_of_1000_is_archive_unsafe() -> None:
    bomb = make_zip({"zeros.bin": b"\x00" * (10 * 1024 * 1024)}, compression=zipfile.ZIP_DEFLATED)
    assert run("bomb.zip", bomb) == Outcome("FAILED", "ARCHIVE_UNSAFE")


@pytest.mark.parametrize("name", ["../evil.txt", "a/../../evil.txt", "/etc/passwd", "C:/windows/x", "a\\..\\b"])
def test_dangerous_entry_names(name: str) -> None:
    assert run("a.zip", make_zip({name: b"x"})) == Outcome("FAILED", "ARCHIVE_UNSAFE")


def test_symlink_entries_are_unsafe() -> None:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        info = zipfile.ZipInfo("link")
        info.create_system = 3
        info.external_attr = (stat.S_IFLNK | 0o777) << 16
        archive.writestr(info, "target")
    assert run("a.zip", buffer.getvalue()) == Outcome("FAILED", "ARCHIVE_UNSAFE")


def test_too_many_entries_and_too_much_data(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(verification, "ZIP_MAX_ENTRIES", 3)
    assert run("a.zip", make_zip({f"f{i}.txt": b"x" for i in range(5)})) == Outcome("FAILED", "ARCHIVE_UNSAFE")
    monkeypatch.setattr(verification, "ZIP_MAX_ENTRIES", 10_000)
    monkeypatch.setattr(verification, "ZIP_MAX_UNCOMPRESSED", 10)
    assert run("a.zip", make_zip({"a.txt": b"x" * 6, "b.txt": b"y" * 6})) == Outcome("FAILED", "ARCHIVE_UNSAFE")


def test_truncated_zip_is_unsafe() -> None:
    data = make_zip({"a.txt": b"hello"})
    assert run("a.zip", data[:-10]) == Outcome("FAILED", "ARCHIVE_UNSAFE")


def test_range_reader_seeks_and_reads() -> None:
    store = MemoryObjectStore("b")
    store.put("k", b"0123456789", "x")
    reader = io.BufferedReader(RangeReader(store, "k", 10), 4)
    reader.seek(-3, io.SEEK_END)
    assert reader.read() == b"789"
    reader.seek(2)
    assert reader.read(3) == b"234"
    assert reader.tell() == 5


def test_apply_outcome_only_touches_uploaded_rows(db: PgUrls) -> None:
    version_id = insert_version(db, insert_dataset(db))
    uploaded = insert_file(db, version_id, path="a.csv", status="UPLOADED")
    failed = insert_file(db, version_id, path="b.csv", status="FAILED")
    with session_factory(db.app)() as session, session.begin():
        assert apply_outcome(session, uploaded, Outcome("VERIFIED", None, "SKIPPED")) is True
        assert apply_outcome(session, uploaded, Outcome("FAILED", "CHECKSUM_MISMATCH")) is False
        assert apply_outcome(session, failed, Outcome("VERIFIED")) is False
    [row] = rows(db, "SELECT status, verified_at FROM catalog.dataset_files WHERE file_id = :id", id=uploaded)
    assert row["status"] == "VERIFIED" and row["verified_at"] is not None
    assert isinstance(uploaded, UUID)
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `uv run pytest apps/api/modules/catalog/tests/test_verification.py -v`
Expected: collection error `cannot import name 'verification'`.

- [ ] **Step 3: Implement**

`apps/api/modules/catalog/verification.py`:

```python
"""File verification (M03 §6.6): streaming sha256, type sniff (first 8 KiB / last 4 bytes), zip central-directory
checks (never decompresses), malware scan hook. Used synchronously by completeUploadSession for small sessions and
by the catalog.verify_file actor otherwise."""

import codecs
import hashlib
import io
import logging
import stat
import struct
import zipfile
from collections.abc import Mapping
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Literal
from uuid import UUID

from botocore.exceptions import BotoCoreError
from sqlalchemy import update
from sqlalchemy.orm import Session

from api.modules.catalog.domain import extension
from api.modules.catalog.interfaces import MalwareScannerPort
from api.modules.catalog.objects import ObjectMissing, ObjectStore, StorageUnavailable
from api.modules.catalog.repo import rowcount
from api.modules.catalog.tables import dataset_files
from api.platform import clock

if TYPE_CHECKING:
    from api.modules.catalog.deps import CatalogDeps

logger = logging.getLogger("nais.catalog.verification")

SNIFF_BYTES = 8 * 1024
HASH_CHUNK = 1024 * 1024
ZIP_MAX_ENTRIES = 10_000
ZIP_MAX_UNCOMPRESSED = 20 * 1024**3
ZIP_MAX_RATIO = 100
ZIP_MAX_CENTRAL_DIRECTORY = 32 * 1024 * 1024
HDF5_SIGNATURE = b"\x89HDF\r\n\x1a\n"
TEXT_EXTENSIONS = frozenset({".csv", ".tsv", ".json", ".jsonl", ".txt", ".md"})


@dataclass(frozen=True)
class Outcome:
    status: Literal["VERIFIED", "FAILED"]
    failure_code: str | None = None
    scan_status: str = "SKIPPED"

    @property
    def failed(self) -> bool:
        return self.status == "FAILED"


def _text_ok(head: bytes, *, complete: bool, json_start: bool) -> bool:
    if b"\x00" in head:
        return False
    if head.startswith(codecs.BOM_UTF8):
        head = head[len(codecs.BOM_UTF8) :]
    try:
        text = codecs.getincrementaldecoder("utf-8")().decode(head, final=complete)
    except UnicodeDecodeError:
        return False
    if json_start:
        stripped = text.lstrip()
        return bool(stripped) and stripped[0] in "{["
    return True


def sniff(ext: str, head: bytes, tail: bytes, size: int) -> bool:
    if ext in TEXT_EXTENSIONS:
        return _text_ok(head, complete=size <= SNIFF_BYTES, json_start=ext == ".json")
    if ext == ".parquet":
        return size >= 8 and head[:4] == b"PAR1" and tail[-4:] == b"PAR1"
    if ext in (".h5", ".hdf5"):
        return head.startswith(HDF5_SIGNATURE)
    if ext == ".nc":
        return head[:4] in (b"CDF\x01", b"CDF\x02") or head.startswith(HDF5_SIGNATURE)
    if ext == ".zip":
        return head[:4] == b"PK\x03\x04"
    return False


class RangeReader(io.RawIOBase):
    """Seekable read-only view of an object through ranged GETs (zipfile needs seek/tell)."""

    def __init__(self, store: ObjectStore, key: str, size: int) -> None:
        super().__init__()
        self._store = store
        self._key = key
        self._size = size
        self._pos = 0

    def readable(self) -> bool:
        return True

    def seekable(self) -> bool:
        return True

    def tell(self) -> int:
        return self._pos

    def seek(self, offset: int, whence: int = io.SEEK_SET) -> int:
        base = {io.SEEK_SET: 0, io.SEEK_CUR: self._pos, io.SEEK_END: self._size}[whence]
        if base + offset < 0:
            raise ValueError("negative seek position")
        self._pos = base + offset
        return self._pos

    def readinto(self, buffer: Any) -> int:
        view = memoryview(buffer).cast("B")
        if self._pos >= self._size or len(view) == 0:
            return 0
        end = min(self._pos + len(view), self._size) - 1
        data = self._store.read_range(self._key, self._pos, end)
        view[: len(data)] = data
        self._pos += len(data)
        return len(data)


def _eocd_ok(store: ObjectStore, key: str, size: int) -> bool:
    """Reject archives whose end-of-central-directory declares too many entries or a huge directory,
    before zipfile loads the directory into memory."""
    tail_len = min(size, 22 + 65535)
    tail = store.read_range(key, size - tail_len, size - 1)
    index = tail.rfind(b"PK\x05\x06")
    if index < 0 or len(tail) - index < 22:
        return False
    entries = int(struct.unpack("<H", tail[index + 10 : index + 12])[0])
    directory_size = int(struct.unpack("<I", tail[index + 12 : index + 16])[0])
    if entries != 0xFFFF and entries > ZIP_MAX_ENTRIES:
        return False
    return directory_size == 0xFFFFFFFF or directory_size <= ZIP_MAX_CENTRAL_DIRECTORY


def _entry_name_unsafe(name: str) -> bool:
    normalized = name.replace("\\", "/")
    if normalized.startswith("/") or (len(normalized) > 1 and normalized[1] == ":"):
        return True
    return any(part == ".." for part in normalized.split("/"))


def zip_is_safe(store: ObjectStore, key: str, size: int) -> bool:
    try:
        if not _eocd_ok(store, key, size):
            return False
        with zipfile.ZipFile(io.BufferedReader(RangeReader(store, key, size), 64 * 1024)) as archive:
            infos = archive.infolist()
    except (zipfile.BadZipFile, zipfile.LargeZipFile, ValueError, struct.error, EOFError, NotImplementedError):
        return False
    if len(infos) > ZIP_MAX_ENTRIES:
        return False
    total = 0
    for info in infos:
        if _entry_name_unsafe(info.filename) or stat.S_ISLNK(info.external_attr >> 16):
            return False
        total += info.file_size
        if total > ZIP_MAX_UNCOMPRESSED:
            return False
        if info.file_size > ZIP_MAX_RATIO * max(info.compress_size, 1):
            return False
    return True


def evaluate_object(
    store: ObjectStore, *, key: str, size: int, sha256: str, path: str, scanner: MalwareScannerPort
) -> Outcome:
    ext = extension(path)
    digest = hashlib.sha256()
    head = b""
    tail = b""
    seen = 0
    try:
        body = store.open_stream(key)
        try:
            while chunk := body.read(HASH_CHUNK):
                digest.update(chunk)
                if len(head) < SNIFF_BYTES:
                    head += chunk[: SNIFF_BYTES - len(head)]
                tail = (tail + chunk)[-4:]
                seen += len(chunk)
        finally:
            body.close()
    except ObjectMissing:
        return Outcome("FAILED", "OBJECT_MISSING")
    except BotoCoreError as exc:
        raise StorageUnavailable(str(exc)) from exc
    if seen != size:
        return Outcome("FAILED", "SIZE_MISMATCH")
    if digest.hexdigest() != sha256.strip():
        return Outcome("FAILED", "CHECKSUM_MISMATCH")
    if not sniff(ext, head, tail, size):
        return Outcome("FAILED", "TYPE_MISMATCH")
    if ext == ".zip" and not zip_is_safe(store, key, size):
        return Outcome("FAILED", "ARCHIVE_UNSAFE")
    scan = scanner.scan(store.bucket, key)
    if scan.status == "INFECTED":
        return Outcome("FAILED", "MALWARE_DETECTED", "INFECTED")
    return Outcome("VERIFIED", None, scan.status)


def apply_outcome(session: Session, file_id: UUID, outcome: Outcome) -> bool:
    now = clock.now()
    values: dict[str, Any] = {
        "status": outcome.status,
        "failure_code": outcome.failure_code,
        "scan_status": outcome.scan_status,
        "updated_at": now,
    }
    if outcome.status == "VERIFIED":
        values["verified_at"] = now
    result = session.execute(
        update(dataset_files)
        .where(dataset_files.c.file_id == file_id, dataset_files.c.status == "UPLOADED")
        .values(**values)
    )
    return rowcount(result) == 1


def verify_in_session(session: Session, deps: "CatalogDeps", f: Mapping[Any, Any]) -> Outcome:
    store = deps.storage.for_bucket(f["storage_bucket"])
    outcome = evaluate_object(
        store,
        key=f["storage_key"],
        size=int(f["size_bytes"]),
        sha256=f["sha256"],
        path=f["path"],
        scanner=deps.scanner,
    )
    if apply_outcome(session, f["file_id"], outcome) and outcome.failed:
        store.delete(f["storage_key"])  # M03 §5.2: a file that fails verification is removed from storage
    logger.info(
        "catalog file verified",
        extra={"file_id": str(f["file_id"]), "status": outcome.status, "failure_code": outcome.failure_code},
    )
    return outcome
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `uv run pytest apps/api/modules/catalog/tests/test_verification.py -v`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
uv run ruff check --fix apps/api/modules/catalog && uv run ruff format apps/api/modules/catalog
git add apps/api/modules/catalog
git commit -m "feat(catalog): verification engine (sha256, type sniff, zip bomb defence, scan hook)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 11: `completeUploadSession`, `deleteDraftFile`, the `catalog.verify_file` actor, and SeaweedFS end-to-end (AT-05/06/07)

**Files:**
- Create: `apps/api/modules/catalog/service/completion.py`
- Create: `apps/api/modules/catalog/routes/completion.py`
- Create: `apps/api/modules/catalog/jobs.py`
- Modify: `apps/api/modules/catalog/router.py`
- Modify: `apps/api/modules/catalog/__init__.py` (import `jobs` so the actor is declared at import time)
- Test: `apps/api/modules/catalog/tests/test_complete_upload.py`, `apps/api/modules/catalog/tests/test_s3_e2e.py`

**Interfaces:**
- Consumes: `upload_session_response`, `abort_quietly` (Task 9), `dependency_errors` (Task 9), `verify_in_session`, `evaluate_object`, `apply_outcome` (Task 10), `steward_version`, `require_draft`, `is_steward`, `can_see_dataset`, `not_found` (Task 6), `MultipartFailed`, `StorageUnavailable` (Task 3), `UploadCompleteIn`, support helpers `start_upload`, `put_uploaded`, `complete`, `upload_files`, `file_row`, `assert_upload_session_matches` (Task 9), `new_draft` (Task 8).
- Produces:
  - `service.completion.complete_upload_session(session, deps, user, upload_session_id, body) -> tuple[dict, list[UUID]]` (response body, file ids to verify asynchronously after commit); `service.completion.delete_draft_file(session, deps, user, version_id, file_id) -> None`.
  - Routes `POST /upload-sessions/{upload_session_id}/complete` (`completeUploadSession`; enqueues async verification through FastAPI `BackgroundTasks`, i.e. after `SessionDep` committed), `DELETE /dataset-versions/{version_id}/files/{file_id}` (`deleteDraftFile`, 204).
  - `jobs.verify_file_job(file_id: UUID, *, deps: CatalogDeps) -> str | None` (returns the new status, or None if the row was not `UPLOADED`); Dramatiq actor `jobs.verify_file_actor` (`actor_name="catalog.verify_file"`, queue `catalog`, `time_limit` 2 h, retried up to 3 times only on `StorageUnavailable`).

- [ ] **Step 1: Write the failing tests**

`apps/api/modules/catalog/tests/test_complete_upload.py`:

```python
import hashlib
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

from dramatiq.brokers.stub import StubBroker

from api.modules.catalog.adapters.queue import DramatiqVerificationQueue
from api.modules.catalog.jobs import verify_file_actor, verify_file_job
from api.modules.catalog.settings import CatalogSettings
from api.modules.catalog.testing import RecordingVerificationQueue, memory_store
from api.modules.catalog.tests.support import SHA_A, insert_version, rows
from api.modules.catalog.tests.support_api import CatalogApi, assert_error, create_dataset, new_draft
from api.modules.catalog.tests.support_upload import (
    assert_upload_session_matches,
    complete,
    file_row,
    file_spec,
    put_uploaded,
    start_upload,
    upload_files,
)
from api.platform import clock
from api.platform.broker import configure_broker
from api.platform.settings import Settings
from api.platform.testing.contracts import assert_matches_response
from api.platform.testing.fixtures import PgUrls

CSV = b"sample_id,value\n" + b"S0001,1.0\n" * 300  # 3016 bytes: 3 parts under SMALL_MULTIPART
SMALL_MULTIPART = CatalogSettings(storage_multipart_threshold_bytes=1024, catalog_multipart_part_size_bytes=1024)


def test_small_session_is_verified_synchronously(api: CatalogApi, db: PgUrls) -> None:
    _, version_id = new_draft(api)
    result = upload_files(api, db, version_id, {"data/a.csv": CSV})
    assert_upload_session_matches("completeUploadSession", 200, result)
    assert result["status"] == "COMPLETED"
    assert [(f["status"], f["failure_code"]) for f in result["files"]] == [("VERIFIED", None)]
    row = file_row(db, result["files"][0]["file_id"])
    assert row["verified_at"] is not None and row["scan_status"] == "SKIPPED"
    assert api.deps.verification.enqueued == []  # type: ignore[attr-defined]


def test_missing_object_and_size_mismatch_fail(api: CatalogApi, db: PgUrls) -> None:
    _, version_id = new_draft(api)
    body = start_upload(api, version_id, {"a.csv": CSV, "b.csv": CSV})
    store = memory_store(api.deps.storage, "inst-b")
    b_key = file_row(db, body["files"][1]["file_id"])["storage_key"]
    store.put(b_key, CSV + b"extra", "text/csv")
    result = complete(api, body["upload_session_id"]).json()
    assert {f["path"]: (f["status"], f["failure_code"]) for f in result["files"]} == {
        "a.csv": ("FAILED", "OBJECT_MISSING"),
        "b.csv": ("FAILED", "SIZE_MISMATCH"),
    }
    assert store.head(b_key) is None


def test_checksum_mismatch_deletes_the_object(api: CatalogApi, db: PgUrls) -> None:
    _, version_id = new_draft(api)
    body = start_upload(api, version_id, {"a.csv": CSV})
    tampered = CSV.replace(b"1.0", b"9.9")
    put_uploaded(api, db, body, {"a.csv": tampered})
    result = complete(api, body["upload_session_id"]).json()
    assert (result["files"][0]["status"], result["files"][0]["failure_code"]) == ("FAILED", "CHECKSUM_MISMATCH")
    assert memory_store(api.deps.storage, "inst-b").head(file_row(db, body["files"][0]["file_id"])["storage_key"]) is None


def test_multipart_upload_completes_and_verifies(api: CatalogApi, db: PgUrls) -> None:
    api.use(replace(api.deps, settings=SMALL_MULTIPART))
    _, version_id = new_draft(api)
    body = start_upload(api, version_id, {"data/big.csv": CSV})
    assert body["files"][0]["upload"]["method"] == "MULTIPART"
    parts = put_uploaded(api, db, body, {"data/big.csv": CSV})
    response = complete(api, body["upload_session_id"], parts)
    assert response.status_code == 200, response.text
    assert response.json()["files"][0]["status"] == "VERIFIED"


def test_at07_multipart_with_wrong_content_fails_and_is_deleted(api: CatalogApi, db: PgUrls) -> None:  # memory variant
    api.use(replace(api.deps, settings=SMALL_MULTIPART))
    _, version_id = new_draft(api)
    body = start_upload(api, version_id, {"data/big.csv": CSV})
    parts = put_uploaded(api, db, body, {"data/big.csv": CSV.replace(b"S0001", b"S0002")})
    result = complete(api, body["upload_session_id"], parts).json()
    assert (result["files"][0]["status"], result["files"][0]["failure_code"]) == ("FAILED", "CHECKSUM_MISMATCH")
    key = file_row(db, body["files"][0]["file_id"])["storage_key"]
    assert memory_store(api.deps.storage, "inst-b").head(key) is None


def test_multipart_needs_its_parts(api: CatalogApi, db: PgUrls) -> None:
    api.use(replace(api.deps, settings=SMALL_MULTIPART))
    _, version_id = new_draft(api)
    body = start_upload(api, version_id, {"data/big.csv": CSV})
    response = complete(api, body["upload_session_id"], {"parts": []})
    assert response.status_code == 422
    assert_matches_response("completeUploadSession", 422, response.json())
    assert response.json()["error"]["details"]["fields"][0]["reason"] == "MISSING_PARTS"
    unknown = complete(api, body["upload_session_id"], {"parts": [{"file_id": str(uuid4()), "etags": [{"part_number": 1, "etag": "x"}]}]})
    assert unknown.status_code == 422
    assert rows(db, "SELECT status FROM catalog.upload_sessions") == [{"status": "OPEN"}]


def test_bad_etag_fails_the_file_as_object_missing(api: CatalogApi, db: PgUrls) -> None:
    api.use(replace(api.deps, settings=SMALL_MULTIPART))
    _, version_id = new_draft(api)
    body = start_upload(api, version_id, {"data/big.csv": CSV})
    parts = put_uploaded(api, db, body, {"data/big.csv": CSV})
    parts["parts"][0]["etags"][0]["etag"] = '"deadbeef"'
    result = complete(api, body["upload_session_id"], parts).json()
    assert (result["files"][0]["status"], result["files"][0]["failure_code"]) == ("FAILED", "OBJECT_MISSING")


def test_second_complete_is_conflict(api: CatalogApi, db: PgUrls) -> None:  # Review Focus 4
    _, version_id = new_draft(api)
    body = start_upload(api, version_id, {"a.csv": CSV})
    put_uploaded(api, db, body, {"a.csv": CSV})
    assert complete(api, body["upload_session_id"]).status_code == 200
    response = complete(api, body["upload_session_id"])
    assert response.status_code == 409
    assert_matches_response("completeUploadSession", 409, response.json())
    assert response.json()["error"]["code"] == "CONFLICT"
    assert file_row(db, body["files"][0]["file_id"])["status"] == "VERIFIED"


def test_expired_session_cannot_be_completed(api: CatalogApi) -> None:
    _, version_id = new_draft(api)
    body = start_upload(api, version_id, {"a.csv": CSV})
    with clock.frozen(datetime.now(UTC) + timedelta(hours=2)):
        response = complete(api, body["upload_session_id"])
    assert response.status_code == 409
    assert_matches_response("completeUploadSession", 409, response.json())
    assert response.json()["error"]["code"] == "UPLOAD_SESSION_EXPIRED"


def test_only_creator_or_owner_steward_can_complete(api: CatalogApi) -> None:
    _, version_id = new_draft(api)
    body = start_upload(api, version_id, {"a.csv": CSV})
    assert_error(complete(api, body["upload_session_id"], user="b.admin"), 403, "FORBIDDEN")
    assert_error(complete(api, body["upload_session_id"], user="a.steward"), 404, "NOT_FOUND")
    assert_error(complete(api, str(uuid4())), 404, "NOT_FOUND")


def test_large_sessions_are_verified_by_the_worker(api: CatalogApi, db: PgUrls) -> None:
    api.use(replace(api.deps, settings=CatalogSettings(catalog_sync_verify_max_bytes=10)))
    _, version_id = new_draft(api)
    body = start_upload(api, version_id, {"a.csv": CSV})
    put_uploaded(api, db, body, {"a.csv": CSV})
    result = complete(api, body["upload_session_id"]).json()
    file_id = UUID(result["files"][0]["file_id"])
    assert result["files"][0]["status"] == "UPLOADED"
    queue = api.deps.verification
    assert isinstance(queue, RecordingVerificationQueue) and queue.enqueued == [file_id]
    assert verify_file_job(file_id, deps=api.deps) == "VERIFIED"
    assert verify_file_job(file_id, deps=api.deps) is None  # at-least-once delivery: second run is a no-op
    polled = api.get("b.steward", f"/upload-sessions/{body['upload_session_id']}").json()
    assert polled["files"][0]["status"] == "VERIFIED"


def test_dramatiq_queue_sends_one_message_per_file() -> None:
    broker = configure_broker(Settings(), StubBroker())
    DramatiqVerificationQueue().enqueue([uuid4(), uuid4()])
    assert broker.queues["catalog"].qsize() == 2  # type: ignore[attr-defined]
    assert verify_file_actor.actor_name == "catalog.verify_file"


def test_delete_draft_file(api: CatalogApi, db: PgUrls) -> None:
    _, version_id = new_draft(api)
    body = start_upload(api, version_id, {"a.csv": CSV})
    tampered = {"a.csv": CSV.replace(b"1.0", b"2.0")}
    put_uploaded(api, db, body, tampered)
    complete(api, body["upload_session_id"])
    file_id = body["files"][0]["file_id"]
    response = api.delete("b.steward", f"/dataset-versions/{version_id}/files/{file_id}")
    assert response.status_code == 204 and response.content == b""
    assert rows(db, "SELECT file_id FROM catalog.dataset_files") == []
    again = api.delete("b.steward", f"/dataset-versions/{version_id}/files/{file_id}")
    assert again.status_code == 404
    assert_matches_response("deleteDraftFile", 404, again.json())


def test_delete_rules(api: CatalogApi, db: PgUrls) -> None:
    _, version_id = new_draft(api)
    body = start_upload(api, version_id, {"a.csv": CSV})
    file_id = body["files"][0]["file_id"]
    pending = api.delete("b.steward", f"/dataset-versions/{version_id}/files/{file_id}")
    assert pending.status_code == 409
    assert_matches_response("deleteDraftFile", 409, pending.json())
    forbidden = api.delete("b.researcher", f"/dataset-versions/{version_id}/files/{file_id}")
    assert forbidden.status_code == 404  # draft versions are invisible to non-stewards
    dataset_id = create_dataset(api)["dataset_id"]
    published = insert_version(db, UUID(dataset_id), published=True, files=[("data/a.csv", 10, SHA_A)])
    published_file = rows(db, "SELECT file_id FROM catalog.dataset_files WHERE dataset_version_id = :v", v=published)[0]["file_id"]
    immutable = api.delete("b.steward", f"/dataset-versions/{published}/files/{published_file}")
    assert immutable.status_code == 409
    assert immutable.json()["error"]["code"] == "DATASET_VERSION_IMMUTABLE"


def test_upload_session_body_after_complete_has_no_urls(api: CatalogApi, db: PgUrls) -> None:
    _, version_id = new_draft(api)
    result = upload_files(api, db, version_id, {"a.csv": CSV, "b.json": b'{"k": 1}'})
    assert all("upload" not in f for f in result["files"])
    assert hashlib.sha256(CSV).hexdigest() == file_spec("a.csv", CSV)["sha256"]
```

`apps/api/modules/catalog/tests/test_s3_e2e.py`:

```python
"""M03-AT-05/06/07 through the real presign path: TestClient API -> presigned URL -> :21051 gateway -> SeaweedFS."""

import hashlib
from dataclasses import replace
from urllib.parse import urlsplit

import httpx
import pytest

from api.modules.catalog.objects import StorageRegistry
from api.modules.catalog.tests.support_api import CatalogApi, new_draft
from api.modules.catalog.tests.support_upload import complete, file_row, start_upload
from api.platform.testing.fixtures import PgUrls

MIB = 1024 * 1024
LINE = b"0123456789,abcdefghij\n"
OTHER = b"9876543210,jihgfedcba\n"


@pytest.fixture
def s3_api(api: CatalogApi, seaweed_registry: StorageRegistry) -> CatalogApi:
    api.use(replace(api.deps, storage=seaweed_registry))
    return api


def _put_parts(upload: dict[str, object], data: bytes) -> list[dict[str, object]]:
    size = int(upload["part_size_bytes"])  # type: ignore[arg-type]
    etags = []
    for part in upload["parts"]:  # type: ignore[attr-defined]
        n = part["part_number"]
        response = httpx.put(part["url"], content=data[(n - 1) * size : n * size], timeout=300)
        assert response.status_code == 200, response.text
        etags.append({"part_number": n, "etag": response.headers["etag"]})
    return etags


def test_at05_small_csv_through_the_gateway(s3_api: CatalogApi, db: PgUrls, s3_prefixes: list[str], seaweed_registry: StorageRegistry) -> None:
    dataset_id, version_id = new_draft(s3_api)
    s3_prefixes.append(f"datasets/{dataset_id}/")
    data = (b"a,b\n" + b"1,2\n" * 300)[:1024]
    body = start_upload(s3_api, version_id, {"data/a.csv": data})
    upload = body["files"][0]["upload"]
    url = urlsplit(upload["url"])
    assert url.netloc == "localhost:21051"
    assert url.path.startswith(f"/nais-inst-b/datasets/{dataset_id}/{version_id}/")
    assert httpx.put(upload["url"], content=data, headers=upload["headers"], timeout=60).status_code == 200
    result = complete(s3_api, body["upload_session_id"]).json()
    assert result["files"][0]["status"] == "VERIFIED"
    key = file_row(db, body["files"][0]["file_id"])["storage_key"]
    assert seaweed_registry.for_org("inst-b").head(key) == len(data)


def test_tampered_single_put_is_rejected_by_storage(s3_api: CatalogApi, s3_prefixes: list[str]) -> None:
    dataset_id, version_id = new_draft(s3_api)
    s3_prefixes.append(f"datasets/{dataset_id}/")
    data = b"a,b\n1,2\n"
    body = start_upload(s3_api, version_id, {"data/a.csv": data})
    upload = body["files"][0]["upload"]
    assert httpx.put(upload["url"], content=b"a,b\n6,6\n", headers=upload["headers"], timeout=60).status_code == 400
    result = complete(s3_api, body["upload_session_id"]).json()
    assert (result["files"][0]["status"], result["files"][0]["failure_code"]) == ("FAILED", "OBJECT_MISSING")


def test_at06_100_mib_multipart_upload_is_verified(s3_api: CatalogApi, s3_prefixes: list[str]) -> None:
    dataset_id, version_id = new_draft(s3_api)
    s3_prefixes.append(f"datasets/{dataset_id}/")
    data = LINE * (100 * MIB // len(LINE) + 1)
    assert len(data) > 64 * MIB
    body = start_upload(s3_api, version_id, {"data/big.csv": data})
    upload = body["files"][0]["upload"]
    assert upload["method"] == "MULTIPART" and len(upload["parts"]) == 2
    parts = [{"file_id": body["files"][0]["file_id"], "etags": _put_parts(upload, data)}]
    result = complete(s3_api, body["upload_session_id"], {"parts": parts}).json()
    assert result["files"][0]["status"] == "VERIFIED", result


def test_at07_multipart_with_wrong_content_fails_and_object_is_gone(
    s3_api: CatalogApi, db: PgUrls, s3_prefixes: list[str], seaweed_registry: StorageRegistry
) -> None:
    dataset_id, version_id = new_draft(s3_api)
    s3_prefixes.append(f"datasets/{dataset_id}/")
    declared = LINE * (70 * MIB // len(LINE))
    actual = OTHER * (70 * MIB // len(OTHER))
    assert len(declared) == len(actual) and hashlib.sha256(declared).digest() != hashlib.sha256(actual).digest()
    body = start_upload(s3_api, version_id, {"data/big.csv": declared})
    upload = body["files"][0]["upload"]
    parts = [{"file_id": body["files"][0]["file_id"], "etags": _put_parts(upload, actual)}]
    result = complete(s3_api, body["upload_session_id"], {"parts": parts}).json()
    assert (result["files"][0]["status"], result["files"][0]["failure_code"]) == ("FAILED", "CHECKSUM_MISMATCH")
    key = file_row(db, body["files"][0]["file_id"])["storage_key"]
    assert seaweed_registry.for_org("inst-b").head(key) is None
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `uv run pytest apps/api/modules/catalog/tests/test_complete_upload.py -v`
Expected: collection error `No module named 'api.modules.catalog.jobs'`.

- [ ] **Step 3: Implement**

`apps/api/modules/catalog/service/completion.py`:

```python
"""completeUploadSession and deleteDraftFile (M03 §5.2, §6.6, D-014)."""

from collections.abc import Sequence
from typing import Any
from uuid import UUID

from sqlalchemy import delete, select, update
from sqlalchemy.engine import RowMapping
from sqlalchemy.orm import Session

from api.modules.catalog.access import can_see_dataset, is_steward, not_found, require_draft, steward_version
from api.modules.catalog.deps import CatalogDeps
from api.modules.catalog.errors import dependency_errors
from api.modules.catalog.objects import MultipartFailed, ObjectStore
from api.modules.catalog.repo import load_dataset, load_version, must
from api.modules.catalog.schemas import UploadCompleteIn
from api.modules.catalog.service.uploads import abort_quietly, upload_session_response
from api.modules.catalog.tables import dataset_files, upload_sessions
from api.modules.catalog.verification import verify_in_session
from api.platform import clock
from api.platform.auth import CurrentUser
from api.platform.errors import ApiError
from api.platform.generated.error_codes import ErrorCode


def _parts_by_file(files: Sequence[RowMapping], body: UploadCompleteIn) -> dict[UUID, list[tuple[int, str]]]:
    multipart_ids = {f["file_id"] for f in files if f["multipart_upload_id"]}
    given = {item.file_id: [(e.part_number, e.etag) for e in item.etags] for item in body.parts}
    problems = [
        {"field": "parts", "reason": "UNKNOWN_FILE", "file_id": str(file_id)}
        for file_id in given
        if file_id not in multipart_ids
    ]
    problems += [
        {"field": "parts", "reason": "MISSING_PARTS", "file_id": str(file_id)}
        for file_id in sorted(multipart_ids, key=str)
        if not given.get(file_id)
    ]
    if problems:
        raise ApiError(ErrorCode.VALIDATION_FAILED, "Multipart files need their part ETags.", {"fields": problems})
    return given


def _finalize_upload(store: ObjectStore, f: RowMapping, parts: list[tuple[int, str]] | None) -> tuple[str, str | None]:
    key = f["storage_key"]
    if f["multipart_upload_id"]:
        try:
            store.complete_multipart(key, f["multipart_upload_id"], parts or [])
        except MultipartFailed:
            abort_quietly(store, key, f["multipart_upload_id"])
            return "FAILED", "OBJECT_MISSING"
    size = store.head(key)
    if size is None:
        return "FAILED", "OBJECT_MISSING"
    if size != int(f["size_bytes"]):
        store.delete(key)
        return "FAILED", "SIZE_MISMATCH"
    return "UPLOADED", None


def complete_upload_session(
    session: Session, deps: CatalogDeps, user: CurrentUser, upload_session_id: UUID, body: UploadCompleteIn
) -> tuple[dict[str, Any], list[UUID]]:
    sess = session.execute(
        select(upload_sessions).where(upload_sessions.c.upload_session_id == upload_session_id).with_for_update()
    ).mappings().first()
    if sess is None:
        raise not_found("Upload session")
    version = must(load_version(session, sess["dataset_version_id"]), "version")
    ds = must(load_dataset(session, version["dataset_id"]), "dataset")
    if sess["created_by"] != user.user_id and not is_steward(user, ds["owner_organization_id"]):
        if can_see_dataset(user, ds):
            raise ApiError(ErrorCode.FORBIDDEN, "Only the session creator or an owner-organization steward can complete it.")
        raise not_found("Upload session")
    now = clock.now()
    if sess["status"] == "EXPIRED" or (sess["status"] == "OPEN" and sess["expires_at"] <= now):
        raise ApiError(ErrorCode.UPLOAD_SESSION_EXPIRED, "Upload session expired; create a new one.")
    if sess["status"] != "OPEN":
        raise ApiError(ErrorCode.CONFLICT, "Upload session is already completed.")
    files = session.execute(
        select(dataset_files)
        .where(dataset_files.c.upload_session_id == upload_session_id, dataset_files.c.status == "PENDING")
        .order_by(dataset_files.c.path.collate("C"))
    ).mappings().all()
    parts = _parts_by_file(files, body)
    uploaded: list[RowMapping] = []
    with dependency_errors():
        for f in files:
            store = deps.storage.for_bucket(f["storage_bucket"])
            status, failure = _finalize_upload(store, f, parts.get(f["file_id"]))
            session.execute(
                update(dataset_files)
                .where(dataset_files.c.file_id == f["file_id"])
                .values(status=status, failure_code=failure, updated_at=now)
            )
            if status == "UPLOADED":
                uploaded.append(f)
        session.execute(
            update(upload_sessions)
            .where(upload_sessions.c.upload_session_id == upload_session_id)
            .values(status="COMPLETED", completed_at=now)
        )
        to_verify: list[UUID] = []
        if sum(int(f["size_bytes"]) for f in uploaded) <= deps.settings.catalog_sync_verify_max_bytes:
            for f in uploaded:
                verify_in_session(session, deps, f)
        else:
            to_verify = [f["file_id"] for f in uploaded]
        return upload_session_response(session, deps, upload_session_id), to_verify


def delete_draft_file(session: Session, deps: CatalogDeps, user: CurrentUser, version_id: UUID, file_id: UUID) -> None:
    version, _ = steward_version(session, user, version_id, for_update=True)
    require_draft(version)
    f = session.execute(
        select(dataset_files).where(dataset_files.c.file_id == file_id, dataset_files.c.dataset_version_id == version_id)
    ).mappings().first()
    if f is None:
        raise not_found("File")
    if f["status"] == "PENDING":
        sess = session.execute(
            select(upload_sessions).where(upload_sessions.c.upload_session_id == f["upload_session_id"])
        ).mappings().first()
        if sess is not None and sess["status"] == "OPEN" and sess["expires_at"] > clock.now():
            raise ApiError(ErrorCode.CONFLICT, "The file is still being uploaded in an open session.")
    session.execute(delete(dataset_files).where(dataset_files.c.file_id == file_id))
    with dependency_errors():
        store = deps.storage.for_bucket(f["storage_bucket"])
        if f["status"] == "PENDING" and f["multipart_upload_id"]:
            abort_quietly(store, f["storage_key"], f["multipart_upload_id"])
        store.delete(f["storage_key"])
```

`apps/api/modules/catalog/routes/completion.py`:

```python
from typing import Any
from uuid import UUID

from fastapi import APIRouter, BackgroundTasks, Response

from api.modules.catalog.deps import CatalogDepsDep
from api.modules.catalog.schemas import UploadCompleteIn
from api.modules.catalog.service import completion as service
from api.platform.auth import CurrentUserDep
from api.platform.db import SessionDep

router = APIRouter(tags=["catalog"])


@router.post("/upload-sessions/{upload_session_id}/complete", operation_id="completeUploadSession")
def complete_upload_session(
    upload_session_id: UUID,
    body: UploadCompleteIn,
    background: BackgroundTasks,
    session: SessionDep,
    user: CurrentUserDep,
    deps: CatalogDepsDep,
) -> dict[str, Any]:
    result, to_verify = service.complete_upload_session(session, deps, user, upload_session_id, body)
    if to_verify:
        # Background tasks run after the response, i.e. after SessionDep committed: the worker sees UPLOADED rows.
        background.add_task(deps.verification.enqueue, to_verify)
    return result


@router.delete("/dataset-versions/{version_id}/files/{file_id}", operation_id="deleteDraftFile", status_code=204)
def delete_draft_file(
    version_id: UUID, file_id: UUID, session: SessionDep, user: CurrentUserDep, deps: CatalogDepsDep
) -> Response:
    service.delete_draft_file(session, deps, user, version_id, file_id)
    return Response(status_code=204)
```

`apps/api/modules/catalog/jobs.py`:

```python
"""Catalog background work (M03 §10). The verify actor is declared at import time (D-036)."""

import logging
from uuid import UUID

import dramatiq
from sqlalchemy import select

from api.modules.catalog.deps import CatalogDeps
from api.modules.catalog.objects import StorageUnavailable
from api.modules.catalog.tables import dataset_files
from api.modules.catalog.verification import apply_outcome, evaluate_object
from api.platform import ports

logger = logging.getLogger("nais.catalog.jobs")

VERIFY_TIME_LIMIT_MS = 2 * 60 * 60 * 1000
VERIFY_MAX_RETRIES = 3


def verify_file_job(file_id: UUID, *, deps: CatalogDeps) -> str | None:
    """Idempotent: only an UPLOADED row is evaluated and updated (at-least-once delivery)."""
    with deps.session_factory() as session:
        row = session.execute(select(dataset_files).where(dataset_files.c.file_id == file_id)).mappings().first()
    if row is None or row["status"] != "UPLOADED":
        return None
    store = deps.storage.for_bucket(row["storage_bucket"])
    outcome = evaluate_object(
        store,
        key=row["storage_key"],
        size=int(row["size_bytes"]),
        sha256=row["sha256"],
        path=row["path"],
        scanner=deps.scanner,
    )
    with deps.session_factory() as session, session.begin():
        applied = apply_outcome(session, file_id, outcome)
    if not applied:
        return None
    if outcome.failed:
        store.delete(row["storage_key"])
    logger.info(
        "catalog file verified",
        extra={"file_id": str(file_id), "status": outcome.status, "failure_code": outcome.failure_code},
    )
    return outcome.status


def _retry_when(retries: int, exc: BaseException) -> bool:
    return retries < VERIFY_MAX_RETRIES and isinstance(exc, StorageUnavailable)


@dramatiq.actor(
    queue_name="catalog",
    actor_name="catalog.verify_file",
    time_limit=VERIFY_TIME_LIMIT_MS,
    retry_when=_retry_when,
)
def verify_file_actor(file_id: str) -> None:
    verify_file_job(UUID(file_id), deps=ports.get(CatalogDeps))
```

`apps/api/modules/catalog/router.py`:

```python
"""All catalog routes (mounted under /api/v1 by the platform)."""

from fastapi import APIRouter

from api.modules.catalog.routes import completion, dataset_update, datasets, uploads, versions

router = APIRouter()
for sub in (datasets.router, dataset_update.router, versions.router, uploads.router, completion.router):
    router.include_router(sub)
```

`apps/api/modules/catalog/__init__.py`:

```python
"""M03 Data Catalog & Versioning. Spec: NAIS_PRD/modules/M03_data_catalog.md."""

from pathlib import Path

from api.modules.catalog import jobs  # noqa: F401  (declares the catalog.verify_file actor at import time)
from api.modules.catalog.router import router
from api.modules.catalog.wiring import wire
from api.platform.modules import ModuleSpec

MODULE = ModuleSpec(
    name="catalog",
    db_schema="catalog",
    router=router,
    migrations_dir=Path(__file__).parent / "migrations",
    wire=wire,
)
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `uv run pytest apps/api/modules/catalog/tests/test_complete_upload.py apps/api/modules/catalog/tests/test_s3_e2e.py -v`
Expected: all PASS (`test_s3_e2e.py` SKIPs only if the dev stack is down; AT-06 moves ~100 MiB through the gateway and may take a few seconds).

- [ ] **Step 5: Commit**

```bash
uv run ruff check --fix apps/api/modules/catalog && uv run ruff format apps/api/modules/catalog
git add apps/api/modules/catalog
git commit -m "feat(catalog): complete upload session, delete draft file, verify_file actor, S3 e2e tests

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 12: `publishDatasetVersion` — manifest, metadata snapshot, immutability, event

**Files:**
- Create: `apps/api/modules/catalog/service/publish.py`
- Create: `apps/api/modules/catalog/routes/publish.py`
- Modify: `apps/api/modules/catalog/router.py`
- Test: `apps/api/modules/catalog/tests/test_publish.py`

**Interfaces:**
- Consumes: `steward_version`, `require_draft` (Task 6), `manifest_sha256`, `SNAPSHOT_FIELDS` (Task 1), `enqueue_index`, `load_version`, `must` (Task 6), `version_response` (Task 8), `upload_files`, `start_upload`, `put_uploaded`, `complete` (Task 9), `outbox`, `EventActor`.
- Produces: `service.publish.metadata_snapshot(ds) -> dict` (keys sorted), `service.publish.finalize_publish(session, *, ds, version, published_by: UUID, actor: EventActor) -> None` (reused by seed), `service.publish.publish_version(session, user, version_id) -> dict`; route `POST /dataset-versions/{version_id}/publish` (`publishDatasetVersion`, 200 DatasetVersion). Emits `catalog.dataset.version_published.v1`.

- [ ] **Step 1: Write the failing tests**

`apps/api/modules/catalog/tests/test_publish.py`:

```python
import hashlib
from uuid import UUID

import pytest
from sqlalchemy.exc import DBAPIError

from api.modules.catalog.domain import manifest_sha256
from api.modules.catalog.tests.support import execute, outbox_events, rows
from api.modules.catalog.tests.support_api import USERS, CatalogApi, new_draft
from api.modules.catalog.tests.support_upload import complete, file_spec, put_uploaded, start_upload, upload_files
from api.platform.testing.contracts import assert_matches_response, assert_valid_event
from api.platform.testing.fixtures import PgUrls

FILES = {"data/b.csv": b"x,y\n3,4\n", "README.md": b"# Battery\n", "data/a.csv": b"x,y\n1,2\n"}


def publish(api: CatalogApi, version_id: str, user: str = "b.steward"):  # type: ignore[no-untyped-def]
    return api.post(user, f"/dataset-versions/{version_id}/publish")


def test_publish_freezes_manifest_and_metadata(api: CatalogApi, db: PgUrls) -> None:
    dataset_id, version_id = new_draft(api)
    upload_files(api, db, version_id, FILES)
    response = publish(api, version_id)
    assert response.status_code == 200, response.text
    body = response.json()
    assert_matches_response("publishDatasetVersion", 200, body)
    expected_manifest = manifest_sha256((p, len(d), hashlib.sha256(d).hexdigest()) for p, d in FILES.items())
    assert body["status"] == "PUBLISHED" and body["manifest_sha256"] == expected_manifest
    assert (body["file_count"], body["total_bytes"]) == (3, sum(len(d) for d in FILES.values()))
    [event] = outbox_events(db, "catalog.dataset.version_published.v1")
    assert_valid_event(event)
    assert event["payload"] == {
        "dataset_id": dataset_id,
        "dataset_version_id": version_id,
        "version_label": "v1",
        "owner_organization_id": body_owner(api, dataset_id),
        "file_count": 3,
        "total_bytes": body["total_bytes"],
        "manifest_sha256": expected_manifest,
    }
    assert event["actor"]["user_id"] == str(USERS["b.steward"].user_id)
    [row] = rows(db, "SELECT metadata_snapshot, published_by FROM catalog.dataset_versions WHERE dataset_version_id = :v", v=version_id)
    snapshot = row["metadata_snapshot"]
    assert sorted(snapshot) == [
        "access_level", "allowed_purposes", "contact_email", "description", "domain", "keywords",
        "license", "max_grant_days", "provenance", "title", "usage_policy",
    ]
    assert snapshot["title"] == "Battery Cycling Measurements" and snapshot["allowed_purposes"] == ["ACADEMIC_RESEARCH", "AI_TRAINING"]
    assert row["published_by"] == USERS["b.steward"].user_id
    assert UUID(dataset_id) in [r["dataset_id"] for r in rows(db, "SELECT dataset_id FROM catalog.index_queue")]

    assert api.patch("b.steward", f"/datasets/{dataset_id}", json={"title": "Renamed after publish"}).status_code == 200
    again = rows(db, "SELECT metadata_snapshot FROM catalog.dataset_versions WHERE dataset_version_id = :v", v=version_id)
    assert again[0]["metadata_snapshot"]["title"] == "Battery Cycling Measurements"


def body_owner(api: CatalogApi, dataset_id: str) -> str:
    owner: str = api.get("b.steward", f"/datasets/{dataset_id}").json()["owner_organization_id"]
    return owner


def test_at11_version_without_files_is_incomplete(api: CatalogApi, db: PgUrls) -> None:
    _, version_id = new_draft(api)
    response = publish(api, version_id)
    assert response.status_code == 409
    assert_matches_response("publishDatasetVersion", 409, response.json())
    assert response.json()["error"]["code"] == "DATASET_VERSION_INCOMPLETE"
    assert outbox_events(db, "catalog.dataset.version_published.v1") == []


def test_failed_or_pending_files_block_publish(api: CatalogApi, db: PgUrls) -> None:
    _, version_id = new_draft(api)
    upload_files(api, db, version_id, {"data/a.csv": b"x,y\n1,2\n"})
    session_body = start_upload(api, version_id, {"data/b.csv": b"x,y\n3,4\n"})
    put_uploaded(api, db, session_body, {"data/b.csv": b"x,y\n9,9\n"})
    complete(api, session_body["upload_session_id"])
    response = publish(api, version_id)
    assert response.status_code == 409
    error = response.json()["error"]
    assert error["code"] == "DATASET_VERSION_INCOMPLETE"
    assert error["details"]["files"] == [
        {"file_id": session_body["files"][0]["file_id"], "path": "data/b.csv", "status": "FAILED"}
    ]


def test_at12_published_version_is_immutable_via_api_and_db(api: CatalogApi, db: PgUrls) -> None:
    _, version_id = new_draft(api)
    upload_files(api, db, version_id, FILES)
    assert publish(api, version_id).status_code == 200
    response = api.post("b.steward", f"/dataset-versions/{version_id}/upload-session", json={"files": [file_spec("c.csv", b"1")]})
    assert response.status_code == 409 and response.json()["error"]["code"] == "DATASET_VERSION_IMMUTABLE"
    second = publish(api, version_id)
    assert second.status_code == 409
    assert_matches_response("publishDatasetVersion", 409, second.json())
    assert second.json()["error"]["code"] == "DATASET_VERSION_IMMUTABLE"
    with pytest.raises(DBAPIError, match="immutable"):
        execute(db, "UPDATE catalog.dataset_versions SET manifest_sha256 = :m WHERE dataset_version_id = :v", m="0" * 64, v=version_id)
    with pytest.raises(DBAPIError, match="immutable"):
        execute(db, "DELETE FROM catalog.dataset_files WHERE dataset_version_id = :v", v=version_id)


def test_at13_new_version_after_publish(api: CatalogApi, db: PgUrls) -> None:
    dataset_id, version_id = new_draft(api)
    upload_files(api, db, version_id, FILES)
    assert publish(api, version_id).status_code == 200
    assert api.post("b.steward", f"/datasets/{dataset_id}/versions", json={"version_label": "v2"}).status_code == 201
    reused = api.post("b.steward", f"/datasets/{dataset_id}/versions", json={"version_label": "v1"})
    assert reused.status_code == 409 and reused.json()["error"]["code"] == "DATASET_VERSION_LABEL_EXISTS"


def test_at14_same_files_in_different_order_give_the_same_manifest(api: CatalogApi, db: PgUrls) -> None:
    dataset_id, first = new_draft(api)
    upload_files(api, db, first, FILES)
    second = api.post("b.steward", f"/datasets/{dataset_id}/versions", json={"version_label": "v2"}).json()["dataset_version_id"]
    for path in reversed(list(FILES)):
        upload_files(api, db, second, {path: FILES[path]})
    manifests = [publish(api, version_id).json()["manifest_sha256"] for version_id in (first, second)]
    assert manifests[0] == manifests[1]


def test_only_owner_stewards_publish(api: CatalogApi, db: PgUrls) -> None:
    _, version_id = new_draft(api)
    upload_files(api, db, version_id, FILES)
    response = publish(api, version_id, user="b.admin")
    assert response.status_code == 403
    assert_matches_response("publishDatasetVersion", 403, response.json())
    assert publish(api, version_id, user="a.steward").status_code == 404


def test_published_version_becomes_the_latest(api: CatalogApi, db: PgUrls) -> None:
    dataset_id, version_id = new_draft(api)
    upload_files(api, db, version_id, FILES)
    publish(api, version_id)
    body = api.get("a.researcher", f"/datasets/{dataset_id}").json()
    assert body["latest_published_version"]["dataset_version_id"] == version_id
    listed = api.get("a.researcher", f"/datasets/{dataset_id}/versions").json()["items"]
    assert [v["dataset_version_id"] for v in listed] == [version_id]
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `uv run pytest apps/api/modules/catalog/tests/test_publish.py -v`
Expected: FAIL — `POST /dataset-versions/{id}/publish` returns 404 (no route).

- [ ] **Step 3: Implement**

`apps/api/modules/catalog/service/publish.py`:

```python
"""publishDatasetVersion (M03 §6.9): one transaction freezes manifest + metadata and emits the event."""

from collections.abc import Mapping
from typing import Any
from uuid import UUID

from sqlalchemy import select, update
from sqlalchemy.orm import Session

from api.modules.catalog.access import require_draft, steward_version
from api.modules.catalog.domain import SNAPSHOT_FIELDS, manifest_sha256
from api.modules.catalog.repo import enqueue_index, load_version, must
from api.modules.catalog.service.versions import version_response
from api.modules.catalog.tables import dataset_files, dataset_versions
from api.platform import clock
from api.platform.auth import CurrentUser
from api.platform.errors import ApiError
from api.platform.events import EventActor
from api.platform.generated.error_codes import ErrorCode
from api.platform.outbox import outbox

LIST_FIELDS = frozenset({"keywords", "allowed_purposes"})


def metadata_snapshot(ds: Mapping[Any, Any]) -> dict[str, Any]:
    """Dataset metadata frozen at publish; M05 evaluates this, never the live dataset (D-029)."""
    return {field: list(ds[field]) if field in LIST_FIELDS else ds[field] for field in sorted(SNAPSHOT_FIELDS)}


def finalize_publish(
    session: Session,
    *,
    ds: Mapping[Any, Any],
    version: Mapping[Any, Any],
    published_by: UUID,
    actor: EventActor,
) -> None:
    version_id = version["dataset_version_id"]
    files = session.execute(
        select(dataset_files)
        .where(dataset_files.c.dataset_version_id == version_id)
        .order_by(dataset_files.c.path.collate("C"))
    ).mappings().all()
    not_ready = [f for f in files if f["status"] != "VERIFIED"]
    if not files or not_ready:
        raise ApiError(
            ErrorCode.DATASET_VERSION_INCOMPLETE,
            "Publishing needs at least one file and every file VERIFIED.",
            {"files": [{"file_id": str(f["file_id"]), "path": f["path"], "status": f["status"]} for f in not_ready]},
        )
    manifest = manifest_sha256((f["path"], int(f["size_bytes"]), f["sha256"].strip()) for f in files)
    total_bytes = sum(int(f["size_bytes"]) for f in files)
    now = clock.now()
    session.execute(
        update(dataset_versions)
        .where(dataset_versions.c.dataset_version_id == version_id, dataset_versions.c.status == "DRAFT")
        .values(
            status="PUBLISHED",
            manifest_sha256=manifest,
            metadata_snapshot=metadata_snapshot(ds),
            file_count=len(files),
            total_bytes=total_bytes,
            published_at=now,
            published_by=published_by,
            updated_at=now,
        )
    )
    outbox.write(
        session,
        "catalog.dataset.version_published.v1",
        {
            "dataset_id": str(ds["dataset_id"]),
            "dataset_version_id": str(version_id),
            "version_label": version["version_label"],
            "owner_organization_id": str(ds["owner_organization_id"]),
            "file_count": len(files),
            "total_bytes": total_bytes,
            "manifest_sha256": manifest,
        },
        actor,
    )
    enqueue_index(session, ds["dataset_id"])


def publish_version(session: Session, user: CurrentUser, version_id: UUID) -> dict[str, Any]:
    version, ds = steward_version(session, user, version_id, for_update=True)
    require_draft(version)
    finalize_publish(session, ds=ds, version=version, published_by=user.user_id, actor=EventActor.for_user(user))
    return version_response(session, must(load_version(session, version_id), "version"))
```

`apps/api/modules/catalog/routes/publish.py`:

```python
from typing import Any
from uuid import UUID

from fastapi import APIRouter

from api.modules.catalog.service import publish as service
from api.platform.auth import CurrentUserDep
from api.platform.db import SessionDep

router = APIRouter(tags=["catalog"])


@router.post("/dataset-versions/{version_id}/publish", operation_id="publishDatasetVersion")
def publish_dataset_version(version_id: UUID, session: SessionDep, user: CurrentUserDep) -> dict[str, Any]:
    return service.publish_version(session, user, version_id)
```

`apps/api/modules/catalog/router.py`:

```python
"""All catalog routes (mounted under /api/v1 by the platform)."""

from fastapi import APIRouter

from api.modules.catalog.routes import completion, dataset_update, datasets, publish, uploads, versions

router = APIRouter()
for sub in (datasets.router, dataset_update.router, versions.router, uploads.router, completion.router, publish.router):
    router.include_router(sub)
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `uv run pytest apps/api/modules/catalog/tests/test_publish.py -v`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
uv run ruff check --fix apps/api/modules/catalog && uv run ruff format apps/api/modules/catalog
git add apps/api/modules/catalog
git commit -m "feat(catalog): publish dataset versions with manifest, snapshot and version_published event

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 13: Search documents, `catalog.index_drain` with back-off, and `reindex_all`

**Files:**
- Create: `apps/api/modules/catalog/search/documents.py`
- Create: `apps/api/modules/catalog/search/drain.py`
- Create: `apps/api/modules/catalog/reindex.py`
- Test: `apps/api/modules/catalog/tests/test_indexing.py`

**Interfaces:**
- Consumes: `CatalogDeps` (Task 5), `SearchIndex`, `OpenSearchIndex`, `SearchUnavailable` (Task 4), `readiness_overall`, `enqueue_index` (Task 6), tables, fixtures `search_api`, `search_index`, `opensearch_url`.
- Produces:
  - `search.documents.build_documents(session, organizations, dataset_ids) -> tuple[list[dict], list[str]]` (upserts for ACTIVE datasets; ids to delete for WITHDRAWN or missing), `SNIPPET_CHARS = 300`.
  - `search.drain.DrainResult(indexed, deleted, failed)`, `search.drain.backoff_seconds(attempts) -> float` (`min(2**attempts, 300)`), `search.drain.drain_index_queue(deps, *, batch_size=None) -> DrainResult` (locks up to `catalog_index_batch_size` due rows with `FOR UPDATE SKIP LOCKED`, bulk-indexes, deletes them; on failure increments `attempts`, pushes `next_attempt_at`, logs an error with `metric=catalog_index_drain_failures` once `attempts > 10`).
  - `reindex.reindex_all(deps, *, chunk=200) -> str` (new `<alias>-v{n}`, full load, atomic alias swap, then re-enqueue all datasets); CLI `python -m api.modules.catalog.reindex`.

- [ ] **Step 1: Write the failing tests**

`apps/api/modules/catalog/tests/test_indexing.py`:

```python
import logging
from collections.abc import Mapping, Sequence
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID

import httpx
import pytest

from api.modules.catalog.reindex import reindex_all
from api.modules.catalog.search.drain import backoff_seconds, drain_index_queue
from api.modules.catalog.search.opensearch import OpenSearchIndex, SearchUnavailable
from api.modules.catalog.testing import RecordingSearchIndex
from api.modules.catalog.tests.support import SHA_A, execute, insert_version, rows
from api.modules.catalog.tests.support_api import CatalogApi, create_dataset
from api.platform import clock
from api.platform.testing.fixtures import PgUrls


class FailingSearchIndex(RecordingSearchIndex):
    def bulk(self, upserts: Sequence[Mapping[Any, Any]], deletes: Sequence[str], *, index: str | None = None) -> None:
        raise SearchUnavailable("opensearch down")


def fetch(index: OpenSearchIndex, dataset_id: str) -> dict[str, Any] | None:
    index.refresh()
    hits = index.search({"query": {"ids": {"values": [dataset_id]}}})["hits"]["hits"]
    return hits[0]["_source"] if hits else None


def test_drain_indexes_a_new_dataset(search_api: CatalogApi, db: PgUrls, search_index: OpenSearchIndex) -> None:
    dataset = create_dataset(search_api, description="x" * 400, keywords=["Battery", "cycling"])
    result = drain_index_queue(search_api.deps)
    assert (result.indexed, result.deleted, result.failed) == (1, 0, 0)
    assert rows(db, "SELECT dataset_id FROM catalog.index_queue") == []
    doc = fetch(search_index, dataset["dataset_id"])
    assert doc is not None
    assert doc["owner_organization_name"] == "Institute B"
    assert doc["has_published_version"] is False and doc["latest_version_id"] is None
    assert doc["snippet"] == "x" * 300
    assert doc["keywords"] == ["Battery", "cycling"]
    assert doc["status"] == "ACTIVE" and doc["access_level"] == "CONTROLLED"


def test_published_version_and_readiness_reach_the_document(search_api: CatalogApi, db: PgUrls, search_index: OpenSearchIndex) -> None:
    dataset_id = create_dataset(search_api)["dataset_id"]
    old = insert_version(db, UUID(dataset_id), label="v1", published=True, files=[("a.csv", 1, SHA_A)], published_at=datetime(2026, 1, 1, tzinfo=UTC))
    new = insert_version(db, UUID(dataset_id), label="v2", published=True, files=[("a.csv", 1, SHA_A)], published_at=datetime(2026, 2, 1, tzinfo=UTC))
    execute(
        db,
        "INSERT INTO catalog.readiness_summaries (dataset_version_id, profile_id, dataset_id, validation_id, run_status,"
        " overall_status, completed_at, source_event_id) VALUES (:v, 'GENERIC_BASIC', :d, gen_random_uuid(),"
        " 'COMPLETED', 'WARNING', now(), gen_random_uuid())",
        v=new,
        d=dataset_id,
    )
    drain_index_queue(search_api.deps)
    doc = fetch(search_index, dataset_id)
    assert doc is not None
    assert (doc["latest_version_id"], doc["latest_version_label"], doc["readiness_overall"]) == (str(new), "v2", "WARNING")
    assert doc["has_published_version"] is True and doc["published_at"].startswith("2026-02-01")
    assert str(old) != doc["latest_version_id"]


def test_withdrawn_dataset_is_removed_from_the_index(search_api: CatalogApi, search_index: OpenSearchIndex) -> None:
    dataset_id = create_dataset(search_api)["dataset_id"]
    drain_index_queue(search_api.deps)
    assert fetch(search_index, dataset_id) is not None
    assert search_api.patch("b.steward", f"/datasets/{dataset_id}", json={"status": "WITHDRAWN"}).status_code == 200
    assert drain_index_queue(search_api.deps).deleted == 1
    assert fetch(search_index, dataset_id) is None


def test_failures_back_off_and_retry(api: CatalogApi, db: PgUrls, caplog: pytest.LogCaptureFixture) -> None:
    api.use(replace(api.deps, search=FailingSearchIndex()))
    dataset_id = create_dataset(api)["dataset_id"]
    now = datetime.now(UTC)
    with clock.frozen(now):
        assert drain_index_queue(api.deps).failed == 1
        assert drain_index_queue(api.deps).failed == 0  # not due yet
    [row] = rows(db, "SELECT attempts, next_attempt_at FROM catalog.index_queue WHERE dataset_id = :id", id=dataset_id)
    assert row["attempts"] == 1 and row["next_attempt_at"] == now + timedelta(seconds=backoff_seconds(1))
    execute(db, "UPDATE catalog.index_queue SET attempts = 10, next_attempt_at = now() - interval '1 second'")
    with caplog.at_level(logging.ERROR, logger="nais.catalog.index"):
        drain_index_queue(api.deps)
    assert "keeps failing" in caplog.text
    recording = RecordingSearchIndex()
    api.use(replace(api.deps, search=recording))
    with clock.frozen(datetime.now(UTC) + timedelta(seconds=600)):
        assert drain_index_queue(api.deps).indexed == 1
    assert list(recording.docs) == [dataset_id]


def test_backoff_is_capped() -> None:
    assert [backoff_seconds(n) for n in (1, 2, 3, 9, 20)] == [2.0, 4.0, 8.0, 300.0, 300.0]


def test_reindex_all_swaps_the_alias(search_api: CatalogApi, db: PgUrls, search_index: OpenSearchIndex, opensearch_url: str) -> None:
    first = create_dataset(search_api)["dataset_id"]
    second = create_dataset(search_api, title="Second dataset")["dataset_id"]
    drain_index_queue(search_api.deps)
    new_index = reindex_all(search_api.deps)
    assert new_index == f"{search_index.alias}-v2"
    assert list(httpx.get(f"{opensearch_url}/_alias/{search_index.alias}").json()) == [new_index]
    assert fetch(search_index, first) is not None and fetch(search_index, second) is not None
    assert {r["dataset_id"] for r in rows(db, "SELECT dataset_id FROM catalog.index_queue")} == {UUID(first), UUID(second)}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `uv run pytest apps/api/modules/catalog/tests/test_indexing.py -v`
Expected: collection error `No module named 'api.modules.catalog.reindex'`.

- [ ] **Step 3: Implement**

`apps/api/modules/catalog/search/documents.py`:

```python
"""DB -> nais-datasets document (M03 §10 mapping). The DB is the system of record; documents are rebuilt."""

from collections.abc import Sequence
from datetime import datetime
from typing import Any
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from api.modules.catalog.interfaces import OrganizationLookup
from api.modules.catalog.repo import readiness_overall
from api.modules.catalog.tables import dataset_versions, datasets

SNIPPET_CHARS = 300


def _iso(value: datetime | None) -> str | None:
    return None if value is None else value.isoformat()


def build_documents(
    session: Session, organizations: OrganizationLookup, dataset_ids: Sequence[UUID]
) -> tuple[list[dict[str, Any]], list[str]]:
    ids = list(dict.fromkeys(dataset_ids))
    found = {row["dataset_id"]: row for row in session.execute(select(datasets).where(datasets.c.dataset_id.in_(ids))).mappings()}
    deletes = [str(i) for i in ids if i not in found or found[i]["status"] != "ACTIVE"]
    active = [found[i] for i in ids if i in found and found[i]["status"] == "ACTIVE"]
    if not active:
        return [], deletes
    latest = {
        row["dataset_id"]: row
        for row in session.execute(
            select(dataset_versions)
            .where(
                dataset_versions.c.dataset_id.in_([d["dataset_id"] for d in active]),
                dataset_versions.c.status == "PUBLISHED",
            )
            .order_by(
                dataset_versions.c.dataset_id,
                dataset_versions.c.published_at.desc(),
                dataset_versions.c.dataset_version_id.desc(),
            )
            .distinct(dataset_versions.c.dataset_id)
        ).mappings()
    }
    readiness = readiness_overall(session, [v["dataset_version_id"] for v in latest.values()])
    orgs = organizations.get_organization_summaries([d["owner_organization_id"] for d in active])
    docs: list[dict[str, Any]] = []
    for ds in active:
        version = latest.get(ds["dataset_id"])
        org = orgs.get(ds["owner_organization_id"])
        docs.append(
            {
                "dataset_id": str(ds["dataset_id"]),
                "title": ds["title"],
                "description": ds["description"],
                "snippet": ds["description"][:SNIPPET_CHARS],
                "keywords": list(ds["keywords"]),
                "domain": ds["domain"],
                "access_level": ds["access_level"],
                "owner_organization_id": str(ds["owner_organization_id"]),
                "owner_organization_name": org.name if org else "",
                "allowed_purposes": list(ds["allowed_purposes"]),
                "license": ds["license"],
                "status": ds["status"],
                "has_published_version": version is not None,
                "latest_version_id": str(version["dataset_version_id"]) if version else None,
                "latest_version_label": version["version_label"] if version else None,
                "readiness_overall": readiness.get(version["dataset_version_id"]) if version else None,
                "published_at": _iso(version["published_at"]) if version else None,
                "updated_at": _iso(ds["updated_at"]),
            }
        )
    return docs, deletes
```

`apps/api/modules/catalog/search/drain.py`:

```python
"""catalog.index_drain (M03 §10): index_queue -> OpenSearch, every 2 s in the worker."""

import logging
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime, timedelta

from sqlalchemy import delete, select, update
from sqlalchemy.engine import RowMapping
from sqlalchemy.orm import Session

from api.modules.catalog.deps import CatalogDeps
from api.modules.catalog.search.documents import build_documents
from api.modules.catalog.tables import index_queue
from api.platform import clock

logger = logging.getLogger("nais.catalog.index")
ALERT_AFTER_ATTEMPTS = 10


@dataclass(frozen=True)
class DrainResult:
    indexed: int = 0
    deleted: int = 0
    failed: int = 0


def backoff_seconds(attempts: int) -> float:
    return float(min(2**attempts, 300))


def _record_failure(session: Session, queued: Sequence[RowMapping], now: datetime, exc: Exception) -> None:
    for row in queued:
        attempts = int(row["attempts"]) + 1
        session.execute(
            update(index_queue)
            .where(index_queue.c.dataset_id == row["dataset_id"])
            .values(attempts=attempts, next_attempt_at=now + timedelta(seconds=backoff_seconds(attempts)))
        )
        if attempts > ALERT_AFTER_ATTEMPTS:
            logger.error(
                "catalog index drain keeps failing",
                extra={
                    "dataset_id": str(row["dataset_id"]),
                    "attempts": attempts,
                    "metric": "catalog_index_drain_failures",
                    "error": str(exc)[:500],
                },
            )
    logger.warning("catalog index drain failed; will retry", extra={"datasets": len(queued), "error": str(exc)[:500]})


def drain_index_queue(deps: CatalogDeps, *, batch_size: int | None = None) -> DrainResult:
    limit = batch_size or deps.settings.catalog_index_batch_size
    now = clock.now()
    with deps.session_factory() as session, session.begin():
        queued = session.execute(
            select(index_queue)
            .where(index_queue.c.next_attempt_at <= now)
            .order_by(index_queue.c.enqueued_at)
            .limit(limit)
            .with_for_update(skip_locked=True)
        ).mappings().all()
        if not queued:
            return DrainResult()
        ids = [row["dataset_id"] for row in queued]
        try:
            docs, deletes = build_documents(session, deps.organizations, ids)
            deps.search.bulk(docs, deletes)
        except Exception as exc:  # OpenSearch or identity down: keep the rows, retry later
            _record_failure(session, queued, now, exc)
            return DrainResult(failed=len(queued))
        session.execute(delete(index_queue).where(index_queue.c.dataset_id.in_(ids)))
        return DrainResult(indexed=len(docs), deleted=len(deletes))
```

`apps/api/modules/catalog/reindex.py`:

```python
"""Full reindex into a new versioned index, then an atomic alias swap (M03 §10 catalog.reindex_all).

Run: python -m api.modules.catalog.reindex
"""

from collections.abc import Sequence
from uuid import UUID

from sqlalchemy import select

from api.modules.catalog.deps import CatalogDeps
from api.modules.catalog.repo import enqueue_index
from api.modules.catalog.search.documents import build_documents
from api.modules.catalog.tables import datasets


def reindex_all(deps: CatalogDeps, *, chunk: int = 200) -> str:
    index = deps.search
    index.ensure()
    new_index = index.next_index_name()
    index.create_index(new_index)
    with deps.session_factory() as session:
        ids: list[UUID] = list(session.execute(select(datasets.c.dataset_id).order_by(datasets.c.dataset_id)).scalars())
        for start in range(0, len(ids), chunk):
            docs, _ = build_documents(session, deps.organizations, ids[start : start + chunk])
            index.bulk(docs, [], index=new_index)
    index.swap_alias(new_index)
    # Changes committed while we were loading went to the old index: queue everything once more.
    with deps.session_factory() as session, session.begin():
        for dataset_id in ids:
            enqueue_index(session, dataset_id)
    return new_index


def main(argv: Sequence[str] | None = None) -> int:
    from api.modules.catalog.wiring import build_default_deps
    from api.platform.broker import configure_broker
    from api.platform.logs import configure_logging
    from api.platform.settings import get_settings

    settings = get_settings()
    configure_logging(settings.log_level)
    configure_broker(settings)
    deps = build_default_deps()
    print(f"alias {deps.search.alias} -> {reindex_all(deps)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `uv run pytest apps/api/modules/catalog/tests/test_indexing.py -v`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
uv run ruff check --fix apps/api/modules/catalog && uv run ruff format apps/api/modules/catalog
git add apps/api/modules/catalog
git commit -m "feat(catalog): search documents, index queue drain with back-off, reindex_all

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 14: `searchDatasets` — D-012 filter, keyword + facets, cursor pagination, 503 on outage

**Files:**
- Create: `apps/api/modules/catalog/search/query.py`
- Create: `apps/api/modules/catalog/service/search.py`
- Create: `apps/api/modules/catalog/routes/search.py`
- Modify: `apps/api/modules/catalog/router.py`
- Test: `apps/api/modules/catalog/tests/test_search_api.py`

**Interfaces:**
- Consumes: `SearchUnavailable`, `SearchRejected` (Task 4), `drain_index_queue` (Task 13), `api.platform.pagination.{decode_cursor, encode_cursor, MAX_CURSOR_LENGTH}`, `CurrentUser`, literals from `schemas`.
- Produces:
  - `search.query.SearchParams(q=None, access_level=(), owner_organization_id=(), purpose=(), keyword=(), readiness_status=(), sort="relevance", cursor=None, limit=20)`; `resolve_sort(params) -> str` (`relevance` without `q` → `updated_desc`); `visibility_filter(user) -> dict`; `build_search_body(user, params, sort_name, search_after) -> dict`; `decode_search_cursor(cursor, sort_name) -> list`; `invalid_cursor() -> ApiError`; `map_search_response(raw, *, limit, sort_name) -> dict` (`total` capped at 10000); `MAX_TOTAL = 10000`.
  - `service.search.search_datasets(deps, user, params) -> dict` (DatasetSearchResult).
  - Route `GET /datasets` (`searchDatasets`) with repeated query params `access_level`, `owner_organization_id`, `purpose`, `keyword`, `readiness_status`, plus `q`, `sort`, `cursor`, `limit`.
  - Test helper in this file: `index_now(api)` = drain + refresh.

- [ ] **Step 1: Write the failing tests**

`apps/api/modules/catalog/tests/test_search_api.py`:

```python
import os
import statistics
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from typing import Any
from uuid import UUID

import pytest

from api.modules.catalog.search.drain import drain_index_queue
from api.modules.catalog.search.opensearch import OpenSearchIndex
from api.modules.catalog.search.query import SearchParams, map_search_response
from api.modules.catalog.service.search import search_datasets
from api.modules.catalog.tests.support import ORG_A, ORG_B, SHA_A, execute, insert_version
from api.modules.catalog.tests.support_api import USERS, CatalogApi, assert_error, create_dataset
from api.platform.pagination import encode_cursor
from api.platform.testing.contracts import assert_matches_response
from api.platform.testing.fixtures import PgUrls


def index_now(api: CatalogApi) -> None:
    drain_index_queue(api.deps)
    api.deps.search.refresh()


def published(api: CatalogApi, db: PgUrls, user: str = "b.steward", **overrides: Any) -> str:
    dataset_id: str = create_dataset(api, user, **overrides)["dataset_id"]
    insert_version(db, UUID(dataset_id), published=True, files=[("data/a.csv", 10, SHA_A)])
    execute(db, "UPDATE catalog.index_queue SET next_attempt_at = now() WHERE dataset_id = :id", id=dataset_id)
    return dataset_id


def search(api: CatalogApi, user: str, **params: Any) -> dict[str, Any]:
    response = api.get(user, "/datasets", params=params)
    assert response.status_code == 200, response.text
    body: dict[str, Any] = response.json()
    assert_matches_response("searchDatasets", 200, body)
    return body


def ids(body: dict[str, Any]) -> set[str]:
    return {item["dataset_id"] for item in body["items"]}


def test_at15_internal_dataset_is_hidden_from_other_orgs(search_api: CatalogApi, db: PgUrls) -> None:
    internal = published(search_api, db, access_level="INTERNAL")
    index_now(search_api)
    assert internal not in ids(search(search_api, "a.researcher"))
    assert internal in ids(search(search_api, "b.researcher"))


def test_at16_published_controlled_dataset_is_discoverable_without_storage_details(search_api: CatalogApi, db: PgUrls) -> None:
    controlled = published(search_api, db)
    index_now(search_api)
    response = search_api.get("a.researcher", "/datasets")
    body = response.json()
    assert_matches_response("searchDatasets", 200, body)
    assert controlled in ids(body)
    assert {"value": "CONTROLLED", "count": 1} in body["facets"]["access_level"]
    hit = next(item for item in body["items"] if item["dataset_id"] == controlled)
    assert hit["owner_organization_name"] == "Institute B" and hit["latest_version_label"] == "v1"
    assert "storage" not in response.text and "http" not in response.text and "datasets/" not in response.text


def test_at17_draft_only_controlled_dataset_is_hidden_from_other_orgs(search_api: CatalogApi) -> None:
    draft_only = create_dataset(search_api)["dataset_id"]
    index_now(search_api)
    assert draft_only not in ids(search(search_api, "a.researcher"))
    assert draft_only in ids(search(search_api, "b.researcher"))


def test_at24_korean_title_is_found_by_a_partial_word(search_api: CatalogApi, db: PgUrls) -> None:
    korean = published(search_api, db, title="고분자 전해질 막 측정")
    published(search_api, db, title="Unrelated battery data")
    index_now(search_api)
    body = search(search_api, "a.researcher", q="전해질")
    assert [item["dataset_id"] for item in body["items"]] == [korean]


def test_withdrawn_datasets_are_not_searchable_even_for_the_owner(search_api: CatalogApi, db: PgUrls) -> None:
    dataset_id = published(search_api, db)
    execute(db, "UPDATE catalog.datasets SET status = 'WITHDRAWN' WHERE dataset_id = :id", id=dataset_id)
    execute(db, "INSERT INTO catalog.index_queue (dataset_id) VALUES (:id) ON CONFLICT DO NOTHING", id=dataset_id)
    index_now(search_api)
    assert dataset_id not in ids(search(search_api, "b.steward"))


def test_filters_and_facets(search_api: CatalogApi, db: PgUrls) -> None:
    public = published(search_api, db, access_level="PUBLIC", allowed_purposes=["EDUCATION"], keywords=["Battery"])
    controlled = published(search_api, db, keywords=["membrane"])
    of_a = published(search_api, db, user="a.steward", access_level="PUBLIC", keywords=["battery"])
    index_now(search_api)
    assert ids(search(search_api, "b.researcher", access_level=["PUBLIC"])) == {public, of_a}
    assert ids(search(search_api, "b.researcher", purpose=["EDUCATION"])) == {public}
    assert ids(search(search_api, "b.researcher", keyword=["BATTERY"])) == {public, of_a}
    assert ids(search(search_api, "b.researcher", owner_organization_id=[str(ORG_A)])) == {of_a}
    assert ids(search(search_api, "b.researcher", access_level=["PUBLIC", "CONTROLLED"], owner_organization_id=[str(ORG_B)])) == {public, controlled}
    facets = search(search_api, "b.researcher")["facets"]
    owners = {bucket["value"]: (bucket.get("label"), bucket["count"]) for bucket in facets["owner_organization_id"]}
    assert owners == {str(ORG_B): ("Institute B", 2), str(ORG_A): ("Institute A", 1)}
    assert {"value": "battery", "count": 2} in facets["keyword"]
    assert {"value": "EDUCATION", "count": 1} in facets["purpose"]


def test_readiness_filter(search_api: CatalogApi, db: PgUrls) -> None:
    dataset_id = published(search_api, db)
    version_id = search_api.get("b.steward", f"/datasets/{dataset_id}").json()["latest_published_version"]["dataset_version_id"]
    execute(
        db,
        "INSERT INTO catalog.readiness_summaries (dataset_version_id, profile_id, dataset_id, validation_id, run_status,"
        " overall_status, completed_at, source_event_id) VALUES (:v, 'TABULAR_ML_BASIC', :d, gen_random_uuid(),"
        " 'COMPLETED', 'FAIL', now(), gen_random_uuid())",
        v=version_id,
        d=dataset_id,
    )
    published(search_api, db)
    index_now(search_api)
    body = search(search_api, "a.researcher", readiness_status=["FAIL"])
    assert ids(body) == {dataset_id}
    assert body["items"][0]["readiness_overall"] == "FAIL"
    assert {"value": "FAIL", "count": 1} in search(search_api, "a.researcher")["facets"]["readiness_status"]


def test_cursor_pagination_without_duplicates(search_api: CatalogApi, db: PgUrls) -> None:
    created = {published(search_api, db, title=f"Dataset {n}") for n in range(3)}
    index_now(search_api)
    first = search(search_api, "a.researcher", limit=2, sort="title_asc")
    assert [item["title"] for item in first["items"]] == ["Dataset 0", "Dataset 1"]
    assert first["page"]["has_more"] is True and first["total"] == 3
    second = search(search_api, "a.researcher", limit=2, sort="title_asc", cursor=first["page"]["next_cursor"])
    assert [item["title"] for item in second["items"]] == ["Dataset 2"]
    assert second["page"] == {"next_cursor": None, "has_more": False}
    assert ids(first) | ids(second) == created


def test_default_order_is_most_recently_updated(search_api: CatalogApi, db: PgUrls) -> None:
    older = published(search_api, db, title="Older dataset")
    newer = published(search_api, db, title="Newer dataset")
    index_now(search_api)
    assert [item["dataset_id"] for item in search(search_api, "a.researcher")["items"]] == [newer, older]


def test_cursor_from_another_sort_is_rejected(search_api: CatalogApi, db: PgUrls) -> None:  # Review Focus 2
    published(search_api, db)
    published(search_api, db)
    index_now(search_api)
    cursor = search(search_api, "a.researcher", limit=1, sort="title_asc")["page"]["next_cursor"]
    assert_error(search_api.get("a.researcher", "/datasets", params={"cursor": cursor, "sort": "updated_desc"}), 422, "VALIDATION_FAILED")


@pytest.mark.parametrize("cursor", ["%%%", "bm90LWpzb24", encode_cursor(["title_asc", "x", "y", "z"]), encode_cursor(["title_asc", {"a": 1}, "b"])])
def test_garbage_cursor_is_rejected(search_api: CatalogApi, cursor: str) -> None:  # Review Focus 2
    response = search_api.get("a.researcher", "/datasets", params={"cursor": cursor, "sort": "title_asc"})
    error = assert_error(response, 422, "VALIDATION_FAILED")
    assert error["details"]["fields"] == [{"field": "cursor", "reason": "INVALID_CURSOR"}]


def test_opensearch_outage_is_503(api: CatalogApi) -> None:
    api.use(replace(api.deps, search=OpenSearchIndex("http://127.0.0.1:9", "nais-datasets", timeout=0.5)))
    assert_error(api.get("a.researcher", "/datasets"), 503, "DEPENDENCY_UNAVAILABLE")


def test_search_requires_authentication(api: CatalogApi) -> None:
    assert_error(api.get(None, "/datasets"), 401, "UNAUTHENTICATED")


def test_total_is_capped_at_10000() -> None:
    raw = {"hits": {"total": {"value": 25000, "relation": "gte"}, "hits": []}, "aggregations": {}}
    assert map_search_response(raw, limit=20, sort_name="updated_desc")["total"] == 10000


@pytest.mark.skipif(os.environ.get("NAIS_PERF") != "1", reason="set NAIS_PERF=1 to run the 10k-document load test")
def test_at20_p95_under_1_5_seconds_with_10k_docs(search_index: OpenSearchIndex) -> None:  # M03-AT-20
    from api.modules.catalog.adapters.identity import FakeIdentityPort
    from api.modules.catalog.adapters.malware import NoopScanner
    from api.modules.catalog.deps import CatalogDeps
    from api.modules.catalog.settings import CatalogSettings
    from api.modules.catalog.testing import RecordingVerificationQueue, memory_registry

    words = ["battery", "membrane", "sensor", "polymer", "catalyst", "전해질", "고분자", "측정"]
    for start in range(0, 10_000, 1000):
        docs = [
            {
                "dataset_id": str(uuid.uuid4()),
                "title": f"{words[n % 8]} dataset {n}",
                "description": " ".join(words[(n + k) % 8] for k in range(20)),
                "snippet": "",
                "keywords": [words[n % 8], words[(n + 3) % 8]],
                "domain": "materials",
                "access_level": ["PUBLIC", "INTERNAL", "CONTROLLED", "SENSITIVE"][n % 4],
                "owner_organization_id": str([ORG_A, ORG_B][n % 2]),
                "owner_organization_name": ["Institute A", "Institute B"][n % 2],
                "allowed_purposes": ["ACADEMIC_RESEARCH"],
                "license": "CC-BY-4.0",
                "status": "ACTIVE",
                "has_published_version": n % 5 != 0,
                "latest_version_id": None,
                "latest_version_label": "v1",
                "readiness_overall": ["PASS", "WARNING", "FAIL", None][n % 4],
                "published_at": None,
                "updated_at": "2026-10-01T00:00:00+00:00",
            }
            for n in range(start, start + 1000)
        ]
        search_index.bulk(docs, [])
    search_index.refresh()
    deps = CatalogDeps(
        settings=CatalogSettings(),
        session_factory=lambda: None,  # type: ignore[arg-type,return-value]
        storage=memory_registry(),
        organizations=FakeIdentityPort(),
        scanner=NoopScanner(),
        verification=RecordingVerificationQueue(),
        search=search_index,
    )
    user = USERS["a.researcher"]
    queries = [SearchParams(q=words[n % 8], keyword=(words[(n + 1) % 8],) if n % 3 == 0 else ()) for n in range(200)]

    def timed(params: SearchParams) -> float:
        started = time.perf_counter()
        search_datasets(deps, user, params)
        return time.perf_counter() - started

    with ThreadPoolExecutor(max_workers=50) as pool:
        latencies = sorted(pool.map(timed, queries))
    p95 = statistics.quantiles(latencies, n=20)[18]
    assert p95 < 1.5, f"p95={p95:.3f}s"
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `uv run pytest apps/api/modules/catalog/tests/test_search_api.py -v`
Expected: collection error `No module named 'api.modules.catalog.search.query'`.

- [ ] **Step 3: Implement**

`apps/api/modules/catalog/search/query.py`:

```python
"""searchDatasets query DSL (M03 §6.2). Visibility is a query filter, never a post-filter (D-012)."""

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any
from uuid import UUID

from api.platform.auth import CurrentUser
from api.platform.errors import ApiError
from api.platform.generated.error_codes import ErrorCode
from api.platform.pagination import decode_cursor, encode_cursor

MAX_TOTAL = 10_000
DISCOVERABLE_LEVELS = ["PUBLIC", "CONTROLLED", "SENSITIVE"]
SORTS: dict[str, list[dict[str, str]]] = {
    "relevance": [{"_score": "desc"}, {"dataset_id": "asc"}],
    "updated_desc": [{"updated_at": "desc"}, {"dataset_id": "asc"}],
    "title_asc": [{"title.raw": "asc"}, {"dataset_id": "asc"}],
}
SEARCH_FIELDS = ["title^3", "keywords.text^2", "description", "owner_organization_name.text"]
AGGREGATIONS: dict[str, Any] = {
    "access_level": {"terms": {"field": "access_level", "size": 4}},
    "owner_organization_id": {
        "terms": {"field": "owner_organization_id", "size": 50},
        "aggs": {"name": {"terms": {"field": "owner_organization_name", "size": 1}}},
    },
    "purpose": {"terms": {"field": "allowed_purposes", "size": 5}},
    "keyword": {"terms": {"field": "keywords", "size": 20}},
    "readiness_status": {"terms": {"field": "readiness_overall", "size": 3}},
}
HIT_FIELDS = (
    "dataset_id",
    "title",
    "snippet",
    "owner_organization_id",
    "owner_organization_name",
    "access_level",
    "keywords",
    "allowed_purposes",
    "latest_version_label",
    "readiness_overall",
    "updated_at",
)


@dataclass(frozen=True)
class SearchParams:
    q: str | None = None
    access_level: tuple[str, ...] = ()
    owner_organization_id: tuple[UUID, ...] = ()
    purpose: tuple[str, ...] = ()
    keyword: tuple[str, ...] = ()
    readiness_status: tuple[str, ...] = ()
    sort: str = "relevance"
    cursor: str | None = None
    limit: int = 20


def invalid_cursor() -> ApiError:
    return ApiError(
        ErrorCode.VALIDATION_FAILED,
        "Invalid pagination cursor.",
        {"fields": [{"field": "cursor", "reason": "INVALID_CURSOR"}]},
    )


def resolve_sort(params: SearchParams) -> str:
    if params.sort == "relevance" and not (params.q and params.q.strip()):
        return "updated_desc"
    return params.sort


def decode_search_cursor(cursor: str, sort_name: str) -> list[Any]:
    values = decode_cursor(cursor)
    if len(values) != 3 or values[0] != sort_name or not all(isinstance(v, str | int | float) for v in values[1:]):
        raise invalid_cursor()
    return values[1:]


def visibility_filter(user: CurrentUser) -> dict[str, Any]:
    return {
        "bool": {
            "should": [
                {
                    "bool": {
                        "filter": [
                            {"terms": {"access_level": DISCOVERABLE_LEVELS}},
                            {"term": {"has_published_version": True}},
                        ]
                    }
                },
                {"term": {"owner_organization_id": str(user.organization_id)}},
            ],
            "minimum_should_match": 1,
        }
    }


def build_search_body(
    user: CurrentUser, params: SearchParams, sort_name: str, search_after: list[Any] | None
) -> dict[str, Any]:
    filters: list[dict[str, Any]] = [{"term": {"status": "ACTIVE"}}, visibility_filter(user)]
    if params.access_level:
        filters.append({"terms": {"access_level": list(params.access_level)}})
    if params.owner_organization_id:
        filters.append({"terms": {"owner_organization_id": [str(o) for o in params.owner_organization_id]}})
    if params.purpose:
        filters.append({"terms": {"allowed_purposes": list(params.purpose)}})
    if params.keyword:
        filters.append({"terms": {"keywords": [k.strip().lower() for k in params.keyword]}})
    if params.readiness_status:
        filters.append({"terms": {"readiness_overall": list(params.readiness_status)}})
    query: dict[str, Any] = {"bool": {"filter": filters}}
    if params.q and params.q.strip():
        query["bool"]["must"] = [{"multi_match": {"query": params.q.strip(), "fields": SEARCH_FIELDS}}]
    body: dict[str, Any] = {
        "query": query,
        "size": params.limit + 1,
        "sort": SORTS[sort_name],
        "track_total_hits": MAX_TOTAL,
        "aggs": AGGREGATIONS,
        "_source": list(HIT_FIELDS),
    }
    if search_after is not None:
        body["search_after"] = search_after
    return body


def _buckets(aggregations: Mapping[Any, Any], name: str) -> list[dict[str, Any]]:
    return [
        {"value": str(bucket["key"]), "count": int(bucket["doc_count"])}
        for bucket in aggregations.get(name, {}).get("buckets", [])
    ]


def _owner_buckets(aggregations: Mapping[Any, Any]) -> list[dict[str, Any]]:
    buckets = []
    for bucket in aggregations.get("owner_organization_id", {}).get("buckets", []):
        item: dict[str, Any] = {"value": str(bucket["key"]), "count": int(bucket["doc_count"])}
        names = bucket.get("name", {}).get("buckets", [])
        if names and names[0]["key"]:
            item["label"] = str(names[0]["key"])
        buckets.append(item)
    return buckets


def _hit(source: Mapping[Any, Any]) -> dict[str, Any]:
    hit = {field: source.get(field) for field in HIT_FIELDS}
    if not hit["owner_organization_name"]:
        hit.pop("owner_organization_name")
    if hit["snippet"] is None:
        hit.pop("snippet")
    hit["keywords"] = list(hit["keywords"] or [])
    hit["allowed_purposes"] = list(hit["allowed_purposes"] or [])
    return hit


def map_search_response(raw: Mapping[Any, Any], *, limit: int, sort_name: str) -> dict[str, Any]:
    hits = raw["hits"]["hits"]
    page_hits = hits[:limit]
    has_more = len(hits) > limit
    next_cursor = encode_cursor([sort_name, *page_hits[-1]["sort"]]) if has_more and page_hits else None
    aggregations = raw.get("aggregations", {})
    return {
        "items": [_hit(hit["_source"]) for hit in page_hits],
        "page": {"next_cursor": next_cursor, "has_more": has_more},
        "total": min(int(raw["hits"]["total"]["value"]), MAX_TOTAL),
        "facets": {
            "access_level": _buckets(aggregations, "access_level"),
            "owner_organization_id": _owner_buckets(aggregations),
            "purpose": _buckets(aggregations, "purpose"),
            "keyword": _buckets(aggregations, "keyword"),
            "readiness_status": _buckets(aggregations, "readiness_status"),
        },
    }
```

`apps/api/modules/catalog/service/search.py`:

```python
"""searchDatasets (M03 §6.2): OpenSearch only; an outage is 503, there is no DB fallback."""

from typing import Any

from api.modules.catalog.deps import CatalogDeps
from api.modules.catalog.search.opensearch import SearchRejected, SearchUnavailable
from api.modules.catalog.search.query import (
    SearchParams,
    build_search_body,
    decode_search_cursor,
    invalid_cursor,
    map_search_response,
    resolve_sort,
)
from api.platform.auth import CurrentUser
from api.platform.errors import ApiError
from api.platform.generated.error_codes import ErrorCode


def search_datasets(deps: CatalogDeps, user: CurrentUser, params: SearchParams) -> dict[str, Any]:
    sort_name = resolve_sort(params)
    search_after = decode_search_cursor(params.cursor, sort_name) if params.cursor else None
    body = build_search_body(user, params, sort_name, search_after)
    try:
        raw = deps.search.search(body)
    except SearchRejected as exc:
        if search_after is not None:
            raise invalid_cursor() from exc
        raise ApiError(ErrorCode.VALIDATION_FAILED, "Invalid search request.") from exc
    except SearchUnavailable as exc:
        raise ApiError(ErrorCode.DEPENDENCY_UNAVAILABLE, "Dataset search is temporarily unavailable.") from exc
    return map_search_response(raw, limit=params.limit, sort_name=sort_name)
```

`apps/api/modules/catalog/routes/search.py`:

```python
from typing import Annotated, Any
from uuid import UUID

from fastapi import APIRouter, Query

from api.modules.catalog.deps import CatalogDepsDep
from api.modules.catalog.schemas import AccessLevelIn, PurposeIn, ReadinessIn, SortIn
from api.modules.catalog.search.query import SearchParams
from api.modules.catalog.service import search as service
from api.platform.auth import CurrentUserDep
from api.platform.pagination import MAX_CURSOR_LENGTH

router = APIRouter(tags=["catalog"])


@router.get("/datasets", operation_id="searchDatasets")
def search_datasets(
    user: CurrentUserDep,
    deps: CatalogDepsDep,
    q: Annotated[str | None, Query(max_length=500)] = None,
    access_level: Annotated[list[AccessLevelIn] | None, Query()] = None,
    owner_organization_id: Annotated[list[UUID] | None, Query()] = None,
    purpose: Annotated[list[PurposeIn] | None, Query()] = None,
    keyword: Annotated[list[str] | None, Query()] = None,
    readiness_status: Annotated[list[ReadinessIn] | None, Query()] = None,
    sort: SortIn = "relevance",
    cursor: Annotated[str | None, Query(max_length=MAX_CURSOR_LENGTH)] = None,
    limit: Annotated[int, Query(ge=1, le=100)] = 20,
) -> dict[str, Any]:
    params = SearchParams(
        q=q,
        access_level=tuple(access_level or ()),
        owner_organization_id=tuple(owner_organization_id or ()),
        purpose=tuple(purpose or ()),
        keyword=tuple(keyword or ()),
        readiness_status=tuple(readiness_status or ()),
        sort=sort,
        cursor=cursor,
        limit=limit,
    )
    return service.search_datasets(deps, user, params)
```

`apps/api/modules/catalog/router.py`:

```python
"""All catalog routes (mounted under /api/v1 by the platform)."""

from fastapi import APIRouter

from api.modules.catalog.routes import completion, dataset_update, datasets, publish, search, uploads, versions

router = APIRouter()
for sub in (
    search.router,
    datasets.router,
    dataset_update.router,
    versions.router,
    uploads.router,
    completion.router,
    publish.router,
):
    router.include_router(sub)
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `uv run pytest apps/api/modules/catalog/tests/test_search_api.py -v`
Expected: all PASS; `test_at20_...` SKIPPED unless `NAIS_PERF=1` (run it once: `NAIS_PERF=1 uv run pytest apps/api/modules/catalog/tests/test_search_api.py -k at20 -v` → PASS).

- [ ] **Step 5: Commit**

```bash
uv run ruff check --fix apps/api/modules/catalog && uv run ruff format apps/api/modules/catalog
git add apps/api/modules/catalog
git commit -m "feat(catalog): searchDatasets with D-012 filter, facets, cursor pagination

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 15: Event consumers — readiness read model (AT-19) and organization re-index

**Files:**
- Create: `apps/api/modules/catalog/handlers.py`
- Modify: `apps/api/modules/catalog/__init__.py` (import `handlers`)
- Test: `apps/api/modules/catalog/tests/test_handlers.py`

**Interfaces:**
- Consumes: `api.platform.event_bus.{subscribe, claim_event, registry, HandlerRegistry}`, `api.platform.relay.dispatch_batch`, `outbox`, `EventActor`, `enqueue_index` (Task 6), `readiness_summaries`, `datasets` tables, `drain_index_queue` (Task 13), fixtures `search_api`.
- Produces: handlers `on_readiness_completed` (claim name `readiness_summary`) for `readiness.validation.completed.v1` and `on_organization_created` (claim name `organization_reindex`) for `identity.organization.created.v1`. Upsert rule for `catalog.readiness_summaries`: an event replaces the stored row for `(dataset_version_id, profile_id)` only if its `occurred_at` is not older **and** (it is COMPLETED **or** the stored row is FAILED).

- [ ] **Step 1: Write the failing tests**

`apps/api/modules/catalog/tests/test_handlers.py`:

```python
from contextlib import nullcontext
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID

from api.modules.catalog.search.drain import drain_index_queue
from api.modules.catalog.tests.support import ORG_B, SHA_A, execute, insert_version, rows
from api.modules.catalog.tests.support_api import CatalogApi, create_dataset
from api.platform import clock
from api.platform.db import session_factory
from api.platform.event_bus import HandlerRegistry, registry
from api.platform.events import EventActor
from api.platform.ids import new_id
from api.platform.outbox import outbox
from api.platform.relay import RelayResult, dispatch_batch
from api.platform.testing.fixtures import PgUrls

CATALOG_EVENTS = ("readiness.validation.completed.v1", "identity.organization.created.v1")


def catalog_registry() -> HandlerRegistry:
    """Only the catalog's handlers (other modules' handlers may be registered in the same test session)."""
    local = HandlerRegistry()
    for event_type in CATALOG_EVENTS:
        for subscription in registry.handlers_for(event_type):
            if subscription.name.startswith("api.modules.catalog."):
                local.subscribe(event_type)(subscription.handler)
    return local


def emit(db: PgUrls, event_type: str, payload: dict[str, Any], at: datetime | None = None) -> None:
    with clock.frozen(at) if at else nullcontext(), session_factory(db.app)() as session, session.begin():
        outbox.write(session, event_type, payload, EventActor.system())


def relay(db: PgUrls) -> RelayResult:
    return dispatch_batch(session_factory(db.app), catalog_registry())


def readiness(dataset_id: str, version_id: UUID, *, profile: str = "TABULAR_ML_BASIC", overall: str | None = "FAIL", run_status: str = "COMPLETED") -> dict[str, Any]:
    return {
        "validation_id": str(new_id()),
        "dataset_id": dataset_id,
        "dataset_version_id": str(version_id),
        "owner_organization_id": str(ORG_B),
        "profile_id": profile,
        "profile_version": "1.0.0",
        "run_status": run_status,
        "overall_status": overall if run_status == "COMPLETED" else None,
        "summary": {"pass": 3, "warning": 0, "fail": 1, "not_applicable": 0},
        "validator_version": "0.1.0",
        "input_fingerprint": "f" * 64,
    }


def published_dataset(api: CatalogApi, db: PgUrls) -> tuple[str, UUID]:
    dataset_id = create_dataset(api)["dataset_id"]
    version_id = insert_version(db, UUID(dataset_id), published=True, files=[("data/a.csv", 10, SHA_A)])
    execute(db, "DELETE FROM platform.outbox_events")  # keep only the events each test emits
    return dataset_id, version_id


def overall(api: CatalogApi, dataset_id: str) -> str | None:
    value: str | None = api.get("b.steward", f"/datasets/{dataset_id}").json()["latest_published_version"]["readiness_overall"]
    return value


def test_catalog_subscribes_to_its_two_events() -> None:
    table = registry.table()
    for event_type in CATALOG_EVENTS:
        assert any(name.startswith("api.modules.catalog.handlers.") for name in table[event_type])


def test_at19_readiness_result_reaches_search_once(search_api: CatalogApi, db: PgUrls) -> None:  # M03-AT-19
    dataset_id, version_id = published_dataset(search_api, db)
    drain_index_queue(search_api.deps)
    emit(db, "readiness.validation.completed.v1", readiness(dataset_id, version_id))
    assert relay(db).dispatched == 1
    drain_index_queue(search_api.deps)
    search_api.deps.search.refresh()
    hits = search_api.get("a.researcher", "/datasets").json()["items"]
    assert [(h["dataset_id"], h["readiness_overall"]) for h in hits] == [(dataset_id, "FAIL")]
    # at-least-once redelivery: no second claim, no new index work
    execute(db, "UPDATE platform.outbox_events SET dispatched_at = NULL")
    assert relay(db).dispatched == 1
    assert rows(db, "SELECT count(*) AS n FROM catalog.processed_events WHERE handler = 'readiness_summary'")[0]["n"] == 1
    assert rows(db, "SELECT dataset_id FROM catalog.index_queue") == []
    assert rows(db, "SELECT overall_status FROM catalog.readiness_summaries") == [{"overall_status": "FAIL"}]


def test_older_events_are_ignored(api: CatalogApi, db: PgUrls) -> None:
    dataset_id, version_id = published_dataset(api, db)
    now = datetime.now(UTC)
    emit(db, "readiness.validation.completed.v1", readiness(dataset_id, version_id, overall="PASS"), at=now)
    emit(db, "readiness.validation.completed.v1", readiness(dataset_id, version_id, overall="FAIL"), at=now - timedelta(minutes=5))
    relay(db)
    assert overall(api, dataset_id) == "PASS"


def test_failed_run_does_not_erase_completed_result(api: CatalogApi, db: PgUrls) -> None:  # Review Focus 5
    dataset_id, version_id = published_dataset(api, db)
    now = datetime.now(UTC)
    emit(db, "readiness.validation.completed.v1", readiness(dataset_id, version_id, overall="WARNING"), at=now)
    emit(db, "readiness.validation.completed.v1", readiness(dataset_id, version_id, run_status="FAILED"), at=now + timedelta(minutes=1))
    relay(db)
    assert overall(api, dataset_id) == "WARNING"


def test_generic_profile_is_the_fallback_and_failed_runs_count_as_none(api: CatalogApi, db: PgUrls) -> None:
    dataset_id, version_id = published_dataset(api, db)
    emit(db, "readiness.validation.completed.v1", readiness(dataset_id, version_id, profile="TABULAR_ML_BASIC", run_status="FAILED"))
    relay(db)
    assert overall(api, dataset_id) is None
    emit(db, "readiness.validation.completed.v1", readiness(dataset_id, version_id, profile="GENERIC_BASIC", overall="PASS"))
    relay(db)
    assert overall(api, dataset_id) == "PASS"
    emit(db, "readiness.validation.completed.v1", readiness(dataset_id, version_id, profile="TABULAR_ML_BASIC", overall="FAIL"))
    relay(db)
    assert overall(api, dataset_id) == "FAIL"
    version = api.get("a.researcher", f"/dataset-versions/{version_id}").json()
    assert version["readiness_overall"] == "FAIL"


def test_organization_created_requeues_its_datasets(api: CatalogApi, db: PgUrls) -> None:
    first = create_dataset(api)["dataset_id"]
    second = create_dataset(api)["dataset_id"]
    create_dataset(api, user="a.steward")
    execute(db, "DELETE FROM catalog.index_queue")
    execute(db, "DELETE FROM platform.outbox_events")
    emit(db, "identity.organization.created.v1", {"organization_id": str(ORG_B), "code": "inst-b", "name": "Institute B", "type": "RESEARCH_INSTITUTE"})
    assert relay(db).dispatched == 1
    assert {r["dataset_id"] for r in rows(db, "SELECT dataset_id FROM catalog.index_queue")} == {UUID(first), UUID(second)}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `uv run pytest apps/api/modules/catalog/tests/test_handlers.py -v`
Expected: FAIL — `test_catalog_subscribes_to_its_two_events` raises `KeyError` (no subscriptions) and the readiness assertions fail.

- [ ] **Step 3: Implement**

`apps/api/modules/catalog/handlers.py`:

```python
"""Event consumers (M03 §3.2, §7.2). Idempotent per handler through catalog.processed_events (D-006)."""

from uuid import UUID

from sqlalchemy import and_, or_, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.orm import Session

from api.modules.catalog.repo import enqueue_index
from api.modules.catalog.tables import datasets, readiness_summaries
from api.platform.event_bus import claim_event, subscribe
from api.platform.events import EventEnvelope

SCHEMA = "catalog"


@subscribe("readiness.validation.completed.v1")
def on_readiness_completed(session: Session, event: EventEnvelope) -> None:
    if not claim_event(session, SCHEMA, event, handler="readiness_summary"):
        return
    payload = event.payload
    stmt = pg_insert(readiness_summaries).values(
        dataset_version_id=UUID(payload["dataset_version_id"]),
        profile_id=payload["profile_id"],
        dataset_id=UUID(payload["dataset_id"]),
        validation_id=UUID(payload["validation_id"]),
        run_status=payload["run_status"],
        overall_status=payload["overall_status"],
        completed_at=event.occurred_at,
        source_event_id=event.event_id,
    )
    excluded = stmt.excluded
    session.execute(
        stmt.on_conflict_do_update(
            index_elements=[readiness_summaries.c.dataset_version_id, readiness_summaries.c.profile_id],
            set_={
                "dataset_id": excluded.dataset_id,
                "validation_id": excluded.validation_id,
                "run_status": excluded.run_status,
                "overall_status": excluded.overall_status,
                "completed_at": excluded.completed_at,
                "source_event_id": excluded.source_event_id,
            },
            # older results never win; a FAILED run never replaces a COMPLETED one (D-028 "latest COMPLETED")
            where=and_(
                readiness_summaries.c.completed_at <= excluded.completed_at,
                or_(excluded.run_status == "COMPLETED", readiness_summaries.c.run_status == "FAILED"),
            ),
        )
    )
    enqueue_index(session, UUID(payload["dataset_id"]))


@subscribe("identity.organization.created.v1")
def on_organization_created(session: Session, event: EventEnvelope) -> None:
    """Organization names are denormalized into search documents: re-index that organization's datasets."""
    if not claim_event(session, SCHEMA, event, handler="organization_reindex"):
        return
    organization_id = UUID(event.payload["organization_id"])
    owned: list[UUID] = list(
        session.execute(select(datasets.c.dataset_id).where(datasets.c.owner_organization_id == organization_id)).scalars()
    )
    for dataset_id in owned:
        enqueue_index(session, dataset_id)
```

`apps/api/modules/catalog/__init__.py`:

```python
"""M03 Data Catalog & Versioning. Spec: NAIS_PRD/modules/M03_data_catalog.md."""

from pathlib import Path

from api.modules.catalog import handlers, jobs  # noqa: F401  (register @subscribe handlers and the verify actor)
from api.modules.catalog.router import router
from api.modules.catalog.wiring import wire
from api.platform.modules import ModuleSpec

MODULE = ModuleSpec(
    name="catalog",
    db_schema="catalog",
    router=router,
    migrations_dir=Path(__file__).parent / "migrations",
    wire=wire,
)
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `uv run pytest apps/api/modules/catalog/tests/test_handlers.py -v`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
uv run ruff check --fix apps/api/modules/catalog && uv run ruff format apps/api/modules/catalog
git add apps/api/modules/catalog
git commit -m "feat(catalog): readiness read model and organization re-index consumers

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 16: Public ports — `CatalogQueryPort`, `StoragePort`, `CatalogReadPort` (AT-18, AT-23)

**Files:**
- Create: `apps/api/modules/catalog/public.py`
- Create: `apps/api/modules/catalog/ports.py`
- Create: `apps/api/modules/catalog/public_impl.py`
- Modify: `apps/api/modules/catalog/wiring.py` (`install` also provides the three public ports)
- Test: `apps/api/modules/catalog/tests/test_public_ports.py`, `apps/api/modules/catalog/tests/test_routes_contract.py`
- Modify: `apps/api/modules/catalog/tests/test_s3_e2e.py` (append a presigned GET download test)

**Interfaces:**
- Consumes: `CatalogDeps` (Task 5), `load_dataset`, `load_version`, `files_of_versions` (Task 6), `can_see_dataset` (Task 6), `basename` (Task 1), `ObjectStore.presign_get`/`open_stream` (Task 3), `CurrentUser`.
- Produces (M03 §8, the only catalog code other modules may import; `api.modules.catalog.ports` re-exports it):
  - frozen dataclasses `DatasetPolicyView(dataset_id, owner_organization_id, access_level, allowed_purposes: tuple[str, ...], approval_required, max_grant_days, status, title)`, `FileRef(file_id, path, size_bytes, sha256, media_type, status, storage_bucket, storage_key)`, `VersionView(dataset_version_id, dataset_id, owner_organization_id, version_label, status, manifest_sha256, metadata_snapshot, files: tuple[FileRef, ...])`, `PresignedGet(file_id, path, url, size_bytes, sha256, expires_at)`; `CatalogNotFound(ValueError)` (message `NOT_FOUND`).
  - Protocols `CatalogQueryPort` (`get_policy_view(dataset_id)`, `get_version(dataset_version_id)`, `is_visible(ctx: CurrentUser, dataset_id) -> bool`), `StoragePort` (`presign_get(dataset_version_id, file_ids: Sequence[UUID] | None, ttl_seconds: int) -> list[PresignedGet]`), `CatalogReadPort` (`open_stream(file: FileRef, byte_range: tuple[int, int] | None = None) -> BinaryIO`).
  - `public_impl.CatalogQueryService(deps)`, `public_impl.CatalogStorageService(deps)`, `public_impl.CatalogReader(deps)`; `wiring.install(deps)` registers them under the three Protocol classes (`ports.get(CatalogQueryPort)` etc.).

- [ ] **Step 1: Write the failing tests**

`apps/api/modules/catalog/tests/test_public_ports.py`:

```python
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

import pytest

from api.modules.catalog.ports import CatalogNotFound as AliasNotFound
from api.modules.catalog.public import (
    CatalogNotFound,
    CatalogQueryPort,
    CatalogReadPort,
    DatasetPolicyView,
    StoragePort,
)
from api.modules.catalog.testing import memory_store
from api.modules.catalog.tests.support import ORG_B, SHA_A, insert_version, rows
from api.modules.catalog.tests.support_api import USERS, CatalogApi, create_dataset, new_draft
from api.modules.catalog.tests.support_upload import upload_files
from api.platform import clock, ports
from api.platform.testing.fixtures import PgUrls

FILES = {"data/b.csv": b"x,y\n3,4\n", "B.md": b"# B\n", "data/a.csv": b"x,y\n1,2\n"}


def published_version(api: CatalogApi, db: PgUrls) -> tuple[str, str]:
    dataset_id, version_id = new_draft(api)
    upload_files(api, db, version_id, FILES)
    assert api.post("b.steward", f"/dataset-versions/{version_id}/publish").status_code == 200
    return dataset_id, version_id


def test_ports_are_registered_by_install(api: CatalogApi) -> None:
    assert ports.get(CatalogQueryPort) is not None
    assert ports.get(StoragePort) is not None
    assert ports.get(CatalogReadPort) is not None
    assert AliasNotFound is CatalogNotFound


def test_get_policy_view(api: CatalogApi) -> None:
    created = create_dataset(api)
    view = ports.get(CatalogQueryPort).get_policy_view(UUID(created["dataset_id"]))
    assert view == DatasetPolicyView(
        dataset_id=UUID(created["dataset_id"]),
        owner_organization_id=ORG_B,
        access_level="CONTROLLED",
        allowed_purposes=("ACADEMIC_RESEARCH", "AI_TRAINING"),
        approval_required=True,
        max_grant_days=180,
        status="ACTIVE",
        title="Battery Cycling Measurements",
    )
    assert ports.get(CatalogQueryPort).get_policy_view(uuid4()) is None


def test_get_version_exposes_files_in_path_order_and_the_snapshot(api: CatalogApi, db: PgUrls) -> None:
    dataset_id, version_id = published_version(api, db)
    view = ports.get(CatalogQueryPort).get_version(UUID(version_id))
    assert view is not None
    assert (view.status, view.version_label, view.owner_organization_id) == ("PUBLISHED", "v1", ORG_B)
    assert [f.path for f in view.files] == ["B.md", "data/a.csv", "data/b.csv"]
    assert all(f.status == "VERIFIED" and f.storage_bucket == "nais-inst-b" for f in view.files)
    assert view.files[1].storage_key == f"datasets/{dataset_id}/{version_id}/data/a.csv"
    assert view.metadata_snapshot is not None and view.metadata_snapshot["title"] == "Battery Cycling Measurements"
    assert view.manifest_sha256 == api.get("b.steward", f"/dataset-versions/{version_id}").json()["manifest_sha256"]
    _, draft_id = new_draft(api)
    draft = ports.get(CatalogQueryPort).get_version(UUID(draft_id))
    assert draft is not None and draft.metadata_snapshot is None and draft.files == ()
    assert ports.get(CatalogQueryPort).get_version(uuid4()) is None


def test_is_visible_matches_d012(api: CatalogApi, db: PgUrls) -> None:
    internal = UUID(create_dataset(api, access_level="INTERNAL")["dataset_id"])
    insert_version(db, internal, published=True, files=[("a.csv", 1, SHA_A)])
    port = ports.get(CatalogQueryPort)
    assert port.is_visible(USERS["b.researcher"], internal) is True
    assert port.is_visible(USERS["a.researcher"], internal) is False
    assert port.is_visible(USERS["a.researcher"], uuid4()) is False


def test_presign_get_signs_verified_files_as_attachments(api: CatalogApi, db: PgUrls) -> None:
    _, version_id = published_version(api, db)
    now = datetime(2026, 10, 1, 12, 0, tzinfo=UTC)
    with clock.frozen(now):
        signed = ports.get(StoragePort).presign_get(UUID(version_id), None, 300)
    assert [s.path for s in signed] == ["B.md", "data/a.csv", "data/b.csv"]
    assert all(s.expires_at == now + timedelta(seconds=300) for s in signed)
    assert signed[1].url.startswith("http://localhost:21051/nais-inst-b/datasets/")
    store = memory_store(api.deps.storage, "inst-b")
    assert [(filename, ttl) for _, filename, ttl in store.presigned_gets] == [("B.md", 300), ("a.csv", 300), ("b.csv", 300)]
    subset = ports.get(StoragePort).presign_get(UUID(version_id), [signed[2].file_id], 60)
    assert [s.path for s in subset] == ["data/b.csv"]


def test_at23_foreign_or_unverified_file_ids_are_not_found(api: CatalogApi, db: PgUrls) -> None:
    _, version_id = published_version(api, db)
    _, other_version = published_version(api, db)
    foreign = ports.get(CatalogQueryPort).get_version(UUID(other_version)).files[0].file_id  # type: ignore[union-attr]
    store = memory_store(api.deps.storage, "inst-b")
    store.presigned_gets.clear()
    with pytest.raises(CatalogNotFound) as caught:
        ports.get(StoragePort).presign_get(UUID(version_id), [foreign], 300)
    assert isinstance(caught.value, ValueError) and str(caught.value).startswith("NOT_FOUND")
    assert store.presigned_gets == []
    _, draft_id = new_draft(api)
    session = api.post(
        "b.steward",
        f"/dataset-versions/{draft_id}/upload-session",
        json={"files": [{"path": "p.csv", "size_bytes": 3, "sha256": SHA_A, "media_type": "text/csv"}]},
    ).json()
    with pytest.raises(CatalogNotFound):
        ports.get(StoragePort).presign_get(UUID(draft_id), [UUID(session["files"][0]["file_id"])], 300)
    with pytest.raises(CatalogNotFound):
        ports.get(StoragePort).presign_get(uuid4(), None, 300)


def test_open_stream_reads_bytes_with_the_service_credentials(api: CatalogApi, db: PgUrls) -> None:
    _, version_id = published_version(api, db)
    view = ports.get(CatalogQueryPort).get_version(UUID(version_id))
    assert view is not None
    ref = next(f for f in view.files if f.path == "data/a.csv")
    reader = ports.get(CatalogReadPort)
    assert reader.open_stream(ref).read() == FILES["data/a.csv"]
    assert reader.open_stream(ref, (2, 4)).read() == FILES["data/a.csv"][2:5]
    assert rows(db, "SELECT count(*) AS n FROM catalog.dataset_files")[0]["n"] == 3
```

`apps/api/modules/catalog/tests/test_routes_contract.py`:

```python
"""M03-AT-18: the catalog HTTP surface is exactly its contract operations and never hands out download URLs."""

from pathlib import Path
from typing import Any

import yaml

import api.modules.catalog as catalog_pkg
from api.modules.catalog import MODULE
from api.platform.settings import get_settings
from api.platform.testing.app import create_test_app
from api.platform.testing.contracts import operation

EXPECTED = {
    "searchDatasets",
    "createDataset",
    "getDataset",
    "updateDataset",
    "getDatasetPolicy",
    "listDatasetVersions",
    "createDatasetVersion",
    "getDatasetVersion",
    "createUploadSession",
    "getUploadSession",
    "completeUploadSession",
    "deleteDraftFile",
    "publishDatasetVersion",
}


def catalog_operations() -> dict[str, tuple[str, str]]:
    """operationId -> (path, method) of every route tagged "catalog", read from the app's generated OpenAPI
    (FastAPI mounts included routers lazily, so app.routes does not list them)."""
    app = create_test_app(modules=[MODULE])
    found: dict[str, tuple[str, str]] = {}
    for path, item in app.openapi()["paths"].items():
        for method, op in item.items():
            if "catalog" in op.get("tags", []):
                found[op["operationId"]] = (path, method)
    return found


def test_routes_are_exactly_the_contract_operations() -> None:
    found = catalog_operations()
    assert set(found) == EXPECTED
    for operation_id, (path, method) in found.items():
        assert (path, method) == (f"/api/v1{operation(operation_id)[0]}", operation(operation_id)[1]), operation_id


def _url_contexts(spec: dict[str, Any], node: Any, context: str, seen: set[str], found: set[str]) -> None:
    if isinstance(node, dict):
        ref = node.get("$ref")
        if isinstance(ref, str) and ref.startswith("#/components/schemas/"):
            name = ref.rsplit("/", 1)[-1]
            if name not in seen:
                seen.add(name)
                _url_contexts(spec, spec["components"]["schemas"][name], name, seen, found)
            return
        if "url" in node.get("properties", {}):
            found.add(context)
        for value in node.values():
            _url_contexts(spec, value, context, seen, found)
    elif isinstance(node, list):
        for value in node:
            _url_contexts(spec, value, context, seen, found)


def test_no_catalog_response_carries_a_download_url() -> None:
    spec = yaml.safe_load((get_settings().contracts_dir / "openapi.yaml").read_text(encoding="utf-8"))
    for operation_id in EXPECTED:
        path, method = operation(operation_id)
        responses = spec["paths"][path][method]["responses"]
        found: set[str] = set()
        for status, response in responses.items():
            if str(status).startswith("2"):
                _url_contexts(spec, response, operation_id, set(), found)
        # the only URLs a catalog operation returns are presigned *upload* URLs inside UploadSession
        assert found <= {"UploadSession"}, (operation_id, found)


def test_only_the_storage_port_presigns_downloads() -> None:
    package = Path(catalog_pkg.__file__).parent
    allowed = {"objects.py", "testing.py", "public.py", "public_impl.py"}
    offenders = [
        str(path.relative_to(package))
        for path in package.rglob("*.py")
        if "tests" not in path.parts and path.name not in allowed and "presign_get(" in path.read_text(encoding="utf-8")
    ]
    assert offenders == []
```

Append to `apps/api/modules/catalog/tests/test_s3_e2e.py`:

```python
def test_storage_port_presigned_get_downloads_through_the_gateway(s3_api: CatalogApi, db: PgUrls, s3_prefixes: list[str]) -> None:
    from uuid import UUID

    from api.modules.catalog.public import StoragePort
    from api.platform import ports

    dataset_id, version_id = new_draft(s3_api)
    s3_prefixes.append(f"datasets/{dataset_id}/")
    data = b"a,b\n1,2\n"
    body = start_upload(s3_api, version_id, {"data/a.csv": data})
    upload = body["files"][0]["upload"]
    assert httpx.put(upload["url"], content=data, headers=upload["headers"], timeout=60).status_code == 200
    assert complete(s3_api, body["upload_session_id"]).json()["files"][0]["status"] == "VERIFIED"
    assert s3_api.post("b.steward", f"/dataset-versions/{version_id}/publish").status_code == 200
    [signed] = ports.get(StoragePort).presign_get(UUID(version_id), None, 300)
    response = httpx.get(signed.url, timeout=30)
    assert response.status_code == 200 and response.content == data
    assert response.headers["content-disposition"] == 'attachment; filename="a.csv"'
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `uv run pytest apps/api/modules/catalog/tests/test_public_ports.py apps/api/modules/catalog/tests/test_routes_contract.py -v`
Expected: collection error `No module named 'api.modules.catalog.ports'`.

- [ ] **Step 3: Implement**

`apps/api/modules/catalog/public.py`:

```python
"""Catalog public interface (M03 §8, D-024). Other modules import only this file (or its alias
api.modules.catalog.ports) and look the implementations up with api.platform.ports.get(<Protocol>)."""

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime
from typing import Any, BinaryIO, Literal, Protocol
from uuid import UUID

from api.platform.auth import CurrentUser

AccessLevel = Literal["PUBLIC", "INTERNAL", "CONTROLLED", "SENSITIVE"]


@dataclass(frozen=True)
class DatasetPolicyView:
    dataset_id: UUID
    owner_organization_id: UUID
    access_level: AccessLevel
    allowed_purposes: tuple[str, ...]
    approval_required: bool
    max_grant_days: int
    status: Literal["ACTIVE", "WITHDRAWN"]
    title: str


@dataclass(frozen=True)
class FileRef:
    file_id: UUID
    path: str
    size_bytes: int
    sha256: str
    media_type: str
    status: Literal["PENDING", "UPLOADED", "VERIFIED", "FAILED"]
    storage_bucket: str  # internal only: never in API responses, events or logs
    storage_key: str


@dataclass(frozen=True)
class VersionView:
    dataset_version_id: UUID
    dataset_id: UUID
    owner_organization_id: UUID
    version_label: str
    status: Literal["DRAFT", "PUBLISHED", "WITHDRAWN"]
    manifest_sha256: str | None
    metadata_snapshot: dict[str, Any] | None  # not None only for PUBLISHED (and WITHDRAWN) versions
    files: tuple[FileRef, ...]  # path ascending (UTF-8 byte order)


@dataclass(frozen=True)
class PresignedGet:
    file_id: UUID
    path: str
    url: str
    size_bytes: int
    sha256: str
    expires_at: datetime


class CatalogNotFound(ValueError):  # noqa: N818  (spec: "ValueError(NOT_FOUND)")
    def __init__(self, detail: str = "") -> None:
        super().__init__(f"NOT_FOUND: {detail}" if detail else "NOT_FOUND")


class CatalogQueryPort(Protocol):
    """For Governance (M04) and Readiness (M05). Makes no access decision except is_visible (D-012)."""

    def get_policy_view(self, dataset_id: UUID) -> DatasetPolicyView | None: ...
    def get_version(self, dataset_version_id: UUID) -> VersionView | None: ...
    def is_visible(self, ctx: CurrentUser, dataset_id: UUID) -> bool: ...


class StoragePort(Protocol):
    """Governance only, after it has authorized the download. Signs VERIFIED files of the version; any other
    file id raises CatalogNotFound. URL: NAIS_PUBLIC_BASE_URL, path-style, attachment disposition."""

    def presign_get(
        self, dataset_version_id: UUID, file_ids: Sequence[UUID] | None, ttl_seconds: int
    ) -> list[PresignedGet]: ...


class CatalogReadPort(Protocol):
    """Readiness worker only (D-018): reads bytes with the service credentials, independent of user grants."""

    def open_stream(self, file: FileRef, byte_range: tuple[int, int] | None = None) -> BinaryIO: ...


__all__ = [
    "AccessLevel",
    "CatalogNotFound",
    "CatalogQueryPort",
    "CatalogReadPort",
    "DatasetPolicyView",
    "FileRef",
    "PresignedGet",
    "StoragePort",
    "VersionView",
]
```

`apps/api/modules/catalog/ports.py`:

```python
"""Alias of public.py: M04 §3 imports `from api.modules.catalog.ports import ...`."""

from api.modules.catalog.public import (
    AccessLevel,
    CatalogNotFound,
    CatalogQueryPort,
    CatalogReadPort,
    DatasetPolicyView,
    FileRef,
    PresignedGet,
    StoragePort,
    VersionView,
)

__all__ = [
    "AccessLevel",
    "CatalogNotFound",
    "CatalogQueryPort",
    "CatalogReadPort",
    "DatasetPolicyView",
    "FileRef",
    "PresignedGet",
    "StoragePort",
    "VersionView",
]
```

`apps/api/modules/catalog/public_impl.py`:

```python
"""Implementations of the catalog public ports (registered by wiring.install)."""

from collections.abc import Mapping, Sequence
from datetime import timedelta
from typing import Any, BinaryIO
from uuid import UUID

from api.modules.catalog.access import can_see_dataset
from api.modules.catalog.deps import CatalogDeps
from api.modules.catalog.domain import basename
from api.modules.catalog.public import CatalogNotFound, DatasetPolicyView, FileRef, PresignedGet, VersionView
from api.modules.catalog.repo import files_of_versions, load_dataset, load_version, must
from api.platform import clock
from api.platform.auth import CurrentUser


def _file_ref(f: Mapping[Any, Any]) -> FileRef:
    return FileRef(
        file_id=f["file_id"],
        path=f["path"],
        size_bytes=int(f["size_bytes"]),
        sha256=f["sha256"].strip(),
        media_type=f["media_type"],
        status=f["status"],
        storage_bucket=f["storage_bucket"],
        storage_key=f["storage_key"],
    )


class CatalogQueryService:
    def __init__(self, deps: CatalogDeps) -> None:
        self._deps = deps

    def get_policy_view(self, dataset_id: UUID) -> DatasetPolicyView | None:
        with self._deps.session_factory() as session:
            ds = load_dataset(session, dataset_id)
        if ds is None:
            return None
        return DatasetPolicyView(
            dataset_id=ds["dataset_id"],
            owner_organization_id=ds["owner_organization_id"],
            access_level=ds["access_level"],
            allowed_purposes=tuple(ds["allowed_purposes"]),
            approval_required=ds["approval_required"],
            max_grant_days=ds["max_grant_days"],
            status=ds["status"],
            title=ds["title"],
        )

    def get_version(self, dataset_version_id: UUID) -> VersionView | None:
        with self._deps.session_factory() as session:
            version = load_version(session, dataset_version_id)
            if version is None:
                return None
            ds = must(load_dataset(session, version["dataset_id"]), "dataset")
            files = files_of_versions(session, [dataset_version_id])[dataset_version_id]
        return VersionView(
            dataset_version_id=version["dataset_version_id"],
            dataset_id=version["dataset_id"],
            owner_organization_id=ds["owner_organization_id"],
            version_label=version["version_label"],
            status=version["status"],
            manifest_sha256=version["manifest_sha256"].strip() if version["manifest_sha256"] else None,
            metadata_snapshot=version["metadata_snapshot"],
            files=tuple(_file_ref(f) for f in files),
        )

    def is_visible(self, ctx: CurrentUser, dataset_id: UUID) -> bool:
        with self._deps.session_factory() as session:
            ds = load_dataset(session, dataset_id)
        return ds is not None and can_see_dataset(ctx, ds)


class CatalogStorageService:
    def __init__(self, deps: CatalogDeps) -> None:
        self._deps = deps

    def presign_get(
        self, dataset_version_id: UUID, file_ids: Sequence[UUID] | None, ttl_seconds: int
    ) -> list[PresignedGet]:
        with self._deps.session_factory() as session:
            if load_version(session, dataset_version_id) is None:
                raise CatalogNotFound(f"dataset version {dataset_version_id}")
            files = [
                f
                for f in files_of_versions(session, [dataset_version_id])[dataset_version_id]
                if f["status"] == "VERIFIED"
            ]
        by_id = {f["file_id"]: f for f in files}
        if file_ids is None:
            chosen = files
        else:
            unknown = [str(file_id) for file_id in file_ids if file_id not in by_id]
            if unknown:
                raise CatalogNotFound(f"files not in version {dataset_version_id}: {', '.join(unknown)}")
            chosen = [by_id[file_id] for file_id in dict.fromkeys(file_ids)]
        expires_at = clock.now() + timedelta(seconds=ttl_seconds)
        signed: list[PresignedGet] = []
        for f in chosen:
            store = self._deps.storage.for_bucket(f["storage_bucket"])
            signed.append(
                PresignedGet(
                    file_id=f["file_id"],
                    path=f["path"],
                    url=store.presign_get(f["storage_key"], basename(f["path"]), ttl_seconds),
                    size_bytes=int(f["size_bytes"]),
                    sha256=f["sha256"].strip(),
                    expires_at=expires_at,
                )
            )
        return signed


class CatalogReader:
    def __init__(self, deps: CatalogDeps) -> None:
        self._deps = deps

    def open_stream(self, file: FileRef, byte_range: tuple[int, int] | None = None) -> BinaryIO:
        return self._deps.storage.for_bucket(file.storage_bucket).open_stream(file.storage_key, byte_range)
```

In `apps/api/modules/catalog/wiring.py`, add to the imports:

```python
from api.modules.catalog.public import CatalogQueryPort, CatalogReadPort, StoragePort
from api.modules.catalog.public_impl import CatalogQueryService, CatalogReader, CatalogStorageService
```

and replace `install` with:

```python
def install(deps: CatalogDeps) -> None:
    """Register the deps container and the public ports (M04 uses CatalogQueryPort + StoragePort,
    M05 uses CatalogQueryPort + CatalogReadPort; the registry cannot restrict consumers, see README)."""
    ports.provide(CatalogDeps, deps)
    ports.provide(CatalogQueryPort, CatalogQueryService(deps))
    ports.provide(StoragePort, CatalogStorageService(deps))
    ports.provide(CatalogReadPort, CatalogReader(deps))
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `uv run pytest apps/api/modules/catalog/tests/test_public_ports.py apps/api/modules/catalog/tests/test_routes_contract.py apps/api/modules/catalog/tests/test_s3_e2e.py -v`
Expected: all PASS (S3 tests SKIP only if the dev stack is down).

- [ ] **Step 5: Commit**

```bash
uv run ruff check --fix apps/api/modules/catalog && uv run ruff format apps/api/modules/catalog
git add apps/api/modules/catalog
git commit -m "feat(catalog): CatalogQueryPort, StoragePort and CatalogReadPort for M04/M05

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 17: Worker jobs — upload-session sweeper (AT-22), stale verification re-queue, `register_worker`

**Files:**
- Modify: `apps/api/modules/catalog/jobs.py` (append jobs + `register_worker`; extend imports)
- Modify: `apps/api/modules/catalog/__init__.py` (`register_worker=`)
- Test: `apps/api/modules/catalog/tests/test_jobs.py`

**Interfaces:**
- Consumes: `drain_index_queue` (Task 13), `abort_quietly` (Task 9), `CatalogDeps`, `api.platform.scheduler.Scheduler`, `api.worker.build_worker`, tables, `start_upload`, `put_uploaded`, `file_row` (Task 9), `new_draft` (Task 8).
- Produces:
  - `jobs.expire_upload_sessions(deps, *, limit=100) -> int` — OPEN sessions with `expires_at < now` → `EXPIRED`; their PENDING files → `FAILED(SESSION_EXPIRED)`; multipart uploads aborted and partial objects deleted (storage errors are logged, never block the DB update).
  - `jobs.requeue_stale_uploads(deps, *, older_than=timedelta(hours=2), limit=500) -> int` — `UPLOADED` files untouched for longer than the verify time limit are re-sent to the verification queue (a lost message must not leave a file UPLOADED forever).
  - `jobs.register_worker(broker, scheduler) -> None` — `catalog.index_drain` every 2 s, `catalog.expire_upload_sessions` every 300 s (also runs the re-queue).
  - Constants `DRAIN_INTERVAL_S = 2.0`, `SWEEP_INTERVAL_S = 300.0`.

- [ ] **Step 1: Write the failing tests**

`apps/api/modules/catalog/tests/test_jobs.py`:

```python
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from uuid import UUID

from dramatiq.brokers.stub import StubBroker

from api.modules.catalog import MODULE
from api.modules.catalog.jobs import expire_upload_sessions, register_worker, requeue_stale_uploads
from api.modules.catalog.settings import CatalogSettings
from api.modules.catalog.testing import RecordingVerificationQueue, memory_store
from api.modules.catalog.tests.support import execute, rows
from api.modules.catalog.tests.support_api import CatalogApi, new_draft
from api.modules.catalog.tests.support_upload import file_row, start_upload
from api.platform import clock
from api.platform.scheduler import Scheduler
from api.platform.settings import Settings
from api.platform.testing.fixtures import PgUrls
from api.worker import build_worker

CSV = b"a,b\n" + b"1,2\n" * 400


def test_at22_expired_session_fails_pending_files_and_aborts_multipart(api: CatalogApi, db: PgUrls) -> None:
    api.use(replace(api.deps, settings=CatalogSettings(storage_multipart_threshold_bytes=1024, catalog_multipart_part_size_bytes=1024)))
    _, version_id = new_draft(api)
    started = datetime.now(UTC)
    with clock.frozen(started):
        body = start_upload(api, version_id, {"big.csv": CSV, "small.csv": b"a\n"})
    by_path = {f["path"]: f for f in body["files"]}
    big, small = file_row(db, by_path["big.csv"]["file_id"]), file_row(db, by_path["small.csv"]["file_id"])
    store = memory_store(api.deps.storage, "inst-b")
    store.put(small["storage_key"], b"a\n", "text/csv")  # uploaded but never completed
    with clock.frozen(started + timedelta(minutes=30)):
        assert expire_upload_sessions(api.deps) == 0
    with clock.frozen(started + timedelta(minutes=61)):
        assert expire_upload_sessions(api.deps) == 1
        assert expire_upload_sessions(api.deps) == 0
    assert rows(db, "SELECT status FROM catalog.upload_sessions") == [{"status": "EXPIRED"}]
    for row in (big, small):
        after = file_row(db, row["file_id"])
        assert (after["status"], after["failure_code"]) == ("FAILED", "SESSION_EXPIRED")
    assert store.aborted == [big["multipart_upload_id"]]
    assert store.head(small["storage_key"]) is None
    again = start_upload(api, version_id, {"small.csv": b"a\n"})
    assert again["files"][0]["file_id"] == str(small["file_id"])


def test_verified_files_are_left_alone(api: CatalogApi, db: PgUrls) -> None:
    _, version_id = new_draft(api)
    body = start_upload(api, version_id, {"a.csv": b"a\n"})
    execute(db, "UPDATE catalog.dataset_files SET status = 'UPLOADED'")
    with clock.frozen(datetime.now(UTC) + timedelta(hours=2)):
        assert expire_upload_sessions(api.deps) == 1
    assert file_row(db, body["files"][0]["file_id"])["status"] == "UPLOADED"


def test_stale_uploaded_files_are_requeued_once(api: CatalogApi, db: PgUrls) -> None:
    queue = RecordingVerificationQueue()
    api.use(replace(api.deps, verification=queue))
    _, version_id = new_draft(api)
    body = start_upload(api, version_id, {"a.csv": b"a\n"})
    file_id = UUID(body["files"][0]["file_id"])
    execute(db, "UPDATE catalog.dataset_files SET status = 'UPLOADED', updated_at = now() - interval '3 hours'")
    assert requeue_stale_uploads(api.deps) == 1
    assert queue.enqueued == [file_id]
    assert requeue_stale_uploads(api.deps) == 0


def test_register_worker_schedules_the_catalog_jobs() -> None:
    scheduler = Scheduler()
    register_worker(StubBroker(), scheduler)
    assert scheduler.job_names == ["catalog.index_drain", "catalog.expire_upload_sessions"]


def test_worker_boots_with_the_catalog_module() -> None:
    runtime = build_worker(modules=[MODULE], broker=StubBroker(), settings=Settings())
    assert "catalog.index_drain" in runtime.scheduler.job_names
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `uv run pytest apps/api/modules/catalog/tests/test_jobs.py -v`
Expected: collection error `cannot import name 'expire_upload_sessions' from 'api.modules.catalog.jobs'`.

- [ ] **Step 3: Implement**

Replace the import block at the top of `apps/api/modules/catalog/jobs.py` with:

```python
import logging
from collections.abc import Mapping
from datetime import timedelta
from typing import Any
from uuid import UUID

import dramatiq
from sqlalchemy import select, update

from api.modules.catalog.deps import CatalogDeps
from api.modules.catalog.objects import StorageUnavailable
from api.modules.catalog.search.drain import drain_index_queue
from api.modules.catalog.service.uploads import abort_quietly
from api.modules.catalog.tables import dataset_files, upload_sessions
from api.modules.catalog.verification import apply_outcome, evaluate_object
from api.platform import clock, ports
from api.platform.scheduler import Scheduler
```

and append to `apps/api/modules/catalog/jobs.py`:

```python
DRAIN_INTERVAL_S = 2.0
SWEEP_INTERVAL_S = 300.0


def _cleanup_partial_upload(deps: CatalogDeps, f: Mapping[Any, Any]) -> None:
    try:
        store = deps.storage.for_bucket(f["storage_bucket"])
        if f["multipart_upload_id"]:
            abort_quietly(store, f["storage_key"], f["multipart_upload_id"])
        store.delete(f["storage_key"])
    except Exception:
        logger.warning("could not clean up an expired upload", extra={"file_id": str(f["file_id"])}, exc_info=True)


def expire_upload_sessions(deps: CatalogDeps, *, limit: int = 100) -> int:
    """catalog.expire_upload_sessions (M03 §5.3, §10)."""
    now = clock.now()
    expired = 0
    with deps.session_factory() as session, session.begin():
        sessions = session.execute(
            select(upload_sessions)
            .where(upload_sessions.c.status == "OPEN", upload_sessions.c.expires_at < now)
            .order_by(upload_sessions.c.expires_at)
            .limit(limit)
            .with_for_update(skip_locked=True)
        ).mappings().all()
        for sess in sessions:
            pending = session.execute(
                select(dataset_files).where(
                    dataset_files.c.upload_session_id == sess["upload_session_id"], dataset_files.c.status == "PENDING"
                )
            ).mappings().all()
            for f in pending:
                _cleanup_partial_upload(deps, f)
            if pending:
                session.execute(
                    update(dataset_files)
                    .where(dataset_files.c.file_id.in_([f["file_id"] for f in pending]), dataset_files.c.status == "PENDING")
                    .values(status="FAILED", failure_code="SESSION_EXPIRED", updated_at=now)
                )
            session.execute(
                update(upload_sessions)
                .where(upload_sessions.c.upload_session_id == sess["upload_session_id"])
                .values(status="EXPIRED")
            )
            expired += 1
    if expired:
        logger.info("expired upload sessions", extra={"count": expired})
    return expired


def requeue_stale_uploads(deps: CatalogDeps, *, older_than: timedelta = timedelta(hours=2), limit: int = 500) -> int:
    now = clock.now()
    with deps.session_factory() as session, session.begin():
        file_ids: list[UUID] = list(
            session.execute(
                select(dataset_files.c.file_id)
                .where(dataset_files.c.status == "UPLOADED", dataset_files.c.updated_at < now - older_than)
                .limit(limit)
                .with_for_update(skip_locked=True)
            ).scalars()
        )
        if file_ids:
            session.execute(update(dataset_files).where(dataset_files.c.file_id.in_(file_ids)).values(updated_at=now))
    if file_ids:
        deps.verification.enqueue(file_ids)
        logger.warning("re-queued stale file verifications", extra={"count": len(file_ids)})
    return len(file_ids)


def _deps() -> CatalogDeps:
    return ports.get(CatalogDeps)


def _drain() -> None:
    drain_index_queue(_deps())


def _sweep() -> None:
    deps = _deps()
    expire_upload_sessions(deps)
    requeue_stale_uploads(deps)


def register_worker(broker: dramatiq.Broker, scheduler: Scheduler) -> None:
    scheduler.every(DRAIN_INTERVAL_S, "catalog.index_drain", _drain)
    scheduler.every(SWEEP_INTERVAL_S, "catalog.expire_upload_sessions", _sweep)
```

`apps/api/modules/catalog/__init__.py`:

```python
"""M03 Data Catalog & Versioning. Spec: NAIS_PRD/modules/M03_data_catalog.md."""

from pathlib import Path

from api.modules.catalog import handlers, jobs  # noqa: F401  (register @subscribe handlers and the verify actor)
from api.modules.catalog.jobs import register_worker
from api.modules.catalog.router import router
from api.modules.catalog.wiring import wire
from api.platform.modules import ModuleSpec

MODULE = ModuleSpec(
    name="catalog",
    db_schema="catalog",
    router=router,
    migrations_dir=Path(__file__).parent / "migrations",
    wire=wire,
    register_worker=register_worker,
)
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `uv run pytest apps/api/modules/catalog/tests/test_jobs.py apps/api/modules/catalog/tests/test_complete_upload.py -v`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
uv run ruff check --fix apps/api/modules/catalog && uv run ruff format apps/api/modules/catalog
git add apps/api/modules/catalog
git commit -m "feat(catalog): upload-session sweeper, stale verification re-queue, worker registration

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 18: Seed data (10_SEED_DATA §5), module README, and verification on the running stack

**Files:**
- Create: `apps/api/modules/catalog/seed_files.py`
- Create: `apps/api/modules/catalog/seed_data.py`
- Create: `apps/api/modules/catalog/seed.py`
- Create: `apps/api/modules/catalog/README.md`
- Modify: `apps/api/modules/catalog/__init__.py` (`seed=`)
- Test: `apps/api/modules/catalog/tests/test_seed.py`

**Interfaces:**
- Consumes: `insert_dataset`, `policy_or_error` (Task 6), `finalize_publish` (Task 12), `build_policy`, `storage_key`, `ALLOWED_MEDIA_TYPES`, `extension` (Task 1), `load_dataset`, `load_version`, `must` (Task 6), `CatalogDeps`, `build_default_deps` (Task 5), `ports.get(CatalogQueryPort)` (Task 16).
- Produces:
  - `seed_files.fixture_files(fixture: str) -> dict[str, bytes]` for `clean_tabular`, `missing_metadata`, `invalid_units`, `missing_provenance` (files `README.md`, `_codebook.csv`, `_schema.json`, `data/measurements.csv` per 09_AI_READY_RULES §5); `seed_files.measurements_csv() -> bytes`.
  - `seed_data.SeedDataset` + `seed_data.SEED_DATASETS` (fixed ids `...2001`–`...2005`, versions `...2101`–`...2105`, sessions `...2201`–`...2204`), `seed_data.metadata_for(fixture) -> dict`, `seed_data.file_id(version_id, path) -> UUID` (uuid5, stable).
  - `seed.seed(session) -> None` (idempotent: skips datasets that exist).

- [ ] **Step 1: Write the failing test**

`apps/api/modules/catalog/tests/test_seed.py`:

```python
import csv
import io
import json
from uuid import UUID

from api.modules.catalog.public import CatalogQueryPort
from api.modules.catalog.seed import seed
from api.modules.catalog.seed_data import SEED_DATASETS
from api.modules.catalog.seed_files import fixture_files, measurements_csv
from api.modules.catalog.testing import memory_store
from api.modules.catalog.tests.support import outbox_events, rows
from api.modules.catalog.tests.support_api import USERS, CatalogApi
from api.platform import ports
from api.platform.db import session_factory
from api.platform.testing.contracts import assert_valid_event
from api.platform.testing.fixtures import PgUrls


def run_seed(db: PgUrls) -> None:
    with session_factory(db.app)() as session, session.begin():
        seed(session)


def test_measurements_follow_the_fixture_formula() -> None:
    reader = list(csv.reader(io.StringIO(measurements_csv().decode())))
    assert reader[0] == ["sample_id", "material", "temperature_c", "pressure_kpa", "measured_at"]
    assert len(reader) == 1001
    assert reader[1] == ["S0001", "CU", "20.5", "102.325", "2026-01-01T00:01:00Z"]
    assert reader[100] == ["S0100", "CU", "20.0", "", "2026-01-01T01:40:00Z"]
    assert sum(1 for row in reader[1:] if row[3] == "") == 10


def test_fixture_variants() -> None:
    clean = fixture_files("clean_tabular")
    assert sorted(clean) == ["README.md", "_codebook.csv", "_schema.json", "data/measurements.csv"]
    units = {f["name"]: f.get("unit") for f in json.loads(fixture_files("invalid_units")["_schema.json"])["fields"]}
    assert (units["temperature_c"], units["pressure_kpa"]) == ("degC", "kilopascal")
    assert "## Provenance" in clean["README.md"].decode()
    assert "## Provenance" not in fixture_files("missing_provenance")["README.md"].decode()


def test_seed_is_idempotent_and_matches_10_seed_data(api: CatalogApi, db: PgUrls) -> None:
    run_seed(db)
    run_seed(db)
    datasets = {r["dataset_id"]: r for r in rows(db, "SELECT * FROM catalog.datasets")}
    assert {str(i)[-4:] for i in datasets} == {"2001", "2002", "2003", "2004", "2005"}
    by_suffix = {str(i)[-4:]: r for i, r in datasets.items()}
    assert (by_suffix["2001"]["access_level"], by_suffix["2001"]["max_grant_days"]) == ("CONTROLLED", 180)
    assert (by_suffix["2002"]["access_level"], len(by_suffix["2002"]["allowed_purposes"])) == ("PUBLIC", 5)
    assert by_suffix["2003"]["access_level"] == "INTERNAL"
    assert (by_suffix["2004"]["access_level"], by_suffix["2004"]["max_grant_days"]) == ("SENSITIVE", 30)
    assert by_suffix["2004"]["description"] == "측정 데이터" and by_suffix["2004"]["keywords"] == []
    assert by_suffix["2002"]["provenance"] is None
    versions = rows(db, "SELECT dataset_id, status, file_count FROM catalog.dataset_versions ORDER BY dataset_id")
    assert [(str(v["dataset_id"])[-4:], v["status"], v["file_count"]) for v in versions] == [
        ("2001", "PUBLISHED", 4),
        ("2002", "PUBLISHED", 4),
        ("2003", "PUBLISHED", 4),
        ("2004", "PUBLISHED", 4),
        ("2005", "DRAFT", 0),
    ]
    assert rows(db, "SELECT count(*) AS n FROM catalog.dataset_files WHERE status = 'VERIFIED'")[0]["n"] == 16
    events = outbox_events(db)
    assert [e["event_type"] for e in events].count("catalog.dataset.created.v1") == 5
    assert [e["event_type"] for e in events].count("catalog.dataset.version_published.v1") == 4
    for event in events:
        assert_valid_event(event)
    steward_b = str(USERS["b.steward"].user_id)
    assert {e["actor"]["user_id"] for e in events if e["payload"].get("owner_organization_id") == str(by_suffix["2001"]["owner_organization_id"])} == {steward_b}
    assert len(memory_store(api.deps.storage, "inst-b").objects) == 12
    assert len(memory_store(api.deps.storage, "inst-a").objects) == 4


def test_seed_check_visibility(api: CatalogApi, db: PgUrls) -> None:  # 10_SEED_DATA §7 (metadata part)
    run_seed(db)
    port = ports.get(CatalogQueryPort)
    visible_to_a = {s.dataset_id for s in SEED_DATASETS if port.is_visible(USERS["a.researcher"], s.dataset_id)}
    visible_to_b = {s.dataset_id for s in SEED_DATASETS if port.is_visible(USERS["b.researcher"], s.dataset_id)}
    suffix = lambda ids: {str(i)[-4:] for i in ids}  # noqa: E731
    assert suffix(visible_to_a) == {"2001", "2002", "2004", "2005"}
    assert suffix(visible_to_b) == {"2001", "2002", "2003", "2004"}
    view = port.get_version(UUID("00000000-0000-7000-8000-000000002101"))
    assert view is not None and view.metadata_snapshot is not None
    assert view.metadata_snapshot["title"] == "Battery Cycling Measurements"
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `uv run pytest apps/api/modules/catalog/tests/test_seed.py -v`
Expected: collection error `No module named 'api.modules.catalog.seed'`.

- [ ] **Step 3: Implement**

`apps/api/modules/catalog/seed_files.py`:

```python
"""Readiness fixture files generated from the 09_AI_READY_RULES §5 formulas (no randomness).

M05 owns tests/fixtures/readiness (not in the api image); the catalog seed rebuilds the same files in code.
Keep this byte-identical with tests/fixtures/readiness/generate.py (see README "Integration notes").
"""

import json
from datetime import UTC, datetime, timedelta

MATERIALS = ("AL", "CU", "FE")
START = datetime(2026, 1, 1, tzinfo=UTC)


def measurements_csv() -> bytes:
    lines = ["sample_id,material,temperature_c,pressure_kpa,measured_at"]
    for i in range(1, 1001):
        pressure = "" if i % 100 == 0 else f"{101.325 + (i % 10):.3f}"
        measured_at = (START + timedelta(minutes=i)).strftime("%Y-%m-%dT%H:%M:%SZ")
        lines.append(f"S{i:04d},{MATERIALS[i % 3]},{20.0 + (i % 50) * 0.5:.1f},{pressure},{measured_at}")
    return ("\n".join(lines) + "\n").encode("utf-8")


def schema_json(fixture: str) -> bytes:
    temperature_unit, pressure_unit = ("degC", "kilopascal") if fixture == "invalid_units" else ("Cel", "kPa")
    schema = {
        "fields": [
            {"name": "sample_id", "type": "string", "x-nais-concept": "https://schema.org/identifier"},
            {
                "name": "material",
                "type": "string",
                "constraints": {"enum": list(MATERIALS)},
                "x-nais-concept": "https://w3id.org/emmo#Material",
            },
            {
                "name": "temperature_c",
                "type": "number",
                "unit": temperature_unit,
                "x-nais-concept": "http://qudt.org/vocab/quantitykind/Temperature",
            },
            {
                "name": "pressure_kpa",
                "type": "number",
                "unit": pressure_unit,
                "x-nais-concept": "http://qudt.org/vocab/quantitykind/Pressure",
            },
            {"name": "measured_at", "type": "datetime", "x-nais-concept": "http://www.w3.org/2006/time#Instant"},
        ],
        "primaryKey": "sample_id",
    }
    return (json.dumps(schema, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


def codebook_csv() -> bytes:
    rows = [
        "file,field,code,label,description,unit",
        "data/measurements.csv,material,AL,Aluminium,,",
        "data/measurements.csv,material,CU,Copper,,",
        "data/measurements.csv,material,FE,Iron,,",
    ]
    return ("\n".join(rows) + "\n").encode("utf-8")


def readme_md(fixture: str) -> bytes:
    text = (
        "# 고분자 전해질 막 온도-압력 측정\n\n"
        "연료전지용 고분자 전해질 막 시편 1,000개의 온도와 압력 측정값. 데이터 파일은 data/measurements.csv,"
        " 필드 정의는 _schema.json, 재료 코드는 _codebook.csv에 있다.\n"
    )
    if fixture != "missing_provenance":
        text += (
            "\n## Provenance\n\n"
            "Institute B 연료전지 실험실의 환경 챔버(모델 EC-200)에서 2026년 1월 1일부터 1분 간격으로 자동 수집한"
            " 측정값이며, 수집 후 단위 변환 외의 가공은 하지 않았다.\n"
        )
    return text.encode("utf-8")


def fixture_files(fixture: str) -> dict[str, bytes]:
    return {
        "README.md": readme_md(fixture),
        "_codebook.csv": codebook_csv(),
        "_schema.json": schema_json(fixture),
        "data/measurements.csv": measurements_csv(),
    }
```

`apps/api/modules/catalog/seed_data.py`:

```python
"""10_SEED_DATA §5 datasets as Python data (docs are not in the image). Fixed UUIDs keep seeding idempotent."""

import uuid
from dataclasses import dataclass
from typing import Any
from uuid import UUID

from api.modules.catalog.domain import PURPOSES


def sid(suffix: str) -> UUID:
    return UUID(f"00000000-0000-7000-8000-00000000{suffix}")


ORG_A = UUID("00000000-0000-7000-8000-00000000000a")
ORG_B = UUID("00000000-0000-7000-8000-00000000000b")
ORG_CODES = {ORG_A: "inst-a", ORG_B: "inst-b"}
STEWARDS = {ORG_A: sid("0a03"), ORG_B: sid("0b03")}
SEED_NAMESPACE = uuid.UUID("5b7d0a52-1f4e-4c55-9f5e-6e41c3a1d203")

# 09_AI_READY_RULES §5.2 clean_tabular dataset.json (title comes from 10_SEED_DATA instead).
CLEAN_METADATA: dict[str, Any] = {
    "description": (
        "연료전지용 고분자 전해질 막 시편 1,000개에 대해 온도와 압력을 측정한 표 형식 데이터셋이다."
        " 재료 코드는 codebook에 정의되어 있다."
    ),
    "keywords": ["fuel-cell", "membrane", "temperature", "pressure"],
    "domain": "materials",
    "license": "CC-BY-4.0",
    "usage_policy": "학술 연구 및 AI 학습 목적에 한해 사용한다. 재배포 금지. 결과 공개 시 출처를 표기한다.",
    "contact_email": "steward@inst-b.example",
    "provenance": (
        "Institute B 연료전지 실험실의 환경 챔버(모델 EC-200)에서 2026년 1월 1일 1분 간격으로 자동 수집한 측정값."
    ),
}


@dataclass(frozen=True)
class SeedDataset:
    dataset_id: UUID
    version_id: UUID
    session_id: UUID
    owner: UUID
    title: str
    access_level: str
    allowed_purposes: tuple[str, ...]
    max_grant_days: int
    fixture: str | None
    publish: bool

    @property
    def steward(self) -> UUID:
        return STEWARDS[self.owner]


SEED_DATASETS: tuple[SeedDataset, ...] = (
    SeedDataset(sid("2001"), sid("2101"), sid("2201"), ORG_B, "Battery Cycling Measurements", "CONTROLLED",
                ("ACADEMIC_RESEARCH", "AI_TRAINING"), 180, "clean_tabular", True),
    SeedDataset(sid("2002"), sid("2102"), sid("2202"), ORG_B, "Open Materials Properties", "PUBLIC",
                PURPOSES, 365, "missing_provenance", True),
    SeedDataset(sid("2003"), sid("2103"), sid("2203"), ORG_B, "Inst-B Internal QC Logs", "INTERNAL",
                ("ACADEMIC_RESEARCH",), 90, "invalid_units", True),
    SeedDataset(sid("2004"), sid("2104"), sid("2204"), ORG_A, "Facility Sensor Streams", "SENSITIVE",
                ("ACADEMIC_RESEARCH",), 30, "missing_metadata", True),
    SeedDataset(sid("2005"), sid("2105"), sid("2205"), ORG_A, "Electrolyte Screening (draft)", "CONTROLLED",
                ("AI_TRAINING",), 90, None, False),
)


def metadata_for(fixture: str | None) -> dict[str, Any]:
    metadata = dict(CLEAN_METADATA)
    if fixture == "missing_metadata":
        metadata.update(description="측정 데이터", keywords=[], domain=None, contact_email=None)
    if fixture == "missing_provenance":
        metadata["provenance"] = None
    return metadata


def file_id(version_id: UUID, path: str) -> UUID:
    return uuid.uuid5(SEED_NAMESPACE, f"{version_id}/{path}")
```

`apps/api/modules/catalog/seed.py`:

```python
"""ModuleSpec.seed (10_SEED_DATA §1 step 3): datasets -> versions -> files -> S3 objects -> publish -> index queue."""

import hashlib
import logging

from sqlalchemy import insert
from sqlalchemy.orm import Session

from api.modules.catalog.deps import CatalogDeps
from api.modules.catalog.domain import ALLOWED_MEDIA_TYPES, build_policy, extension, storage_key
from api.modules.catalog.repo import load_dataset, load_version, must
from api.modules.catalog.seed_data import ORG_CODES, SEED_DATASETS, SeedDataset, file_id, metadata_for
from api.modules.catalog.seed_files import fixture_files
from api.modules.catalog.service.datasets import insert_dataset
from api.modules.catalog.service.publish import finalize_publish
from api.modules.catalog.tables import dataset_files, dataset_versions, upload_sessions
from api.platform import clock, ports
from api.platform.events import EventActor

logger = logging.getLogger("nais.catalog.seed")


def _deps() -> CatalogDeps:
    try:
        return ports.get(CatalogDeps)
    except ports.PortNotProvided:  # `python -m api.platform.cli seed` does not call wire()
        from api.modules.catalog.wiring import build_default_deps

        return build_default_deps()


def _seed_one(session: Session, deps: CatalogDeps, item: SeedDataset) -> None:
    actor = EventActor(type="USER", user_id=item.steward, organization_id=item.owner)
    policy = build_policy(item.access_level, item.allowed_purposes, item.max_grant_days)
    fields = {"title": item.title, **metadata_for(item.fixture)}
    insert_dataset(
        session,
        dataset_id=item.dataset_id,
        owner=item.owner,
        created_by=item.steward,
        fields=fields,
        policy=policy,
        actor=actor,
    )
    now = clock.now()
    session.execute(
        insert(dataset_versions).values(
            dataset_version_id=item.version_id,
            dataset_id=item.dataset_id,
            version_label="v1",
            status="DRAFT",
            change_note="Seed data (10_SEED_DATA.md)",
            created_by=item.steward,
            created_at=now,
            updated_at=now,
        )
    )
    if item.fixture is None:
        return
    store = deps.storage.for_org(ORG_CODES[item.owner])
    session.execute(
        insert(upload_sessions).values(
            upload_session_id=item.session_id,
            dataset_version_id=item.version_id,
            status="COMPLETED",
            created_by=item.steward,
            expires_at=now,
            completed_at=now,
            created_at=now,
        )
    )
    for path, data in sorted(fixture_files(item.fixture).items()):
        key = storage_key(item.dataset_id, item.version_id, path)
        media_type = ALLOWED_MEDIA_TYPES[extension(path)]
        store.put(key, data, media_type)
        session.execute(
            insert(dataset_files).values(
                file_id=file_id(item.version_id, path),
                dataset_version_id=item.version_id,
                upload_session_id=item.session_id,
                path=path,
                size_bytes=len(data),
                sha256=hashlib.sha256(data).hexdigest(),
                media_type=media_type,
                storage_bucket=store.bucket,
                storage_key=key,
                status="VERIFIED",
                scan_status="SKIPPED",
                verified_at=now,
                created_at=now,
                updated_at=now,
            )
        )
    if item.publish:
        finalize_publish(
            session,
            ds=must(load_dataset(session, item.dataset_id), "dataset"),
            version=must(load_version(session, item.version_id), "version"),
            published_by=item.steward,
            actor=actor,
        )


def seed(session: Session) -> None:
    deps = _deps()
    for item in SEED_DATASETS:
        if load_dataset(session, item.dataset_id) is not None:
            continue
        _seed_one(session, deps, item)
        logger.info("seeded dataset", extra={"dataset_id": str(item.dataset_id), "title": item.title})
```

`apps/api/modules/catalog/__init__.py` (final):

```python
"""M03 Data Catalog & Versioning. Spec: NAIS_PRD/modules/M03_data_catalog.md."""

from pathlib import Path

from api.modules.catalog import handlers, jobs  # noqa: F401  (register @subscribe handlers and the verify actor)
from api.modules.catalog.jobs import register_worker
from api.modules.catalog.router import router
from api.modules.catalog.seed import seed
from api.modules.catalog.wiring import wire
from api.platform.modules import ModuleSpec

MODULE = ModuleSpec(
    name="catalog",
    db_schema="catalog",
    router=router,
    migrations_dir=Path(__file__).parent / "migrations",
    wire=wire,
    register_worker=register_worker,
    seed=seed,
)
```

`apps/api/modules/catalog/README.md`:

````markdown
# catalog (M03 Data Catalog & Versioning)

Spec: `NAIS_PRD/modules/M03_data_catalog.md`. Schema `catalog`, migrations in `migrations/`.

## HTTP (openapi operationIds)
searchDatasets, createDataset, getDataset, updateDataset, getDatasetPolicy, listDatasetVersions,
createDatasetVersion, getDatasetVersion, createUploadSession, getUploadSession, completeUploadSession,
deleteDraftFile, publishDatasetVersion. No endpoint returns a download URL, bucket or storage key.

## Upload flow
1. `POST /dataset-versions/{id}/upload-session` → per file either `PUT` (sign `Content-Type` and
   `x-amz-checksum-sha256`; send both headers exactly as returned) or `MULTIPART` (64 MiB parts, one URL each).
2. Upload through `http://localhost:21051/<bucket>/...` (gateway → SeaweedFS). Keep each part's `ETag`.
3. `POST /upload-sessions/{id}/complete` with `{"parts": [{"file_id", "etags": [{"part_number", "etag"}]}]}`.
   Sessions ≤ 256 MiB are verified synchronously; larger ones return `UPLOADED` — poll `GET /upload-sessions/{id}`.
4. `POST /dataset-versions/{id}/publish` when every file is `VERIFIED`. The version is then immutable (DB triggers).

## Events
Produces `catalog.dataset.created.v1`, `catalog.dataset.access_level_changed.v1`, `catalog.dataset.policy_changed.v1`,
`catalog.dataset.version_published.v1`. Consumes `readiness.validation.completed.v1` (readiness read model) and
`identity.organization.created.v1` (re-index). Idempotent per handler via `catalog.processed_events`.

## Worker
`catalog.index_drain` (2 s), `catalog.expire_upload_sessions` (5 min, also re-queues stale verifications),
Dramatiq actor `catalog.verify_file` (queue `catalog`). Full rebuild: `python -m api.modules.catalog.reindex`.

## Search
Index `nais-datasets-v1` behind alias `nais-datasets` (`infra/opensearch`). Without the `analysis-nori`
plugin the catalog creates the index with the fallback analyzer (`standard` + `cjk_bigram`). The compose
`opensearch` service must build `infra/opensearch/Dockerfile` to get nori.

## Integration notes
- **M04 Governance:** use `api.platform.ports.get(CatalogQueryPort)` and `ports.get(StoragePort)` with the Protocol
  classes imported from `api.modules.catalog.public` (or its alias `api.modules.catalog.ports`); a Protocol defined in
  your own module is a different registry key. `presign_get` raises `CatalogNotFound` (a `ValueError`) for unknown
  versions and for file ids that are not VERIFIED files of that version.
- **M05 Readiness:** `CatalogQueryPort.get_version()` gives `VersionView.metadata_snapshot` (frozen at publish; evaluate
  it, not the live dataset) and `files` in path order; read bytes with `ports.get(CatalogReadPort).open_stream(file_ref,
  byte_range)`. Seed files come from `seed_files.py` (09 §5 formulas) and must stay byte-identical with
  `tests/fixtures/readiness/generate.py`.
- **M01 Identity:** the catalog calls `IdentityQueryPort.get_organization_summary` from
  `api.modules.identity.public`; until that module exists it uses `FakeIdentityPort` (seed organizations).
- The ports registry cannot restrict which module reads `StoragePort`/`CatalogReadPort`; only M04/M05 may use them.

## Known limitations (P0)
Nested archives are not inspected; malware scan is a no-op; the server re-hashes every file; facet counts are not
disjunctive; `total` is capped at 10,000; organization renames need `reindex`.
````

- [ ] **Step 4: Run the tests to verify they pass, then the whole module suite, lint and types**

Run: `uv run pytest apps/api/modules/catalog -v`
Expected: all PASS (S3/OpenSearch tests SKIP only without Docker / dev stack; AT-20 and nori SKIP unless opted in).

Run: `uv run ruff check apps/api/modules/catalog && uv run ruff format --check apps/api/modules/catalog`
Expected: no findings.

Run: `uv run mypy apps/api/modules/catalog --exclude 'apps/api/modules/catalog/(tests|migrations)/'`
Expected: `Success: no issues found` (fix any reported typing issue in the module before continuing).

Run: `uv run pytest apps/api/platform tests/contract -q`
Expected: still green (the catalog must not break platform tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/modules/catalog
git commit -m "feat(catalog): seed datasets from 10_SEED_DATA and module README

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 6: Deploy to the running stack (no `down`, no volume deletion)**

```bash
docker compose build api
docker compose up -d api worker
scripts/nais migrate          # expect: "migrated platform" then "migrated catalog"
scripts/nais storage-init     # buckets already exist: prints nothing or "created bucket ..."
scripts/nais seed             # expect: "seeded catalog"
scripts/nais seed             # second run: still "seeded catalog", no new rows (idempotent)
docker compose logs worker --since 2m | grep -m1 'event subscriptions'
```

Expected: the subscriptions line lists `readiness.validation.completed.v1` and `identity.organization.created.v1`
with `api.modules.catalog.handlers.*`.

- [ ] **Step 7: Verify data, storage and index**

```bash
docker compose exec -T postgres psql -U nais -d nais -c \
  "SELECT right(dataset_id::text, 4) AS id, status, file_count, manifest_sha256 IS NOT NULL AS has_manifest
     FROM catalog.dataset_versions ORDER BY 1"
```

Expected: `2001..2004 PUBLISHED 4 t`, `2005 DRAFT 0 f`.

```bash
for i in $(seq 1 15); do
  n=$(curl -s -u nais:nais 'http://localhost:21056/nais-datasets/_count' | python3 -c 'import json,sys; print(json.load(sys.stdin).get("count", 0))')
  [ "$n" = "5" ] && break; sleep 2
done; echo "indexed documents: $n"
curl -s -u nais:nais 'http://localhost:21056/_alias/nais-datasets'
```

Expected: `indexed documents: 5` (the worker drain indexed them; the draft-only 2005 is indexed with
`has_published_version=false`) and the alias points at `nais-datasets-v1`.

```bash
docker compose run --rm --no-deps -T api python - <<'PY'
from uuid import UUID
from api.platform.broker import configure_broker
from api.platform.settings import get_settings
configure_broker(get_settings())
from api.modules.catalog.search.query import SearchParams
from api.modules.catalog.service.search import search_datasets
from api.modules.catalog.wiring import build_default_deps
from api.platform.auth import CurrentUser

deps = build_default_deps()
def user(suffix: str, org: str) -> CurrentUser:
    return CurrentUser(user_id=UUID(f"00000000-0000-7000-8000-00000000{suffix}"),
                       organization_id=UUID(f"00000000-0000-7000-8000-00000000000{org}"),
                       session_id="check", display_name=suffix)
for name, u in (("a.researcher", user("0a02", "a")), ("b.researcher", user("0b02", "b"))):
    print(name, sorted(h["dataset_id"][-4:] for h in search_datasets(deps, u, SearchParams(limit=50))["items"]))
store = deps.storage.for_org("inst-b")
print("object bytes", store.head("datasets/00000000-0000-7000-8000-000000002001/00000000-0000-7000-8000-000000002101/data/measurements.csv"))
PY
```

Expected (10_SEED_DATA §7): `a.researcher ['2001', '2002', '2004', '2005']`, `b.researcher ['2001', '2002', '2003', '2004']`,
and `object bytes` a positive integer (the measurements.csv size).

- [ ] **Step 8: Verify through the 21051 gateway**

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:21051/api/v1/datasets
curl -s http://localhost:21051/api/v1/openapi.json | python3 -c 'import json,sys; ops={o.get("operationId") for p in json.load(sys.stdin)["paths"].values() for o in p.values() if isinstance(o, dict)}; print(sorted(o for o in ops if o and ("ataset" in o or "pload" in o)))'
curl -s http://localhost:21051/api/v1/health/ready
```

Expected: `401` (no token → `UNAUTHENTICATED`), the 13 catalog operationIds listed, and readiness `{"status": "ok", ...}`.
When M01 (identity) is merged, repeat the search with a real token for `a.researcher@inst-a.local` / `nais` from the
Keycloak realm (`/auth/realms/nais/protocol/openid-connect/token`, using the direct-grant client M01 configures) and
expect the same dataset sets as Step 7; before M01 is merged, authenticated calls return
`503 DEPENDENCY_UNAVAILABLE` ("Identity module is not installed."), which is expected.

---
## Spec coverage map (M03 §12 acceptance tests)

| AT | Where |
|---|---|
| 01–04 | Task 6 `test_datasets_api.py` |
| 05 | Task 9 (session shape), Task 11 `test_s3_e2e.py::test_at05_*` |
| 06 | Task 9 (session shape), Task 11 `test_s3_e2e.py::test_at06_*` |
| 07 | Task 11 memory variant + `test_s3_e2e.py::test_at07_*` |
| 08, 10 | Task 9 `test_upload_sessions_api.py` |
| 09 | Task 10 `test_verification.py::test_at09_*` |
| 11, 14 | Task 12 `test_publish.py` |
| 12 | Task 2 (DB trigger), Task 9 + Task 12 (API) |
| 13 | Task 8, Task 12 |
| 15, 17 | Task 6 (GET), Task 8 (draft GET), Task 14 (search) |
| 16, 24 | Task 14 (`test_at24` also at index level in Task 4; nori opt-in) |
| 18 | Task 16 `test_routes_contract.py` |
| 19 | Task 15 `test_handlers.py::test_at19_*` |
| 20 | Task 14 `test_at20_*` (opt-in `NAIS_PERF=1`) |
| 21 | Task 7 (grant rows are M04's; catalog only proves it emits the event and touches no grant data) |
| 22 | Task 17 `test_jobs.py::test_at22_*` |
| 23 | Task 16 `test_public_ports.py::test_at23_*` |

## Contract/shared changes needed (not planned here; for Agent 0 / the controller)

1. `NAIS_PRD/contracts/openapi.yaml` — `UploadSession.files[].upload` must not be `required` (the same contract says
   presigned URLs are omitted once a session is COMPLETED/EXPIRED). Tests bridge this with
   `support_upload.assert_upload_session_matches` until it lands.
2. `openapi.yaml` — error responses the catalog returns but the contract does not declare (tests use `assert_error`
   for them): `401` on every catalog operation; `searchDatasets` 422/503; `updateDataset` 404/409;
   `listDatasetVersions` 404; `createDatasetVersion` 404; `createUploadSession` 404/503; `completeUploadSession`
   403/404/503; `deleteDraftFile` 503; `publishDatasetVersion` 404.
3. `docker-compose.yml` — the `opensearch` service should build `infra/opensearch` (analysis-nori) instead of the stock
   `opensearchproject/opensearch:2.19.1`. Until then the catalog creates `nais-datasets-v1` with the fallback analyzer
   automatically (an existing fallback index needs `python -m api.modules.catalog.reindex` after the switch).
4. `.env.example` — optional catalog keys (code defaults are identical): `UPLOAD_URL_TTL_SECONDS=3600`,
   `UPLOAD_SESSION_TTL_SECONDS=3600`, `CATALOG_SYNC_VERIFY_MAX_BYTES=268435456`, `CATALOG_INDEX_ALIAS=nais-datasets`,
   `MALWARE_SCANNER=noop`.
5. Cross-module integration: M04 must use the Protocol classes from `api.modules.catalog.public`/`.ports` as
   `api.platform.ports` keys; M01 must export `IdentityQueryPort` from `api.modules.identity.public`; M05's
   `tests/fixtures/readiness/generate.py` and `catalog/seed_files.py` must produce byte-identical files (codebook
   header and README wording are catalog guesses) for the 10_SEED_DATA §7 golden readiness check.
6. `pyproject.toml` `[tool.mypy] files` covers only the platform; add `apps/api/modules` so CI type-checks modules.
