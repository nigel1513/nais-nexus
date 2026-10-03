"""Recipes (spec §5.3; openapi listRecipes/createRecipe/getRecipe/updateRecipe/deleteRecipe/previewRecipe).

A recipe names project inputs (input_ids; the first is the base table, join steps reference the others) and an
ordered list of steps. Saving validates the steps against the inputs' columns: the schema of the first 10,000 rows
of each input the steps read (base + joined inputs), typed like a preview/run reads them. Any misfit is
422 RECIPE_INVALID with details.step_index (null for an input problem), details.reason, details.column /
details.input_id. Every save is a new version (recipe_versions keeps them all, so runs are reproducible) and emits
workspace.recipe.saved.v1. updateRecipe needs If-Match = current version (409 CONFLICT otherwise).

Access: read = ACTIVE project member (else 404). Create = writer of an ACTIVE project (archived -> 403, the
contract lists no 409); update/delete = writer (archived -> 409 PROJECT_ARCHIVED). Delete is soft and refused while
a run is QUEUED/RUNNING (409 RUN_NOT_ALLOWED).
Preview: any member whose access to every recipe input is live (else 409 INPUT_ACCESS_LAPSED); reads at most
10,000 rows per input, returns the first 100 result rows; 20 s budget (503 DEPENDENCY_UNAVAILABLE when exceeded).
"""

import logging
from collections.abc import Iterator, Sequence
from contextlib import contextmanager
from dataclasses import dataclass
from uuid import UUID

import pyarrow as pa
from sqlalchemy.engine import RowMapping
from sqlalchemy.orm import Session

from api.modules.catalog.public import (
    DatasetPolicyView,
    FileRef,
    ObjectMissing,
    StorageUnavailable,
    VersionView,
)
from api.modules.workspace import repo
from api.modules.workspace.access import (
    has_dataset_access,
    require_open_writer,
    require_reader,
    require_writer,
)
from api.modules.workspace.deps import WorkspaceDeps
from api.modules.workspace.errors import not_found
from api.modules.workspace.recipes import reader, steps
from api.modules.workspace.recipes.model import Step, dump_steps, parse_steps
from api.modules.workspace.schemas import Recipe, RecipePreview, RecipePreviewIn, RecipeWriteIn
from api.platform import clock
from api.platform.auth import CurrentUser
from api.platform.bounded_io import Deadline
from api.platform.errors import ApiError
from api.platform.events import EventActor
from api.platform.generated.error_codes import ErrorCode
from api.platform.generated.event_types import EventType
from api.platform.ids import new_id
from api.platform.outbox import outbox

logger = logging.getLogger("nais.workspace")

PREVIEW_INPUT_ROWS = 10_000
PREVIEW_RESULT_ROWS = 100
PREVIEW_MAX_ROWS = 1_000_000  # intermediate rows a preview may build (joins)
PREVIEW_TIMEOUT_S = 20.0
SAVE_TIMEOUT_S = 20.0


def recipe_invalid(error: steps.StepError) -> ApiError:
    return ApiError(ErrorCode.RECIPE_INVALID, error.message, error.details())


def input_problem(input_id: UUID, reason: str, message: str) -> ApiError:
    return recipe_invalid(steps.StepError(None, reason, message, input_id=input_id))


def _timeout() -> ApiError:
    return ApiError(ErrorCode.DEPENDENCY_UNAVAILABLE, "Reading the inputs took longer than 20 seconds.")


def _storage_down() -> ApiError:
    return ApiError(ErrorCode.DEPENDENCY_UNAVAILABLE, "Input storage is unavailable; try again later.")


# ---------------------------------------------------------------- inputs of a recipe


@dataclass(frozen=True)
class RecipeInput:
    input_id: UUID
    row: RowMapping  # workspace.inputs
    policy: DatasetPolicyView | None
    version: VersionView | None

    @property
    def title(self) -> str:
        return self.policy.title if self.policy else "unknown dataset"


def resolve_inputs(
    session: Session, deps: WorkspaceDeps, project_id: UUID, input_ids: Sequence[UUID]
) -> list[RecipeInput]:
    """The recipe's inputs in order; a removed or foreign input id is 422 RECIPE_INVALID (UNKNOWN_INPUT)."""
    rows = repo.live_inputs_by_id(session, project_id, input_ids)
    catalog = deps.catalog
    resolved: list[RecipeInput] = []
    for input_id in input_ids:
        row = rows.get(input_id)
        if row is None:
            raise input_problem(
                input_id, "UNKNOWN_INPUT", "The recipe uses an input that is not in the project."
            )
        resolved.append(
            RecipeInput(
                input_id,
                row,
                catalog.get_policy_view(row["dataset_id"]),
                catalog.get_version(row["dataset_version_id"]),
            )
        )
    return resolved


def lapsed_inputs(deps: WorkspaceDeps, user: CurrentUser, inputs: Sequence[RecipeInput]) -> list[str]:
    return [
        str(i.input_id) for i in inputs if i.policy is None or not has_dataset_access(deps, user, i.policy)
    ]


def require_live_access(deps: WorkspaceDeps, user: CurrentUser, inputs: Sequence[RecipeInput]) -> None:
    lapsed = lapsed_inputs(deps, user, inputs)
    if lapsed:
        raise ApiError(
            ErrorCode.INPUT_ACCESS_LAPSED,
            "Access to an input of this recipe was revoked or expired.",
            {"input_ids": lapsed},
        )


def table_file(item: RecipeInput) -> FileRef:
    """The input's primary tabular file (422 RECIPE_INVALID when there is none or the version is unusable)."""
    if item.version is None or item.version.status != "PUBLISHED":
        raise input_problem(
            item.input_id, "INPUT_UNAVAILABLE", "The input's pinned version is not published."
        )
    file = reader.primary_file(item.version)
    if file is None:
        raise input_problem(
            item.input_id, "INPUT_NOT_TABULAR", "The input's version has no CSV or Parquet file to read."
        )
    return file


def _schemas(
    deps: WorkspaceDeps, by_id: dict[UUID, RecipeInput], needed: Sequence[UUID], deadline: Deadline
) -> dict[UUID, pa.Schema]:
    found: dict[UUID, pa.Schema] = {}
    for input_id in needed:
        item = by_id[input_id]
        with _read_errors(input_id):
            found[input_id] = reader.SCHEMAS.schema(deps.reader, table_file(item), deadline)
    return found


@contextmanager
def _read_errors(input_id: UUID) -> Iterator[None]:
    """Reader/storage failures of one input -> API errors (no file content in any message)."""
    try:
        yield
    except reader.ReadTimeout as exc:
        raise _timeout() from exc
    except StorageUnavailable as exc:
        raise _storage_down() from exc
    except ObjectMissing as exc:
        raise input_problem(
            input_id, "INPUT_UNAVAILABLE", "The input's file is not available in storage."
        ) from exc
    except reader.InputUnreadable as exc:
        raise input_problem(input_id, "INPUT_UNREADABLE", str(exc)) from exc
    except reader.InputTooLarge as exc:
        raise input_problem(input_id, "INPUT_TOO_LARGE", str(exc)) from exc


def validate(
    session: Session,
    deps: WorkspaceDeps,
    project_id: UUID,
    input_ids: Sequence[UUID],
    recipe_steps: Sequence[Step],
) -> list[RecipeInput]:
    """Inputs exist in the project, joins reference recipe inputs, steps fit the inputs' columns."""
    resolved = resolve_inputs(session, deps, project_id, input_ids)
    for index, step in enumerate(recipe_steps):  # before any storage read
        if step.type == "join" and step.right_input_id not in input_ids:
            raise recipe_invalid(
                steps.StepError(
                    index,
                    "UNKNOWN_INPUT",
                    f"Step {index + 1} (join): the joined input is not one of the recipe's inputs.",
                    input_id=step.right_input_id,
                )
            )
    by_id = {i.input_id: i for i in resolved}
    needed = steps.needed_inputs(recipe_steps, input_ids)
    schemas = _schemas(deps, by_id, needed, reader.deadline_after(SAVE_TIMEOUT_S))
    try:
        steps.plan(recipe_steps, schemas, input_ids)
    except steps.StepError as exc:
        raise recipe_invalid(exc) from exc
    return resolved


# ---------------------------------------------------------------- views


def _view(row: RowMapping) -> Recipe:
    return Recipe.model_validate(
        {
            "recipe_id": row["recipe_id"],
            "project_id": row["project_id"],
            "name": row["name"],
            "input_ids": list(row["input_ids"]),
            "steps": row["steps"],
            "version": row["version"],
            "updated_by": row["updated_by"],
            "updated_at": row["updated_at"],
        }
    )


def list_recipes(session: Session, deps: WorkspaceDeps, user: CurrentUser, project_id: UUID) -> list[Recipe]:
    require_reader(deps, project_id, user)
    return [_view(r) for r in repo.list_recipes(session, project_id)]


def _live(session: Session, project_id: UUID, recipe_id: UUID, *, for_update: bool = False) -> RowMapping:
    row = repo.load_recipe(session, project_id, recipe_id, for_update=for_update)
    if row is None:
        raise not_found("Recipe")
    return row


def get_recipe(
    session: Session, deps: WorkspaceDeps, user: CurrentUser, project_id: UUID, recipe_id: UUID
) -> Recipe:
    require_reader(deps, project_id, user)
    return _view(_live(session, project_id, recipe_id))


# ---------------------------------------------------------------- writes


def _saved_event(session: Session, user: CurrentUser, row: RowMapping) -> None:
    outbox.write(
        session,
        EventType.WORKSPACE_RECIPE_SAVED_V1,
        {
            "project_id": str(row["project_id"]),
            "actor_id": str(user.user_id),
            "occurred_at": row["updated_at"].isoformat(),
            "recipe_id": str(row["recipe_id"]),
            "recipe_name": row["name"],
            "recipe_version": row["version"],
            "input_ids": [str(i) for i in row["input_ids"]],
            "step_count": len(row["steps"]),
        },
        EventActor.for_user(user),
    )


def create_recipe(
    session: Session, deps: WorkspaceDeps, user: CurrentUser, project_id: UUID, body: RecipeWriteIn
) -> Recipe:
    require_open_writer(deps, project_id, user)
    validate(session, deps, project_id, body.input_ids, body.steps)
    now = clock.now()
    row = repo.insert_recipe(
        session,
        recipe_id=new_id(),
        project_id=project_id,
        name=body.name,
        input_ids=list(body.input_ids),
        steps=dump_steps(body.steps),
        version=1,
        created_by=user.user_id,
        created_at=now,
        updated_by=user.user_id,
        updated_at=now,
    )
    _saved_event(session, user, row)
    return _view(row)


def update_recipe(
    session: Session,
    deps: WorkspaceDeps,
    user: CurrentUser,
    project_id: UUID,
    recipe_id: UUID,
    body: RecipeWriteIn,
    if_match: int,
) -> Recipe:
    require_writer(deps, project_id, user)
    current = _live(session, project_id, recipe_id, for_update=True)
    if current["version"] != if_match:
        raise ApiError(
            ErrorCode.CONFLICT,
            "The recipe was saved by someone else; reload it and apply your changes again.",
            {"current_version": current["version"]},
        )
    validate(session, deps, project_id, body.input_ids, body.steps)
    row = repo.save_recipe_version(
        session,
        recipe_id,
        name=body.name,
        input_ids=list(body.input_ids),
        steps=dump_steps(body.steps),
        version=current["version"] + 1,
        updated_by=user.user_id,
        updated_at=clock.now(),
    )
    _saved_event(session, user, row)
    return _view(row)


def delete_recipe(
    session: Session, deps: WorkspaceDeps, user: CurrentUser, project_id: UUID, recipe_id: UUID
) -> None:
    require_writer(deps, project_id, user)
    _live(session, project_id, recipe_id, for_update=True)
    if repo.active_run(session, recipe_id) is not None:
        raise ApiError(ErrorCode.RUN_NOT_ALLOWED, "A run of this recipe is queued or running.")
    repo.soft_delete_recipe(session, recipe_id, clock.now())


# ---------------------------------------------------------------- preview


def preview(
    session: Session,
    deps: WorkspaceDeps,
    user: CurrentUser,
    project_id: UUID,
    recipe_id: UUID,
    body: RecipePreviewIn | None,
) -> RecipePreview:
    require_reader(deps, project_id, user)
    row = _live(session, project_id, recipe_id)
    input_ids: list[UUID] = list(body.input_ids) if body and body.input_ids else list(row["input_ids"])
    recipe_steps = list(body.steps) if body and body.steps is not None else parse_steps(row["steps"])
    resolved = resolve_inputs(session, deps, project_id, input_ids)
    require_live_access(deps, user, resolved)
    by_id = {i.input_id: i for i in resolved}
    deadline = reader.deadline_after(PREVIEW_TIMEOUT_S)
    tables: dict[UUID, pa.Table] = {}
    for input_id in steps.needed_inputs(recipe_steps, input_ids):
        if input_id not in by_id:  # a join outside the recipe: plan() reports it with its step index
            continue
        with _read_errors(input_id):
            tables[input_id] = reader.read_table(
                deps.reader,
                table_file(by_id[input_id]),
                max_rows=PREVIEW_INPUT_ROWS,
                truncate=True,
                deadline=deadline,
            ).table
    try:
        result = steps.apply(recipe_steps, tables, input_ids, max_rows=PREVIEW_MAX_ROWS, check=deadline)
    except steps.StepError as exc:
        raise recipe_invalid(exc) from exc
    except reader.ReadTimeout as exc:
        raise _timeout() from exc
    return RecipePreview.model_validate(
        {
            "header": result.column_names,
            "rows": steps.preview_rows(result, PREVIEW_RESULT_ROWS),
            "rows_truncated": result.num_rows > PREVIEW_RESULT_ROWS,
            "input_rows_read": sum(t.num_rows for t in tables.values()),
            "output_rows": result.num_rows,
        }
    )
