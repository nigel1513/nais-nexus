"""Public project search: the nais-projects index holds PUBLIC + ACTIVE projects and only their public fields."""

import uuid
import zlib
from collections.abc import Iterator

import httpx
import pytest
from fastapi import FastAPI

from api.modules.catalog.tests.fixtures_search import opensearch_url  # noqa: F401
from api.modules.project.identity_fake import FakeIdentityQueryPort
from api.modules.project.query import ProjectSearchSlot
from api.modules.project.search import MAPPINGS, ProjectSearch, project_index, reconcile
from api.modules.project.tests.helpers import ProjectApi, sql
from api.platform import ports
from api.platform.db import session_factory
from api.platform.search_index import EMBEDDING_DIMENSION, EMBEDDING_FIELD
from api.platform.testing.contracts import assert_matches_response
from api.platform.testing.fixtures import PgUrls


class ConceptEmbedder:
    """Embedding double: texts about the same concept (in either language) get the same unit vector."""

    CONCEPTS = (("연료전지", "fuel cell"), ("기후", "climate"))

    def embed(self, texts: list[str]) -> list[list[float]]:
        vectors = []
        for text in texts:
            vector = [0.0] * EMBEDDING_DIMENSION
            lowered = text.lower()
            axis = next(
                (i for i, words in enumerate(self.CONCEPTS) if any(word in lowered for word in words)),
                # Anything else is its own direction: unrelated to every other text.
                len(self.CONCEPTS)
                + zlib.crc32(lowered.encode()) % (EMBEDDING_DIMENSION - len(self.CONCEPTS)),
            )
            vector[axis] = 1.0
            vectors.append(vector)
        return vectors


@pytest.fixture
def search(api: ProjectApi, opensearch_url: str) -> Iterator[ProjectSearch]:  # noqa: F811
    embedder = ConceptEmbedder()
    index = project_index(opensearch_url, f"test-projects-{uuid.uuid4().hex[:12]}")
    project_search = ProjectSearch(index=index, embedder=embedder, query_embedder=embedder)
    ports.provide(ProjectSearchSlot, ProjectSearchSlot(project_search))
    yield project_search
    ports.provide(ProjectSearchSlot, ProjectSearchSlot(None))
    listed = httpx.get(
        f"{opensearch_url}/_cat/indices/{index.alias}-v*", params={"format": "json"}, timeout=10
    )
    for item in listed.json() if listed.status_code == 200 else []:
        httpx.delete(f"{opensearch_url}/{item['index']}", timeout=10)


def sync(search: ProjectSearch, db: PgUrls, identity: FakeIdentityQueryPort) -> tuple[int, int]:
    with session_factory(db.app)() as session:
        return reconcile(search, session, identity)


def discover(api: ProjectApi, q: str, user: str = "b.researcher") -> list[str]:
    response = api.get(user, "/projects", params={"scope": "discover", "q": q})
    assert response.status_code == 200, response.text
    body = response.json()
    assert_matches_response("listProjects", 200, body)
    assert body["page"] == {"next_cursor": None, "has_more": False}
    return [item["name"] for item in body["items"]]


def test_discover_search_finds_public_projects_by_words_and_by_meaning(
    api: ProjectApi, db: PgUrls, identity: FakeIdentityQueryPort, search: ProjectSearch
) -> None:
    api.create_project(name="연료전지 막 열화 공동연구", visibility="PUBLIC")
    api.create_project(name="기후 관측 자료 정비", visibility="PUBLIC")
    assert sync(search, db, identity) == (2, 0)
    assert discover(api, "연료전지") == ["연료전지 막 열화 공동연구"]
    # No word in common with the Korean name: only the embedding connects them.
    assert discover(api, "fuel cell") == ["연료전지 막 열화 공동연구"]
    assert discover(api, "climate") == ["기후 관측 자료 정비"]
    assert discover(api, "quantum") == []


def test_private_and_archived_projects_never_reach_the_index(
    api: ProjectApi, db: PgUrls, identity: FakeIdentityQueryPort, search: ProjectSearch
) -> None:
    api.create_project(name="연료전지 비공개 과제")
    archived = api.create_project(name="연료전지 종료 과제", visibility="PUBLIC")
    public = api.create_project(name="연료전지 공개 과제", visibility="PUBLIC")
    sql(
        db,
        "UPDATE project.projects SET status = 'ARCHIVED' WHERE project_id = :id",
        id=archived["project_id"],
    )
    assert sync(search, db, identity) == (1, 0)
    assert search.index.document_ids() == [public["project_id"]]
    assert discover(api, "연료전지") == ["연료전지 공개 과제"]
    assert discover(api, "fuel cell") == ["연료전지 공개 과제"]


def test_index_documents_carry_only_the_public_summary_fields(
    api: ProjectApi, db: PgUrls, identity: FakeIdentityQueryPort, search: ProjectSearch
) -> None:
    api.create_project(
        name="공개 과제", visibility="PUBLIC", description="내부 실험 계획 초안", keywords=["기밀키워드"]
    )
    sync(search, db, identity)
    raw = search.index.search({"query": {"match_all": {}}})["hits"]["hits"][0]["_source"]
    assert set(raw) == set(MAPPINGS["properties"]) | {EMBEDDING_FIELD}
    assert "내부 실험" not in str(raw) and "기밀키워드" not in str(raw)
    # Member-only text is not searchable either.
    assert discover(api, "기밀키워드") == [] and discover(api, "실험 계획") == []


def test_reconcile_follows_renames_and_unpublishing(
    api: ProjectApi, db: PgUrls, identity: FakeIdentityQueryPort, search: ProjectSearch
) -> None:
    project = api.create_project(name="기후 관측", visibility="PUBLIC")
    assert sync(search, db, identity) == (1, 0)
    assert sync(search, db, identity) == (0, 0)
    response = api.patch("a.researcher", f"/projects/{project['project_id']}", json={"name": "연료전지 관측"})
    assert response.status_code == 200, response.text
    assert sync(search, db, identity) == (1, 0)
    assert discover(api, "fuel cell") == ["연료전지 관측"] and discover(api, "climate") == []
    api.patch("a.researcher", f"/projects/{project['project_id']}", json={"visibility": "PRIVATE"})
    assert sync(search, db, identity) == (0, 1)
    assert discover(api, "fuel cell") == []


def test_a_stale_index_entry_is_not_listed_once_the_project_is_private(
    api: ProjectApi, db: PgUrls, identity: FakeIdentityQueryPort, search: ProjectSearch
) -> None:
    project = api.create_project(name="연료전지 공개 과제", visibility="PUBLIC")
    sync(search, db, identity)
    api.patch("a.researcher", f"/projects/{project['project_id']}", json={"visibility": "PRIVATE"})
    # Not reconciled yet: the index still has the document, the database decides.
    assert discover(api, "연료전지") == []


def test_discover_search_falls_back_to_names_when_the_index_is_down(
    api: ProjectApi, db: PgUrls, identity: FakeIdentityQueryPort
) -> None:
    down = ProjectSearch(index=project_index("http://127.0.0.1:9", "unreachable", timeout=0.5))
    ports.provide(ProjectSearchSlot, ProjectSearchSlot(down))
    try:
        api.create_project(name="Open Solar Study", visibility="PUBLIC")
        assert discover(api, "solar") == ["Open Solar Study"]
    finally:
        ports.provide(ProjectSearchSlot, ProjectSearchSlot(None))


TOKEN = {"X-NAIS-Internal-Token": "s3cret"}


def demo_project(name: str) -> dict[str, object]:
    return {
        "project_id": str(uuid.uuid4()),
        "name": name,
        "lead_organization_id": str(uuid.uuid4()),
        "lead_organization_name": "한국에너지기술연구원",
        "member_count": 3,
        "updated_at": "2026-10-01T00:00:00+00:00",
    }


def test_internal_demo_projects_are_searched_through_their_own_index(
    app: FastAPI, api: ProjectApi, search: ProjectSearch
) -> None:
    from api.modules.project.settings import ProjectSettings, get_project_settings

    client = api.client
    fuel, climate = demo_project("연료전지 스택 공동연구"), demo_project("기후 관측 자료 정비")
    body = {"documents": [fuel, climate]}
    # Without NAIS_INTERNAL_TOKEN the endpoints do not exist; with it, the header is required.
    assert client.put("/api/v1/internal/demo/projects", json=body, headers=TOKEN).status_code == 404
    app.dependency_overrides[get_project_settings] = lambda: ProjectSettings(nais_internal_token="s3cret")
    assert client.put("/api/v1/internal/demo/projects", json=body).status_code == 403
    assert client.put("/api/v1/internal/demo/projects", content=b"{").status_code == 403

    ports.provide(ProjectSearchSlot, ProjectSearchSlot(None, search))
    response = client.put("/api/v1/internal/demo/projects", json=body, headers=TOKEN)
    assert response.status_code == 200, response.text
    assert response.json() == {"indexed": 2, "removed": 0}
    assert_matches_response("syncDemoProjects", 200, response.json())

    def find(q: str) -> list[str]:
        found = client.post("/api/v1/internal/demo/projects/search", json={"q": q}, headers=TOKEN)
        assert found.status_code == 200, found.text
        assert_matches_response("searchDemoProjects", 200, found.json())
        ids: list[str] = found.json()["project_ids"]
        return ids

    assert find("스택") == [fuel["project_id"]]
    assert find("fuel cell") == [fuel["project_id"]]
    assert find("에너지기술연구원") != []
    replaced = client.put("/api/v1/internal/demo/projects", json={"documents": [climate]}, headers=TOKEN)
    assert replaced.json() == {"indexed": 1, "removed": 1}
    assert find("fuel cell") == [] and find("climate") == [climate["project_id"]]
