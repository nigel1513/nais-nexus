"""All catalog routes (mounted under /api/v1 by the platform)."""

from fastapi import APIRouter

from api.modules.catalog.routes import (
    completion,
    contributors,
    dataset_update,
    datasets,
    diff,
    jsonld,
    previews,
    publish,
    search,
    uploads,
    versions,
    vocabulary,
)

router = APIRouter()
for sub in (
    search.router,
    datasets.router,
    dataset_update.router,
    jsonld.router,
    versions.router,
    diff.router,
    uploads.router,
    completion.router,
    contributors.router,
    publish.router,
    vocabulary.router,
    previews.router,
):
    router.include_router(sub)
