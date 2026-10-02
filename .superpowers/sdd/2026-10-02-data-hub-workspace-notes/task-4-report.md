# Task 4 report: workspace discussions + Data-Hub overview/projects/activity

Status: DONE_WITH_CONCERNS (minor, listed at the end)

## What was built
### Discussions (tag `workspace`)
Operations: `listThreads`, `createThread`, `updateThread`, `listComments`, `addComment`.
Files: `routes/threads.py` and `service/threads.py`.

Who can do what:
- **PROJECT / OUTPUT / RECIPE threads**
  - Read: an ACTIVE project member, in any project status. Anyone else gets 404.
  - Write (create a thread, add a comment): a member of an ACTIVE project. VIEWERs may discuss.
  - An archived project's threads are read-only and writes get **403 FORBIDDEN**. The contract lists no 409 for these operations, so PROJECT_ARCHIVED was not used.
  - OUTPUT and RECIPE targets resolve to their project through `service.threads.TARGET_PROJECT` (scope → resolver). Only PROJECT is registered for now. Tasks 5 and 6 must register OUTPUT and RECIPE; until then those scopes return 404.
- **DATASET threads**
  - Anyone who can see the dataset (catalog `is_visible`) can read and write, from any organization. Anyone else gets 404.
  - `project_id` is null on these threads.
- **updateThread**: the author, a PROJECT_OWNER/PROJECT_ADMIN for project threads, or a DATA_STEWARD of the dataset's owner organization for dataset threads. Anyone else gets 403.

Validation:
- Markdown body: 1 to 10,000 characters (pydantic). A longer body returns **422 VALIDATION_FAILED**. The DB also enforces it with check `ck_comments_body_length`.
- Title: 1 to 200 characters. `ThreadUpdate` must not be empty (minProperties 1), must not contain nulls, and allows no extra fields.
- `listThreads` needs either `scope` + `target_id` or `project_id`. Any other combination returns 422.

Paging and ordering:
- Threads: newest activity first, by keyset on (last_comment_at, thread_id).
- Comments: oldest first.
- An invalid cursor returns 422 INVALID_CURSOR.
- The keyset helper is in `paging.py`. `build_page` can't be used here because the generated `Id`/`Timestamp` RootModels don't support `.isoformat()`.

Events:
- Every comment, including a thread's first one, emits `workspace.comment.added.v1`. Payloads are checked against the schema in tests.
- `project_id` is null only when `scope == DATASET`.
- `owner_organization_id` is the dataset owner for DATASET threads and null otherwise.

### Data-Hub (tag `hub`)
Operations: `getHubOverview`, `listDatasetProjects`, `listDatasetActivity`.
Files: `routes/hub.py` and `service/hub.py`.

**getHubOverview**
- Makes **one** batched catalog call, `list_visible_dataset_summaries(ctx)`, and keeps only ACTIVE datasets.
- Rails, at most 6 cards each:
  - trending: access requests in the last 7 days, highest first. Datasets with 0 requests are left out.
  - recent: newest published version first. `metric` is null.
  - most_used: number of live project inputs. Datasets with 0 inputs are left out.
- Organization rows: dataset_count, public_count, controlled_count (CONTROLLED + SENSITIVE), and last_updated_at (the newest dataset `updated_at`). Sorted by dataset_count, highest first.

**listDatasetProjects**
- Needs a visible dataset, else 404.
- Live inputs of the dataset are split into:
  - projects the caller is an ACTIVE member of: name, lead_organization_name and input_added_at, newest first;
  - everything else: only counted in `hidden_count`.

**listDatasetActivity**
- Needs a visible dataset, else 404. Paged, newest first.
- Reads the `dataset_activity` table that the handlers fill.
- For rows linked to a project the caller is not a member of, `project_id`, `ref_id`, the project-name label and the actor name are all hidden.

### Event handlers (`handlers.py`, imported from `__init__`)
All handlers are idempotent: `claim_event` against `workspace.processed_events`, plus a unique `source_event_id` on activity rows.

| Event | Activity row written |
|---|---|
| `catalog.dataset.version_published.v1` | VERSION_PUBLISHED, label = version label, ref = version id |
| `catalog.dataset.metadata_changed.v1` | METADATA_CHANGED |
| `catalog.dataset.policy_changed.v1` | POLICY_CHANGED |
| `catalog.dataset.access_level_changed.v1` | POLICY_CHANGED, label = new access level |
| `readiness.validation.completed.v1` | READINESS_COMPLETED, only when the run COMPLETED; label = overall status, ref = version id |
| `workspace.input.added.v1` | USED_IN_PROJECT, ref and project = project id; the project name is read live for members |
| `workspace.comment.added.v1` | DISCUSSION_STARTED, only for a new DATASET thread; label = thread title |
| `governance.access.requested.v1` (exists in EventType) | no activity row; adds a row to `hub_access_requests`, which feeds trending |

### Storage (migration `workspace_0002`, revises `workspace_0001`)
- `threads`, with these checks:
  - scope is one of the allowed values;
  - `(scope='DATASET') = (project_id IS NULL)`;
  - title length;
  - comment_count >= 1.
  - Indexes on target and on project.
- `comments`, with a body length check and an index on thread.
- `dataset_activity`, with a type check, unique source_event_id, and an index on (dataset, occurred_at desc).
- `hub_access_requests`.

### Cross-module changes (all additive)
- **Catalog:**
  - New `DatasetSummary` dataclass and `CatalogQueryPort.list_visible_dataset_summaries(ctx)`.
  - It runs one SQL query (datasets left-joined to their latest PUBLISHED version via DISTINCT ON) and filters with the catalog's own `can_see_dataset`. It then batches readiness_overall (D-028), the Korean SUBJECT labels and the organization names.
  - Test: `test_list_visible_dataset_summaries_uses_d012_in_one_batch`.
  - `audit/fakes.py` and `readiness/fakes.py` got a stub that raises NotImplementedError.
- **Workspace `DisplayNameLookup`:** new `get_organization_names()`. The identity adapter calls `get_organization_summary` once per distinct organization; this is used for project lead organization names, because `ProjectQueryPort.get_summary` returns `lead_organization_name=None`.

## Tests (TDD)
- **Catalog**
  - RED: `uv run pytest apps/api/modules/catalog/tests/test_public_ports.py -k summaries` gave 1 failed (ImportError for DatasetSummary).
  - GREEN: 17 passed.
- **Workspace**
  - RED: `uv run pytest apps/api/modules/workspace -x` errored on the missing `workspace.threads`/`dataset_activity` tables in the test conftest TRUNCATE.
  - GREEN: 60 passed. The first green run surfaced 3 failures (RootModel cursor key, unhashable `Id`), which were then fixed.
  - Coverage of `test_threads.py`, `test_hub.py` and `test_wiring.py` additions:
    - permission boundaries for project, dataset and archived threads;
    - the 10,000 vs 10,001 character limit returns 422;
    - the selector rule returns 422;
    - paging and the resolved filter;
    - moderation rules;
    - the event payload rule for both scopes;
    - the hub visibility filter (INTERNAL, WITHDRAWN and unpublished datasets), with exactly one catalog call;
    - rail maximum of 6;
    - trending: the 7-day window and 0 excluded;
    - handler idempotency on redelivery;
    - most_used counts only live inputs;
    - `hidden_count`;
    - activity masking for foreign projects, and activity paging;
    - DB check constraints;
    - the org-name adapter.
- **Final checks**
  - `uv run pytest tests/contract apps/api/platform apps/api/modules/{workspace,catalog,audit,readiness}`: **1550 passed, 3 skipped**.
  - After the last edits, `workspace` + catalog public ports were re-run: 77 passed.
  - `ruff check` / `ruff format` are clean, and `uv run mypy` reports no issues (211 files).

## Concerns / decisions
1. **Trending:** the backend counts `governance.access.requested.v1`, but there is no governance backend yet, so nothing produces that event and trending stays `[]` in practice. Old `hub_access_requests` rows are never pruned; the read uses a 7-day window. A cleanup can be added later.
2. **Hub counters:** most_used is computed live from `workspace.inputs` and recent from the catalog's `latest_published_at`. There are no denormalized counters, so there is no drift and no backfill for data that existed before workspace. The brief's "hub_counters" table became `hub_access_requests`, which only feeds trending.
3. **Input removal:** `workspace.input.removed.v1` adds no activity row because DatasetActivityType has no removal type. OUTPUT_PUBLISHED is left for the publish task (`workspace.publish.decided.v1`).
4. **Archived projects:** writes to their threads return 403 FORBIDDEN instead of 409 PROJECT_ARCHIVED, to stay within the contract's listed responses.
5. **OUTPUT/RECIPE scopes:** they return 404 until Tasks 5 and 6 register resolvers in `TARGET_PROJECT`.
6. **Overview cost:** `getHubOverview` loads every visible dataset summary per request. That is fine at the current scale; if datasets grow large, add SQL-side ranking and limits.
