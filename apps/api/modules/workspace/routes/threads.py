"""Discussions: /threads, /threads/{thread_id}, /threads/{thread_id}/comments (openapi tag `workspace`)."""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends

from api.modules.workspace.deps import WorkspaceDepsDep
from api.modules.workspace.schemas import (
    Comment,
    CommentCreateIn,
    Thread,
    ThreadCreateIn,
    ThreadScope,
    ThreadUpdateIn,
)
from api.modules.workspace.service import threads as service
from api.platform.auth import CurrentUserDep
from api.platform.db import SessionDep
from api.platform.pagination import Page, PageParams, page_params

router = APIRouter(tags=["workspace"])
PageDep = Annotated[PageParams, Depends(page_params)]


@router.get("/threads", operation_id="listThreads")
def list_threads(
    user: CurrentUserDep,
    session: SessionDep,
    deps: WorkspaceDepsDep,
    paging: PageDep,
    scope: ThreadScope | None = None,
    target_id: UUID | None = None,
    project_id: UUID | None = None,
    resolved: bool | None = None,
) -> Page[Thread]:
    return service.list_threads(
        session,
        deps,
        user,
        scope=scope.value if scope else None,
        target_id=target_id,
        project_id=project_id,
        resolved=resolved,
        params=paging,
    )


@router.post("/threads", operation_id="createThread", status_code=201)
def create_thread(
    body: ThreadCreateIn, user: CurrentUserDep, session: SessionDep, deps: WorkspaceDepsDep
) -> Thread:
    return service.create_thread(session, deps, user, body)


@router.patch("/threads/{thread_id}", operation_id="updateThread")
def update_thread(
    thread_id: UUID, body: ThreadUpdateIn, user: CurrentUserDep, session: SessionDep, deps: WorkspaceDepsDep
) -> Thread:
    return service.update_thread(session, deps, user, thread_id, body)


@router.get("/threads/{thread_id}/comments", operation_id="listComments")
def list_comments(
    thread_id: UUID, user: CurrentUserDep, session: SessionDep, deps: WorkspaceDepsDep, paging: PageDep
) -> Page[Comment]:
    return service.list_comments(session, deps, user, thread_id, paging)


@router.post("/threads/{thread_id}/comments", operation_id="addComment", status_code=201)
def add_comment(
    thread_id: UUID, body: CommentCreateIn, user: CurrentUserDep, session: SessionDep, deps: WorkspaceDepsDep
) -> Comment:
    return service.add_comment(session, deps, user, thread_id, body)
