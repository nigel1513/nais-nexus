"""Throwaway OpenSearch (same image as compose) so D-012 filters and analyzers are tested for real."""

import time
import uuid
from collections.abc import Iterator

import httpx
import pytest

from api.modules.catalog.search.opensearch import OpenSearchIndex

OPENSEARCH_IMAGE = "opensearchproject/opensearch:2.19.1"


def start_opensearch(image: str) -> tuple[object, str]:
    from testcontainers.core.container import DockerContainer

    container = (
        DockerContainer(image)
        .with_env("discovery.type", "single-node")
        .with_env("DISABLE_SECURITY_PLUGIN", "true")
        .with_env("DISABLE_INSTALL_DEMO_CONFIG", "true")
        .with_env("OPENSEARCH_JAVA_OPTS", "-Xms512m -Xmx512m")
        .with_exposed_ports(9200)
    )
    container.start()
    url = f"http://{container.get_container_host_ip()}:{container.get_exposed_port(9200)}"
    deadline = time.monotonic() + 180
    while True:
        try:
            if httpx.get(f"{url}/_cluster/health", timeout=2).status_code == 200:
                return container, url
        except httpx.HTTPError:
            pass
        if time.monotonic() > deadline:
            container.stop()
            raise RuntimeError("OpenSearch container did not become ready in 180 s")
        time.sleep(1)


@pytest.fixture(scope="session")
def opensearch_url() -> Iterator[str]:
    try:
        container, url = start_opensearch(OPENSEARCH_IMAGE)
    except Exception as exc:  # docker missing or daemon not reachable
        pytest.skip(f"OpenSearch container unavailable: {exc}")
    try:
        yield url
    finally:
        container.stop()  # type: ignore[attr-defined]


@pytest.fixture
def search_index(opensearch_url: str) -> Iterator[OpenSearchIndex]:
    index = OpenSearchIndex(opensearch_url, f"test-{uuid.uuid4().hex[:12]}")
    yield index
    listed = httpx.get(
        f"{opensearch_url}/_cat/indices/{index.alias}-v*", params={"format": "json"}, timeout=10
    )
    for item in listed.json() if listed.status_code == 200 else []:
        httpx.delete(f"{opensearch_url}/{item['index']}", timeout=10)
