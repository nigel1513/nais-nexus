"""searchNotes (semantic search: bge-m3 cosine over the caller's readable notes, reranked top 50 -> 20; keyword
fallback with score null) and the embedding job `notes.embed_notes` / sweep `notes.embed_sweep`."""

import json
from collections.abc import Iterator
from datetime import UTC, date, datetime, timedelta
from typing import Any
from uuid import UUID

import pytest
from dramatiq.brokers.stub import StubBroker

from api.modules.notes import jobs
from api.modules.notes.deps import NotesDeps
from api.modules.notes.search import unit
from api.modules.notes.settings import NotesSettings
from api.modules.notes.tests.conftest import NotesApi, World, add_ai_block, sql
from api.modules.notes.tests.fakes import USERS, FakeEmbedder, FakeReranker
from api.platform import clock
from api.platform.ids import new_id
from api.platform.llm import LlmUnavailable
from api.platform.testing.contracts import assert_matches_response
from api.platform.testing.fixtures import PgUrls

NOW = datetime(2026, 10, 1, 3, 0, tzinfo=UTC)


@pytest.fixture(autouse=True)
def frozen() -> Iterator[None]:
    with clock.frozen(NOW):
        yield


@pytest.fixture
def semantic(world: World) -> World:
    """The embedding service on (no reranker)."""
    world.embedder = FakeEmbedder()
    world.install()
    return world


def search(api: NotesApi, user: str, q: str, **params: Any) -> list[dict[str, Any]]:
    response = api.get(user, "/notes/search", params={"q": q, **params})
    assert response.status_code == 200, response.text
    assert_matches_response("searchNotes", 200, response.json())
    items: list[dict[str, Any]] = response.json()["items"]
    return items


def ids(items: list[dict[str, Any]]) -> list[str]:
    return [i["note_id"] for i in items]


def note_on(api: NotesApi, world: World, day: int, text_: str, user: str = "a.recorder") -> dict[str, Any]:
    """A DRAFT of the user on 2026-10-<day> with one HUMAN MEMO block."""
    with clock.frozen(datetime(2026, 10, day, 3, 0, tzinfo=UTC)):
        return api.written(world, text_, user=user)


def embed_all(*notes: dict[str, Any]) -> int:
    return jobs.embed_notes([UUID(n["note_id"]) for n in notes])


def stored_embedding(db: PgUrls, note_id: str) -> dict[str, Any] | None:
    rows = sql(db, "SELECT * FROM notes.embeddings WHERE note_id = :id", id=note_id)
    return rows[0] if rows else None


def queued(queue: str) -> list[dict[str, Any]]:
    broker = jobs.embed_notes_actor.broker
    assert isinstance(broker, StubBroker)
    if queue not in broker.queues:
        return []
    return [json.loads(m) for m in list(broker.queues[queue].queue)]


def embed_messages() -> list[dict[str, Any]]:
    return [
        m
        for q in (jobs.QUEUE, f"{jobs.QUEUE}.DQ")
        for m in queued(q)
        if m["actor_name"] == "notes.embed_notes"
    ]


# ---------------------------------------------------------------- keyword fallback and scope


def test_keyword_fallback_finds_the_callers_readable_notes_only(api: NotesApi, world: World) -> None:
    api.witnessed(world)  # b.witness witnesses every submit from now on
    draft = api.written(world, "고온에서 용량 감소가 보였다.")
    submitted = api.submitted(world, user="a.colleague")  # "40도 이상에서 용량 감소가 뚜렷하다."

    mine = search(api, "a.recorder", "용량")
    assert ids(mine) == [draft["note_id"]]
    assert mine[0] | {"snippet": None} == {
        "note_id": draft["note_id"],
        "project_name": "전극 소재 열화 분석",
        "note_date": "2026-10-01",
        "snippet": None,
        "score": None,
    }
    assert "용량" in mine[0]["snippet"]

    # the witness of the submitted note finds it, never the other recorder's DRAFT
    assert ids(search(api, "b.witness", "용량")) == [submitted["note_id"]]
    assert ids(search(api, "a.colleague", "용량")) == [submitted["note_id"]]
    # other members, non-members and org admins see neither
    for user in ("a.member", "a.owner", "b.recorder", "a.admin", "c.outsider"):
        assert search(api, user, "용량") == [], user

    # a witness who left the project no longer finds it
    world.projects.remove(world.project_id, USERS["b.witness"])
    assert search(api, "b.witness", "용량") == []


def test_project_filter(api: NotesApi, world: World) -> None:
    note = api.written(world, "용량 측정")
    assert ids(search(api, "a.recorder", "용량", project_id=str(world.project_id))) == [note["note_id"]]
    assert search(api, "a.recorder", "용량", project_id=str(new_id())) == []


def test_unaccepted_ai_text_is_not_searched(api: NotesApi, world: World, db: PgUrls) -> None:
    note = api.written(world, "오늘은 측정만 했다.")
    add_ai_block(db, note["note_id"], "전해질 분해 반응을 확인했다.")
    assert search(api, "a.recorder", "전해질") == []
    sql(db, "UPDATE notes.blocks SET accepted = true WHERE origin = 'AI'")
    assert ids(search(api, "a.recorder", "전해질")) == [note["note_id"]]


def test_keyword_is_literal(api: NotesApi, world: World) -> None:
    api.written(world, "용량 감소")
    assert search(api, "a.recorder", "%") == []
    assert search(api, "a.recorder", "_") == []


def test_snippet_is_short_plain_text_around_the_match(api: NotesApi, world: World) -> None:
    long_text = "가" * 300 + "\n\n용량 감소가 뚜렷하다 " + "나" * 300
    note = api.save(
        api.today(world),
        [{"section": "DIRECTION", "text": "방향을 정했다."}, {"section": "RESULTS", "text": long_text}],
    )
    [hit] = search(api, "a.recorder", "용량")
    assert hit["note_id"] == note["note_id"]
    assert len(hit["snippet"]) <= 160
    assert "용량 감소가 뚜렷하다" in hit["snippet"]
    assert "\n" not in hit["snippet"]


def test_query_validation(api: NotesApi) -> None:
    assert api.get("a.recorder", "/notes/search", params={"q": ""}).status_code == 422
    assert api.get("a.recorder", "/notes/search", params={"q": "x" * 501}).status_code == 422
    assert api.get("a.recorder", "/notes/search").status_code == 422
    assert api.get("a.recorder", "/notes/search", params={"q": "용량\x00"}).status_code == 422
    blank = api.get("a.recorder", "/notes/search", params={"q": "   "})
    assert blank.status_code == 422 and blank.json()["error"]["code"] == "VALIDATION_FAILED"
    assert api.get(None, "/notes/search", params={"q": "용량"}).status_code == 401


# ---------------------------------------------------------------- semantic search


def test_semantic_search_ranks_by_cosine(api: NotesApi, semantic: World) -> None:
    both = note_on(api, semantic, 1, "용량 감소, 온도 영향")
    capacity = note_on(api, semantic, 2, "용량 용량 측정")
    electrode = note_on(api, semantic, 3, "전극 표면 확인")
    assert embed_all(both, capacity, electrode) == 3

    hits = search(api, "a.recorder", "용량")
    assert ids(hits) == [capacity["note_id"], both["note_id"], electrode["note_id"]]
    scores = [h["score"] for h in hits]
    assert all(isinstance(s, float) for s in scores) and scores == sorted(scores, reverse=True)
    # the query is embedded on the request path, alone
    assert semantic.embedder is not None and semantic.embedder.calls[-1] == ["용량"]


def test_rerank_orders_the_cosine_candidates(api: NotesApi, semantic: World) -> None:
    semantic.reranker = FakeReranker(lambda q, d: 0.9 if "전극" in d else 0.2)
    semantic.install()
    capacity = note_on(api, semantic, 1, "용량 용량 측정")
    electrode = note_on(api, semantic, 2, "전극 표면 확인")
    embed_all(capacity, electrode)

    hits = search(api, "a.recorder", "용량")
    assert ids(hits) == [electrode["note_id"], capacity["note_id"]]
    assert [h["score"] for h in hits] == [pytest.approx(0.9), pytest.approx(0.2)]
    [(query, documents)] = semantic.reranker.calls
    assert query == "용량" and len(documents) == 2


def bulk_notes(db: PgUrls, world: World, texts: list[str], *, embed: bool = True) -> list[str]:
    """DRAFT notes of a.recorder with the given texts (one per day back from 2026-09-30), embedded by the job."""
    note_ids = []
    for i, text_ in enumerate(texts):
        note_id = str(new_id())
        note_ids.append(note_id)
        sql(
            db,
            "INSERT INTO notes.notes (note_id, project_id, organization_id, recorder_id, note_date, version,"
            " status, revision, draft_status, created_at, updated_at)"
            " VALUES (:id, :p, :o, :r, :d, 1, 'DRAFT', 1, 'NONE', :t, :t)",
            id=note_id,
            p=world.project_id,
            o=USERS["a.recorder"].organization_id,
            r=USERS["a.recorder"].user_id,
            d=date(2026, 9, 30) - timedelta(days=i),
            t=NOW,
        )
        sql(
            db,
            "INSERT INTO notes.blocks (block_id, note_id, position, section, text, origin, accepted)"
            " VALUES (:b, :id, 0, 'MEMO', :text, 'HUMAN', true)",
            b=new_id(),
            id=note_id,
            text=text_,
        )
    if embed:
        assert jobs.embed_notes([UUID(n) for n in note_ids]) == len(note_ids)
    return note_ids


def test_cosine_top_50_reranked_to_top_20(api: NotesApi, semantic: World, db: PgUrls) -> None:
    bulk_notes(db, semantic, [f"온도 기록 {'용량 ' * (i % 7)}" for i in range(55)])
    assert len(search(api, "a.recorder", "용량")) == 20  # fused (no reranker): top 20

    semantic.reranker = FakeReranker(lambda q, d: float(len(d)))
    semantic.install()
    hits = search(api, "a.recorder", "용량")
    assert len(hits) == 20
    [(_, documents)] = semantic.reranker.calls
    # cosine top 50 united with the keyword top 20 (here all keyword hits are among the cosine top 50)
    assert len(documents) == 50
    assert [h["score"] for h in hits] == sorted((h["score"] for h in hits), reverse=True)


def test_an_unembedded_keyword_match_joins_the_candidates(api: NotesApi, semantic: World, db: PgUrls) -> None:
    bulk_notes(db, semantic, ["온도 기록"] * 25)
    pending = note_on(api, semantic, 1, "용량 감소")  # saved, not embedded yet
    hits = search(api, "a.recorder", "용량")
    assert len(hits) == 20 and pending["note_id"] in ids(hits)
    hit = next(h for h in hits if h["note_id"] == pending["note_id"])
    assert isinstance(hit["score"], float)  # fused rank, not null: semantic search ran

    # with the reranker the unembedded note gets a real rerank score
    semantic.reranker = FakeReranker(lambda q, d: 0.9 if q in d else 0.1)
    semantic.install()
    hits = search(api, "a.recorder", "용량")
    assert hits[0]["note_id"] == pending["note_id"] and hits[0]["score"] == pytest.approx(0.9)
    [(_, documents)] = semantic.reranker.calls
    assert len(documents) == 26


def test_a_literal_match_outside_the_cosine_top_50_still_appears(
    api: NotesApi, semantic: World, db: PgUrls
) -> None:
    # the query has no word the fake model knows, so plain notes are its nearest and the match is far away
    [target, *_] = bulk_notes(db, semantic, ["용량 용량 용량 시료 ABC-123", *["기록 일지"] * 60])
    hits = search(api, "a.recorder", "ABC-123")
    assert target in ids(hits)
    assert "ABC-123" in next(h for h in hits if h["note_id"] == target)["snippet"]


def test_embedding_service_down_falls_back_to_keywords(api: NotesApi, semantic: World) -> None:
    capacity = note_on(api, semantic, 1, "용량 측정")
    electrode = note_on(api, semantic, 2, "전극 확인")
    embed_all(capacity, electrode)
    assert semantic.embedder is not None
    semantic.embedder.fail = LlmUnavailable("down")
    hits = search(api, "a.recorder", "용량")
    assert ids(hits) == [capacity["note_id"]] and hits[0]["score"] is None


def test_rerank_failure_keeps_the_fused_order(api: NotesApi, semantic: World) -> None:
    semantic.reranker = FakeReranker()
    semantic.reranker.fail = LlmUnavailable("down")
    semantic.install()
    both = note_on(api, semantic, 1, "용량 온도")
    capacity = note_on(api, semantic, 2, "용량 용량")
    embed_all(both, capacity)
    assert ids(search(api, "a.recorder", "용량")) == [capacity["note_id"], both["note_id"]]


def test_semantic_scope_hides_other_recorders_drafts(api: NotesApi, semantic: World) -> None:
    api.witnessed(semantic)
    draft = note_on(api, semantic, 1, "용량 측정")
    with clock.frozen(datetime(2026, 10, 2, 3, 0, tzinfo=UTC)):
        submitted = api.submitted(semantic, user="a.colleague")
    embed_all(draft, submitted)
    assert ids(search(api, "a.colleague", "용량")) == [submitted["note_id"]]
    assert ids(search(api, "b.witness", "용량")) == [submitted["note_id"]]
    assert search(api, "a.member", "용량") == []


def test_only_the_latest_version_of_the_recorders_day_is_searched(api: NotesApi, semantic: World) -> None:
    signed = api.signed(semantic)
    revised = api.post("a.recorder", f"/notes/{signed['note_id']}/revise").json()
    embed_all(signed, revised)
    assert ids(search(api, "a.recorder", "용량")) == [revised["note_id"]]


# ---------------------------------------------------------------- embedding job


def test_embedding_uses_human_and_accepted_ai_text_once(api: NotesApi, semantic: World, db: PgUrls) -> None:
    note = api.written(semantic, "용량 측정")
    add_ai_block(db, note["note_id"], "전해질 분해 반응을 확인했다.")
    embedder = semantic.embedder
    assert embedder is not None

    assert embed_all(note) == 1
    assert embedder.calls == [["용량 측정"]]
    row = stored_embedding(db, note["note_id"])
    assert row is not None and row["version"] == 1
    assert len(row["text_hash"]) == 64
    assert row["vector"] == pytest.approx(unit(FakeEmbedder.vector("용량 측정")), rel=1e-6)
    assert sum(x * x for x in row["vector"]) == pytest.approx(1.0, rel=1e-5)

    # unchanged text: no second embedding
    assert embed_all(note) == 0
    assert len(embedder.calls) == 1

    # changed text: embedded again
    with clock.frozen(NOW + timedelta(minutes=5)):
        fresh = api.get("a.recorder", f"/notes/{note['note_id']}").json()
        api.save(fresh, [{"section": "MEMO", "text": "전극 확인"}])
    assert embed_all(note) == 1
    assert embedder.calls[-1] == ["전극 확인"]


def test_embedding_batches_several_notes_in_one_call(api: NotesApi, semantic: World) -> None:
    notes = [note_on(api, semantic, day, f"용량 {day}") for day in (1, 2, 3)]
    assert embed_all(*notes) == 3
    assert semantic.embedder is not None
    assert len(semantic.embedder.calls) == 1 and len(semantic.embedder.calls[0]) == 3


def test_embedding_service_down_leaves_notes_for_the_sweep(
    api: NotesApi, semantic: World, db: PgUrls
) -> None:
    note = api.written(semantic, "용량 측정")
    assert semantic.embedder is not None
    semantic.embedder.fail = LlmUnavailable("down")
    assert embed_all(note) == 0
    assert stored_embedding(db, note["note_id"]) is None


def test_saving_queues_an_embedding_while_the_service_is_on(api: NotesApi, world: World) -> None:
    api.written(world)  # service off: nothing queued
    assert embed_messages() == []
    world.embedder = FakeEmbedder()
    world.install()
    note = note_on(api, world, 2, "용량 측정")
    assert [m["args"] for m in embed_messages()] == [[[note["note_id"]]]]


def test_sweep_queues_missing_and_stale_embeddings(api: NotesApi, world: World, db: PgUrls) -> None:
    note = api.written(world, "용량 측정")
    assert jobs.embed_sweep() == 0  # service off
    world.embedder = FakeEmbedder()
    world.install()
    assert jobs.embed_sweep() == 1
    assert [m["args"] for m in embed_messages()] == [[[note["note_id"]]]]

    with clock.frozen(NOW + timedelta(minutes=1)):
        embed_all(note)
    assert jobs.embed_sweep() == 0

    # a change after the embedding makes it stale
    with clock.frozen(NOW + timedelta(minutes=2)):
        fresh = api.get("a.recorder", f"/notes/{note['note_id']}").json()
        api.save(fresh, [{"section": "MEMO", "text": "전극 확인"}])
    assert jobs.embed_sweep() == 1


def test_signing_does_not_re_embed_the_same_text(api: NotesApi, semantic: World, db: PgUrls) -> None:
    note = api.written(semantic, "용량 측정")
    embed_all(note)
    with clock.frozen(NOW + timedelta(minutes=1)):
        assert api.post("a.recorder", f"/notes/{note['note_id']}/sign").status_code == 200
    assert semantic.embedder is not None
    calls = len(semantic.embedder.calls)
    with clock.frozen(NOW + timedelta(minutes=2)):
        assert embed_all(note) == 0
        assert jobs.embed_sweep() == 0
    assert len(semantic.embedder.calls) == calls


def test_deleting_a_draft_removes_its_embedding(api: NotesApi, semantic: World, db: PgUrls) -> None:
    note = api.written(semantic, "용량 측정")
    embed_all(note)
    assert api.delete("a.recorder", f"/notes/{note['note_id']}").status_code == 204
    assert stored_embedding(db, note["note_id"]) is None


def test_search_uses_the_short_request_timeout(api: NotesApi, semantic: World) -> None:
    semantic.reranker = FakeReranker()
    semantic.install()
    embed_all(note_on(api, semantic, 1, "용량 측정"))
    semantic.lookups.clear()
    search(api, "a.recorder", "용량")
    assert semantic.lookups == [("embedder", {"timeout_s": 5.0}), ("reranker", {"timeout_s": 5.0})]


def test_search_timeout_setting(monkeypatch: pytest.MonkeyPatch) -> None:
    assert NotesSettings().nais_search_timeout_s == 5.0
    monkeypatch.setenv("NAIS_SEARCH_TIMEOUT_S", "2.5")
    assert NotesSettings().nais_search_timeout_s == 2.5
    assert NotesDeps(settings=NotesSettings(), people=None).embedder is not None  # type: ignore[arg-type]


def test_a_refused_text_gets_an_empty_vector_and_the_batch_goes_on(
    api: NotesApi, semantic: World, db: PgUrls
) -> None:
    notes = [
        note_on(api, semantic, day, text_) for day, text_ in ((1, "용량 1"), (2, "거부 2"), (3, "용량 3"))
    ]
    assert semantic.embedder is not None
    semantic.embedder.refuse = "거부"
    assert embed_all(*notes) == 3
    assert [len(c) for c in semantic.embedder.calls] == [3, 1, 1, 1]  # the batch, then one at a time
    vectors = [stored_embedding(db, n["note_id"]) for n in notes]
    assert all(v is not None for v in vectors)
    assert [len(v["vector"]) for v in vectors if v is not None] == [7, 0, 7]
    assert embed_all(*notes) == 0  # not retried until its text changes


def test_rows_are_stamped_with_the_notes_updated_at(api: NotesApi, semantic: World, db: PgUrls) -> None:
    note = api.written(semantic, "용량 측정")
    with clock.frozen(NOW + timedelta(hours=1)):
        embed_all(note)
    row = stored_embedding(db, note["note_id"])
    [stored] = sql(db, "SELECT updated_at FROM notes.notes WHERE note_id = :id", id=note["note_id"])
    assert row is not None and row["updated_at"] == stored["updated_at"]


def test_a_new_embedding_model_re_embeds(api: NotesApi, semantic: World, db: PgUrls) -> None:
    note = api.written(semantic, "용량 측정")
    embed_all(note)
    before = stored_embedding(db, note["note_id"])
    semantic.embed_model = "bge-m3-v2"
    semantic.install()
    assert embed_all(note) == 1
    after = stored_embedding(db, note["note_id"])
    assert before is not None and after is not None and before["text_hash"] != after["text_hash"]
