"""All workspace routes (mounted under /api/v1 by the platform). Later tasks add their routers here."""

from fastapi import APIRouter

from api.modules.workspace.routes import hub, inputs, threads

router = APIRouter()
for sub in (inputs.router, threads.router, hub.router):
    router.include_router(sub)
