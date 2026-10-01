"""Upload helpers for tests that use the in-memory object store."""

import hashlib
from typing import Any
from uuid import UUID

import httpx

from api.modules.catalog.domain import ALLOWED_MEDIA_TYPES, extension
from api.modules.catalog.testing import memory_store
from api.modules.catalog.tests.support import rows
from api.modules.catalog.tests.support_api import CatalogApi
from api.platform.testing.fixtures import PgUrls


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def file_spec(path: str, data: bytes) -> dict[str, Any]:
    return {
        "path": path,
        "size_bytes": len(data),
        "sha256": sha(data),
        "media_type": ALLOWED_MEDIA_TYPES[extension(path)],
    }


def start_upload(
    api: CatalogApi, version_id: str, files: dict[str, bytes], user: str = "b.steward"
) -> dict[str, Any]:
    body = {"files": [file_spec(path, data) for path, data in files.items()]}
    response = api.post(user, f"/dataset-versions/{version_id}/upload-session", json=body)
    assert response.status_code == 201, response.text
    created: dict[str, Any] = response.json()
    return created


def file_row(db: PgUrls, file_id: str | UUID) -> dict[str, Any]:
    return rows(db, "SELECT * FROM catalog.dataset_files WHERE file_id = :id", id=file_id)[0]


def put_uploaded(
    api: CatalogApi, db: PgUrls, session_body: dict[str, Any], contents: dict[str, bytes], org: str = "inst-b"
) -> dict[str, Any]:
    """Do what the browser does with the presigned URLs, against the memory store."""
    store = memory_store(api.deps.storage, org)
    parts: list[dict[str, Any]] = []
    for item in session_body["files"]:
        data = contents[item["path"]]
        row = file_row(db, item["file_id"])
        if item["upload"]["method"] == "PUT":
            store.put(row["storage_key"], data, row["media_type"])
            continue
        size = item["upload"]["part_size_bytes"]
        etags = [
            {
                "part_number": part["part_number"],
                "etag": store.upload_part(
                    row["storage_key"],
                    row["multipart_upload_id"],
                    part["part_number"],
                    data[(part["part_number"] - 1) * size : part["part_number"] * size],
                ),
            }
            for part in item["upload"]["parts"]
        ]
        parts.append({"file_id": item["file_id"], "etags": etags})
    return {"parts": parts}


def complete(
    api: CatalogApi, upload_session_id: str, body: dict[str, Any] | None = None, user: str = "b.steward"
) -> httpx.Response:
    return api.post(user, f"/upload-sessions/{upload_session_id}/complete", json=body or {})


def upload_files(
    api: CatalogApi,
    db: PgUrls,
    version_id: str,
    files: dict[str, bytes],
    user: str = "b.steward",
    org: str = "inst-b",
) -> dict[str, Any]:
    session_body = start_upload(api, version_id, files, user)
    response = complete(
        api, session_body["upload_session_id"], put_uploaded(api, db, session_body, files, org), user
    )
    assert response.status_code == 200, response.text
    result: dict[str, Any] = response.json()
    return result
