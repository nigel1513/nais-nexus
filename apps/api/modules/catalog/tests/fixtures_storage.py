"""Real SeaweedFS of the running dev stack (host ports 21053/21054, gateway 21051), D-034/D-037."""

import os
from collections.abc import Iterator

import httpx
import pytest

from api.modules.catalog.objects import StorageRegistry
from api.platform.storage import ensure_buckets, internal_client, load_storage_config

GATEWAY_URL = os.environ.get("NAIS_TEST_GATEWAY_URL", "http://localhost:21051")
SEAWEED_ENV = {
    "STORAGE_INST_A_ENDPOINT": os.environ.get("NAIS_TEST_STORAGE_A", "http://localhost:21053"),
    "STORAGE_INST_A_BUCKET": "nais-inst-a",
    "STORAGE_INST_A_ACCESS_KEY": "nais",
    "STORAGE_INST_A_SECRET_KEY": "nais",
    "STORAGE_INST_B_ENDPOINT": os.environ.get("NAIS_TEST_STORAGE_B", "http://localhost:21054"),
    "STORAGE_INST_B_BUCKET": "nais-inst-b",
    "STORAGE_INST_B_ACCESS_KEY": "nais",
    "STORAGE_INST_B_SECRET_KEY": "nais",
}
CODES = ("inst-a", "inst-b")


@pytest.fixture(scope="session")
def seaweed_registry() -> StorageRegistry:
    try:
        httpx.get(f"{GATEWAY_URL}/healthz", timeout=2).raise_for_status()
        ensure_buckets(list(CODES), SEAWEED_ENV)
    except Exception as exc:  # stack not running on this host
        pytest.skip(f"dev stack gateway/storage unavailable: {exc}")
    return StorageRegistry(SEAWEED_ENV, GATEWAY_URL, CODES)


@pytest.fixture
def s3_prefixes(seaweed_registry: StorageRegistry) -> Iterator[list[str]]:
    prefixes: list[str] = []
    yield prefixes
    for code in CODES:
        cfg = load_storage_config(code, SEAWEED_ENV)
        client = internal_client(cfg)
        for prefix in prefixes:
            listed = client.list_objects_v2(Bucket=cfg.bucket, Prefix=prefix)
            for item in listed.get("Contents", []):
                client.delete_object(Bucket=cfg.bucket, Key=item["Key"])
