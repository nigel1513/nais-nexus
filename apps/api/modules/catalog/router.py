"""All catalog routes (mounted under /api/v1 by the platform)."""

from fastapi import APIRouter

from api.modules.catalog.routes import dataset_update, datasets, versions

router = APIRouter()
for sub in (datasets.router, dataset_update.router, versions.router):
    router.include_router(sub)
