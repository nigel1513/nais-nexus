"""Against the dev stack's SeaweedFS through the 21051 gateway (skips when the stack is down)."""

import base64
import hashlib
import uuid

import httpx
import pytest

from api.modules.catalog.objects import MultipartFailed, ObjectMissing, StorageRegistry

CSV = b"sample_id,value\nS0001,1.0\n"


def _b64(data: bytes) -> str:
    return base64.b64encode(hashlib.sha256(data).digest()).decode()


@pytest.fixture
def prefix(s3_prefixes: list[str]) -> str:
    value = f"datasets/test-{uuid.uuid4()}/"
    s3_prefixes.append(value)
    return value


def test_presigned_put_goes_through_the_gateway_and_rejects_tampering(
    seaweed_registry: StorageRegistry, prefix: str
) -> None:
    store = seaweed_registry.for_org("inst-b")
    key = f"{prefix}data/a.csv"
    url, headers = store.presign_put(key, "text/csv", _b64(CSV), 300)
    assert url.startswith(f"http://localhost:21051/nais-inst-b/{key}?")
    assert httpx.put(url, content=b"tampered!", headers=headers, timeout=30).status_code == 400
    assert store.head(key) is None
    assert httpx.put(url, content=CSV, headers=headers, timeout=30).status_code == 200
    assert store.head(key) == len(CSV)
    assert store.read_range(key, 0, 8) == CSV[:9]


def test_presigned_multipart_upload_and_complete(seaweed_registry: StorageRegistry, prefix: str) -> None:
    store = seaweed_registry.for_org("inst-a")
    key = f"{prefix}big.csv"
    part1, part2 = b"a" * (5 * 1024 * 1024), b"b" * 1024
    upload_id = store.create_multipart(key, "text/csv")
    etags = []
    for number, data in ((1, part1), (2, part2)):
        response = httpx.put(store.presign_part(key, upload_id, number, 300), content=data, timeout=60)
        assert response.status_code == 200, response.text
        etags.append((number, response.headers["etag"]))
    with pytest.raises(MultipartFailed):
        store.complete_multipart(key, upload_id, [(1, '"0000"'), (2, etags[1][1])])
    store.complete_multipart(key, upload_id, etags)
    assert store.head(key) == len(part1) + len(part2)
    stream = store.open_stream(key, (len(part1) - 1, len(part1)))
    assert stream.read() == b"ab"


def test_presigned_get_downloads_as_attachment(seaweed_registry: StorageRegistry, prefix: str) -> None:
    store = seaweed_registry.for_org("inst-b")
    key = f"{prefix}data/a.csv"
    store.put(key, CSV, "text/csv")
    response = httpx.get(store.presign_get(key, "a.csv", 60), timeout=30)
    assert response.status_code == 200 and response.content == CSV
    assert response.headers["content-disposition"] == 'attachment; filename="a.csv"'


def test_missing_objects_and_idempotent_cleanup(seaweed_registry: StorageRegistry, prefix: str) -> None:
    store = seaweed_registry.for_org("inst-b")
    assert store.head(f"{prefix}nothing.csv") is None
    store.delete(f"{prefix}nothing.csv")
    upload_id = store.create_multipart(f"{prefix}x.csv", "text/csv")
    store.abort_multipart(f"{prefix}x.csv", upload_id)
    store.abort_multipart(f"{prefix}x.csv", upload_id)


def test_server_side_copy_and_missing_source(seaweed_registry: StorageRegistry, prefix: str) -> None:
    store = seaweed_registry.for_org("inst-b")
    store.put(f"{prefix}src.csv", CSV, "text/csv")
    store.copy(f"{prefix}src.csv", f"{prefix}dst.csv")
    assert store.read_range(f"{prefix}dst.csv", 0, len(CSV) - 1) == CSV
    with pytest.raises(ObjectMissing):
        store.copy(f"{prefix}nothing.csv", f"{prefix}other.csv")
