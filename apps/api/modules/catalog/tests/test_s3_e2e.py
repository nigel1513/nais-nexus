"""M03-AT-05/06/07 through the real presign path: TestClient API -> presigned URL -> :21051 gateway -> SeaweedFS."""

import hashlib
from dataclasses import replace
from urllib.parse import urlsplit

import httpx
import pytest

from api.modules.catalog.objects import StorageRegistry
from api.modules.catalog.tests.support_api import CatalogApi, new_draft
from api.modules.catalog.tests.support_upload import complete, file_row, start_upload
from api.platform.testing.fixtures import PgUrls

MIB = 1024 * 1024
LINE = b"0123456789,abcdefghij\n"
OTHER = b"9876543210,jihgfedcba\n"


@pytest.fixture
def s3_api(api: CatalogApi, seaweed_registry: StorageRegistry) -> CatalogApi:
    api.use(replace(api.deps, storage=seaweed_registry))
    return api


def _put_parts(upload: dict[str, object], data: bytes) -> list[dict[str, object]]:
    size = int(upload["part_size_bytes"])  # type: ignore[arg-type]
    etags = []
    for part in upload["parts"]:  # type: ignore[attr-defined]
        n = part["part_number"]
        response = httpx.put(part["url"], content=data[(n - 1) * size : n * size], timeout=300)
        assert response.status_code == 200, response.text
        etags.append({"part_number": n, "etag": response.headers["etag"]})
    return etags


def test_at05_small_csv_through_the_gateway(
    s3_api: CatalogApi, db: PgUrls, s3_prefixes: list[str], seaweed_registry: StorageRegistry
) -> None:
    dataset_id, version_id = new_draft(s3_api)
    s3_prefixes.append(f"datasets/{dataset_id}/")
    data = (b"a,b\n" + b"1,2\n" * 300)[:1024]
    body = start_upload(s3_api, version_id, {"data/a.csv": data})
    upload = body["files"][0]["upload"]
    url = urlsplit(upload["url"])
    assert url.netloc == "localhost:21051"
    assert url.path.startswith(f"/nais-inst-b/datasets/{dataset_id}/{version_id}/")
    assert httpx.put(upload["url"], content=data, headers=upload["headers"], timeout=60).status_code == 200
    result = complete(s3_api, body["upload_session_id"]).json()
    assert result["files"][0]["status"] == "VERIFIED"
    key = file_row(db, body["files"][0]["file_id"])["storage_key"]
    assert seaweed_registry.for_org("inst-b").head(key) == len(data)


def test_tampered_single_put_is_rejected_by_storage(s3_api: CatalogApi, s3_prefixes: list[str]) -> None:
    dataset_id, version_id = new_draft(s3_api)
    s3_prefixes.append(f"datasets/{dataset_id}/")
    data = b"a,b\n1,2\n"
    body = start_upload(s3_api, version_id, {"data/a.csv": data})
    upload = body["files"][0]["upload"]
    assert (
        httpx.put(upload["url"], content=b"a,b\n6,6\n", headers=upload["headers"], timeout=60).status_code
        == 400
    )
    result = complete(s3_api, body["upload_session_id"]).json()
    assert (result["files"][0]["status"], result["files"][0]["failure_code"]) == ("FAILED", "OBJECT_MISSING")


def test_at06_100_mib_multipart_upload_is_verified(s3_api: CatalogApi, s3_prefixes: list[str]) -> None:
    dataset_id, version_id = new_draft(s3_api)
    s3_prefixes.append(f"datasets/{dataset_id}/")
    data = LINE * (100 * MIB // len(LINE) + 1)
    assert len(data) > 64 * MIB
    body = start_upload(s3_api, version_id, {"data/big.csv": data})
    upload = body["files"][0]["upload"]
    assert upload["method"] == "MULTIPART" and len(upload["parts"]) == 2
    parts = [{"file_id": body["files"][0]["file_id"], "etags": _put_parts(upload, data)}]
    result = complete(s3_api, body["upload_session_id"], {"parts": parts}).json()
    assert result["files"][0]["status"] == "VERIFIED", result


def test_at07_multipart_with_wrong_content_fails_and_object_is_gone(
    s3_api: CatalogApi, db: PgUrls, s3_prefixes: list[str], seaweed_registry: StorageRegistry
) -> None:
    dataset_id, version_id = new_draft(s3_api)
    s3_prefixes.append(f"datasets/{dataset_id}/")
    declared = LINE * (70 * MIB // len(LINE))
    actual = OTHER * (70 * MIB // len(OTHER))
    assert (
        len(declared) == len(actual) and hashlib.sha256(declared).digest() != hashlib.sha256(actual).digest()
    )
    body = start_upload(s3_api, version_id, {"data/big.csv": declared})
    upload = body["files"][0]["upload"]
    parts = [{"file_id": body["files"][0]["file_id"], "etags": _put_parts(upload, actual)}]
    result = complete(s3_api, body["upload_session_id"], {"parts": parts}).json()
    assert (result["files"][0]["status"], result["files"][0]["failure_code"]) == (
        "FAILED",
        "CHECKSUM_MISMATCH",
    )
    key = file_row(db, body["files"][0]["file_id"])["storage_key"]
    assert seaweed_registry.for_org("inst-b").head(key) is None
