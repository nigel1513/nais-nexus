"""All catalog routes (mounted under /api/v1 by the platform)."""

from fastapi import APIRouter

from api.modules.catalog.routes import (
    completion,
    dataset_update,
    datasets,
    publish,
    search,
    uploads,
    versions,
)

router = APIRouter()
for sub in (
    search.router,
    datasets.router,
    dataset_update.router,
    versions.router,
    uploads.router,
    completion.router,
    publish.router,
):
    router.include_router(sub)
