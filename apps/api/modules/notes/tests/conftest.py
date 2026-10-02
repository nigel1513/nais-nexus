"""Notes fixtures: migrated schema, fake project/identity ports, a token issuer whose tokens carry auth_time."""

import json
from collections.abc import Iterator
from dataclasses import dataclass
from typing import Any
from uuid import UUID

import httpx
import pytest
from dramatiq.brokers.stub import StubBroker
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, text

from api.modules.notes import MODULE, jobs
from api.modules.notes.deps import NotesDeps
from api.modules.notes.settings import NotesSettings
from api.modules.notes.tests.fakes import (
    USERS,
    FakeEmbedder,
    FakeLlm,
    FakePeople,
    FakeProjects,
    FakeReranker,
)
from api.modules.notes.wiring import install
from api.modules.project.public import ProjectQueryPort
from api.platform import clock, ports
from api.platform.auth import CurrentUser, PrincipalResolver, TokenVerifier, get_token_verifier
from api.platform.broker import configure_broker
from api.platform.ids import new_id
from api.platform.migrate import upgrade_all
from api.platform.settings import Settings
from api.platform.testing.app import create_test_app
from api.platform.testing.fixtures import PgUrls
from api.platform.testing.tokens import FakeIssuer

ISSUER = FakeIssuer()
# The draft actor binds to the global Dramatiq broker when the module is imported (D-036); bind it to our StubBroker.
STUB_BROKER = configure_broker(Settings(), StubBroker())
for _actor in (jobs.draft_note_actor, jobs.embed_notes_actor):
    if _actor.broker is not STUB_BROKER:
        _actor.broker = STUB_BROKER
        STUB_BROKER.declare_actor(_actor)
TABLES = (
    "notes.embeddings, notes.signatures, notes.blocks, notes.notes, notes.chains, notes.settings, notes.evidence,"
    " notes.processed_events, notes.daily_runs"
)


@pytest.fixture(scope="session")
def notes_db(migrated_db: PgUrls) -> PgUrls:
    """Platform + notes migrations applied once per test session."""
    upgrade_all(migrated_db.migrator, [MODULE])
    return migrated_db


@pytest.fixture
def db(notes_db: PgUrls) -> Iterator[PgUrls]:
    """Empty notes tables, outbox and draft queue for every test (TRUNCATE fires no row triggers); the drafting job
    works on the test database."""
    engine = create_engine(notes_db.migrator)
    with engine.begin() as conn:
        conn.execute(text(f"TRUNCATE {TABLES}"))
        conn.execute(text("DELETE FROM platform.outbox_events"))
    engine.dispose()
    STUB_BROKER.flush_all()
    previous = jobs.RUNTIME.database_url
    jobs.RUNTIME.database_url = notes_db.app
    try:
        yield notes_db
    finally:
        jobs.RUNTIME.database_url = previous


class FakePrincipals:
    """PrincipalResolver stand-in for M01: the token `sub` is a key of fakes.USERS."""

    def resolve(self, claims: dict[str, Any], correlation_id: UUID) -> CurrentUser:
        return USERS[claims["sub"]]


@dataclass
class World:
    projects: FakeProjects
    people: FakePeople
    project_id: UUID
    llm: FakeLlm
    llm_enabled: bool = True
    # Search (Task 11): None = the embedding / rerank service is off (the default, as NAIS_LLM_ENABLED=false).
    embedder: FakeEmbedder | None = None
    reranker: FakeReranker | None = None

    def install(self) -> None:
        """(Re)register NotesDeps with this world's fakes; llm_enabled=False makes the platform LLM client None."""
        install(
            NotesDeps(
                settings=NotesSettings(),
                people=self.people,
                llm=lambda: self.llm if self.llm_enabled else None,
                embedder=lambda: self.embedder,
                reranker=lambda: self.reranker,
            )
        )


@pytest.fixture
def world() -> World:
    """One ACTIVE project: a.recorder, a.colleague (RESEARCHER), a.member (VIEWER), a.owner (PROJECT_OWNER) and the
    other organization's b.witness / b.recorder (joint project). a.admin, b.admin and c.outsider are not members."""
    projects = FakeProjects()
    project_id = new_id()
    projects.add(project_id, USERS["a.owner"], "PROJECT_OWNER")
    for name in ("a.recorder", "a.colleague", "b.witness", "b.recorder"):
        projects.add(project_id, USERS[name], "RESEARCHER")
    projects.add(project_id, USERS["a.member"], "VIEWER")
    ports.provide(ProjectQueryPort, projects)
    world = World(projects, FakePeople(), project_id, FakeLlm())
    world.install()
    return world


class NotesApi:
    def __init__(self, client: TestClient) -> None:
        self.client = client

    def request(
        self, method: str, user: str | None, path: str, *, auth_age: int | None = 0, **kwargs: Any
    ) -> httpx.Response:
        """auth_age: seconds since the user's last login (token auth_time relative to the server clock); None omits
        the claim."""
        headers: dict[str, str] = {}
        if user:
            claims: dict[str, Any] = {"sub": user}
            if auth_age is not None:
                claims["auth_time"] = int(clock.now().timestamp()) - auth_age
            headers["Authorization"] = f"Bearer {ISSUER.token(**claims)}"
        headers |= kwargs.pop("headers", None) or {}
        return self.client.request(method, f"/api/v1{path}", headers=headers, **kwargs)

    def get(self, user: str | None, path: str, **kwargs: Any) -> httpx.Response:
        return self.request("GET", user, path, **kwargs)

    def post(self, user: str | None, path: str, **kwargs: Any) -> httpx.Response:
        return self.request("POST", user, path, **kwargs)

    def put(self, user: str | None, path: str, **kwargs: Any) -> httpx.Response:
        return self.request("PUT", user, path, **kwargs)

    def patch(self, user: str | None, path: str, **kwargs: Any) -> httpx.Response:
        return self.request("PATCH", user, path, **kwargs)

    def delete(self, user: str | None, path: str, **kwargs: Any) -> httpx.Response:
        return self.request("DELETE", user, path, **kwargs)

    # ------------------------------------------------------------ scenario helpers

    def today(self, world: World, user: str = "a.recorder") -> dict[str, Any]:
        response = self.post(user, f"/projects/{world.project_id}/notes/today")
        assert response.status_code in (200, 201), response.text
        body: dict[str, Any] = response.json()
        return body

    def save(
        self, note: dict[str, Any], blocks: list[dict[str, Any]], user: str = "a.recorder"
    ) -> dict[str, Any]:
        response = self.put(
            user,
            f"/notes/{note['note_id']}/blocks",
            json={"blocks": blocks},
            headers={"If-Match": str(note["revision"])},
        )
        assert response.status_code == 200, response.text
        body: dict[str, Any] = response.json()
        return body

    def settings(self, world: World, **body: Any) -> dict[str, Any]:
        response = self.patch("a.owner", f"/projects/{world.project_id}/note-settings", json=body)
        assert response.status_code == 200, response.text
        result: dict[str, Any] = response.json()
        return result

    def witnessed(self, world: World) -> None:
        self.settings(world, witness_required=True, witness_user_ids=[str(USERS["b.witness"].user_id)])

    def written(
        self, world: World, text_: str = "40도 이상에서 용량 감소가 뚜렷하다.", user: str = "a.recorder"
    ) -> dict[str, Any]:
        """Today's DRAFT with one HUMAN MEMO block."""
        return self.save(self.today(world, user), [{"section": "MEMO", "text": text_}], user)

    def submitted(self, world: World, user: str = "a.recorder") -> dict[str, Any]:
        note = self.written(world, user=user)
        response = self.post(user, f"/notes/{note['note_id']}/submit")
        assert response.status_code == 200, response.text
        body: dict[str, Any] = response.json()
        return body

    def signed(self, world: World, user: str = "a.recorder") -> dict[str, Any]:
        """A note signed by its recorder alone (the project requires no witness)."""
        note = self.written(world, user=user)
        response = self.post(user, f"/notes/{note['note_id']}/sign")
        assert response.status_code == 200, response.text
        body: dict[str, Any] = response.json()
        assert body["status"] == "SIGNED"
        return body


@pytest.fixture
def api(db: PgUrls, world: World) -> Iterator[NotesApi]:
    app = create_test_app(modules=[MODULE], settings=Settings(database_url=db.app))
    world.install()
    app.dependency_overrides[get_token_verifier] = lambda: TokenVerifier(
        issuer=ISSUER.issuer, audience=ISSUER.audience, jwk_client=ISSUER.jwk_client()
    )
    ports.provide(PrincipalResolver, FakePrincipals())
    yield NotesApi(TestClient(app, raise_server_exceptions=False))


def sql(urls: PgUrls, statement: str, *, role: str = "migrator", **params: Any) -> list[dict[str, Any]]:
    """Run SQL bypassing the API (as the schema owner by default, or as the app role) and return rows as dicts."""
    engine = create_engine(urls.migrator if role == "migrator" else urls.app)
    try:
        with engine.begin() as conn:
            result = conn.execute(text(statement), params)
            return [dict(row) for row in result.mappings()] if result.returns_rows else []
    finally:
        engine.dispose()


def tamper(urls: PgUrls, table: str, statement: str, **params: Any) -> None:
    """Change stored rows behind the API's back with the table's guard triggers switched off (an attacker with
    direct database access), then switch them on again."""
    engine = create_engine(urls.migrator)
    try:
        with engine.begin() as conn:
            conn.execute(text(f"ALTER TABLE notes.{table} DISABLE TRIGGER USER"))
            conn.execute(text(statement), params)
            conn.execute(text(f"ALTER TABLE notes.{table} ENABLE TRIGGER USER"))
    finally:
        engine.dispose()


def outbox(urls: PgUrls, event_type: str | None = None) -> list[dict[str, Any]]:
    """Envelopes the notes module wrote to the outbox, oldest first."""
    rows = sql(
        urls,
        "SELECT envelope FROM platform.outbox_events WHERE envelope->>'producer' = 'notes' ORDER BY id",
    )
    envelopes = [row["envelope"] for row in rows]
    return [e for e in envelopes if event_type is None or e["event_type"] == event_type]


def add_ai_block(
    urls: PgUrls,
    note_id: str,
    text_: str,
    *,
    section: str = "STEPS",
    evidence: list[dict[str, Any]] | None = None,
) -> str:
    """Append an AI block the way the drafting job (Task 10) will: accepted=false, with evidence."""
    block_id = new_id()
    evidence = (
        evidence
        if evidence is not None
        else [
            {
                "type": "RUN_SUCCEEDED",
                "ref_id": str(new_id()),
                "label": "고온 구간 평균 용량@3 · 182,340행 → 24행",
                "at": "2026-10-01T05:01:20Z",
            }
        ]
    )
    sql(
        urls,
        "INSERT INTO notes.blocks (block_id, note_id, position, section, text, origin, accepted, evidence)"
        " SELECT :block_id, :note_id, coalesce(max(position) + 1, 0), :section, :text, 'AI', false,"
        " CAST(:evidence AS jsonb) FROM notes.blocks WHERE note_id = :note_id",
        block_id=block_id,
        note_id=note_id,
        section=section,
        text=text_,
        evidence=json.dumps(evidence, ensure_ascii=False),
    )
    return str(block_id)
