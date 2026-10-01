import pytest

from api.modules.catalog.objects import MultipartFailed, ObjectMissing, S3ObjectStore, StorageUnavailable
from api.modules.catalog.testing import MemoryObjectStore, memory_registry, memory_store
from api.platform.storage import StorageConfig, StorageNotConfigured


def test_registry_maps_org_codes_and_buckets() -> None:
    registry = memory_registry(("inst-a", "inst-b"))
    assert registry.is_configured("inst-b") and not registry.is_configured("nais")
    assert registry.for_org("inst-b").bucket == "nais-inst-b"
    assert registry.for_bucket("nais-inst-a") is registry.for_org("inst-a")
    with pytest.raises(StorageNotConfigured):
        registry.for_org("nais")
    with pytest.raises(StorageNotConfigured):
        registry.for_bucket("nais-platform")
    assert not registry.is_configured("BAD CODE")


def test_memory_store_objects_and_ranges() -> None:
    store = MemoryObjectStore("nais-inst-b")
    store.put("k", b"0123456789", "text/plain")
    assert store.head("k") == 10 and store.head("missing") is None
    assert store.read_range("k", 2, 4) == b"234"
    assert store.open_stream("k", (8, 9)).read() == b"89"
    store.delete("k")
    store.delete("k")
    with pytest.raises(ObjectMissing):
        store.open_stream("k")


def test_memory_multipart_checks_etags_and_records_aborts() -> None:
    store = memory_store(memory_registry(), "inst-b")
    upload_id = store.create_multipart("big.csv", "text/csv")
    etag1 = store.upload_part("big.csv", upload_id, 1, b"ab")
    etag2 = store.upload_part("big.csv", upload_id, 2, b"cd")
    with pytest.raises(MultipartFailed):
        store.complete_multipart("big.csv", upload_id, [(1, etag1), (2, '"bogus"')])
    store.complete_multipart("big.csv", upload_id, [(2, etag2), (1, etag1)])
    assert store.objects["big.csv"] == b"abcd"
    second = store.create_multipart("other.csv", "text/csv")
    store.abort_multipart("other.csv", second)
    store.abort_multipart("other.csv", second)
    assert store.aborted == [second]


def test_memory_presigned_urls_point_at_the_gateway() -> None:
    store = MemoryObjectStore("nais-inst-b")
    url, headers = store.presign_put("datasets/d/v/a.csv", "text/csv", "c2hh", 3600)
    assert url.startswith("http://localhost:21051/nais-inst-b/datasets/d/v/a.csv?")
    assert headers == {"Content-Type": "text/csv", "x-amz-checksum-sha256": "c2hh"}
    assert "partNumber=3" in store.presign_part("k", "u", 3, 60)


def test_s3_store_translates_connection_failures() -> None:
    store = S3ObjectStore(
        StorageConfig("inst-b", "http://127.0.0.1:9", "nais-inst-b", "k", "s"), "http://localhost:21051"
    )
    with pytest.raises(StorageUnavailable):
        store.head("anything")
