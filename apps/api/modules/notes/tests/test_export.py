"""exportNotes: streamed ZIP of canonical JSON, escaped HTML and hashes.csv; ORG_ADMIN scope and view logging."""

import csv
import hashlib
import io
import json
import zipfile
from typing import Any

from api.modules.notes.hashing import canonical_json
from api.modules.notes.tests.conftest import NotesApi, World, outbox, sql
from api.modules.notes.tests.fakes import USERS
from api.platform.testing.contracts import assert_valid_event
from api.platform.testing.fixtures import PgUrls


def uid(name: str) -> str:
    return str(USERS[name].user_id)


def export(api: NotesApi, user: str, world: World, **params: Any) -> Any:
    return api.get(user, "/notes/export", params={"project_id": str(world.project_id), **params})


def archive(response: Any) -> zipfile.ZipFile:
    assert response.status_code == 200, response.text
    assert response.headers["content-type"] == "application/zip"
    return zipfile.ZipFile(io.BytesIO(response.content))


def notes_in(zf: zipfile.ZipFile) -> dict[str, dict[str, Any]]:
    out: dict[str, dict[str, Any]] = {}
    for name in zf.namelist():
        if name.startswith("notes/") and name.endswith(".json"):
            record = json.loads(zf.read(name))
            out[record["content"]["note_id"]] = record
    return out


def test_recorder_exports_own_notes_of_every_status(api: NotesApi, world: World, db: PgUrls) -> None:
    signed = api.signed(world)
    revised = api.post("a.recorder", f"/notes/{signed['note_id']}/revise").json()
    api.save(revised, [{"section": "RESULTS", "text": "<script>alert(1)</script> & 정정"}])
    api.signed(world, user="a.colleague")
    response = export(api, "a.recorder", world)
    zf = archive(response)
    today = signed["note_date"]
    assert response.headers["content-disposition"] == (
        f'attachment; filename="research-notes-{world.project_id}-all-all.zip"'
    )
    records = notes_in(zf)
    assert set(records) == {signed["note_id"], revised["note_id"]}

    record = records[signed["note_id"]]
    # the JSON is canonical and its content re-hashes to the stored content_hash
    name = next(n for n in zf.namelist() if signed["note_id"] in n and n.endswith(".json"))
    raw = zf.read(name)
    assert raw == canonical_json(record)
    assert hashlib.sha256(canonical_json(record["content"])).hexdigest() == signed["content_hash"]
    assert (record["status"], record["content_hash"], record["chain_hash"]) == (
        "SIGNED",
        signed["content_hash"],
        signed["chain_hash"],
    )
    assert [s["role"] for s in record["signatures"]] == ["RECORDER"]
    assert record["content"]["note_date"] == today

    html_name = next(n for n in zf.namelist() if revised["note_id"] in n and n.endswith(".html"))
    page = zf.read(html_name).decode()
    assert "<script>" not in page and "&lt;script&gt;alert(1)&lt;/script&gt; &amp; 정정" in page
    assert "Content-Security-Policy" in page and "김민준" in page

    rows = list(csv.DictReader(io.StringIO(zf.read("hashes.csv").decode())))
    assert {r["note_id"] for r in rows} == {signed["note_id"], revised["note_id"]}
    signed_row = next(r for r in rows if r["note_id"] == signed["note_id"])
    assert (signed_row["status"], signed_row["content_hash"], signed_row["chain_hash"]) == (
        "SIGNED",
        signed["content_hash"],
        signed["chain_hash"],
    )
    draft_row = next(r for r in rows if r["note_id"] == revised["note_id"])
    assert (draft_row["status"], draft_row["content_hash"]) == ("DRAFT", "")
    assert outbox(db, "notes.note.viewed.v1") == []  # own notes are not "viewed"


def test_org_admin_gets_submitted_and_signed_notes_of_their_organization(
    api: NotesApi, world: World, db: PgUrls
) -> None:
    mine = api.signed(world)
    colleague_draft = api.written(world, user="a.colleague")
    api.witnessed(world)
    owner_submitted = api.submitted(world, user="a.owner")
    other_org = api.submitted(world, user="b.recorder")
    zf = archive(export(api, "a.admin", world))  # ORG_A admin, not a project member
    assert set(notes_in(zf)) == {mine["note_id"], owner_submitted["note_id"]}
    assert colleague_draft["note_id"] not in zf.read("hashes.csv").decode()
    assert other_org["note_id"] not in zf.read("hashes.csv").decode()
    viewed = outbox(db, "notes.note.viewed.v1")
    for event in viewed:
        assert_valid_event(event)
    assert sorted(e["payload"]["note_id"] for e in viewed) == sorted(
        [mine["note_id"], owner_submitted["note_id"]]
    )
    assert {e["payload"]["actor_id"] for e in viewed} == {uid("a.admin")}

    b_zip = archive(export(api, "b.admin", world))
    assert set(notes_in(b_zip)) == {other_org["note_id"]}


def test_export_access_and_parameters(api: NotesApi, world: World, db: PgUrls) -> None:
    api.signed(world)
    assert export(api, "c.outsider", world).status_code == 404
    # a member with no notes gets an empty archive
    zf = archive(export(api, "a.member", world))
    assert notes_in(zf) == {} and zf.read("hashes.csv").decode().splitlines()[0].startswith("note_id,")
    assert api.get("a.recorder", "/notes/export").status_code == 422
    assert export(api, "a.recorder", world, **{"from": "2026-10-05", "to": "2026-10-01"}).status_code == 422
    # a recorder who left the project keeps access to their own notes
    world.projects.remove(world.project_id, USERS["a.recorder"])
    assert len(notes_in(archive(export(api, "a.recorder", world)))) == 1


def test_export_date_range_is_inclusive(api: NotesApi, world: World, db: PgUrls) -> None:
    note = api.signed(world)
    day = note["note_date"]
    response = export(api, "a.recorder", world, **{"from": day, "to": day})
    assert set(notes_in(archive(response))) == {note["note_id"]}
    assert response.headers["content-disposition"].endswith(f'-{day}-{day}.zip"')
    sql(db, "SELECT 1")
    assert notes_in(archive(export(api, "a.recorder", world, **{"to": "2000-01-01"}))) == {}


def test_export_is_capped(api: NotesApi, world: World, db: PgUrls, monkeypatch: Any) -> None:
    from api.modules.notes.service import export as service

    monkeypatch.setattr(service, "MAX_EXPORT_NOTES", 2)
    for user in ("a.recorder", "a.colleague", "a.owner"):
        api.signed(world, user=user)
    response = export(api, "a.admin", world)
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "VALIDATION_FAILED"
    assert response.json()["error"]["details"]["fields"][0]["reason"] == "TOO_MANY_NOTES"
    assert outbox(db, "notes.note.viewed.v1") == []  # nothing exported, nothing logged
    assert len(notes_in(archive(export(api, "a.recorder", world)))) == 1


def test_export_streams_notes_in_batches(api: NotesApi, world: World, db: PgUrls, monkeypatch: Any) -> None:
    from api.modules.notes.service import export as service

    monkeypatch.setattr(service, "BATCH_SIZE", 2)
    signed = [api.signed(world, user=user) for user in ("a.recorder", "a.colleague", "a.owner")]
    zf = archive(export(api, "a.admin", world))
    assert set(notes_in(zf)) == {n["note_id"] for n in signed}
    assert len(zf.read("hashes.csv").decode().splitlines()) == 4
    assert len(outbox(db, "notes.note.viewed.v1")) == 3
    for record, note in zip(
        sorted(notes_in(zf).values(), key=lambda r: r["content"]["note_id"]),
        sorted(signed, key=lambda n: n["note_id"]),
        strict=True,
    ):
        assert record["recorder_display_name"] and record["signatures"][0]["signer_display_name"]
        assert hashlib.sha256(canonical_json(record["content"])).hexdigest() == note["content_hash"]


def test_note_rejected_after_selection_is_not_exported(
    api: NotesApi, world: World, db: PgUrls, monkeypatch: Any
) -> None:
    """A witness rejects another recorder's note (SUBMITTED -> DRAFT) after the ORG_ADMIN's export selected it but
    before the archive streams: its DRAFT content never reaches the archive or hashes.csv."""
    from api.modules.notes.service import export as service

    kept = api.signed(world)
    api.witnessed(world)
    rejected = api.submitted(world, user="a.colleague")
    original = service.prepare

    def prepare_then_reject(*args: Any, **kwargs: Any) -> Any:
        archive = original(*args, **kwargs)
        assert rejected["note_id"] in {str(i) for i in archive.note_ids}
        response = api.post("b.witness", f"/notes/{rejected['note_id']}/reject", json={"reason": "보완"})
        assert response.status_code == 200, response.text
        return archive

    monkeypatch.setattr(service, "prepare", prepare_then_reject)
    zf = archive(export(api, "a.admin", world))
    assert set(notes_in(zf)) == {kept["note_id"]}
    assert all(rejected["note_id"] not in name for name in zf.namelist())
    assert rejected["note_id"] not in zf.read("hashes.csv").decode()


def test_html_is_the_standard_research_note_form(api: NotesApi, world: World) -> None:
    api.witnessed(world)
    note = api.today(world)
    note = api.save(
        note,
        [
            {"section": "REFERENCES", "text": "고온 구간 용량 분석 노트북"},
            {"section": "RESULTS", "text": "40도 이상에서 용량 감소가 뚜렷하다."},
            {"section": "OBJECTIVE", "text": "고온 열화 원인 파악"},
        ],
    )
    assert api.post("a.recorder", f"/notes/{note['note_id']}/submit").status_code == 200
    zf = archive(export(api, "a.recorder", world))
    page = zf.read(next(n for n in zf.namelist() if n.endswith(".html"))).decode()

    header = page[page.index('<table class="header">') : page.index('<table class="sections">')]
    for label, value in (
        ("과제명", "전극 소재 열화 분석"),
        ("연구일자", note["note_date"]),
        ("기록자", "김민준"),
        ("소속", "한국소재연구원"),
    ):
        assert f'<th scope="row">{label}</th><td>{value}</td>' in header

    sections = page[page.index('<table class="sections">') : page.index("<h2>서명</h2>")]
    labels = [
        "연구 목표",
        "연구 방법·재료",
        "수행 내용",
        "결과 및 관찰",
        "고찰·문제점",
        "향후 계획",
        "참고 자료",
    ]
    positions = [sections.index(f'<th scope="row">{label}</th>') for label in labels]
    assert positions == sorted(positions)  # template order, whatever the save order
    assert '<th scope="row">연구 방법·재료</th><td>-</td>' in sections  # empty sections keep their row
    assert '<th scope="row">연구 목표</th><td><p>고온 열화 원인 파악</p></td>' in sections

    signatures = page[page.index('<table class="signatures">') :]
    assert '<th scope="row">기록자</th><td>김민준</td><td>서명 전</td>' in signatures
    assert '<th scope="row">확인자</th><td>박지훈</td><td>서명 전</td>' in signatures  # the unsigned witness
