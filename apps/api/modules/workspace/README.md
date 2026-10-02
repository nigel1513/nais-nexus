# M13 Project Workspace & Data Hub (`api.modules.workspace`)

Spec: `docs/superpowers/specs/2026-10-02-data-hub-workspace-notes-design.md` §4–5. Contract 1.6.0 (openapi tag
`workspace`). Schema `workspace`, migrations in `migrations/` (revision ids `workspace_NNNN`).

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

## Layout
`routes/` (thin HTTP) → `service/` (rules, events) → `repo.py` (SQL Core on `tables.py`). `access.py` holds the
membership and dataset-access rules shared by every workspace feature. `schemas.py`: responses are the generated
contract models; request bodies mirror them with the null/minProperties rules.

## Ports
- Consumed (`deps.WorkspaceDeps`, registered by `wiring.install`): `ProjectQueryPort` and `CatalogQueryPort` are
  resolved per call (503 `DEPENDENCY_UNAVAILABLE` when unwired); `grants: GrantQueryPort` and
  `people: DisplayNameLookup` are consumer-side Protocols in `interfaces.py`.
- **No governance backend yet:** `grants` defaults to `adapters.grants.NoGrants` (always False, fail closed).
  When M04 ships, replace it in `wiring.build_default_deps()` with an adapter over M04's public port.
- Provided: `public.WorkspaceQueryPort.list_pinned_inputs(project_id)` (leaf module; `public_impl.py`).

## Tests
`uv run pytest apps/api/modules/workspace -q`. Fakes for every consumed port live in `tests/fakes.py`;
`tests/test_routes_contract.py::EXPECTED` lists the operationIds implemented so far — extend it with each task.
