"""Recipe runs (spec §5.3; openapi startRun/listRuns/getRun). The work itself is jobs.run_recipe.

startRun (writer; archived -> 409 PROJECT_ARCHIVED) pins the recipe's current version and every input's current
dataset version (titles/labels snapshotted for lineage) in a QUEUED run, sent to the `workspace` queue after commit.
Refused when: a run of the recipe is QUEUED/RUNNING or an input version is no longer published
(409 RUN_NOT_ALLOWED), the caller's access to an input lapsed (409 INPUT_ACCESS_LAPSED, details.input_ids), the
recipe uses a removed input (422 RECIPE_INVALID). Reads: ACTIVE project members (else 404), newest first.
"""

from collections.abc import Sequence
from uuid import UUID

from sqlalchemy.engine import RowMapping
from sqlalchemy.orm import Session

from api.modules.workspace import jobs, repo
from api.modules.workspace.access import require_reader, require_writer
from api.modules.workspace.deps import WorkspaceDeps
from api.modules.workspace.errors import not_found
from api.modules.workspace.paging import keyset_page, sort_key
from api.modules.workspace.schemas import Run
from api.modules.workspace.service.recipes import require_live_access, resolve_inputs
from api.platform import clock
from api.platform.auth import CurrentUser
from api.platform.errors import ApiError
from api.platform.generated.error_codes import ErrorCode
from api.platform.ids import new_id
from api.platform.pagination import Page, PageParams

QUEUED = "QUEUED"


def view(row: RowMapping) -> Run:
    return Run.model_validate(
        {
            k: row[k]
            for k in (
                "run_id",
                "project_id",
                "recipe_id",
                "recipe_version",
                "status",
                "started_by",
                "queued_at",
                "started_at",
                "finished_at",
                "input_rows",
                "output_rows",
                "error",
                "output_id",
            )
        }
    )


def start_run(
    session: Session, deps: WorkspaceDeps, user: CurrentUser, project_id: UUID, recipe_id: UUID
) -> Run:
    require_writer(deps, project_id, user)
    recipe = repo.load_recipe(session, project_id, recipe_id, for_update=True)  # serializes concurrent starts
    if recipe is None:
        raise not_found("Recipe")
    if repo.active_run(session, recipe_id) is not None:
        raise ApiError(ErrorCode.RUN_NOT_ALLOWED, "A run of this recipe is already queued or running.")
    inputs = resolve_inputs(session, deps, project_id, list(recipe["input_ids"]))
    require_live_access(deps, user, inputs)
    unpublished = [str(i.input_id) for i in inputs if i.version is None or i.version.status != "PUBLISHED"]
    if unpublished:
        raise ApiError(
            ErrorCode.RUN_NOT_ALLOWED,
            "An input's pinned dataset version is no longer published; pin another version first.",
            {"input_ids": unpublished},
        )
    run_id = new_id()
    row = repo.insert_run(
        session,
        {
            "run_id": run_id,
            "project_id": project_id,
            "recipe_id": recipe_id,
            "recipe_version": recipe["version"],
            "status": QUEUED,
            "started_by": user.user_id,
            "started_by_organization_id": user.organization_id,
            "queued_at": clock.now(),
        },
        [
            {
                "input_id": i.input_id,
                "dataset_id": i.row["dataset_id"],
                "dataset_version_id": i.row["dataset_version_id"],
                "dataset_title": i.policy.title if i.policy else "",
                "version_label": i.version.version_label if i.version else "",
            }
            for i in inputs
        ],
    )
    jobs.enqueue_after_commit(session, run_id)
    return view(row)


def list_runs(
    session: Session,
    deps: WorkspaceDeps,
    user: CurrentUser,
    project_id: UUID,
    *,
    recipe_id: UUID | None,
    statuses: Sequence[str] | None,
    params: PageParams,
) -> Page[Run]:
    after = sort_key(params)
    require_reader(deps, project_id, user)
    rows = repo.list_runs(
        session, project_id, recipe_id=recipe_id, statuses=statuses, after=after, limit=params.limit + 1
    )
    return keyset_page(rows, params.limit, ("queued_at", "run_id"), lambda shown: [view(r) for r in shown])


def get_run(session: Session, deps: WorkspaceDeps, user: CurrentUser, project_id: UUID, run_id: UUID) -> Run:
    require_reader(deps, project_id, user)
    row = repo.load_run(session, project_id, run_id)
    if row is None:
        raise not_found("Run")
    return view(row)
