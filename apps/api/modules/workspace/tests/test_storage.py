"""S3OutputStorage over the platform storage clients (no network: presigning is local, S3 calls are stubbed)."""

import base64
import hashlib
import io
from typing import Any
from urllib.parse import parse_qs, urlsplit

import pytest
from botocore.response import StreamingBody
from botocore.stub import Stubber

from api.modules.workspace.storage import CHUNK_BYTES, S3OutputStorage
from api.platform.errors import ApiError

ENV = {
    "STORAGE_INST_A_ENDPOINT": "http://storage-a:8333",
    "STORAGE_INST_A_BUCKET": "nais-inst-a",
    "STORAGE_INST_A_ACCESS_KEY": "key",
    "STORAGE_INST_A_SECRET_KEY": "secret",
}
KEY = "workspace/p/outputs/o/report.pdf"


def storage() -> S3OutputStorage:
    return S3OutputStorage("http://localhost:21051/", environ=ENV)


def test_presigned_urls_point_at_the_public_gateway_with_the_ttl() -> None:
    s = storage()
    digest = hashlib.sha256(b"x").hexdigest()
    url, headers = s.presign_put("inst-a", KEY, "application/pdf", digest, 900)
    parts = urlsplit(url)
    assert (parts.scheme, parts.netloc, parts.path) == ("http", "localhost:21051", f"/nais-inst-a/{KEY}")
    assert parse_qs(parts.query)["X-Amz-Expires"] == ["900"]
    checksum = base64.b64encode(bytes.fromhex(digest)).decode()
    assert headers == {"Content-Type": "application/pdf", "x-amz-checksum-sha256": checksum}

    get = urlsplit(s.presign_get("inst-a", KEY, "report.pdf", 300))
    query = parse_qs(get.query)
    assert (get.netloc, query["X-Amz-Expires"]) == ("localhost:21051", ["300"])
    assert query["response-content-disposition"] == ['attachment; filename="report.pdf"']


def test_unconfigured_organization_is_503() -> None:
    with pytest.raises(ApiError) as exc:
        storage().head("inst-z", KEY)
    assert exc.value.code == "DEPENDENCY_UNAVAILABLE"


def _stubbed(s: S3OutputStorage) -> Stubber:
    return Stubber(s.internal("inst-a"))


def test_head_and_streamed_sha256_use_the_internal_client() -> None:
    s = storage()
    data = b"z" * (CHUNK_BYTES * 2 + 17)  # several chunks
    with _stubbed(s) as stub:
        stub.add_response("head_object", {"ContentLength": len(data)}, {"Bucket": "nais-inst-a", "Key": KEY})
        body = StreamingBody(io.BytesIO(data), len(data))
        stub.add_response("get_object", {"Body": body}, {"Bucket": "nais-inst-a", "Key": KEY})
        assert s.head("inst-a", KEY) == len(data)
        assert s.sha256("inst-a", KEY) == hashlib.sha256(data).hexdigest()


def test_missing_objects_are_none_and_other_errors_503() -> None:
    s = storage()
    params: dict[str, Any] = {"Bucket": "nais-inst-a", "Key": KEY}
    with _stubbed(s) as stub:
        stub.add_client_error("head_object", "404", http_status_code=404, expected_params=params)
        stub.add_client_error("get_object", "NoSuchKey", http_status_code=404, expected_params=params)
        stub.add_client_error("head_object", "InternalError", http_status_code=500, expected_params=params)
        assert s.head("inst-a", KEY) is None
        assert s.sha256("inst-a", KEY) is None
        with pytest.raises(ApiError) as exc:
            s.head("inst-a", KEY)
        assert exc.value.code == "DEPENDENCY_UNAVAILABLE"
