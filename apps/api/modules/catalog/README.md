# catalog (M03 Data Catalog & Versioning)

Spec: `NAIS_PRD/modules/M03_data_catalog.md`. Schema `catalog`, migrations in `migrations/`.

## HTTP (openapi operationIds)
searchDatasets, createDataset, getDataset, updateDataset, getDatasetPolicy, listDatasetVersions,
createDatasetVersion, getDatasetVersion, createUploadSession, getUploadSession, completeUploadSession,
deleteDraftFile, publishDatasetVersion, getFileProfile, getFilePreview. No endpoint returns a download URL, bucket or storage key.

## Upload flow
1. `POST /dataset-versions/{id}/upload-session` → per file either `PUT` (sign `Content-Type` and
   `x-amz-checksum-sha256`; send both headers exactly as returned) or `MULTIPART` (64 MiB parts, one URL each).
   Each upload session writes to its own keys, `datasets/{dataset_id}/{version_id}/{upload_session_id}/{path}`
   (D-039), and presigned URLs never outlive the session (`ttl = min(UPLOAD_URL_TTL_SECONDS, seconds to expires_at)`;
   an expired session shows `status: EXPIRED` and no URLs). A re-used FAILED/expired path gets the new session's key;
   the old object is removed after commit. Seed rows created earlier keep their stored keys (the key is stored per row).
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

## Data Explorer previews (Wave 1.5 spec §7)
- Publishing queues one `catalog.file_previews` row per CSV/TSV/parquet file (PENDING). `catalog.preview_dispatch`
  (10 s) leases due rows (at most 2 live leases; 3 attempts, then FAILED/GENERATION_FAILED) and sends
  `catalog.generate_preview` on the dedicated queue `catalog_previews` (1 worker thread, ruling P25).
- `getFileProfile` (metadata only, no raw values) is visible to everyone who can see the version; `getFilePreview`
  (first 100 rows, distributions) needs download permission: PLATFORM_ADMIN, owner-organization member, PUBLIC
  dataset, or an ACTIVE grant via `PreviewGrantLookup` (NoGrants until M04), else 403
  `details.reason = DOWNLOAD_PERMISSION_REQUIRED`.
- Profiling runs in a separate interpreter per file (`previews/sandbox.py`, ruling P24) under RLIMIT_AS
  (`CATALOG_PREVIEW_MEMORY_LIMIT_BYTES`, 1.5 GiB), RLIMIT_CPU, RLIMIT_FSIZE (64 KiB), PR_SET_PDEATHSIG and a wall
  clock (`CATALOG_PREVIEW_TIMEOUT_SECONDS` + 15 s). It reads the object only through byte-range requests the worker
  serves (request and byte budgets), gets an environment without secrets, and its output is re-validated against
  the contract shapes and size ceilings before it is stored.
- Residual risk (accepted): the child runs as the worker's uid with the network available. The worker marks itself
  non-dumpable (`PR_SET_DUMPABLE 0`) so the child cannot read its `/proc/<pid>/environ` or memory, but the child
  could still read any file that uid can read (e.g. a mounted `.env`) and open network connections. Only a code-
  execution bug in pyarrow/CPython parsing would expose that; a separate uid, seccomp or a network namespace would
  close it. In compose the api runs in its own container (separate PID namespace), so only worker processes are
  visible to the child.

## Search
Index `nais-datasets-v2` behind alias `nais-datasets` (`infra/opensearch`). Without the `analysis-nori`
plugin the catalog creates the index with the fallback analyzer (`standard` + `cjk_bigram`). The compose
`opensearch` service builds `infra/opensearch/Dockerfile` (nori); an index created earlier with the fallback
analyzer is rebuilt with `python -m api.modules.catalog.reindex`.
Mapping v2 (Wave 1.5) adds subtitle, subject/material/method codes, data period, collecting organization and PI;
existing deployments must run `reindex` once (new `nais-datasets-v{n}` + alias swap). Period filters are overlap
tests (`temporal_end >= temporal_from` with a missing end = ongoing, `temporal_start <= temporal_to`); datasets
without `temporal_start` never match a period filter.

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
cannot see by access level and organization are 404 as well. Non-owners (other organizations, not platform admins) also
need a published version (`has_published_version`): a dataset with no or only draft versions is 404 for them, and
INTERNAL datasets are never visible outside the owner organization. Platform admin search shows all ACTIVE datasets (D-040).

## Public port trust rules
- `CatalogReadPort.open_stream` checks exactly: the `file_id` exists, its status is VERIFIED, its version is PUBLISHED,
  and `(storage_bucket, storage_key)` equal the stored values. It does not check `path`, `size_bytes` or `sha256` of the
  `FileRef`; a ref with a wrong location is rejected, the bytes always come from the stored location.
- `StoragePort.presign_get` only signs for files of PUBLISHED versions in status VERIFIED.
- M04 must still do these checks itself: `presign_get` does not check that the dataset is WITHDRAWN (M04 step 1 must);
  `CatalogQueryPort.is_visible` returns true for the owner organization and platform admins on WITHDRAWN datasets
  (check `DatasetPolicyView.status`); `get_version` also returns DRAFT versions (check `VersionView.status`).

## Known limitations (P0)
Archive (zip) checks are header-only and archives are never extracted (ruling M03-R4); nested archives are therefore not
inspected. Malware scan is a no-op; the server re-hashes every file; facet counts are not disjunctive; `total` is capped
at 10,000; organization renames need `reindex`.
- Zip checks read only the central directory (header-only, see above); nothing is decompressed.
- Withdrawing a version through operator SQL does not enqueue an index update; run `reindex` afterwards.
- Synchronous verification (sessions ≤ 256 MiB) holds the upload-session and version locks while hashing.
- PUBLISHED versions reject every update, including `updated_at`-only ones (stricter than spec §4.2).
