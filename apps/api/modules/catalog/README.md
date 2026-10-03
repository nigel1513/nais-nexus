# catalog (M03 Data Catalog & Versioning)

Spec: `NAIS_PRD/modules/M03_data_catalog.md`. Schema `catalog`, migrations in `migrations/`.

## HTTP (openapi operationIds)
searchDatasets, createDataset, getDataset, updateDataset, getDatasetPolicy, listDatasetVersions,
createDatasetVersion, getDatasetVersion, createUploadSession, getUploadSession, completeUploadSession,
deleteDraftFile, publishDatasetVersion, getFileProfile, getFilePreview, updateDatasetVersion, discardDatasetVersion,
rebaseDatasetVersion, compareDatasetVersions, getFileHistory, getDatasetCitation. No endpoint returns a download URL,
bucket or storage key.

## Upload flow
1. `POST /dataset-versions/{id}/upload-session` → per file either `PUT` (sign `Content-Type` and
   `x-amz-checksum-sha256`; send both headers exactly as returned) or `MULTIPART` (64 MiB parts, one URL each).
   Each upload session writes to its own keys, `datasets/{dataset_id}/{version_id}/{upload_session_id}/{path}`
   (D-039), and presigned URLs never outlive the session (`ttl = min(UPLOAD_URL_TTL_SECONDS, seconds to expires_at)`;
   an expired session shows `status: EXPIRED` and no URLs). A re-used FAILED/expired path gets the new session's key;
   the old object is removed after commit. Seed rows created earlier keep their stored keys (the key is stored per row).
   Shared objects (spec §3.3b): a draft row inherited from a published version shares that version's object. Such a
   row is replaceable (re-uploading its path re-points it to the new session's key, no CONFLICT) and deletable; in
   both cases `versioning/refs.release_objects` takes a per-object advisory lock and schedules the after-commit delete
   only when no row references the object any more, so a published object is never removed. If the replacing upload
   fails or expires, the row stays FAILED and the inherited link does not come back (delete the row instead).
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
- **The api/worker container runs as root:** `apps/api/Dockerfile` has no `USER` directive, so the preview child
  inherits uid 0 inside the container. Mitigations: the worker is non-dumpable (`PR_SET_DUMPABLE 0`), compose does
  not add `SYS_PTRACE` (default capabilities only, so the child cannot ptrace the worker), the child has RLIMITs and
  an environment without secrets, and the container has its own PID namespace.
- Residual risk (accepted): the child runs as the worker's uid (root in the container) with the network available. The worker marks itself
  non-dumpable (`PR_SET_DUMPABLE 0`) so the child cannot read its `/proc/<pid>/environ` or memory, but the child
  could still read any file that uid can read (e.g. a mounted `.env`) and open network connections. Only a code-
  execution bug in pyarrow/CPython parsing would expose that; a separate uid, seccomp or a network namespace would
  close it. In compose the api runs in its own container (separate PID namespace), so only worker processes are
  visible to the child.

## Research metadata (Wave 1.5 stage 1)
- Dataset fields (catalog_0002): `subtitle`, subject/material/method vocabulary codes, `method_detail`, `temporal_start`/
  `temporal_end`, collecting organization (registered id or free text), project title/code, funding agency,
  `update_frequency`, `related_publications`, `contact_email_public`.
- People block: principal investigator and data steward contact are registered users stored with the organization they
  belonged to at the time (at-the-time affiliation); later moves of the user do not rewrite the dataset.
  `steward_contact_absent` is reported when the steward contact is not set or no longer resolvable.
- Vocabulary is seeded by the migration; IRIs stay NULL until curated. Fallbacks are applied at publish time, to NEW
  snapshots only (existing snapshots are frozen and never rewritten): `domain` falls back to the first subject code,
  and `contact_email` falls back to the data steward contact's email only when `contact_email_public` is true and the
  steward is still an ACTIVE owner-organization member (Ruling P23); otherwise it stays empty.
- **Known gap (no contract event):** `createVocabularyTerm` writes no outbox/audit event. Contract 1.3.0 has no
  vocabulary event type (only `catalog.dataset.*`), and the contract is not edited in this wave, so term creation is
  not audited beyond the request log. Add an event type in a later contract revision.
- JSON-LD: `GET /datasets/{id}/metadata.jsonld` (`application/ld+json`). Search v2 adds subject/material/method/PI/period
  filters and facets; the period filter uses overlap semantics (a dataset matches when its range intersects the query).
- **Deploy order:** run `python -m api.modules.catalog.reindex` once, so the index `nais-datasets-v3` is built BEFORE the
  new api/worker drain the index queue (the v1 index has a strict mapping without the new fields).
- Seeding: `seed_data.RESEARCH` fills the five seed datasets; `seed` also backfills seed rows that have no principal
  investigator (only those) and calls `backfill_previews`, which queues `file_previews` rows for tabular files of
  PUBLISHED versions that have none (versions published before catalog_0003). Both are idempotent.
- Accepted races/limits: a steward transfer racing a dataset update is last-writer-wins (not serialized); the free-text
  collecting organization is not a facet (only the registered organization is).
- Preview sandbox residual risks (see above): the child shares the worker's uid, so it can read any file that uid can
  read, and the network is not isolated. NUL characters in cells and names are replaced by U+FFFD before storage
  (JSONB cannot hold them).

## Search
Index `nais-datasets-v3` behind alias `nais-datasets` (`infra/opensearch`). Without the `analysis-nori`
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
- `CatalogPublishPort` (M13 hub publication, `service/from_output.py`): `create_dataset_from_output` creates the dataset
  (provenance = lineage note) and DRAFT v1, copies the output objects server-side (`ObjectStore.copy`, same bucket)
  into the normal upload layout under a COMPLETED server-side session, verifies like `completeUploadSession` and
  publishes v1 with `finalize_publish` once every file is VERIFIED. Idempotent on `dataset_id` (resume by calling
  again); `CatalogPublishRejected` is permanent, `StorageUnavailable` retryable. `output_file_problems` applies the
  upload path/type/size rules.
- The ports registry cannot restrict which module reads `StoragePort`/`CatalogReadPort`; only M04/M05 (and M13 workspace,
  `CatalogReadPort` only, after its own dataset-access check) may use them.

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

## Versioning (lakeFS-style, Wave 1.5 Stage 2; D-041)
Code: `versioning/` (pure rules and the shared-object helpers), `service/versions.py`, `publish.py`, `rebase.py`,
`diff.py`, `history.py`. Binding protocol for shared objects: `versioning/refs.py` and the rules (a)-(g) it implements.

**Lineage columns** (`dataset_versions`, catalog_0004):
- `base_version_id`: the latest PUBLISHED version when the draft was created (or last rebased). NULL only for a
  draft created while nothing was published.
- `source_version_id`: the version whose files the draft started from. It is the latest version by default, an
  older PUBLISHED version for a revert, and NULL for an empty draft.
- `previous_version_id`: set at publish to the version that was the latest just before. The default "compare with
  the previous version" uses it.
- Backfill (catalog_0004 upgrade): versions published earlier get `previous_version_id` per dataset in
  `published_at` order (tie: id; WITHDRAWN versions keep their place). The immutability trigger is disabled for that
  one statement inside the migration transaction. A DRAFT without a base gets the latest PUBLISHED version published
  at or before its `created_at`; if there is none, the base stays NULL, and the draft is stale once anything is
  published.
- `dataset_files.inherited_from_file_id`: an inherited row points at the same stored object as a PUBLISHED row
  of the same dataset. It has no upload session (`upload_session_id` is nullable since catalog_0004).

**Zero-copy reference rule.** Several file rows may share one object. An object is deleted only after commit, and
only when no row references it any more (`release_objects`). Why this is enough:
- Rows are only ever *copied* from PUBLISHED versions of the same dataset (`require_inheritable`).
- Those rows can never be deleted (`files_immutable` / `versions_immutable` triggers). So an object shared with a
  published row always keeps a reference: the published row is the anchor.
- A per-object advisory lock serializes two transactions that remove the last two references at the same time. The
  second one waits for the first to commit, and its reference check (a new statement under READ COMMITTED, which is
  asserted) then sees the first one's delete.
- Draft-owned rows are never copied into another draft. A draft changes a path by re-pointing its own row in place
  (UPDATE, same `file_id`). Its preview rows are dropped first, and `release_objects` runs once, last.

**Publishing and rebase.**
- Publish needs a change note (3-2000 characters) and a current base. If `base_version_id` is not the latest
  PUBLISHED version, publish returns 409 `DATASET_VERSION_STALE_BASE` with both ids. A NULL base is stale as soon as
  anything is published.
- `rebaseDatasetVersion` compares, per path and by sha256, the base, the draft ("mine") and the latest version
  ("theirs"):
  - A path only one side changed takes that side.
  - The same change on both sides (including both deleting) is kept.
  - Different changes are conflicts: a change against a delete, or two different additions (also against a NULL
    base). A conflict returns 409 `CONFLICT` with `details.conflicts` (`path`, and `base`/`mine`/`theirs` as
    `{sha256, size_bytes}` or null) and `latest_version_id`, and nothing changes.
  - The caller answers with `resolutions` (path -> MINE | THEIRS, conflicting paths only, at most 10,000). Any other
    path is 422 `UNKNOWN_PATH`; at most 100 paths are echoed, with `paths_total` when the list is cut.
  - THEIRS re-points the draft's row at the latest row's object, removes it, or adds an inherited row.
  - The rebase is a no-op when the draft is already current. It is refused (409) while an upload session is open.
  - Lock order is version -> dataset, as publish, so a concurrent publish of another draft is either seen or waits.

**Revert.** `createDatasetVersion {from_version_id}` makes a new draft holding an older PUBLISHED version's files
(`source_version_id`), based on the latest version (`base_version_id`). Publishing it makes the old content the
newest version; history is never rewritten.

**Comparison** (`compareDatasetVersions`, `change_summary`) has three layers:
1. **Files:** ADDED / REMOVED / CHANGED / UNCHANGED by sha256.
2. **Schema:** for CHANGED tabular files. It reads the Data Explorer column profiles (name, type, unit, missing
   ratio only). Following D-018 it never reads raw values, min/max or top values, and it does not use M05 results.
3. **Metadata:** the frozen `metadata_snapshot`, or the live snapshot for a draft.

`change_summary` is null when the default comparison target is invisible to the caller (Ruling S10).

**File history** (`getFileHistory`) gives one path across the PUBLISHED versions the caller can see (WITHDRAWN only
for owner stewards/admins and platform admins), oldest first. Each entry is ADDED / CHANGED / UNCHANGED / REMOVED /
ABSENT by sha256, so an inherited span reads UNCHANGED. It runs two queries.

**Citations** (`getDatasetCitation`, `style` = `text` | `bibtex` | `datacite-json`) are for PUBLISHED or WITHDRAWN
versions. A DRAFT is 409 `DATASET_VERSION_NOT_PUBLISHED`; a version the caller cannot see is 404.
- Each citation is pinned to the version label and the version IRI `{NAIS_PUBLIC_BASE_URL}/id/dataset-version/{id}`.
- Creators come from the frozen snapshot: the PI, then co-investigators, de-duplicated, with the affiliation at
  publication time and no emails. A snapshot without people falls back to the owner institute.
- The year is the Asia/Seoul calendar year of `published_at`.
- BibTeX escapes `\ { } & % $ # _ ~ ^` and braces names containing " and " and organization names.
- DataCite 4.5 JSON (compact, sorted keys) uses nameType Personal for people and Organizational for the institute.

**Known limits.**
- The schema layer needs READY previews on both sides. A draft's newly uploaded files have none until publish, so
  they show `PROFILE_MISSING`.
- There are no intermediate commits inside a draft, and no draft-to-draft merge: rebase only onto the latest
  PUBLISHED version.
- No DOI registration: citations carry the URL identifier only, and a DOI only when the dataset row has one.
- The DataCite `nameIdentifierScheme` "NTIS" (national researcher number) is not a registered DataCite scheme.
- File history is capped at the newest 1,000 visible versions, with no truncation flag in the response.
- If every version of a dataset has been withdrawn, there is no latest PUBLISHED version. A rebase then treats
  "theirs" as empty: unchanged inherited files are dropped from the draft (the latest version "removed" them).

## Known limitations (P0)
Archive (zip) checks are header-only and archives are never extracted (ruling M03-R4); nested archives are therefore not
inspected. Malware scan is a no-op; the server re-hashes every file; facet counts are not disjunctive; `total` is capped
at 10,000; organization renames need `reindex`.
- Zip checks read only the central directory (header-only, see above); nothing is decompressed.
- Withdrawing a version through operator SQL does not enqueue an index update; run `reindex` afterwards.
- Synchronous verification (sessions ≤ 256 MiB) holds the upload-session and version locks while hashing.
- PUBLISHED versions reject every update, including `updated_at`-only ones (stricter than spec §4.2).
