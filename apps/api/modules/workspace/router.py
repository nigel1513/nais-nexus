"""All workspace routes (mounted under /api/v1 by the platform). Later tasks add their routers here."""

from fastapi import APIRouter

from api.modules.workspace.routes import inputs

router = APIRouter()
for sub in (inputs.router,):
    router.include_router(sub)
