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
| `public.py`, `query.py` | leaf `ReadinessQueryPort` for other modules (D-038) and its implementation |
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
  change: bump the version, then run `cd apps && uv run python -m api.modules.readiness.selfcheck --record` (or with `PYTHONPATH=apps`) and
  commit. `--record` refuses to replace a changed hash when neither `VALIDATOR_VERSION` nor the profile version
  differs from the expected file, and it records both versions. `test_profiles.py` pins each profile YAML's content
  hash per version.

## Run outcomes
`run_status=FAILED` means "could not validate" (storage down after 3 attempts, `FILE_NOT_FOUND`, `FILE_TIMEOUT`,
`FILE_TOO_LARGE`, `RUN_TIMEOUT`, `STALE_JOB`, `INTERNAL_ERROR`, `VERSION_NOT_FOUND`); it is never reused and a steward
may re-run. A check `FAIL` means the data does not meet the rule; the run is `COMPLETED`.
`FILE_TOO_LARGE` is not in the M05 §5 reason list: it is a free-text reason (`error` starts with `FILE_TOO_LARGE:`)
used when a single file exceeds the parser's size limit. `overall_status` is null on FAILED runs.

## Rule clarifications beyond 09 (reviewed rulings)
- **`schema.presence` extras (M05-R12)**: besides 09 §3.2, a `_schema.json` whose resource has a duplicate header
  column is `FAIL`, and a `_schema.json` resource `path` that is not a file of the version is `FAIL`
  (evidence `unknown_resource_paths`). Both only make malformed schemas stricter.
- **Exact-fraction thresholds**: ratio thresholds (datatype, malformed rows, missing values, unit missing,
  mapping) compare integer/`Fraction` values, never the rounded evidence ratios. Evidence ratios are rounded to
  6 places for display only, so e.g. 1000/99999 invalid values is `FAIL` against 0.01 even though it prints as 0.01.
- **`missing_unit_ratio`**: `semantics.units_codebook` evidence carries this extra key (the exact-fraction input of the
  `unit_missing_fail_ratio` check); not listed in 09 §3.5.
- **UCUM is stricter than the spec** (case-sensitive syntax check against a bundled subset, 09 §3.5): whitespace
  anywhere in a unit, even inside `{annotations}`, is rejected; units longer than 256 characters or nested deeper
  than 16 parentheses levels are `SYNTAX_ERROR`; only metric atoms take a prefix. No unit conversion is performed.
- **Evidence** never carries cell values (D-018); oversize evidence is bounded by reducing the largest list and
  setting `truncated: true`.

## Operations
- **Redelivery after a hard crash**: the job claims the row `QUEUED -> RUNNING`; a redelivered message for a row that
  is already `RUNNING` does nothing. If the worker process dies mid-run the row stays `RUNNING` until the stale
  sweeper marks it `FAILED(STALE_JOB)` (run timeout + 10 min); a steward then re-runs. Same when the database is
  unreachable through all 3 in-process tries.
- **Broker outage after commit**: the Dramatiq message is enqueued after the DB commit (outbox-safe). If Redis is
  down at that moment the API still answers 202 and the row stays `QUEUED` until the sweeper marks it
  `FAILED(STALE_JOB)` after 1 h.
- **Worker threads**: `python -m api.worker` starts two Dramatiq workers: a dedicated one that consumes only the
  `readiness` queue (and its delay queue) with `READINESS_WORKER_CONCURRENCY` threads (default 2), and the general
  worker for every other queue with `WORKER_THREADS`. The module declares this via
  `ModuleSpec.dedicated_queues`. Readiness runs therefore never occupy the shared threads, and the actor's
  `time_limit` measures actual run time only (no semaphore wait).
- **Concurrent requests** race on `uq_validation_inflight` / `uq_validation_reuse`; the service re-decides up to 3
  times and then answers a generic `503 DEPENDENCY_UNAVAILABLE`.
- **Performance (M05-AT-15)**: `READINESS_PERF=1 uv run pytest apps/api/modules/readiness/tests/test_perf.py`
  writes a 1 GiB csv to tmp and checks the run finishes with `truncated=true`, 100000 sampled rows.

## Known limitations
- Parquet: memory is bounded per row group (not per allocation); a file with a huge row group can use a lot of RAM.
- A single large file competes with the per-file deadline (`READINESS_FILE_TIMEOUT_SECONDS`, 600 s): at the measured
  ~17 MB/s a file above roughly 10 GB fails with `FILE_TIMEOUT`.
- `RangeReader` fetches at most 1 MiB per storage round trip (`max_read`); raising it is a tuning option but trades
  memory per read, so it was left unchanged.
- A version withdrawn while a run is in flight fails that run with `VERSION_NOT_FOUND`; reading results of a
  WITHDRAWN version needs owner-org DATA_STEWARD / ORG_ADMIN or PLATFORM_ADMIN (same as M03), others get 404.

## Integration notes
- **M03**: readiness looks up `CatalogQueryPort` and `CatalogReadPort` from `api.modules.catalog.public` (D-038; M03's
  wiring provides them in api and worker). `open_stream` raises the public `ObjectMissing` on 404 and
  `StorageUnavailable` on connection errors (its message is never echoed to clients). Fixture `files/**` bytes come
  from `api.modules.catalog.seed_files` (W1-D5). `readiness_overall` = latest COMPLETED `TABULAR_ML_BASIC`, else
  `GENERIC_BASIC` (D-028); FAILED runs never count.
- **M09**: `readiness.validation.completed.v1` -> audit `READINESS_VALIDATION_COMPLETED`; actor is `USER` for manual runs
  (requester id + org), `SYSTEM` for auto runs; `correlation_id` is the request trace or the publish event's.
- **M10**: show `checks[]` in profile order with `status`, `severity`, `message`; render `evidence` as key/value
  tables (counts, ratios, paths, field names, declared units, row numbers only - never cell values, D-018).
- Wave 2 carry: the package `__init__` imports `jobs` (actor declared at import, D-036), so a Python consumer of
  `ReadinessQueryPort` pulls the actor in; consider lazy declaration when M04/M06 consume it.
- Env (07 §5; listed in `.env.example` by the M00 kickoff): `READINESS_RUN_TIMEOUT_SECONDS=1800`,
  `READINESS_FILE_TIMEOUT_SECONDS=600`, `READINESS_WORKER_CONCURRENCY=2`.
