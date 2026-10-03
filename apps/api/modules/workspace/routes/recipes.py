"""Recipes: /projects/{project_id}/recipes[/{recipe_id}[/preview]] (openapi tag `workspace`)."""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Body, Header, Response

from api.modules.workspace.deps import WorkspaceDepsDep
from api.modules.workspace.schemas import Recipe, RecipeList, RecipePreview, RecipePreviewIn, RecipeWriteIn
from api.modules.workspace.service import recipes as service
from api.platform.auth import CurrentUserDep
from api.platform.db import SessionDep

router = APIRouter(tags=["workspace"])
IfMatch = Annotated[str, Header(alias="If-Match", pattern=r'^"?[1-9][0-9]{0,8}"?$')]


@router.get("/projects/{project_id}/recipes", operation_id="listRecipes")
def list_recipes(
    project_id: UUID, user: CurrentUserDep, session: SessionDep, deps: WorkspaceDepsDep
) -> RecipeList:
    return RecipeList(items=service.list_recipes(session, deps, user, project_id))


@router.post("/projects/{project_id}/recipes", operation_id="createRecipe", status_code=201)
def create_recipe(
    project_id: UUID, body: RecipeWriteIn, user: CurrentUserDep, session: SessionDep, deps: WorkspaceDepsDep
) -> Recipe:
    return service.create_recipe(session, deps, user, project_id, body)


@router.get("/projects/{project_id}/recipes/{recipe_id}", operation_id="getRecipe")
def get_recipe(
    project_id: UUID, recipe_id: UUID, user: CurrentUserDep, session: SessionDep, deps: WorkspaceDepsDep
) -> Recipe:
    return service.get_recipe(session, deps, user, project_id, recipe_id)


@router.put("/projects/{project_id}/recipes/{recipe_id}", operation_id="updateRecipe")
def update_recipe(
    project_id: UUID,
    recipe_id: UUID,
    body: RecipeWriteIn,
    if_match: IfMatch,
    user: CurrentUserDep,
    session: SessionDep,
    deps: WorkspaceDepsDep,
) -> Recipe:
    version = int(if_match.strip('"'))
    return service.update_recipe(session, deps, user, project_id, recipe_id, body, version)


@router.delete("/projects/{project_id}/recipes/{recipe_id}", operation_id="deleteRecipe", status_code=204)
def delete_recipe(
    project_id: UUID, recipe_id: UUID, user: CurrentUserDep, session: SessionDep, deps: WorkspaceDepsDep
) -> Response:
    service.delete_recipe(session, deps, user, project_id, recipe_id)
    return Response(status_code=204)


@router.post("/projects/{project_id}/recipes/{recipe_id}/preview", operation_id="previewRecipe")
def preview_recipe(
    project_id: UUID,
    recipe_id: UUID,
    user: CurrentUserDep,
    session: SessionDep,
    deps: WorkspaceDepsDep,
    body: Annotated[RecipePreviewIn | None, Body()] = None,
) -> RecipePreview:
    return service.preview(session, deps, user, project_id, recipe_id, body)
