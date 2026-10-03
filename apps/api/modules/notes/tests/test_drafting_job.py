"""Local-LLM drafting of the standard template from the day's notebooks: draftNote (recorder, DRAFT, notebook activity
required, rate limit, LLM switch), the `notes.draft_note` job (retry once on an unusable answer, FAILED on an
unreachable LLM, human blocks never touched, results for a note that left DRAFT discarded) and the
`notes.daily_drafts` schedule (once per KST day, from 19:00, for the day's notebook authors)."""

import json
from datetime import UTC, date, datetime, timedelta
from typing import Any
from uuid import UUID

import pytest
from dramatiq.brokers.stub import StubBroker

from api.modules.notes import MODULE, jobs
from api.modules.notes.interfaces import NotebookActivity, NotebookActivityPort, NotebookCell
from api.modules.notes.tests.conftest import NotesApi, World, sql
from api.modules.notes.tests.fakes import USERS, notebook
from api.platform import clock, ports
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


def add_notebook(
    world: World,
    user: str = "a.recorder",
    *,
    day: date = TODAY,
    project_id: UUID | None = None,
    **kwargs: Any,
) -> NotebookActivity:
    """A notebook the user saved in the project on the day (default: today, an hour ago, 3 cells: 1 markdown)."""
    kwargs.setdefault("saved_at", NOW - timedelta(hours=1))
    saved = notebook(**kwargs) if "title" not in kwargs else notebook(kwargs.pop("title"), **kwargs)
    world.notebooks.add(USERS[user], project_id or world.project_id, day, saved)
    return saved


def good_answer(**sections: list[dict[str, Any]]) -> dict[str, Any]:
    names = ("OBJECTIVE", "METHOD", "PROCEDURE", "RESULTS", "DISCUSSION", "NEXT", "REFERENCES")
    return {name: [] for name in names} | sections


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


def test_draft_appends_template_blocks_from_the_days_notebooks(
    api: NotesApi, world: World, db: PgUrls
) -> None:
    saved = add_notebook(world)
    note = api.written(world, "40도 이상에서 용량 감소가 뚜렷하다.")
    add_notebook(world, "a.colleague", title="남의 노트북")  # another researcher's day
    add_notebook(world, day=TODAY - timedelta(days=1), title="어제 노트북")  # another day
    add_notebook(world, project_id=new_id(), title="다른 과제 노트북")  # another project
    add_evidence(db, world, label="작업 공간 실행 근거")  # workspace evidence: listed on screen, never sent
    assert note["draft_source_count"] == 1
    world.llm.script(
        good_answer(
            OBJECTIVE=[{"text": "고온 구간 용량 감소를 확인한다.", "evidence": ["1.1"]}],
            METHOD=[{"text": "pandas로 충방전 데이터를 분석했다.", "evidence": ["1.2"]}],
            PROCEDURE=[{"text": "측정 데이터를 읽고 온도별 평균 용량을 그렸다.", "evidence": ["1.2", "1.3"]}],
            RESULTS=[
                {"text": "근거 없는 결과.", "evidence": []},
                {"text": "그래프가 출력되었다.", "evidence": ["1.3"]},
            ],
            DISCUSSION=[{"text": "설명 셀 근거가 없는 고찰.", "evidence": ["1.2"]}],
            NEXT=[{"text": "저온 구간도 확인한다.", "evidence": ["1.1"]}],
            REFERENCES=[{"text": "고온 구간 용량 분석 노트북.", "evidence": ["1"]}],
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
    assert "[1] 노트북 '고온 구간 용량 분석' (저장 18:30)" in user_message
    assert "[1.1] 설명: ## 목표: 40도 이상 고온 구간의 용량 감소를 확인한다" in user_message
    assert (
        "[1.3] 코드: df.groupby('temp').capacity.mean().plot() / 출력: display_data 1개, 오류 없음"
        in user_message
    )
    for absent in (
        "남의 노트북",
        "어제 노트북",
        "다른 과제 노트북",
        "작업 공간 실행 근거",
        "40도 이상에서 용량",
    ):
        assert absent not in user_message
    assert "[2]" not in user_message

    body = api.get("a.recorder", f"/notes/{note['note_id']}").json()
    assert body["draft_status"] == "DONE" and body["draft_error"] is None
    assert body["revision"] == note["revision"] + 1
    assert [(b["section"], b["origin"], b["accepted"]) for b in body["blocks"]] == [
        ("OBJECTIVE", "AI", False),
        ("METHOD", "AI", False),
        ("PROCEDURE", "AI", False),
        ("RESULTS", "HUMAN", True),
        ("RESULTS", "AI", False),
        ("NEXT", "AI", False),
        ("REFERENCES", "AI", False),
    ]
    assert body["blocks"][3] == note["blocks"][0]
    procedure = body["blocks"][2]["evidence"]
    assert procedure == [
        {
            "type": "NOTEBOOK",
            "ref_id": str(saved.version_id),
            "label": f"{saved.title} · 셀 {k}",
            "at": "2026-10-01T09:30:00Z",
        }
        for k in (2, 3)
    ]
    assert body["blocks"][6]["evidence"][0]["label"] == saved.title

    # the same answer again adds nothing (same evidence sets)
    with clock.frozen(NOW + timedelta(minutes=2)):
        assert draft(api, body).status_code == 202
        world.llm.script(
            good_answer(
                OBJECTIVE=[{"text": "다른 표현, 같은 근거.", "evidence": ["1.1"]}],
                PROCEDURE=[{"text": "다른 표현, 같은 근거.", "evidence": ["1.3", "1.2"]}],
            )
        )
        assert jobs.draft_note(UUID(note["note_id"])) == "DONE"
    assert len(api.get("a.recorder", f"/notes/{note['note_id']}").json()["blocks"]) == 7


def test_output_values_from_the_port_never_reach_the_llm(api: NotesApi, world: World) -> None:
    from dataclasses import dataclass

    @dataclass(frozen=True)
    class LeakyCell(NotebookCell):
        outputs: tuple[str, ...] = ("SECRET-OUTPUT 홍길동 010-1234-5678",)

    note = api.today(world)
    leaky = LeakyCell("code", "print(df.head())", ("stream",), 1, False)
    world.notebooks.add(
        USERS["a.recorder"],
        world.project_id,
        TODAY,
        notebook("분석", leaky, saved_at=NOW - timedelta(hours=1)),
    )
    world.llm.script(good_answer())
    assert draft(api, note).status_code == 202
    assert jobs.draft_note(UUID(note["note_id"])) == "DONE"
    text = "\n".join(m.content for m in world.llm.calls[0])
    assert "print(df.head())" in text
    for secret in ("SECRET", "홍길동", "010-1234-5678"):
        assert secret not in text


def test_no_notebook_activity_is_422(api: NotesApi, world: World, db: PgUrls) -> None:
    note = api.written(world)
    add_evidence(db, world)  # workspace activity alone is no drafting source
    assert note["draft_source_count"] == 0
    response = draft(api, note)
    assert response.status_code == 422, response.text
    error = response.json()["error"]
    assert error["code"] == "VALIDATION_FAILED"
    assert error["details"]["reason"] == "NO_NOTEBOOK_ACTIVITY"
    assert error["message"] == "오늘 저장한 노트북이 없습니다."
    assert stored_note(db, note["note_id"])["draft_status"] == "NONE"
    assert queued() == [] and world.llm.calls == []


def test_default_port_has_no_activity(api: NotesApi, world: World) -> None:
    from api.modules.notes.adapters import NoNotebooks

    ports.provide(NotebookActivityPort, NoNotebooks())  # what wire() provides until M07 replaces it
    note = api.today(world)
    assert note["draft_source_count"] == 0
    response = draft(api, note)
    assert response.status_code == 422
    assert response.json()["error"]["details"]["reason"] == "NO_NOTEBOOK_ACTIVITY"


def test_draft_source_count_is_for_the_recorder_only(api: NotesApi, world: World) -> None:
    api.witnessed(world)
    add_notebook(world)
    add_notebook(world, title="두 번째", saved_at=NOW - timedelta(minutes=10))
    note = api.written(world)
    assert note["draft_source_count"] == 2
    assert api.get("a.recorder", f"/notes/{note['note_id']}").json()["draft_source_count"] == 2
    submitted = api.post("a.recorder", f"/notes/{note['note_id']}/submit").json()
    assert submitted["draft_source_count"] == 2
    witness_view = api.get("b.witness", f"/notes/{note['note_id']}")
    assert witness_view.status_code == 200
    assert witness_view.json()["draft_source_count"] == 0
    assert_matches_response("getNote", 200, witness_view.json())


def test_notebook_port_failure_fails_the_draft(api: NotesApi, world: World, db: PgUrls) -> None:
    note = api.written(world)
    add_notebook(world)
    assert draft(api, note).status_code == 202

    class Broken:
        def list_notebook_activity(self, *args: Any) -> list[NotebookActivity]:
            raise RuntimeError("notebook store down")

        def count_notebooks(self, *args: Any) -> int:
            raise RuntimeError("notebook store down")

        def list_notebook_authors(self, day: date) -> list[tuple[UUID, UUID]]:
            return []

    ports.provide(NotebookActivityPort, Broken())
    with pytest.raises(RuntimeError):
        jobs.draft_note(UUID(note["note_id"]))
    after = stored_note(db, note["note_id"])
    assert (after["draft_status"], after["draft_error"]) == ("FAILED", FAILED_MESSAGE)


def test_unusable_answer_twice_fails_and_keeps_human_blocks(api: NotesApi, world: World, db: PgUrls) -> None:
    note = api.written(world)
    add_notebook(world)
    world.llm.script(ValueError("no JSON object in LLM response"), {"sections": "nope"})
    assert draft(api, note).status_code == 202
    assert jobs.draft_note(UUID(note["note_id"])) == "FAILED"
    assert len(world.llm.calls) == 2
    body = api.get("a.recorder", f"/notes/{note['note_id']}").json()
    assert (body["draft_status"], body["draft_error"]) == ("FAILED", FAILED_MESSAGE)
    assert body["blocks"] == note["blocks"] and body["revision"] == note["revision"]


def test_unusable_answer_once_is_retried(api: NotesApi, world: World, db: PgUrls) -> None:
    note = api.written(world)
    add_notebook(world)
    world.llm.script(ValueError("bad"), good_answer(PROCEDURE=[{"text": "실행했다.", "evidence": ["1.2"]}]))
    assert draft(api, note).status_code == 202
    assert jobs.draft_note(UUID(note["note_id"])) == "DONE"
    assert len(world.llm.calls) == 2
    blocks = api.get("a.recorder", f"/notes/{note['note_id']}").json()["blocks"]
    assert [(b["section"], b["origin"]) for b in blocks] == [("PROCEDURE", "AI"), ("RESULTS", "HUMAN")]


def test_unreachable_llm_fails_without_retry(api: NotesApi, world: World, db: PgUrls) -> None:
    note = api.written(world)
    add_notebook(world)
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


def test_notebooks_gone_by_the_job_finish_without_calling_the_llm(api: NotesApi, world: World) -> None:
    note = api.today(world)
    add_notebook(world)
    assert draft(api, note).status_code == 202
    world.notebooks.saved.clear()
    assert jobs.draft_note(UUID(note["note_id"])) == "DONE"
    assert world.llm.calls == []


def test_duplicate_delivery_is_skipped(api: NotesApi, world: World, db: PgUrls) -> None:
    note = api.written(world)
    add_notebook(world)
    world.llm.script(good_answer(PROCEDURE=[{"text": "실행했다.", "evidence": ["1.2"]}]))
    assert draft(api, note).status_code == 202
    assert jobs.draft_note(UUID(note["note_id"])) == "DONE"
    assert jobs.draft_note(UUID(note["note_id"])) == "SKIPPED"
    assert jobs.draft_note(new_id()) == "SKIPPED"
    assert len(world.llm.calls) == 1


def test_result_for_a_note_signed_meanwhile_is_discarded(api: NotesApi, world: World, db: PgUrls) -> None:
    note = api.written(world)
    add_notebook(world)

    def sign_first(messages: Any) -> dict[str, Any]:
        signed = api.post("a.recorder", f"/notes/{note['note_id']}/sign")
        assert signed.status_code == 200, signed.text
        return good_answer(PROCEDURE=[{"text": "실행했다.", "evidence": ["1.2"]}])

    world.llm.script(sign_first)
    assert draft(api, note).status_code == 202
    assert jobs.draft_note(UUID(note["note_id"])) == "DISCARDED"
    after = stored_note(db, note["note_id"])
    assert after["status"] == "SIGNED"
    assert (after["draft_status"], after["draft_error"]) == ("NONE", None)  # reset as it left DRAFT
    blocks = api.get("a.recorder", f"/notes/{note['note_id']}").json()["blocks"]
    assert [b["origin"] for b in blocks] == ["HUMAN"]


def test_result_for_a_submitted_note_is_discarded(api: NotesApi, world: World, db: PgUrls) -> None:
    api.witnessed(world)
    note = api.written(world)
    add_notebook(world)

    def submit_first(messages: Any) -> dict[str, Any]:
        assert api.post("a.recorder", f"/notes/{note['note_id']}/submit").status_code == 200
        return good_answer(PROCEDURE=[{"text": "실행했다.", "evidence": ["1.2"]}])

    world.llm.script(submit_first)
    assert draft(api, note).status_code == 202
    assert jobs.draft_note(UUID(note["note_id"])) == "DISCARDED"
    after = stored_note(db, note["note_id"])
    assert (after["status"], after["draft_status"]) == ("SUBMITTED", "NONE")
    assert sql(db, "SELECT count(*) AS n FROM notes.blocks WHERE note_id = :id", id=note["note_id"]) == [
        {"n": 1}
    ]


def test_result_after_submit_and_reject_round_trip_is_discarded(
    api: NotesApi, world: World, db: PgUrls
) -> None:
    """claim -> submit -> witness rejects back to DRAFT -> the old answer arrives: it belongs to no request."""
    api.witnessed(world)
    note = api.written(world)
    add_notebook(world)

    def round_trip(messages: Any) -> dict[str, Any]:
        assert api.post("a.recorder", f"/notes/{note['note_id']}/submit").status_code == 200
        rejected = api.post("b.witness", f"/notes/{note['note_id']}/reject", json={"reason": "근거 보완"})
        assert rejected.status_code == 200, rejected.text
        assert rejected.json()["draft_status"] == "NONE"
        return good_answer(PROCEDURE=[{"text": "실행했다.", "evidence": ["1.2"]}])

    world.llm.script(round_trip)
    assert draft(api, note).status_code == 202
    assert jobs.draft_note(UUID(note["note_id"])) == "DISCARDED"
    after = stored_note(db, note["note_id"])
    assert (after["status"], after["draft_status"], after["draft_error"]) == ("DRAFT", "NONE", None)
    assert sql(db, "SELECT count(*) AS n FROM notes.blocks WHERE note_id = :id", id=note["note_id"]) == [
        {"n": 1}
    ]


def test_result_for_a_superseded_request_is_discarded(api: NotesApi, world: World, db: PgUrls) -> None:
    """A stale RUNNING draft re-requested by the recorder: the old run's late answer is not applied."""
    note = api.written(world)
    add_notebook(world)

    def re_requested(messages: Any) -> dict[str, Any]:
        with clock.frozen(NOW + jobs.STALE_AFTER + timedelta(seconds=1)):
            assert draft(api, note).status_code == 202
        return good_answer(PROCEDURE=[{"text": "실행했다.", "evidence": ["1.2"]}])

    world.llm.script(re_requested)
    assert draft(api, note).status_code == 202
    assert jobs.draft_note(UUID(note["note_id"])) == "DISCARDED"
    assert stored_note(db, note["note_id"])["draft_status"] == "QUEUED"  # the new request runs next
    assert len(queued()) == 2


def test_time_limit_fails_the_draft(api: NotesApi, world: World, db: PgUrls) -> None:
    from dramatiq.middleware import TimeLimitExceeded

    note = api.written(world)
    add_notebook(world)
    world.llm.script(TimeLimitExceeded())
    assert draft(api, note).status_code == 202
    jobs.draft_note_actor(note["note_id"])  # the actor body, as the worker runs it
    body = api.get("a.recorder", f"/notes/{note['note_id']}").json()
    assert (body["draft_status"], body["draft_error"]) == ("FAILED", FAILED_MESSAGE)
    assert body["blocks"] == note["blocks"]


def test_truncated_answer_fails_without_retry(api: NotesApi, world: World, db: PgUrls) -> None:
    from api.platform.llm import LlmTruncated

    note = api.written(world)
    add_notebook(world)
    world.llm.script(LlmTruncated("cut"))
    assert draft(api, note).status_code == 202
    assert jobs.draft_note(UUID(note["note_id"])) == "FAILED"
    assert len(world.llm.calls) == 1
    assert world.llm.max_tokens == [jobs.MAX_TOKENS]
    assert jobs.MAX_TOKENS >= 2048


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
    add_notebook(world)
    note = api.written(world)
    assert draft(api, note).status_code == 202
    with clock.frozen(NOW + timedelta(seconds=59)):
        response = draft(api, note)
    assert response.status_code == 429 and code(response) == "RATE_LIMITED"
    with clock.frozen(NOW + timedelta(seconds=61)):  # still QUEUED: accepted, nothing sent twice
        again = draft(api, note)
    assert again.status_code == 202 and again.json()["draft_status"] == "QUEUED"
    assert len(queued()) == 1
    with clock.frozen(NOW + jobs.STALE_AFTER + timedelta(seconds=1)):  # stuck past the time limit: reclaimed
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


def test_daily_drafts_never_before_19_kst(api: NotesApi, world: World, db: PgUrls) -> None:
    add_notebook(world)
    for at in (kst(18, 59), kst(10, 0), kst(9, 0)):
        with clock.frozen(at):
            assert jobs.daily_drafts() == 0
    assert sql(db, "SELECT count(*) AS n FROM notes.notes") == [{"n": 0}]
    assert sql(db, "SELECT count(*) AS n FROM notes.daily_runs") == [{"n": 0}]
    assert queued() == []


def test_daily_drafts_run_once_per_day_with_catch_up(api: NotesApi, world: World, db: PgUrls) -> None:
    """A worker down at 19:00 catches up at its first tick that evening; later ticks that day do nothing."""
    add_notebook(world)
    with clock.frozen(kst(21, 40)):
        assert jobs.daily_drafts() == 1
    sql(db, "UPDATE notes.notes SET draft_status = 'DONE'")
    with clock.frozen(kst(22, 0)):
        assert jobs.daily_drafts() == 0
    assert [r["run_date"] for r in sql(db, "SELECT run_date FROM notes.daily_runs")] == [TODAY]
    next_day = datetime(2026, 10, 2, 10, 5, tzinfo=UTC)  # 19:05 KST the next day
    add_notebook(world, day=TODAY + timedelta(days=1), saved_at=next_day - timedelta(hours=1))
    with clock.frozen(next_day):
        assert jobs.daily_drafts() == 1


def test_daily_drafts_one_failing_recorder_does_not_block_others(
    api: NotesApi, world: World, db: PgUrls, monkeypatch: pytest.MonkeyPatch
) -> None:
    add_notebook(world)
    add_notebook(world, "a.colleague")
    real = jobs._queue_daily

    def flaky(session: Any, project_id: UUID, recorder_id: UUID, *args: Any) -> bool:
        if recorder_id == USERS["a.recorder"].user_id:
            raise RuntimeError("boom")
        return real(session, project_id, recorder_id, *args)

    monkeypatch.setattr(jobs, "_queue_daily", flaky)
    with clock.frozen(kst(19, 1)):
        assert jobs.daily_drafts() == 1
    [note] = sql(db, "SELECT recorder_id, draft_status FROM notes.notes")
    assert (note["recorder_id"], note["draft_status"]) == (USERS["a.colleague"].user_id, "QUEUED")


def test_daily_drafts_reclaim_a_stuck_draft(api: NotesApi, world: World, db: PgUrls) -> None:
    note = api.written(world)
    add_notebook(world)
    sql(
        db,
        "UPDATE notes.notes SET draft_status = 'RUNNING', draft_requested_at = :at WHERE note_id = :id",
        at=kst(19, 0) - jobs.STALE_AFTER - timedelta(minutes=1),
        id=note["note_id"],
    )
    with clock.frozen(kst(19, 0)):
        assert jobs.daily_drafts() == 1
    assert stored_note(db, note["note_id"])["draft_status"] == "QUEUED"


def test_daily_drafts_queue_the_days_recorders(api: NotesApi, world: World, db: PgUrls) -> None:
    existing = api.written(world)  # a.recorder already has today's DRAFT
    add_notebook(world)
    add_notebook(world, "a.colleague")  # no note yet: one is created
    signed = api.signed(world, user="b.recorder")  # today's note already SIGNED: left alone
    add_notebook(world, "b.recorder")
    add_notebook(world, "c.outsider")  # not a member: ignored
    add_notebook(world, "a.member", day=TODAY - timedelta(days=1))  # yesterday: ignored
    with clock.frozen(kst(19, 7)):
        assert jobs.daily_drafts() == 2
        assert jobs.daily_drafts() == 0  # one run per day
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


def test_daily_drafts_follow_notebook_authors_not_workspace_evidence(
    api: NotesApi, world: World, db: PgUrls
) -> None:
    add_evidence(db, world)  # workspace activity alone: nobody is drafted
    with clock.frozen(kst(19, 5)):
        assert jobs.daily_drafts() == 0
    assert sql(db, "SELECT count(*) AS n FROM notes.notes") == [{"n": 0}]
    assert queued() == []


def test_daily_drafts_with_the_default_port_do_nothing(api: NotesApi, world: World, db: PgUrls) -> None:
    from api.modules.notes.adapters import NoNotebooks

    ports.provide(NotebookActivityPort, NoNotebooks())
    with clock.frozen(kst(19, 5)):
        assert jobs.daily_drafts() == 0
    assert sql(db, "SELECT count(*) AS n FROM notes.notes") == [{"n": 0}]


def test_daily_drafts_do_nothing_when_the_llm_is_off(api: NotesApi, world: World, db: PgUrls) -> None:
    add_notebook(world)
    world.llm_enabled = False
    with clock.frozen(kst(19, 0)):
        assert jobs.daily_drafts() == 0
    assert queued() == []


def test_worker_registration() -> None:
    scheduler = Scheduler()
    jobs.register_worker(jobs.draft_note_actor.broker, scheduler)
    assert scheduler.job_names == ["notes.daily_drafts", "notes.embed_sweep"]
    assert scheduler._jobs[0].next_run <= scheduler._clock()  # runs at worker start (evening catch-up)
    assert jobs.draft_note_actor.actor_name == "notes.draft_note"
    assert jobs.draft_note_actor.queue_name == "notes"
    assert jobs.embed_notes_actor.actor_name == "notes.embed_notes"
    assert jobs.embed_notes_actor.queue_name == "notes"
    assert MODULE.register_worker is jobs.register_worker
    assert MODULE.dedicated_queues == {"notes": 1}
    with pytest.raises(RuntimeError, match="broker"):
        jobs.register_worker(StubBroker(), Scheduler())


def test_draft_source_count_fails_soft(api: NotesApi, world: World, caplog: pytest.LogCaptureFixture) -> None:
    note = api.today(world)

    class Broken:
        def list_notebook_activity(self, *args: Any) -> list[NotebookActivity]:
            raise RuntimeError("SECRET notebook store detail")

        def count_notebooks(self, *args: Any) -> int:
            raise RuntimeError("SECRET notebook store detail")

        def list_notebook_authors(self, day: date) -> list[tuple[UUID, UUID]]:
            return []

    ports.provide(NotebookActivityPort, Broken())
    response = api.get("a.recorder", f"/notes/{note['note_id']}")
    assert response.status_code == 200, response.text
    assert response.json()["draft_source_count"] == 0
    [record] = [r for r in caplog.records if r.getMessage() == "draft source count unavailable"]
    assert record.levelname == "WARNING" and record.error_type == "RuntimeError"
    assert "SECRET" not in record.getMessage()


def test_after_a_422_the_draft_works_once_notebooks_appear(api: NotesApi, world: World, db: PgUrls) -> None:
    note = api.written(world)
    assert draft(api, note).status_code == 422
    assert stored_note(db, note["note_id"])["draft_requested_at"] is None  # no rate-limit slot used
    add_notebook(world)
    response = draft(api, note)
    assert response.status_code == 202, response.text
    assert response.json()["draft_source_count"] == 1


def test_notebook_source_failure_on_request_is_503(api: NotesApi, world: World, db: PgUrls) -> None:
    note = api.written(world)

    class Broken:
        def list_notebook_activity(self, *args: Any) -> list[NotebookActivity]:
            raise RuntimeError("down")

        def count_notebooks(self, *args: Any) -> int:
            raise RuntimeError("down")

        def list_notebook_authors(self, day: date) -> list[tuple[UUID, UUID]]:
            return []

    ports.provide(NotebookActivityPort, Broken())
    response = draft(api, note)
    assert response.status_code == 503 and code(response) == "DEPENDENCY_UNAVAILABLE"
    assert stored_note(db, note["note_id"])["draft_status"] == "NONE"
    assert queued() == []


def test_daily_drafts_retry_when_the_author_list_fails(api: NotesApi, world: World, db: PgUrls) -> None:
    add_notebook(world)
    real = world.notebooks.list_notebook_authors
    calls: list[date] = []

    def flaky(day: date) -> list[tuple[UUID, UUID]]:
        calls.append(day)
        if len(calls) == 1:
            raise RuntimeError("notebook store down")
        return real(day)

    world.notebooks.list_notebook_authors = flaky  # type: ignore[method-assign]
    with clock.frozen(kst(19, 0)):
        assert jobs.daily_drafts() == 0
    assert sql(db, "SELECT count(*) AS n FROM notes.daily_runs") == [{"n": 0}]  # the day is not claimed
    with clock.frozen(kst(19, 15)):
        assert jobs.daily_drafts() == 1
    assert [r["run_date"] for r in sql(db, "SELECT run_date FROM notes.daily_runs")] == [TODAY]
    assert len(queued()) == 1
