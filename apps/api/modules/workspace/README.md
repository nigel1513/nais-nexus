# M13 Project Workspace & Data Hub (`api.modules.workspace`)

Spec: `docs/superpowers/specs/2026-10-02-data-hub-workspace-notes-design.md` §4–5. Contract 1.6.0 (openapi tags
`workspace`, `hub`). Schema `workspace`, migrations in `migrations/` (revision ids `workspace_NNNN`).

## What it does (so far)
- Pinned dataset inputs: `GET/POST /projects/{p}/inputs`, `PATCH/DELETE /projects/{p}/inputs/{i}`.
  - Read: ACTIVE project member (any project status), else 404.
  - Write: ACTIVE member other than VIEWER (403 `FORBIDDEN`) of an ACTIVE project (409 `PROJECT_ARCHIVED`).
  - Add: dataset visible to the caller (`CatalogQueryPort.is_visible`, else 404), ACTIVE, version PUBLISHED
    (`DATASET_VERSION_NOT_PUBLISHED`; default = latest published), one live input per dataset (409 `CONFLICT`).
  - Dataset use = PUBLIC, the caller's own organization's dataset, or an ACTIVE grant (`GrantQueryPort`);
    otherwise 403 `ACCESS_REQUIRED` with `details.dataset_id`.
  - `access_lapsed` is the same rule evaluated for the caller at read time; `newer_version_label` is the latest
    PUBLISHED version's label when it is not the pinned one.
  - Version change re-checks access; removal is a soft delete (`removed_at`).
- Events (outbox, same transaction): `workspace.input.added.v1`, `workspace.input.version_changed.v1`,
  `workspace.input.removed.v1`. Note-only edits emit nothing.
- Discussions (`service/threads.py`): `GET/POST /threads`, `PATCH /threads/{t}`, `GET/POST /threads/{t}/comments`.
  - PROJECT/OUTPUT/RECIPE: read = project member (404 otherwise); write = member of an ACTIVE project (archived →
    403 `FORBIDDEN`; the contract has no 409 here). OUTPUT/RECIPE targets resolve to their project through
    `service.threads.TARGET_PROJECT`, which the output/recipe tasks extend (unregistered scope → 404).
  - DATASET: anyone who sees the dataset reads and writes (any organization); `project_id` is null.
  - Update: author, PROJECT_OWNER/PROJECT_ADMIN, or the dataset owner organization's DATA_STEWARD.
  - Markdown body ≤ 10,000 characters (422 `VALIDATION_FAILED`, also a DB check). Each comment, including the
    first one, emits `workspace.comment.added.v1` (`project_id` null iff `scope == DATASET`; `owner_organization_id`
    = dataset owner for DATASET threads, else null).
  - Titles and bodies may not contain NUL characters or be blank (422); input notes may not contain NUL.
- Outputs (`service/outputs.py`): `GET/POST /projects/{p}/outputs`, `GET /projects/{p}/outputs/{o}`,
  `POST .../{o}/complete`, `POST .../{o}/download`.
  - Upload session (writer of an ACTIVE project; archived → 403): files declared with size and sha256, one
    presigned PUT each (15 min, `x-amz-checksum-sha256` signed) to the lead organization's bucket under
    `workspace/{project_id}/outputs/{output_id}/{name}`. Sessions (`status = UPLOADING`) are invisible to readers.
  - Access level: never looser than the strictest live input at session time (PUBLIC < INTERNAL < CONTROLLED <
    SENSITIVE); floor INTERNAL with no inputs; else 422 `VALIDATION_FAILED` (`details.field = access_level`,
    `details.minimum`). Those inputs are snapshotted as the output's lineage.
  - Complete (uploader only, 403 otherwise; expired → 409 `UPLOAD_SESSION_EXPIRED`): HEAD size, then sha256
    streamed through the internal client; any mismatch/missing → 422 `UPLOAD_CHECKSUM_MISMATCH` with
    `details.files[{name, reason}]`. Success sets `status = READY`, `created_at`, emits
    `workspace.output.created.v1`. Repeating it returns the same output without a second event.
  - Download (any member, any project status; non-member 403): every lineage input must still be accessible to the
    caller (409 `INPUT_ACCESS_LAPSED`, `details.input_ids`); presigned GETs live 300 s.
  - OUTPUT threads resolve to the output's project (READY outputs only).
- Data-Hub (`service/hub.py`, tag `hub`): `GET /hub/overview`, `GET /datasets/{d}/projects`,
  `GET /datasets/{d}/activity`.
  - Visibility is the catalog's: one batched `CatalogQueryPort.list_visible_dataset_summaries` for the overview
    (only ACTIVE datasets), `is_visible` (else 404) for the per-dataset reads.
  - Rails (≤ 6 each): trending = `governance.access.requested.v1` count of the last 7 days (> 0 only), recent =
    latest publication, most_used = live project inputs (> 0 only). Organization rows count the visible ACTIVE
    datasets (controlled = CONTROLLED + SENSITIVE).
  - Projects: the caller's projects by name; the rest only in `hidden_count`.
  - Activity: rows of `dataset_activity`, written by `handlers.py` from catalog version/metadata/policy events,
    readiness completions, `workspace.input.added.v1` and new DATASET threads. Project-linked rows show
    `project_id`, `ref_id`, project name and actor only to that project's members.
  - There is no governance backend yet, so nothing produces `governance.access.requested.v1` and trending stays
    empty in the backend until M04 ships (the web mock exercises it).

## Layout
`routes/` (thin HTTP) → `service/` (rules, events) → `repo.py` (SQL Core on `tables.py`). `access.py` holds the
membership and dataset-access rules shared by every workspace feature. `schemas.py`: responses are the generated
contract models; request bodies mirror them with the null/minProperties rules.

## Ports
- Consumed (`deps.WorkspaceDeps`, registered by `wiring.install`): `ProjectQueryPort` and `CatalogQueryPort` are
  resolved per call (503 `DEPENDENCY_UNAVAILABLE` when unwired); `grants: GrantQueryPort` and
  `people: DisplayNameLookup` are consumer-side Protocols in `interfaces.py`; `storage: OutputStorage` defaults to
  `storage.S3OutputStorage` (platform storage clients, `NAIS_PUBLIC_BASE_URL` for presigned URLs).
- **No governance backend yet:** `grants` defaults to `adapters.grants.NoGrants` (always False, fail closed).
  When M04 ships, replace it in `wiring.build_default_deps()` with an adapter over M04's public port.
- Provided: `public.WorkspaceQueryPort.list_pinned_inputs(project_id)` (leaf module; `public_impl.py`).
- Event consumers (`handlers.py`, idempotent through `workspace.processed_events`): see Data-Hub above.

## Tests
`uv run pytest apps/api/modules/workspace -q`. Fakes for every consumed port live in `tests/fakes.py`;
`tests/test_routes_contract.py::EXPECTED` lists the operationIds implemented so far — extend it with each task.
