"""Signing (auth_time, roles, witness snapshot), the project x organization hash chain and verification."""

from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime
from typing import Any

from api.modules.notes.hashing import GENESIS_CHAIN_HASH, next_chain_hash
from api.modules.notes.tests.conftest import NotesApi, World, add_ai_block, outbox, sql, tamper
from api.modules.notes.tests.fakes import ORG_A, USERS
from api.platform import clock
from api.platform.testing.contracts import assert_matches_response, assert_valid_event
from api.platform.testing.fixtures import PgUrls


def code(response: Any) -> str:
    return str(response.json()["error"]["code"])


def uid(name: str) -> str:
    return str(USERS[name].user_id)


def sign(api: NotesApi, user: str, note: dict[str, Any], **kwargs: Any) -> Any:
    return api.post(user, f"/notes/{note['note_id']}/sign", **kwargs)


# ---------------------------------------------------------------- re-authentication


def test_signing_needs_a_login_within_five_minutes(api: NotesApi, world: World, db: PgUrls) -> None:
    note = api.written(world)
    for age in (None, 301, 3600, -600):  # no claim, stale, very stale, from the future
        response = sign(api, "a.recorder", note, auth_age=age)
        assert response.status_code == 401 and code(response) == "NOTE_SIGNATURE_EXPIRED", age
    assert api.get("a.recorder", f"/notes/{note['note_id']}").json()["status"] == "DRAFT"
    assert outbox(db, "notes.note.signed.v1") == []
    assert sign(api, "a.recorder", note, auth_age=290).status_code == 200


def test_auth_time_is_checked_after_visibility(api: NotesApi, world: World) -> None:
    note = api.written(world)
    assert sign(api, "c.outsider", note, auth_age=None).status_code == 404


# ---------------------------------------------------------------- recorder alone


def test_recorder_signs_from_draft_when_no_witness_is_required(
    api: NotesApi, world: World, db: PgUrls
) -> None:
    note = api.written(world)
    with clock.frozen(datetime(2026, 10, 1, 10, 6, tzinfo=UTC)):
        response = sign(api, "a.recorder", note)
    assert response.status_code == 200, response.text
    assert_matches_response("signNote", 200, response.json())
    body = response.json()
    assert body["status"] == "SIGNED" and body["submitted_at"] == "2026-10-01T10:06:00Z"
    assert (body["witness_required"], body["witness_user_ids"]) == (False, [])
    assert body["chain_hash"] == next_chain_hash(None, body["content_hash"])
    assert body["chain_hash"] == next_chain_hash(GENESIS_CHAIN_HASH, body["content_hash"])
    assert body["signatures"] == [
        {
            "signer_id": uid("a.recorder"),
            "signer_display_name": "김민준",
            "role": "RECORDER",
            "signed_at": "2026-10-01T10:06:00Z",
            "content_hash": body["content_hash"],
        }
    ]
    [event] = outbox(db, "notes.note.signed.v1")
    assert_valid_event(event)
    assert event["payload"] | {"occurred_at": None} == {
        "project_id": str(world.project_id),
        "actor_id": uid("a.recorder"),
        "occurred_at": None,
        "note_id": note["note_id"],
        "note_date": note["note_date"],
        "version": 1,
        "recorder_id": uid("a.recorder"),
        "organization_id": str(ORG_A),
        "project_name": "전극 소재 열화 분석",
        "signer_id": uid("a.recorder"),
        "signer_role": "RECORDER",
        "final": True,
        "content_hash": body["content_hash"],
        "chain_hash": body["chain_hash"],
    }
    [sig] = sql(db, "SELECT auth_time FROM notes.signatures WHERE note_id = :n", n=note["note_id"])
    assert sig["auth_time"] is not None


def test_draft_sign_runs_the_submit_checks(api: NotesApi, world: World, db: PgUrls) -> None:
    note = api.written(world)
    add_ai_block(db, note["note_id"], "AI 문장")
    response = sign(api, "a.recorder", note)
    assert response.status_code == 409 and code(response) == "NOTE_HAS_UNACCEPTED_AI"


def test_draft_sign_needs_a_submit_when_witnesses_are_required(api: NotesApi, world: World) -> None:
    api.witnessed(world)
    note = api.written(world)
    response = sign(api, "a.recorder", note)
    assert response.status_code == 409 and code(response) == "CONFLICT"


def test_recorder_signs_a_submitted_note_without_witness(api: NotesApi, world: World, db: PgUrls) -> None:
    note = api.submitted(world)
    body = sign(api, "a.recorder", note).json()
    assert body["status"] == "SIGNED" and body["content_hash"] == note["content_hash"]
    assert body["submitted_at"] == note["submitted_at"]
    again = sign(api, "a.recorder", note)
    assert again.status_code == 409 and code(again) == "NOTE_LOCKED"


# ---------------------------------------------------------------- witnesses


def test_recorder_then_witness(api: NotesApi, world: World, db: PgUrls) -> None:
    api.witnessed(world)
    note = api.submitted(world)
    first = sign(api, "a.recorder", note)
    assert first.status_code == 200
    assert first.json()["status"] == "SUBMITTED" and first.json()["chain_hash"] is None
    duplicate = sign(api, "a.recorder", note)
    assert duplicate.status_code == 409 and code(duplicate) == "CONFLICT"
    second = sign(api, "b.witness", note)
    assert second.status_code == 200
    body = second.json()
    assert body["status"] == "SIGNED" and body["chain_hash"] == next_chain_hash(None, body["content_hash"])
    assert [(s["role"], s["signer_display_name"]) for s in body["signatures"]] == [
        ("RECORDER", "김민준"),
        ("WITNESS", "박지훈"),
    ]
    events = outbox(db, "notes.note.signed.v1")
    for event in events:
        assert_valid_event(event)
    assert [
        (e["payload"]["signer_role"], e["payload"]["final"], e["payload"]["chain_hash"]) for e in events
    ] == [
        ("RECORDER", False, None),
        ("WITNESS", True, body["chain_hash"]),
    ]


def test_witness_then_recorder(api: NotesApi, world: World) -> None:
    api.witnessed(world)
    note = api.submitted(world)
    witnessed = sign(api, "b.witness", note).json()
    assert witnessed["status"] == "SUBMITTED"
    assert code(sign(api, "b.witness", note)) == "CONFLICT"
    assert sign(api, "a.recorder", note).json()["status"] == "SIGNED"


def test_only_snapshot_witnesses_may_witness(api: NotesApi, world: World) -> None:
    api.witnessed(world)
    note = api.submitted(world)
    for user in ("a.colleague", "a.owner", "b.recorder"):
        response = sign(api, user, note)
        assert response.status_code == 403 and code(response) == "NOTE_NOT_WITNESS", user
    assert sign(api, "c.outsider", note).status_code == 404
    draft = api.written(world, user="a.colleague")
    assert sign(api, "b.witness", draft).status_code == 404
    # configured as witness after the submit: still not a witness of this note
    api.settings(world, witness_user_ids=[uid("b.witness"), uid("a.colleague")])
    assert code(sign(api, "a.colleague", note)) == "NOTE_NOT_WITNESS"
    # witness who stopped being an active member
    world.projects.remove(world.project_id, USERS["b.witness"])
    assert sign(api, "b.witness", note).status_code == 404


def test_snapshot_decides_how_a_submitted_note_completes(api: NotesApi, world: World) -> None:
    api.witnessed(world)
    needs_witness = api.submitted(world)
    no_witness = api.submitted(world, user="a.colleague")  # also needs a witness (same settings)
    api.settings(world, witness_required=False)
    assert sign(api, "a.recorder", needs_witness).json()["status"] == "SUBMITTED"
    assert sign(api, "b.witness", needs_witness).json()["status"] == "SIGNED"
    assert no_witness["witness_required"] is True

    plain = api.submitted(world, user="b.recorder")  # submitted while no witness is required
    api.witnessed(world)
    assert plain["witness_required"] is False
    assert code(sign(api, "b.witness", plain)) == "NOTE_NOT_WITNESS"
    assert sign(api, "b.recorder", plain).json()["status"] == "SIGNED"


def test_witness_of_an_archived_project_cannot_sign(api: NotesApi, world: World) -> None:
    api.witnessed(world)
    note = api.submitted(world)
    world.projects.archived.add(world.project_id)
    response = sign(api, "b.witness", note)
    assert response.status_code == 409 and code(response) == "PROJECT_ARCHIVED"


# ---------------------------------------------------------------- chain and verification


def test_chain_links_signed_notes_per_project_and_organization(
    api: NotesApi, world: World, db: PgUrls
) -> None:
    first = api.signed(world)
    other_org = api.signed(world, user="b.recorder")
    second = api.signed(world, user="a.colleague")
    assert first["chain_hash"] == next_chain_hash(None, first["content_hash"])
    assert other_org["chain_hash"] == next_chain_hash(None, other_org["content_hash"])
    assert second["chain_hash"] == next_chain_hash(first["chain_hash"], second["content_hash"])
    [chain] = sql(
        db,
        "SELECT last_seq, last_chain_hash FROM notes.chains WHERE project_id = :p AND organization_id = :o",
        p=world.project_id,
        o=ORG_A,
    )
    assert chain == {"last_seq": 2, "last_chain_hash": second["chain_hash"]}
    revised = api.post("a.recorder", f"/notes/{first['note_id']}/revise").json()
    api.save(revised, [{"section": "RESULTS", "text": "정정"}])
    third = sign(api, "a.recorder", revised).json()
    assert third["chain_hash"] == next_chain_hash(second["chain_hash"], third["content_hash"])


def test_verify_signed_and_submitted_notes(api: NotesApi, world: World) -> None:
    signed = api.signed(world)
    with clock.frozen(datetime(2026, 10, 2, tzinfo=UTC)):
        response = api.get("a.recorder", f"/notes/{signed['note_id']}/verify")
    assert response.status_code == 200
    assert_matches_response("verifyNote", 200, response.json())
    assert response.json() == {
        "note_id": signed["note_id"],
        "valid": True,
        "content_hash": signed["content_hash"],
        "recomputed_hash": signed["content_hash"],
        "chain_valid": True,
        "checked_at": "2026-10-02T00:00:00Z",
    }
    api.witnessed(world)
    submitted = api.submitted(world, user="a.colleague")
    result = api.get("b.witness", f"/notes/{submitted['note_id']}/verify").json()
    assert (result["valid"], result["chain_valid"]) == (True, True)
    assert api.get("a.recorder", f"/notes/{submitted['note_id']}/verify").status_code == 403
    assert api.get("c.outsider", f"/notes/{submitted['note_id']}/verify").status_code == 404
    draft = api.written(world, user="b.recorder")
    response = api.get("b.recorder", f"/notes/{draft['note_id']}/verify")
    assert response.status_code == 409 and code(response) == "CONFLICT"


def test_verify_detects_tampering_in_the_middle_of_the_chain(api: NotesApi, world: World, db: PgUrls) -> None:
    first = api.signed(world)
    middle = api.signed(world, user="a.colleague")
    world.projects.add(world.project_id, USERS["a.owner"], "PROJECT_OWNER")
    last = api.signed(world, user="a.owner")
    tamper(
        db, "blocks", "UPDATE notes.blocks SET text = '조작된 결과' WHERE note_id = :n", n=middle["note_id"]
    )

    tampered = api.get("a.colleague", f"/notes/{middle['note_id']}/verify").json()
    assert tampered["valid"] is False and tampered["chain_valid"] is False
    assert tampered["content_hash"] == middle["content_hash"] != tampered["recomputed_hash"]
    for note, user in ((first, "a.recorder"), (last, "a.owner")):
        result = api.get(user, f"/notes/{note['note_id']}/verify").json()
        assert (result["valid"], result["chain_valid"]) == (True, False)


def test_verify_detects_a_rewritten_hash_and_a_removed_note(api: NotesApi, world: World, db: PgUrls) -> None:
    first = api.signed(world)
    second = api.signed(world, user="a.colleague")
    # the attacker rewrites the content and its stored hash consistently: the chain no longer matches
    tamper(db, "blocks", "UPDATE notes.blocks SET text = '조작' WHERE note_id = :n", n=first["note_id"])
    [note] = sql(db, "SELECT * FROM notes.notes WHERE note_id = :n", n=first["note_id"])
    blocks = sql(db, "SELECT * FROM notes.blocks WHERE note_id = :n ORDER BY position", n=first["note_id"])
    from api.modules.notes.hashing import content_hash

    tamper(
        db,
        "notes",
        "UPDATE notes.notes SET content_hash = :h WHERE note_id = :n",
        h=content_hash(note, blocks),
        n=first["note_id"],
    )
    result = api.get("a.recorder", f"/notes/{first['note_id']}/verify").json()
    assert (result["valid"], result["chain_valid"]) == (True, False)

    # deleting the newest signed note breaks the chain head
    tamper(
        db,
        "notes",
        "UPDATE notes.notes SET content_hash = :h WHERE note_id = :n",
        h=first["content_hash"],
        n=first["note_id"],
    )
    tamper(
        db,
        "blocks",
        "UPDATE notes.blocks SET text = :t WHERE note_id = :n",
        t=first["blocks"][0]["text"],
        n=first["note_id"],
    )
    assert api.get("a.recorder", f"/notes/{first['note_id']}/verify").json()["chain_valid"] is True
    tamper(db, "signatures", "DELETE FROM notes.signatures WHERE note_id = :n", n=second["note_id"])
    tamper(db, "blocks", "DELETE FROM notes.blocks WHERE note_id = :n", n=second["note_id"])
    tamper(db, "notes", "DELETE FROM notes.notes WHERE note_id = :n", n=second["note_id"])
    assert api.get("a.recorder", f"/notes/{first['note_id']}/verify").json()["chain_valid"] is False


def test_verify_detects_a_changed_signature_hash(api: NotesApi, world: World, db: PgUrls) -> None:
    signed = api.signed(world)
    tamper(
        db,
        "signatures",
        "UPDATE notes.signatures SET content_hash = repeat('1', 64) WHERE note_id = :n",
        n=signed["note_id"],
    )
    result = api.get("a.recorder", f"/notes/{signed['note_id']}/verify").json()
    assert result["valid"] is True and result["chain_valid"] is False


def test_concurrent_signatures_serialize_on_the_chain_head(api: NotesApi, world: World, db: PgUrls) -> None:
    """Four recorders of one organization sign at the same time: the chain row lock gives every note its own
    sequence number and an intact chain."""
    recorders = ("a.recorder", "a.colleague", "a.owner", "a.member")
    notes = [api.written(world, user=user) for user in recorders]
    with ThreadPoolExecutor(max_workers=len(recorders)) as pool:
        responses = list(
            pool.map(lambda pair: sign(api, pair[0], pair[1]), zip(recorders, notes, strict=True))
        )
    assert [r.status_code for r in responses] == [200] * len(recorders)
    rows = sql(
        db,
        "SELECT chain_seq FROM notes.notes WHERE project_id = :p AND organization_id = :o ORDER BY chain_seq",
        p=world.project_id,
        o=ORG_A,
    )
    assert [r["chain_seq"] for r in rows] == [1, 2, 3, 4]
    assert api.get("a.recorder", f"/notes/{notes[0]['note_id']}/verify").json()["chain_valid"] is True


def test_non_witness_member_gets_not_witness_whatever_the_state_or_token(api: NotesApi, world: World) -> None:
    signed = api.signed(world)
    for note in (signed, api.submitted(world, user="a.colleague")):
        for age in (0, None, 3600):
            response = sign(api, "b.recorder", note, auth_age=age)
            assert response.status_code == 403 and code(response) == "NOTE_NOT_WITNESS", (note["status"], age)


def _witnessed_and_signed(api: NotesApi, world: World) -> dict[str, Any]:
    api.witnessed(world)
    note = api.submitted(world)
    sign(api, "a.recorder", note)
    body: dict[str, Any] = sign(api, "b.witness", note).json()
    assert body["status"] == "SIGNED"
    return body


def test_verify_detects_a_forged_recorder_signer(api: NotesApi, world: World, db: PgUrls) -> None:
    note = _witnessed_and_signed(api, world)
    tamper(
        db,
        "signatures",
        "UPDATE notes.signatures SET signer_id = :u WHERE note_id = :n AND role = 'RECORDER'",
        u=USERS["a.colleague"].user_id,
        n=note["note_id"],
    )
    result = api.get("a.recorder", f"/notes/{note['note_id']}/verify").json()
    assert (result["valid"], result["chain_valid"]) == (True, False)  # the content itself is intact


def test_verify_detects_a_forged_witness_signer(api: NotesApi, world: World, db: PgUrls) -> None:
    note = _witnessed_and_signed(api, world)
    for forged in (USERS["a.colleague"].user_id, USERS["a.recorder"].user_id):  # not a witness / the recorder
        tamper(
            db,
            "signatures",
            "UPDATE notes.signatures SET signer_id = :u WHERE note_id = :n AND role = 'WITNESS'",
            u=forged,
            n=note["note_id"],
        )
        assert api.get("a.recorder", f"/notes/{note['note_id']}/verify").json()["chain_valid"] is False


def test_verify_detects_a_signature_dated_after_completion(api: NotesApi, world: World, db: PgUrls) -> None:
    note = _witnessed_and_signed(api, world)
    tamper(
        db,
        "signatures",
        "UPDATE notes.signatures SET signed_at = signed_at + interval '1 day' WHERE note_id = :n AND role = 'WITNESS'",
        n=note["note_id"],
    )
    assert api.get("a.recorder", f"/notes/{note['note_id']}/verify").json()["chain_valid"] is False


def test_verify_accepts_an_untampered_witnessed_chain(api: NotesApi, world: World) -> None:
    note = _witnessed_and_signed(api, world)
    result = api.get("b.witness", f"/notes/{note['note_id']}/verify").json()
    assert (result["valid"], result["chain_valid"]) == (True, True)
