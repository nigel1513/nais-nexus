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
`opensearch` service builds `infra/opensearch/Dockerfile` (nori); an index created earlier with the fallback
analyzer is rebuilt with `python -m api.modules.catalog.reindex`.

## Integration notes
- **M04 Governance:** use `api.platform.ports.get(CatalogQueryPort)` and `ports.get(StoragePort)` with the Protocol
  classes imported from `api.modules.catalog.public` (or its alias `api.modules.catalog.ports`); a Protocol defined in
  your own module is a different registry key. `presign_get` raises `CatalogNotFound` (a `ValueError`) for unknown
  versions and for file ids that are not VERIFIED files of that version.
- **M05 Readiness:** `CatalogQueryPort.get_version()` gives `VersionView.metadata_snapshot` (frozen at publish; evaluate
  it, not the live dataset) and `files` in path order; read bytes with `ports.get(CatalogReadPort).open_stream(file_ref,
  byte_range)`; it raises `api.modules.catalog.public.ObjectMissing` (404) or `StorageUnavailable` (retryable).
  Seed files come from `seed_files.py` (09 §5 formulas); M05's `tests/fixtures/readiness/generate.py` imports
  `seed_files.fixture_files`, so both are byte-identical (W1-D5).
- **M01 Identity:** the catalog calls `IdentityQueryPort.get_organization_summary` imported from
  `api.modules.identity.public`; installed but unwired → 503 `DEPENDENCY_UNAVAILABLE`; without the identity package it
  uses `FakeIdentityPort` (seed organizations).
- The ports registry cannot restrict which module reads `StoragePort`/`CatalogReadPort`; only M04/M05 may use them.

## Visibility (ruling M03-R3)
Search returns ACTIVE datasets only. A direct `GET /datasets/{id}` of a WITHDRAWN dataset succeeds only for the owner
organization and platform admins; everyone else gets 404 (never 403, so existence is not disclosed). Datasets the caller
cannot see by access level and organization are 404 as well.

## Public port trust rules
- `CatalogReadPort.open_stream` re-verifies the `FileRef` against the catalog (version, path, size, sha256, VERIFIED)
  before streaming; a forged or stale ref is rejected.
- `StoragePort.presign_get` only signs for files of PUBLISHED versions in status VERIFIED.

## Known limitations (P0)
Archive (zip) checks are header-only and archives are never extracted (ruling M03-R4); nested archives are therefore not
inspected. Malware scan is a no-op; the server re-hashes every file; facet counts are not disjunctive; `total` is capped
at 10,000; organization renames need `reindex`.
