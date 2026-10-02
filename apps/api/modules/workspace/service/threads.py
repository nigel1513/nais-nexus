"""Discussions (spec §5.6; openapi listThreads/createThread/updateThread/listComments/addComment).

Read: PROJECT/OUTPUT/RECIPE threads -> an ACTIVE member of the owning project in any project status (else 404);
DATASET threads -> anyone who can see the dataset (catalog is_visible, else 404).
Write (create, comment): the same, and a project thread's project must be ACTIVE (archived -> 403 FORBIDDEN, the
contract lists no 409 for these operations). DATASET threads are open to every signed-in user who sees the dataset.
Update: the thread author, PROJECT_OWNER/PROJECT_ADMIN for project threads, or a DATA_STEWARD of the dataset's
owner organization for dataset threads (else 403).
"""

from collections.abc import Callable, Sequence
from dataclasses import dataclass
from datetime import datetime
from typing import Any
from uuid import UUID

from sqlalchemy.engine import RowMapping
from sqlalchemy.orm import Session

from api.modules.workspace import repo
from api.modules.workspace.deps import WorkspaceDeps
from api.modules.workspace.errors import forbidden, not_found
from api.modules.workspace.paging import keyset_page, sort_key
from api.modules.workspace.schemas import Comment, CommentCreateIn, Thread, ThreadCreateIn, ThreadUpdateIn
from api.platform import clock
from api.platform.auth import CurrentUser
from api.platform.errors import ApiError
from api.platform.events import EventActor
from api.platform.generated.error_codes import ErrorCode
from api.platform.generated.event_types import EventType
from api.platform.ids import new_id
from api.platform.outbox import outbox
from api.platform.pagination import Page, PageParams

DATASET = "DATASET"
MODERATORS = frozenset({"PROJECT_OWNER", "PROJECT_ADMIN"})
DATA_STEWARD = "DATA_STEWARD"

ProjectOf = Callable[[Session, UUID], UUID | None]
# scope -> the project owning a target id (None: no such target). OUTPUT targets are completed outputs only (an
# upload session is not discussable). RECIPE is registered by the task that adds recipes; until then 404.
TARGET_PROJECT: dict[str, ProjectOf] = {
    "PROJECT": lambda _session, target_id: target_id,
    "OUTPUT": repo.ready_output_project,
}


@dataclass(frozen=True)
class Target:
    scope: str
    target_id: UUID
    project_id: UUID | None  # None for DATASET
    owner_organization_id: UUID | None  # dataset owner for DATASET, else None


# ---------------------------------------------------------------- access


def _readable_target(
    session: Session, deps: WorkspaceDeps, user: CurrentUser, scope: str, target_id: UUID
) -> Target:
    if scope == DATASET:
        catalog = deps.catalog
        policy = catalog.get_policy_view(target_id) if catalog.is_visible(user, target_id) else None
        if policy is None:
            raise not_found("Dataset")
        return Target(scope, target_id, None, policy.owner_organization_id)
    resolve = TARGET_PROJECT.get(scope)
    project_id = resolve(session, target_id) if resolve else None
    if project_id is None or deps.projects.get_member_role(project_id, user.user_id) is None:
        raise not_found("Thread target")
    return Target(scope, target_id, project_id, None)


def _readable_thread(
    session: Session, deps: WorkspaceDeps, user: CurrentUser, thread_id: UUID, *, for_update: bool = False
) -> RowMapping:
    row = repo.load_thread(session, thread_id, for_update=for_update)
    if row is None:
        raise not_found("Thread")
    if row["scope"] == DATASET:
        visible = deps.catalog.is_visible(user, row["target_id"])
    else:
        visible = deps.projects.get_member_role(row["project_id"], user.user_id) is not None
    if not visible:
        raise not_found("Thread")
    return row


def _require_open(deps: WorkspaceDeps, user: CurrentUser, project_id: UUID | None) -> None:
    """Readers of a project thread are members; writing additionally needs an ACTIVE project."""
    if project_id is not None and not deps.projects.is_active_member(project_id, user.user_id):
        raise forbidden("The project is archived; its discussions are read-only.")


def _require_moderator(deps: WorkspaceDeps, user: CurrentUser, row: RowMapping) -> None:
    if row["created_by"] == user.user_id:
        return
    if row["scope"] == DATASET:
        if user.has_org_role(row["owner_organization_id"], DATA_STEWARD):
            return
    elif deps.projects.get_member_role(row["project_id"], user.user_id) in MODERATORS:
        return
    raise forbidden("Only the thread author or a moderator can change this thread.")


# ---------------------------------------------------------------- reads


def list_threads(
    session: Session,
    deps: WorkspaceDeps,
    user: CurrentUser,
    *,
    scope: str | None,
    target_id: UUID | None,
    project_id: UUID | None,
    resolved: bool | None,
    params: PageParams,
) -> Page[Thread]:
    after = sort_key(params)
    if project_id is not None and scope is None and target_id is None:
        if deps.projects.get_member_role(project_id, user.user_id) is None:
            raise not_found("Project")
        rows = repo.list_threads(
            session, project_id=project_id, resolved=resolved, after=after, limit=params.limit + 1
        )
    elif project_id is None and scope is not None and target_id is not None:
        _readable_target(session, deps, user, scope, target_id)
        rows = repo.list_threads(
            session, scope=scope, target_id=target_id, resolved=resolved, after=after, limit=params.limit + 1
        )
    else:
        raise ApiError(
            ErrorCode.VALIDATION_FAILED,
            "Give either scope and target_id, or project_id.",
            {"fields": [{"field": "project_id", "reason": "SELECTOR_REQUIRED"}]},
        )
    return keyset_page(
        rows, params.limit, ("last_comment_at", "thread_id"), lambda shown: _thread_views(deps, shown)
    )


def list_comments(
    session: Session, deps: WorkspaceDeps, user: CurrentUser, thread_id: UUID, params: PageParams
) -> Page[Comment]:
    after = sort_key(params)
    _readable_thread(session, deps, user, thread_id)
    rows = repo.list_comments(session, thread_id, after=after, limit=params.limit + 1)
    return keyset_page(
        rows, params.limit, ("created_at", "comment_id"), lambda shown: _comment_views(deps, shown)
    )


def _thread_views(deps: WorkspaceDeps, rows: Sequence[RowMapping]) -> list[Thread]:
    names = deps.people.get_display_names([r["created_by"] for r in rows])
    return [
        Thread.model_validate(
            {
                "thread_id": r["thread_id"],
                "scope": r["scope"],
                "target_id": r["target_id"],
                "project_id": r["project_id"],
                "title": r["title"],
                "created_by": r["created_by"],
                "created_by_display_name": names.get(r["created_by"], ""),
                "created_at": r["created_at"],
                "resolved": r["resolved"],
                "comment_count": r["comment_count"],
                "last_comment_at": r["last_comment_at"],
            }
        )
        for r in rows
    ]


def _comment_views(deps: WorkspaceDeps, rows: Sequence[RowMapping]) -> list[Comment]:
    names = deps.people.get_display_names([r["author_id"] for r in rows])
    return [
        Comment.model_validate(
            {
                "comment_id": r["comment_id"],
                "thread_id": r["thread_id"],
                "body": r["body"],
                "author_id": r["author_id"],
                "author_display_name": names.get(r["author_id"], ""),
                "created_at": r["created_at"],
                "edited_at": r["edited_at"],
            }
        )
        for r in rows
    ]


# ---------------------------------------------------------------- writes


def create_thread(session: Session, deps: WorkspaceDeps, user: CurrentUser, body: ThreadCreateIn) -> Thread:
    target = _readable_target(session, deps, user, body.scope.value, body.target_id)
    _require_open(deps, user, target.project_id)
    now = clock.now()
    thread = repo.insert_thread(
        session,
        thread_id=new_id(),
        scope=target.scope,
        target_id=target.target_id,
        project_id=target.project_id,
        owner_organization_id=target.owner_organization_id,
        title=body.title,
        created_by=user.user_id,
        created_at=now,
        resolved=False,
        comment_count=1,
        last_comment_at=now,
    )
    comment = _insert_comment(session, thread, user, body.body, now)
    _emit(session, user, thread, comment, new_thread=True)
    [view] = _thread_views(deps, [thread])
    return view


def add_comment(
    session: Session, deps: WorkspaceDeps, user: CurrentUser, thread_id: UUID, body: CommentCreateIn
) -> Comment:
    thread = _readable_thread(session, deps, user, thread_id, for_update=True)
    _require_open(deps, user, thread["project_id"])
    now = clock.now()
    comment = _insert_comment(session, thread, user, body.body, now)
    thread = repo.update_thread(
        session, thread_id, comment_count=thread["comment_count"] + 1, last_comment_at=now
    )
    _emit(session, user, thread, comment, new_thread=False)
    [view] = _comment_views(deps, [comment])
    return view


def update_thread(
    session: Session, deps: WorkspaceDeps, user: CurrentUser, thread_id: UUID, body: ThreadUpdateIn
) -> Thread:
    thread = _readable_thread(session, deps, user, thread_id, for_update=True)
    _require_moderator(deps, user, thread)
    _require_open(deps, user, thread["project_id"])
    values: dict[str, Any] = {name: getattr(body, name) for name in body.model_fields_set}
    thread = repo.update_thread(session, thread_id, **values)
    [view] = _thread_views(deps, [thread])
    return view


def _insert_comment(
    session: Session, thread: RowMapping, user: CurrentUser, body: str, at: datetime
) -> RowMapping:
    return repo.insert_comment(
        session,
        comment_id=new_id(),
        thread_id=thread["thread_id"],
        body=body,
        author_id=user.user_id,
        created_at=at,
    )


def _emit(
    session: Session, user: CurrentUser, thread: RowMapping, comment: RowMapping, *, new_thread: bool
) -> None:
    """workspace.comment.added.v1: project_id is null exactly for DATASET threads (schema if/then)."""
    outbox.write(
        session,
        EventType.WORKSPACE_COMMENT_ADDED_V1,
        {
            "project_id": str(thread["project_id"]) if thread["project_id"] else None,
            "actor_id": str(user.user_id),
            "occurred_at": comment["created_at"].isoformat(),
            "thread_id": str(thread["thread_id"]),
            "thread_title": thread["title"],
            "scope": thread["scope"],
            "target_id": str(thread["target_id"]),
            "comment_id": str(comment["comment_id"]),
            "new_thread": new_thread,
            "owner_organization_id": (
                str(thread["owner_organization_id"]) if thread["owner_organization_id"] else None
            ),
        },
        EventActor.for_user(user),
    )
