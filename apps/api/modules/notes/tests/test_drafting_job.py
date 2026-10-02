"""Local-LLM drafting: draftNote (recorder, DRAFT, rate limit, LLM switch), the `notes.draft_note` job (retry once on
an unusable answer, FAILED on an unreachable LLM, human blocks never touched, results for a note that left DRAFT
discarded) and the `notes.daily_drafts` schedule (KST 19:00-19:14 only)."""

import json
from datetime import UTC, date, datetime, timedelta
from typing import Any
from uuid import UUID

import pytest
from dramatiq.brokers.stub import StubBroker

from api.modules.notes import MODULE, jobs
from api.modules.notes.tests.conftest import NotesApi, World, sql
from api.modules.notes.tests.fakes import USERS
from api.platform import clock
from api.platform.ids import new_id
from api.platform.llm import LlmUnavailable
from api.platform.scheduler import Scheduler
from api.platform.testing.contracts import assert_matches_response
from api.platform.testing.fixtures import PgUrls

NOW = datetime(2026, 10, 1, 10, 30, tzinfo=UTC)  # 19:30 KST
TODAY = date(2026, 10, 1)
FAILED_MESSAGE = "초안을 만들지 못했습니다. 잠시 후 다시 시도하세요."


@pytest.fixture(autouse=True)
def frozen() -> Any:
    with clock.frozen(NOW):
        yield


def add_evidence(
    db: PgUrls,
    world: World,
    user: str = "a.recorder",
    kind: str = "RUN_SUCCEEDED",
    label: str = "고온 구간 평균 용량@3 · 182,340행 → 24행",
    *,
    at: datetime = NOW - timedelta(hours=1),
    day: date = TODAY,
    project_id: UUID | None = None,
) -> UUID:
    ref_id = new_id()
    sql(
        db,
        "INSERT INTO notes.evidence (evidence_id, project_id, actor_id, note_date, type, ref_id, label, at, payload)"
        " VALUES (:id, :p, :a, :d, :t, :r, :l, :at, CAST(:payload AS jsonb))",
        id=new_id(),
        p=project_id or world.project_id,
        a=USERS[user].user_id,
        d=day,
        t=kind,
        r=ref_id,
        l=label,
        at=at,
        payload=json.dumps({"organization_id": str(USERS[user].organization_id)}),
    )
    return ref_id


def good_answer(**sections: list[dict[str, Any]]) -> dict[str, Any]:
    return {"sections": {"DIRECTION": [], "STEPS": [], "RESULTS": [], "NEXT": [], **sections}}


def queued() -> list[dict[str, Any]]:
    broker = jobs.draft_note_actor.broker
    assert isinstance(broker, StubBroker)
    return [json.loads(m) for m in list(broker.queues[jobs.QUEUE].queue)]


def draft(api: NotesApi, note: dict[str, Any], user: str = "a.recorder") -> Any:
    return api.post(user, f"/notes/{note['note_id']}/draft")


def code(response: Any) -> str:
    result: str = response.json()["error"]["code"]
    return result


def stored_note(db: PgUrls, note_id: str) -> dict[str, Any]:
    [row] = sql(db, "SELECT * FROM notes.notes WHERE note_id = :id", id=note_id)
    return row


# ---------------------------------------------------------------- draftNote + job


def test_draft_appends_ai_blocks_from_the_days_evidence(api: NotesApi, world: World, db: PgUrls) -> None:
    note = api.written(world, "고온 구간 용량을 먼저 보기로 했다.")
    input_ref = add_evidence(
        db, world, kind="INPUT_ADDED", label="전극 열화 측정@v2", at=NOW - timedelta(hours=2)
    )
    run_ref = add_evidence(db, world)
    add_evidence(db, world, user="a.colleague", label="남의 실행")  # another researcher's day
    add_evidence(db, world, day=TODAY - timedelta(days=1), label="어제 실행")  # another day
    world.llm.script(
        good_answer(
            DIRECTION=[{"text": "고온 구간 용량을 우선 분석한다.", "evidence": []}],
            STEPS=[
                {"text": "측정 데이터 v2를 입력으로 추가하고 평균 레시피를 실행했다.", "evidence": [1, 2]}
            ],
            RESULTS=[{"text": "근거 없는 결과.", "evidence": []}],
        )
    )
    response = draft(api, note)
    assert response.status_code == 202, response.text
    assert_matches_response("draftNote", 202, response.json())
    assert response.json()["draft_status"] == "QUEUED"
    assert [m["args"] for m in queued()] == [[note["note_id"]]]
    assert queued()[0]["actor_name"] == "notes.draft_note"

    assert jobs.draft_note(UUID(note["note_id"])) == "DONE"

    [messages] = world.llm.calls
    user_message = messages[1].content
    assert "1. [INPUT_ADDED] 전극 열화 측정@v2" in user_message
    assert "2. [RUN_SUCCEEDED] 고온 구간 평균 용량@3 · 182,340행 → 24행" in user_message
    assert "남의 실행" not in user_message and "어제 실행" not in user_message
    assert "고온 구간 용량을 먼저 보기로 했다." in user_message

    body = api.get("a.recorder", f"/notes/{note['note_id']}").json()
    assert body["draft_status"] == "DONE" and body["draft_error"] is None
    assert body["revision"] == note["revision"] + 1
    assert [(b["section"], b["origin"], b["accepted"]) for b in body["blocks"]] == [
        ("MEMO", "HUMAN", True),
        ("DIRECTION", "AI", False),
        ("STEPS", "AI", False),
    ]
    assert body["blocks"][0] == note["blocks"][0]
    assert [e["ref_id"] for e in body["blocks"][2]["evidence"]] == [str(input_ref), str(run_ref)]
    assert body["blocks"][2]["evidence"][1]["label"] == "고온 구간 평균 용량@3 · 182,340행 → 24행"

    # the same answer again adds nothing (same evidence sets / same evidence-free text)
    with clock.frozen(NOW + timedelta(minutes=2)):
        assert draft(api, body).status_code == 202
        world.llm.script(
            good_answer(
                DIRECTION=[{"text": "고온 구간 용량을 우선 분석한다.", "evidence": []}],
                STEPS=[{"text": "다른 표현, 같은 근거.", "evidence": [2, 1]}],
            )
        )
        assert jobs.draft_note(UUID(note["note_id"])) == "DONE"
    assert len(api.get("a.recorder", f"/notes/{note['note_id']}").json()["blocks"]) == 3


def test_unusable_answer_twice_fails_and_keeps_human_blocks(api: NotesApi, world: World, db: PgUrls) -> None:
    note = api.written(world)
    add_evidence(db, world)
    world.llm.script(ValueError("no JSON object in LLM response"), {"sections": "nope"})
    assert draft(api, note).status_code == 202
    assert jobs.draft_note(UUID(note["note_id"])) == "FAILED"
    assert len(world.llm.calls) == 2
    body = api.get("a.recorder", f"/notes/{note['note_id']}").json()
    assert (body["draft_status"], body["draft_error"]) == ("FAILED", FAILED_MESSAGE)
    assert body["blocks"] == note["blocks"] and body["revision"] == note["revision"]


def test_unusable_answer_once_is_retried(api: NotesApi, world: World, db: PgUrls) -> None:
    note = api.written(world)
    add_evidence(db, world)
    world.llm.script(ValueError("bad"), good_answer(STEPS=[{"text": "실행했다.", "evidence": [1]}]))
    assert draft(api, note).status_code == 202
    assert jobs.draft_note(UUID(note["note_id"])) == "DONE"
    assert len(world.llm.calls) == 2
    assert [b["origin"] for b in api.get("a.recorder", f"/notes/{note['note_id']}").json()["blocks"]] == [
        "HUMAN",
        "AI",
    ]


def test_unreachable_llm_fails_without_retry(api: NotesApi, world: World, db: PgUrls) -> None:
    note = api.written(world)
    add_evidence(db, world)
    world.llm.script(LlmUnavailable("/v1/chat/completions: ReadTimeout"))
    assert draft(api, note).status_code == 202
    assert jobs.draft_note(UUID(note["note_id"])) == "FAILED"
    assert len(world.llm.calls) == 1
    body = api.get("a.recorder", f"/notes/{note['note_id']}").json()
    assert (body["draft_status"], body["draft_error"]) == ("FAILED", FAILED_MESSAGE)
    assert body["blocks"] == note["blocks"]
    # a later request clears the error
    with clock.frozen(NOW + timedelta(minutes=1, seconds=1)):
        again = draft(api, body)
    assert again.status_code == 202
    assert (again.json()["draft_status"], again.json()["draft_error"]) == ("QUEUED", None)


def test_nothing_to_draft_finishes_without_calling_the_llm(api: NotesApi, world: World) -> None:
    note = api.today(world)
    assert draft(api, note).status_code == 202
    assert jobs.draft_note(UUID(note["note_id"])) == "DONE"
    assert world.llm.calls == []


def test_duplicate_delivery_is_skipped(api: NotesApi, world: World, db: PgUrls) -> None:
    note = api.written(world)
    add_evidence(db, world)
    world.llm.script(good_answer(STEPS=[{"text": "실행했다.", "evidence": [1]}]))
    assert draft(api, note).status_code == 202
    assert jobs.draft_note(UUID(note["note_id"])) == "DONE"
    assert jobs.draft_note(UUID(note["note_id"])) == "SKIPPED"
    assert jobs.draft_note(new_id()) == "SKIPPED"
    assert len(world.llm.calls) == 1


def test_result_for_a_note_signed_meanwhile_is_discarded(api: NotesApi, world: World, db: PgUrls) -> None:
    note = api.written(world)
    add_evidence(db, world)

    def sign_first(messages: Any) -> dict[str, Any]:
        signed = api.post("a.recorder", f"/notes/{note['note_id']}/sign")
        assert signed.status_code == 200, signed.text
        return good_answer(STEPS=[{"text": "실행했다.", "evidence": [1]}])

    world.llm.script(sign_first)
    assert draft(api, note).status_code == 202
    assert jobs.draft_note(UUID(note["note_id"])) == "DISCARDED"
    after = stored_note(db, note["note_id"])
    assert after["status"] == "SIGNED"
    assert after["draft_status"] == "RUNNING"  # a SIGNED note is never written again
    blocks = api.get("a.recorder", f"/notes/{note['note_id']}").json()["blocks"]
    assert [b["origin"] for b in blocks] == ["HUMAN"]


def test_result_for_a_submitted_note_is_discarded(api: NotesApi, world: World, db: PgUrls) -> None:
    api.witnessed(world)
    note = api.written(world)
    add_evidence(db, world)

    def submit_first(messages: Any) -> dict[str, Any]:
        assert api.post("a.recorder", f"/notes/{note['note_id']}/submit").status_code == 200
        return good_answer(STEPS=[{"text": "실행했다.", "evidence": [1]}])

    world.llm.script(submit_first)
    assert draft(api, note).status_code == 202
    assert jobs.draft_note(UUID(note["note_id"])) == "DISCARDED"
    after = stored_note(db, note["note_id"])
    assert (after["status"], after["draft_status"]) == ("SUBMITTED", "RUNNING")
    assert sql(db, "SELECT count(*) AS n FROM notes.blocks WHERE note_id = :id", id=note["note_id"]) == [
        {"n": 1}
    ]


# ---------------------------------------------------------------- draftNote rules


def test_llm_disabled_is_503(api: NotesApi, world: World) -> None:
    note = api.written(world)
    world.llm_enabled = False
    response = draft(api, note)
    assert response.status_code == 503 and code(response) == "LLM_UNAVAILABLE"
    assert api.get("a.recorder", f"/notes/{note['note_id']}").json()["draft_status"] == "NONE"
    assert queued() == []
    settings = api.get("a.recorder", f"/projects/{world.project_id}/note-settings").json()
    assert settings["llm_enabled"] is False


def test_once_per_minute_per_note(api: NotesApi, world: World) -> None:
    note = api.written(world)
    assert draft(api, note).status_code == 202
    with clock.frozen(NOW + timedelta(seconds=59)):
        response = draft(api, note)
    assert response.status_code == 429 and code(response) == "RATE_LIMITED"
    with clock.frozen(NOW + timedelta(seconds=61)):
        assert draft(api, note).status_code == 202
    assert len(queued()) == 2


def test_recorder_and_draft_only(api: NotesApi, world: World) -> None:
    note = api.written(world)
    assert draft(api, note, "a.colleague").status_code == 404  # a DRAFT is the recorder's alone
    assert draft(api, note, "c.outsider").status_code == 404
    submitted = api.submitted(world, user="b.recorder")
    response = draft(api, submitted, "b.recorder")
    assert response.status_code == 409 and code(response) == "NOTE_LOCKED"
    assert draft(api, submitted, "a.colleague").status_code == 403
    assert queued() == []


# ---------------------------------------------------------------- daily schedule


def kst(hour: int, minute: int) -> datetime:
    return datetime(2026, 10, 1, hour - 9, minute, tzinfo=UTC)


def test_daily_drafts_only_inside_the_evening_window(api: NotesApi, world: World, db: PgUrls) -> None:
    add_evidence(db, world)
    for at in (kst(18, 59), kst(19, 15), kst(20, 0), kst(10, 0)):
        with clock.frozen(at):
            assert jobs.daily_drafts() == 0
    assert sql(db, "SELECT count(*) AS n FROM notes.notes") == [{"n": 0}]
    assert queued() == []


def test_daily_drafts_queue_the_days_recorders(api: NotesApi, world: World, db: PgUrls) -> None:
    existing = api.written(world)  # a.recorder already has today's DRAFT
    add_evidence(db, world)
    add_evidence(db, world, user="a.colleague")  # no note yet: one is created
    signed = api.signed(world, user="b.recorder")  # today's note already SIGNED: left alone
    add_evidence(db, world, user="b.recorder")
    add_evidence(db, world, user="c.outsider")  # not a member: ignored
    add_evidence(db, world, user="a.member", day=TODAY - timedelta(days=1))  # yesterday: ignored
    with clock.frozen(kst(19, 7)):
        assert jobs.daily_drafts() == 2
        assert jobs.daily_drafts() == 0  # a second run inside the window queues nothing new
    notes = sql(
        db,
        "SELECT note_id, recorder_id, status, draft_status, version FROM notes.notes ORDER BY recorder_id",
    )
    by_user = {r["recorder_id"]: r for r in notes}
    assert by_user[USERS["a.recorder"].user_id]["note_id"] == UUID(existing["note_id"])
    assert by_user[USERS["a.recorder"].user_id]["draft_status"] == "QUEUED"
    colleague = by_user[USERS["a.colleague"].user_id]
    assert (colleague["status"], colleague["draft_status"], colleague["version"]) == ("DRAFT", "QUEUED", 1)
    assert by_user[USERS["b.recorder"].user_id]["note_id"] == UUID(signed["note_id"])
    assert by_user[USERS["b.recorder"].user_id]["draft_status"] == "NONE"
    assert USERS["c.outsider"].user_id not in by_user
    assert sorted(m["args"][0] for m in queued()) == sorted([existing["note_id"], str(colleague["note_id"])])
    [org] = sql(db, "SELECT organization_id FROM notes.notes WHERE note_id = :id", id=colleague["note_id"])
    assert org["organization_id"] == USERS["a.colleague"].organization_id


def test_daily_drafts_do_nothing_when_the_llm_is_off(api: NotesApi, world: World, db: PgUrls) -> None:
    add_evidence(db, world)
    world.llm_enabled = False
    with clock.frozen(kst(19, 0)):
        assert jobs.daily_drafts() == 0
    assert queued() == []


def test_worker_registration() -> None:
    scheduler = Scheduler()
    jobs.register_worker(jobs.draft_note_actor.broker, scheduler)
    assert scheduler.job_names == ["notes.daily_drafts"]
    assert jobs.draft_note_actor.actor_name == "notes.draft_note"
    assert jobs.draft_note_actor.queue_name == "notes"
    assert MODULE.register_worker is jobs.register_worker
    assert MODULE.dedicated_queues == {"notes": 1}
    with pytest.raises(RuntimeError, match="broker"):
        jobs.register_worker(StubBroker(), Scheduler())
