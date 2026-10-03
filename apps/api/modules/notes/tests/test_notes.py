"""Notes lifecycle: today's note, read rules, block edits, submit/reject/revise/delete, list, settings, DB guards."""

from datetime import UTC, datetime
from typing import Any

import pytest
from sqlalchemy.exc import DBAPIError

from api.modules.notes.hashing import content_hash
from api.modules.notes.tests.conftest import NotesApi, World, add_ai_block, outbox, sql
from api.modules.notes.tests.fakes import ORG_A, ORG_B, USERS
from api.platform import clock
from api.platform.ids import new_id
from api.platform.testing.contracts import assert_matches_response, assert_valid_event
from api.platform.testing.fixtures import PgUrls


def code(response: Any) -> str:
    return str(response.json()["error"]["code"])


def uid(name: str) -> str:
    return str(USERS[name].user_id)


def stored_hash(db: PgUrls, note_id: str) -> str:
    [note] = sql(db, "SELECT * FROM notes.notes WHERE note_id = :n", n=note_id)
    blocks = sql(db, "SELECT * FROM notes.blocks WHERE note_id = :n ORDER BY position", n=note_id)
    return content_hash(note, blocks)


# ---------------------------------------------------------------- today


def test_today_creates_a_draft_once_in_asia_seoul_date(api: NotesApi, world: World) -> None:
    path = f"/projects/{world.project_id}/notes/today"
    with clock.frozen(datetime(2026, 10, 1, 15, 30, tzinfo=UTC)):  # 2026-10-02 00:30 KST
        first = api.post("a.recorder", path)
        again = api.post("a.recorder", path)
    assert first.status_code == 201, first.text
    assert_matches_response("getOrCreateTodayNote", 201, first.json())
    note = first.json()
    assert note["note_date"] == "2026-10-02"
    assert (note["status"], note["version"], note["revision"], note["draft_status"]) == (
        "DRAFT",
        1,
        1,
        "NONE",
    )
    assert note["organization_id"] == str(ORG_A)
    assert note["recorder_id"] == uid("a.recorder") and note["recorder_display_name"] == "김민준"
    assert note["project_name"] == "전극 소재 열화 분석"
    assert (note["blocks"], note["signatures"], note["content_hash"], note["chain_hash"]) == (
        [],
        [],
        None,
        None,
    )
    assert again.status_code == 200 and again.json()["note_id"] == note["note_id"]
    assert_matches_response("getOrCreateTodayNote", 200, again.json())
    other = api.post("b.recorder", path)
    assert other.status_code == 201 and other.json()["organization_id"] == str(ORG_B)


def test_today_requires_an_active_member(api: NotesApi, world: World) -> None:
    path = f"/projects/{world.project_id}/notes/today"
    assert code(api.post("c.outsider", path)) == "NOT_FOUND"
    assert api.post("a.admin", path).status_code == 404
    assert api.post("a.recorder", f"/projects/{new_id()}/notes/today").status_code == 404
    world.projects.archived.add(world.project_id)
    response = api.post("a.recorder", path)
    assert response.status_code == 409 and code(response) == "PROJECT_ARCHIVED"
    assert api.post(None, path).status_code == 401


def test_organization_is_fixed_at_creation(api: NotesApi, world: World, db: PgUrls) -> None:
    note = api.written(world)
    # the recorder moves to another organization: their existing note keeps ORG_A
    moved = USERS["a.recorder"].model_copy(update={"organization_id": ORG_B})
    USERS["a.recorder"], original = moved, USERS["a.recorder"]
    try:
        again = api.today(world)
    finally:
        USERS["a.recorder"] = original
    assert again["note_id"] == note["note_id"] and again["organization_id"] == str(ORG_A)


# ---------------------------------------------------------------- read rules


def test_draft_is_visible_to_its_recorder_only(api: NotesApi, world: World, db: PgUrls) -> None:
    note = api.written(world)
    path = f"/notes/{note['note_id']}"
    mine = api.get("a.recorder", path)
    assert mine.status_code == 200
    assert_matches_response("getNote", 200, mine.json())
    api.witnessed(world)
    for user in ("a.colleague", "a.owner", "b.witness", "a.admin", "c.outsider"):
        response = api.get(user, path)
        assert response.status_code == 404 and code(response) == "NOT_FOUND", user
    assert api.get("a.recorder", f"/notes/{new_id()}").status_code == 404
    assert outbox(db, "notes.note.viewed.v1") == []


def test_submitted_note_is_read_by_snapshot_witnesses_and_logged(
    api: NotesApi, world: World, db: PgUrls
) -> None:
    api.witnessed(world)
    note = api.submitted(world)
    path = f"/notes/{note['note_id']}"

    # the cross-organization witness of the joint project reads it; the read is logged (열람 관리대장)
    read = api.get("b.witness", path)
    assert read.status_code == 200
    assert_matches_response("getNote", 200, read.json())
    [viewed] = outbox(db, "notes.note.viewed.v1")
    assert_valid_event(viewed)
    assert viewed["payload"] == {
        "project_id": str(world.project_id),
        "actor_id": uid("b.witness"),
        "occurred_at": viewed["payload"]["occurred_at"],
        "note_id": note["note_id"],
        "note_date": note["note_date"],
        "version": 1,
        "recorder_id": uid("a.recorder"),
        "organization_id": str(ORG_A),
        "status": "SUBMITTED",
    }
    # the recorder's own reads are not logged
    api.get("a.recorder", path)
    assert len(outbox(db, "notes.note.viewed.v1")) == 1

    # other ACTIVE members: 403; non-members (an org admin included): 404
    for user in ("a.colleague", "a.owner", "a.member", "b.recorder"):
        response = api.get(user, path)
        assert response.status_code == 403 and code(response) == "FORBIDDEN", user
    for user in ("a.admin", "b.admin", "c.outsider"):
        assert api.get(user, path).status_code == 404, user


def test_witness_visibility_follows_the_snapshot_not_current_settings(api: NotesApi, world: World) -> None:
    api.witnessed(world)
    note = api.submitted(world)
    path = f"/notes/{note['note_id']}"
    assert note["witness_required"] is True and note["witness_user_ids"] == [uid("b.witness")]
    # settings change after submit: the snapshot still decides
    api.settings(world, witness_user_ids=[uid("a.colleague")])
    assert api.get("b.witness", path).status_code == 200
    assert api.get("a.colleague", path).status_code == 403
    assert api.get("a.recorder", path).json()["witness_user_ids"] == [uid("b.witness")]
    # a witness who left the project no longer sees it (and the project is not revealed)
    world.projects.remove(world.project_id, USERS["b.witness"])
    assert api.get("b.witness", path).status_code == 404


def test_draft_mirrors_the_current_settings_for_display(api: NotesApi, world: World) -> None:
    note = api.written(world)
    assert (note["witness_required"], note["witness_user_ids"]) == (False, [])
    api.witnessed(world)
    shown = api.get("a.recorder", f"/notes/{note['note_id']}").json()
    assert (shown["witness_required"], shown["witness_user_ids"]) == (True, [uid("b.witness")])


# ---------------------------------------------------------------- blocks


def test_block_save_replaces_the_list_and_bumps_revision(api: NotesApi, world: World, db: PgUrls) -> None:
    note = api.today(world)
    saved = api.save(
        note,
        [
            {"section": "OBJECTIVE", "text": "고온 열화 원인 파악"},
            {"section": "RESULTS", "text": "메모", "accepted": False},
        ],
    )
    assert_matches_response("updateNoteBlocks", 200, saved)
    assert saved["revision"] == 2
    assert [(b["section"], b["origin"], b["accepted"], b["evidence"]) for b in saved["blocks"]] == [
        ("OBJECTIVE", "HUMAN", True, []),
        ("RESULTS", "HUMAN", True, []),
    ]
    first, second = saved["blocks"]
    again = api.save(saved, [{"block_id": second["block_id"], "section": "RESULTS", "text": "수정"}])
    assert again["revision"] == 3
    assert [(b["block_id"], b["section"], b["text"]) for b in again["blocks"]] == [
        (second["block_id"], "RESULTS", "수정")
    ]
    assert sql(db, "SELECT count(*) AS n FROM notes.blocks WHERE note_id = :n", n=note["note_id"]) == [
        {"n": 1}
    ]


def test_block_save_checks_if_match(api: NotesApi, world: World) -> None:
    note = api.today(world)
    path = f"/notes/{note['note_id']}/blocks"
    body = {"blocks": [{"section": "RESULTS", "text": "x"}]}
    stale = api.put("a.recorder", path, json=body, headers={"If-Match": '"7"'})
    assert stale.status_code == 409 and code(stale) == "CONFLICT"
    assert api.put("a.recorder", path, json=body).status_code == 422  # If-Match is required
    assert api.put("a.recorder", path, json=body, headers={"If-Match": "abc"}).status_code == 422
    assert api.put("a.recorder", path, json=body, headers={"If-Match": '"1"'}).status_code == 200


@pytest.mark.parametrize(
    "block",
    [
        {"section": "RESULTS", "text": "x", "origin": "AI"},
        {"section": "RESULTS", "text": "x", "evidence": []},
        {"section": "RESULTS", "text": ""},
        {"section": "RESULTS", "text": "x" * 4001},
        {"section": "RESULTS", "text": "nul\x00"},
        {"section": "OTHER", "text": "x"},
        {"section": "RESULTS", "text": "x", "block_id": None},
        {"section": "RESULTS", "text": "x", "block_id": "00000000-0000-7000-8000-00000000dead"},
    ],
    ids=["origin", "evidence", "empty", "too-long", "nul", "section", "null-id", "foreign-id"],
)
def test_block_save_rejects_invalid_blocks(api: NotesApi, world: World, block: dict[str, Any]) -> None:
    note = api.today(world)
    response = api.put(
        "a.recorder", f"/notes/{note['note_id']}/blocks", json={"blocks": [block]}, headers={"If-Match": "1"}
    )
    assert response.status_code == 422 and code(response) == "VALIDATION_FAILED"


def test_block_save_rejects_duplicates_and_other_notes_blocks(
    api: NotesApi, world: World, db: PgUrls
) -> None:
    note = api.written(world)
    [block] = note["blocks"]
    path = f"/notes/{note['note_id']}/blocks"
    dup = {"blocks": [{"block_id": block["block_id"], "section": "RESULTS", "text": "a"}] * 2}
    assert api.put("a.recorder", path, json=dup, headers={"If-Match": "2"}).status_code == 422
    other = api.written(world, user="a.colleague")
    steal = {"blocks": [{"block_id": other["blocks"][0]["block_id"], "section": "RESULTS", "text": "a"}]}
    assert api.put("a.recorder", path, json=steal, headers={"If-Match": "2"}).status_code == 422
    assert api.put("a.recorder", path, json={"blocks": []}, headers={"If-Match": "2"}).json()["blocks"] == []
    assert (
        api.put("a.recorder", path, json={"blocks": [{}] * 501}, headers={"If-Match": "3"}).status_code == 422
    )


def test_ai_blocks_keep_origin_and_evidence_and_need_acceptance(
    api: NotesApi, world: World, db: PgUrls
) -> None:
    note = api.written(world)
    ai = add_ai_block(db, note["note_id"], "충방전 측정 v1을 입력으로 추가했다.")
    current = api.get("a.recorder", f"/notes/{note['note_id']}").json()
    assert [b["origin"] for b in current["blocks"]] == ["HUMAN", "AI"]
    human, ai_block = current["blocks"]
    assert ai_block["accepted"] is False and len(ai_block["evidence"]) == 1

    # keeping the AI block untouched (no accepted flag) keeps it unaccepted
    kept = api.save(
        current,
        [
            {"block_id": human["block_id"], "section": "RESULTS", "text": human["text"]},
            {"block_id": ai, "section": "DISCUSSION", "text": ai_block["text"]},
        ],
    )
    assert kept["blocks"][1]["accepted"] is False
    assert kept["blocks"][1]["evidence"] == ai_block["evidence"]
    # editing an AI sentence or accepting it explicitly resolves it; origin and evidence stay
    edited = api.save(kept, [{"block_id": ai, "section": "DISCUSSION", "text": "직접 고친 문장"}])
    assert (edited["blocks"][0]["origin"], edited["blocks"][0]["accepted"]) == ("AI", True)
    assert edited["blocks"][0]["evidence"] == ai_block["evidence"]
    unaccepted = api.save(
        edited, [{"block_id": ai, "section": "DISCUSSION", "text": "직접 고친 문장", "accepted": False}]
    )
    assert unaccepted["blocks"][0]["accepted"] is False
    accepted = api.save(
        unaccepted, [{"block_id": ai, "section": "DISCUSSION", "text": "직접 고친 문장", "accepted": True}]
    )
    assert accepted["blocks"][0]["accepted"] is True
    # HUMAN blocks are always accepted
    human_again = api.save(accepted, [{"section": "RESULTS", "text": "h", "accepted": False}])
    assert human_again["blocks"][0]["accepted"] is True


def test_blocks_are_recorder_only(api: NotesApi, world: World) -> None:
    api.witnessed(world)
    draft = api.today(world)
    body = {"blocks": [{"section": "RESULTS", "text": "x"}]}
    for user in ("a.colleague", "b.witness", "c.outsider"):
        response = api.put(user, f"/notes/{draft['note_id']}/blocks", json=body, headers={"If-Match": "1"})
        assert response.status_code == 404, user
    submitted = api.submitted(world, user="a.colleague")
    for user, status in (("b.witness", 403), ("a.recorder", 403), ("c.outsider", 404)):
        response = api.put(
            user, f"/notes/{submitted['note_id']}/blocks", json=body, headers={"If-Match": "2"}
        )
        assert response.status_code == status, user


def test_submitted_and_signed_notes_are_locked(api: NotesApi, world: World) -> None:
    submitted = api.submitted(world)
    signed = api.signed(world, user="a.colleague")
    for note, user in ((submitted, "a.recorder"), (signed, "a.colleague")):
        response = api.put(
            user,
            f"/notes/{note['note_id']}/blocks",
            json={"blocks": [{"section": "RESULTS", "text": "변조"}]},
            headers={"If-Match": str(note["revision"])},
        )
        assert response.status_code == 409 and code(response) == "NOTE_LOCKED"
        again = api.post(user, f"/notes/{note['note_id']}/submit")
        assert again.status_code == 409 and code(again) == "NOTE_LOCKED"


def test_archived_project_notes_are_read_only(api: NotesApi, world: World) -> None:
    note = api.written(world)
    world.projects.archived.add(world.project_id)
    assert api.get("a.recorder", f"/notes/{note['note_id']}").status_code == 200
    response = api.put(
        "a.recorder",
        f"/notes/{note['note_id']}/blocks",
        json={"blocks": []},
        headers={"If-Match": str(note["revision"])},
    )
    assert response.status_code == 409 and code(response) == "PROJECT_ARCHIVED"
    assert code(api.post("a.recorder", f"/notes/{note['note_id']}/submit")) == "PROJECT_ARCHIVED"


# ---------------------------------------------------------------- submit / reject


def test_submit_fixes_hash_snapshot_and_emits(api: NotesApi, world: World, db: PgUrls) -> None:
    api.settings(
        world,
        witness_required=True,
        witness_user_ids=[uid("b.witness"), uid("a.recorder"), uid("a.colleague")],
    )
    note = api.written(world)
    with clock.frozen(datetime(2026, 10, 1, 10, 5, tzinfo=UTC)):
        response = api.post("a.recorder", f"/notes/{note['note_id']}/submit")
    assert response.status_code == 200, response.text
    assert_matches_response("submitNote", 200, response.json())
    body = response.json()
    assert body["status"] == "SUBMITTED" and body["submitted_at"] == "2026-10-01T10:05:00Z"
    assert body["content_hash"] == stored_hash(db, note["note_id"])
    assert body["chain_hash"] is None and body["signatures"] == []
    # the recorder is never their own witness
    assert (body["witness_required"], body["witness_user_ids"]) == (
        True,
        [uid("b.witness"), uid("a.colleague")],
    )
    [event] = outbox(db, "notes.note.submitted.v1")
    assert_valid_event(event)
    assert event["payload"]["witness_user_ids"] == [uid("b.witness"), uid("a.colleague")]
    assert event["payload"]["content_hash"] == body["content_hash"]
    assert event["payload"]["project_name"] == "전극 소재 열화 분석"


def test_submit_snapshot_skips_witnesses_who_left(api: NotesApi, world: World) -> None:
    api.witnessed(world)
    world.projects.remove(world.project_id, USERS["b.witness"])
    note = api.written(world)
    response = api.post("a.recorder", f"/notes/{note['note_id']}/submit")
    assert response.status_code == 409 and code(response) == "CONFLICT"  # nobody left to witness it


def test_submit_refuses_unaccepted_ai(api: NotesApi, world: World, db: PgUrls) -> None:
    note = api.written(world)
    add_ai_block(db, note["note_id"], "AI 문장")
    response = api.post("a.recorder", f"/notes/{note['note_id']}/submit")
    assert response.status_code == 409 and code(response) == "NOTE_HAS_UNACCEPTED_AI"


def test_submit_is_recorder_only(api: NotesApi, world: World) -> None:
    note = api.written(world)
    assert api.post("a.colleague", f"/notes/{note['note_id']}/submit").status_code == 404
    assert api.post("c.outsider", f"/notes/{note['note_id']}/submit").status_code == 404


def test_witness_rejects_back_to_draft(api: NotesApi, world: World, db: PgUrls) -> None:
    api.witnessed(world)
    note = api.submitted(world)
    assert api.post("a.recorder", f"/notes/{note['note_id']}/sign").status_code == 200  # recorder signature
    path = f"/notes/{note['note_id']}/reject"
    response = api.post("b.witness", path, json={"reason": "결과 섹션에 실행 근거를 보완해 주세요."})
    assert response.status_code == 200, response.text
    assert_matches_response("rejectNote", 200, response.json())
    body = response.json()
    assert body["status"] == "DRAFT" and body["rejected_reason"] == "결과 섹션에 실행 근거를 보완해 주세요."
    assert body["content_hash"] is None and body["signatures"] == []
    assert body["submitted_at"] == note["submitted_at"]
    [event] = outbox(db, "notes.note.rejected.v1")
    assert_valid_event(event)
    assert event["payload"]["reason"] == "결과 섹션에 실행 근거를 보완해 주세요."
    assert event["actor"]["user_id"] == uid("b.witness")
    # back to the recorder only, editable again; a new submit takes a new snapshot and clears the reason
    assert api.get("b.witness", f"/notes/{note['note_id']}").status_code == 404
    api.settings(world, witness_user_ids=[uid("a.colleague")])
    edited = api.save(body, [{"section": "RESULTS", "text": "근거 보완"}])
    again = api.post("a.recorder", f"/notes/{note['note_id']}/submit").json()
    assert again["witness_user_ids"] == [uid("a.colleague")] and again["rejected_reason"] is None
    assert again["revision"] == edited["revision"]


def test_reject_rules(api: NotesApi, world: World) -> None:
    api.witnessed(world)
    note = api.submitted(world)
    path = f"/notes/{note['note_id']}/reject"
    reason = {"reason": "보완"}
    for user in ("a.recorder", "a.colleague", "a.owner"):
        response = api.post(user, path, json=reason)
        assert response.status_code == 403 and code(response) == "NOTE_NOT_WITNESS", user
    assert api.post("c.outsider", path, json=reason).status_code == 404
    for body in ({}, {"reason": ""}, {"reason": "x" * 2001}, {"reason": "a", "x": 1}):
        assert api.post("b.witness", path, json=body).status_code == 422
    draft = api.written(world, user="a.colleague")
    assert api.post("b.witness", f"/notes/{draft['note_id']}/reject", json=reason).status_code == 404
    api.post("a.recorder", f"/notes/{note['note_id']}/sign")
    api.post("b.witness", f"/notes/{note['note_id']}/sign")
    locked = api.post("b.witness", path, json=reason)
    assert locked.status_code == 409 and code(locked) == "NOTE_LOCKED"


# ---------------------------------------------------------------- revise / delete


def test_revise_creates_the_next_draft_version(api: NotesApi, world: World, db: PgUrls) -> None:
    signed = api.signed(world)
    response = api.post("a.recorder", f"/notes/{signed['note_id']}/revise")
    assert response.status_code == 201, response.text
    assert_matches_response("reviseNote", 201, response.json())
    draft = response.json()
    assert (draft["status"], draft["version"], draft["previous_version_id"]) == (
        "DRAFT",
        2,
        signed["note_id"],
    )
    assert (draft["revision"], draft["note_date"], draft["organization_id"]) == (
        1,
        signed["note_date"],
        signed["organization_id"],
    )
    assert [(b["section"], b["text"], b["origin"]) for b in draft["blocks"]] == [
        (b["section"], b["text"], b["origin"]) for b in signed["blocks"]
    ]
    assert {b["block_id"] for b in draft["blocks"]}.isdisjoint({b["block_id"] for b in signed["blocks"]})
    # today's note is now the new version; the signed version is unchanged
    assert api.today(world)["note_id"] == draft["note_id"]
    assert api.get("a.recorder", f"/notes/{signed['note_id']}").json() == signed
    # only the latest version is revised, only by its recorder, only when SIGNED
    again = api.post("a.recorder", f"/notes/{signed['note_id']}/revise")
    assert again.status_code == 409 and code(again) == "CONFLICT"
    locked = api.post("a.recorder", f"/notes/{draft['note_id']}/revise")
    assert locked.status_code == 409 and code(locked) == "NOTE_LOCKED"
    submitted = api.submitted(world, user="a.colleague")
    locked = api.post("a.colleague", f"/notes/{submitted['note_id']}/revise")
    assert locked.status_code == 409 and code(locked) == "NOTE_LOCKED"


def test_revise_is_recorder_only(api: NotesApi, world: World) -> None:
    api.witnessed(world)
    note = api.submitted(world)
    api.post("a.recorder", f"/notes/{note['note_id']}/sign")
    api.post("b.witness", f"/notes/{note['note_id']}/sign")
    assert api.post("b.witness", f"/notes/{note['note_id']}/revise").status_code == 403
    assert api.post("a.colleague", f"/notes/{note['note_id']}/revise").status_code == 403
    assert api.post("c.outsider", f"/notes/{note['note_id']}/revise").status_code == 404


def test_delete_draft_only(api: NotesApi, world: World, db: PgUrls) -> None:
    signed = api.signed(world)
    draft = api.post("a.recorder", f"/notes/{signed['note_id']}/revise").json()
    for user, status in (("a.colleague", 404), ("c.outsider", 404)):
        assert api.delete(user, f"/notes/{draft['note_id']}").status_code == status
    response = api.delete("a.recorder", f"/notes/{draft['note_id']}")
    assert response.status_code == 204 and response.content == b""
    assert api.get("a.recorder", f"/notes/{draft['note_id']}").status_code == 404
    assert api.get("a.recorder", f"/notes/{signed['note_id']}").json() == signed
    locked = api.delete("a.recorder", f"/notes/{signed['note_id']}")
    assert locked.status_code == 409 and code(locked) == "NOTE_LOCKED"
    submitted = api.submitted(world, user="a.colleague")
    assert code(api.delete("a.colleague", f"/notes/{submitted['note_id']}")) == "NOTE_LOCKED"
    assert api.delete("a.recorder", f"/notes/{submitted['note_id']}").status_code == 403
    assert sql(db, "SELECT count(*) AS n FROM notes.notes") == [{"n": 2}]


# ---------------------------------------------------------------- list


def _seed_day(db: PgUrls, world: World, user: str, day: str, status: str = "DRAFT", **extra: Any) -> str:
    note_id = new_id()
    values = {
        "note_id": note_id,
        "project_id": world.project_id,
        "organization_id": USERS[user].organization_id,
        "recorder_id": USERS[user].user_id,
        "note_date": day,
        "version": 1,
        "status": status,
    } | extra
    sql(
        db,
        f"INSERT INTO notes.notes ({', '.join(values)}) VALUES ({', '.join(':' + k for k in values)})",
        **values,
    )
    return str(note_id)


def test_list_recorder_notes_latest_version_per_day(api: NotesApi, world: World, db: PgUrls) -> None:
    signed = api.signed(world)
    revised = api.post("a.recorder", f"/notes/{signed['note_id']}/revise").json()
    older = [_seed_day(db, world, "a.recorder", f"2026-09-{d:02d}") for d in (1, 2, 3)]
    _seed_day(db, world, "a.colleague", "2026-09-05")
    response = api.get("a.recorder", "/notes")
    assert response.status_code == 200
    assert_matches_response("listNotes", 200, response.json())
    items = response.json()["items"]
    assert [i["note_id"] for i in items] == [revised["note_id"], *reversed(older)]
    assert items[0] | {"updated_at": None} == {
        "note_id": revised["note_id"],
        "project_id": str(world.project_id),
        "project_name": "전극 소재 열화 분석",
        "recorder_id": uid("a.recorder"),
        "recorder_display_name": "김민준",
        "note_date": revised["note_date"],
        "version": 2,
        "status": "DRAFT",
        "draft_status": "NONE",
        "block_count": 1,
        "unaccepted_ai_count": 0,
        "submitted_at": None,
        "updated_at": None,
    }
    page1 = api.get("a.recorder", "/notes", params={"limit": 2}).json()
    page2 = api.get(
        "a.recorder", "/notes", params={"limit": 2, "cursor": page1["page"]["next_cursor"]}
    ).json()
    assert page1["page"]["has_more"] is True and page2["page"]["has_more"] is False
    assert [i["note_id"] for i in page1["items"] + page2["items"]] == [i["note_id"] for i in items]
    ranged = api.get("a.recorder", "/notes", params={"from": "2026-09-02", "to": "2026-09-03"}).json()
    assert [i["note_id"] for i in ranged["items"]] == [older[2], older[1]]
    assert api.get("a.recorder", "/notes", params={"status": ["SIGNED"]}).json()["items"] == []
    drafts = api.get("a.recorder", "/notes", params=[("status", "DRAFT"), ("status", "SIGNED")]).json()
    assert len(drafts["items"]) == 4
    other_project = api.get("a.recorder", "/notes", params={"project_id": str(new_id())}).json()
    assert other_project["items"] == []
    assert (
        api.get("a.recorder", "/notes", params={"from": "2026-09-03", "to": "2026-09-02"}).status_code == 422
    )
    assert api.get("a.recorder", "/notes", params={"cursor": "bm9wZQ"}).status_code == 422
    assert api.get("a.recorder", "/notes", params={"role": "admin"}).status_code == 422


def test_list_witness_notes(api: NotesApi, world: World, db: PgUrls) -> None:
    api.witnessed(world)
    submitted = api.submitted(world)
    api.submitted(world, user="a.colleague")
    api.written(world, user="b.recorder")
    _seed_day(db, world, "b.recorder", "2026-09-01", "DRAFT", witness_user_ids=[USERS["b.witness"].user_id])
    response = api.get("b.witness", "/notes", params={"role": "witness"})
    assert response.status_code == 200
    assert_matches_response("listNotes", 200, response.json())
    items = response.json()["items"]
    assert {i["recorder_id"] for i in items} == {uid("a.recorder"), uid("a.colleague")}
    assert all(i["status"] == "SUBMITTED" for i in items)
    assert api.get("a.member", "/notes", params={"role": "witness"}).json()["items"] == []
    mine = api.get("b.witness", "/notes").json()["items"]
    assert mine == []
    world.projects.remove(world.project_id, USERS["b.witness"])
    assert api.get("b.witness", "/notes", params={"role": "witness"}).json()["items"] == []
    assert submitted["note_id"] in {i["note_id"] for i in items}


# ---------------------------------------------------------------- settings


def test_settings_defaults_and_update(api: NotesApi, world: World) -> None:
    path = f"/projects/{world.project_id}/note-settings"
    response = api.get("a.member", path)
    assert response.status_code == 200
    assert_matches_response("getNoteSettings", 200, response.json())
    assert response.json() == {
        "project_id": str(world.project_id),
        "witness_required": False,
        "witness_user_ids": [],
        "llm_enabled": True,
    }
    assert api.get("c.outsider", path).status_code == 404
    updated = api.patch(
        "a.owner", path, json={"witness_required": True, "witness_user_ids": [uid("b.witness")]}
    )
    assert updated.status_code == 200
    assert_matches_response("updateNoteSettings", 200, updated.json())
    assert api.patch(
        "a.owner", path, json={"witness_user_ids": [uid("b.witness"), uid("a.colleague")]}
    ).json()["witness_user_ids"] == [uid("b.witness"), uid("a.colleague")]
    assert api.get("b.witness", path).json()["witness_required"] is True


def test_settings_update_rules(api: NotesApi, world: World) -> None:
    path = f"/projects/{world.project_id}/note-settings"
    world.projects.add(world.project_id, USERS["a.colleague"], "PROJECT_ADMIN")
    assert api.patch("a.colleague", path, json={"witness_required": False}).status_code == 200
    for user in ("a.recorder", "a.member"):
        response = api.patch(user, path, json={"witness_required": False})
        assert response.status_code == 403 and code(response) == "FORBIDDEN", user
    assert api.patch("c.outsider", path, json={"witness_required": False}).status_code == 404
    invalid = [
        {},
        {"witness_required": None},
        {"witness_user_ids": [uid("c.outsider")]},
        {"witness_user_ids": [uid("b.witness")] * 2},
        {"witness_user_ids": [str(new_id()) for _ in range(21)]},
        {"witness_required": True},  # required, but nobody configured
        {"llm_enabled": False},
    ]
    for body in invalid:
        response = api.patch("a.owner", path, json=body)
        assert response.status_code == 422 and code(response) == "VALIDATION_FAILED", body
    world.projects.archived.add(world.project_id)
    assert api.patch("a.owner", path, json={"witness_required": False}).status_code == 403


# ---------------------------------------------------------------- database guards


def _as_app(db: PgUrls, statement: str, **params: Any) -> None:
    with pytest.raises(DBAPIError):
        sql(db, statement, role="app", **params)


def test_database_refuses_changes_to_locked_notes(api: NotesApi, world: World, db: PgUrls) -> None:
    signed = api.signed(world)
    submitted = api.submitted(world, user="a.colleague")
    for note in (signed, submitted):
        n = note["note_id"]
        _as_app(db, "UPDATE notes.blocks SET text = 'x' WHERE note_id = :n", n=n)
        _as_app(db, "DELETE FROM notes.blocks WHERE note_id = :n", n=n)
        _as_app(
            db,
            "INSERT INTO notes.blocks (block_id, note_id, position, section, text, origin, accepted, evidence)"
            " VALUES (:b, :n, 9, 'RESULTS', 'x', 'HUMAN', true, '[]')",
            b=new_id(),
            n=n,
        )
        _as_app(db, "DELETE FROM notes.notes WHERE note_id = :n", n=n)
        _as_app(db, "UPDATE notes.notes SET note_date = '2020-01-01' WHERE note_id = :n", n=n)
        _as_app(db, "UPDATE notes.notes SET content_hash = repeat('0', 64) WHERE note_id = :n", n=n)
    _as_app(db, "UPDATE notes.notes SET status = 'DRAFT' WHERE note_id = :n", n=signed["note_id"])
    _as_app(db, "UPDATE notes.signatures SET signer_id = :u", u=new_id())
    _as_app(db, "DELETE FROM notes.signatures WHERE note_id = :n", n=signed["note_id"])
    stored = api.get("a.recorder", f"/notes/{signed['note_id']}").json()
    assert stored == signed


def test_app_role_cannot_truncate_notes_tables(db: PgUrls) -> None:
    rows = sql(
        db,
        "SELECT tablename, has_table_privilege('nais_app', 'notes.' || tablename, 'TRUNCATE') AS can"
        " FROM pg_tables WHERE schemaname = 'notes'",
    )
    assert {r["tablename"] for r in rows} >= {
        "notes",
        "blocks",
        "signatures",
        "chains",
        "settings",
        "evidence",
    }
    assert not any(r["can"] for r in rows), rows
