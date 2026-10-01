"""All catalog routes (mounted under /api/v1 by the platform)."""

from fastapi import APIRouter

from api.modules.catalog.routes import datasets

router = APIRouter()
router.include_router(datasets.router)
