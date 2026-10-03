"""All notes routes (mounted under /api/v1 by the platform)."""

from fastapi import APIRouter

from api.modules.notes.routes import internal, notes, settings

router = APIRouter()
for sub in (notes.router, settings.router, internal.router):
    router.include_router(sub)
