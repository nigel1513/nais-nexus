"""All workspace routes (mounted under /api/v1 by the platform)."""

from fastapi import APIRouter

from api.modules.workspace.routes import hub, inputs, outputs, recipes, runs, threads

router = APIRouter()
for sub in (inputs.router, recipes.router, runs.router, outputs.router, threads.router, hub.router):
    router.include_router(sub)
