"""exportNotes: a streamed ZIP of research notes (notes/*.json, notes/*.html, hashes.csv).

Scope: every version of the caller's own notes in the project (any status), plus, for an ORG_ADMIN, the SUBMITTED and
SIGNED notes of other recorders of the admin's organization in that project (never their DRAFTs). Each exported note
of another recorder is logged as notes.note.viewed.v1, as getNote does. A caller who is neither a member of the project
nor gets any note sees 404 (the project is not revealed).

Everything is read inside the request transaction (the session commits before the response body streams); the
generator only formats the loaded rows. Each notes/<file>.json is canonical JSON whose `content` object re-hashes
(sha256 of its canonical JSON) to content_hash, so an archive can be checked offline. Only this module's data plus
project and people names go into the archive.
"""

import csv
import html
import io
import zipfile
from collections.abc import Iterator, Sequence
from dataclasses import dataclass
from datetime import date, datetime
from typing import Any
from uuid import UUID

from sqlalchemy.engine import RowMapping
from sqlalchemy.orm import Session

from api.modules.notes import repo
from api.modules.notes.deps import NotesDeps
from api.modules.notes.errors import not_found
from api.modules.notes.hashing import canonical_json, note_document
from api.modules.notes.service.notes import KST, check_range, emit_viewed
from api.modules.notes.views import evidence_view, project_name
from api.platform import clock
from api.platform.auth import CurrentUser

ORG_ADMIN = "ORG_ADMIN"
FORMAT = "nais.research-note.v1"
SECTIONS = {
    "DIRECTION": "연구 방향",
    "STEPS": "수행 내용",
    "RESULTS": "결과",
    "NEXT": "다음 계획",
    "MEMO": "메모",
}
STATUSES = {"DRAFT": "작성 중", "SUBMITTED": "제출됨", "SIGNED": "서명 완료"}
ROLES = {"RECORDER": "기록자", "WITNESS": "확인자"}
CSV_COLUMNS = (
    "note_id",
    "note_date",
    "version",
    "recorder_id",
    "organization_id",
    "status",
    "content_hash",
    "chain_seq",
    "chain_hash",
    "submitted_at",
    "signed_at",
)


@dataclass(frozen=True)
class ExportedNote:
    note: RowMapping
    blocks: list[RowMapping]
    signatures: list[RowMapping]


@dataclass(frozen=True)
class Archive:
    filename: str
    project_name: str
    names: dict[UUID, str]
    notes: list[ExportedNote]
    created_at: datetime


def prepare(
    session: Session,
    deps: NotesDeps,
    user: CurrentUser,
    project_id: UUID,
    date_from: date | None,
    date_to: date | None,
) -> Archive:
    check_range(date_from, date_to)
    is_admin = ORG_ADMIN in user.org_roles
    rows = repo.export_notes(
        session,
        project_id,
        user.user_id,
        organization_id=user.organization_id if is_admin else None,
        date_from=date_from,
        date_to=date_to,
    )
    if not rows and deps.projects.get_member_role(project_id, user.user_id) is None:
        raise not_found("Project")
    ids = [r["note_id"] for r in rows]
    blocks = repo.load_blocks(session, ids)
    signatures = repo.load_signatures(session, ids)
    for row in rows:
        if row["recorder_id"] != user.user_id:
            emit_viewed(session, user, row)
    people = [r["recorder_id"] for r in rows] + [s["signer_id"] for sigs in signatures.values() for s in sigs]
    span = f"{date_from.isoformat() if date_from else 'all'}-{date_to.isoformat() if date_to else 'all'}"
    return Archive(
        filename=f"research-notes-{project_id}-{span}.zip",
        project_name=project_name(deps, project_id),
        names=deps.people.get_display_names(list(dict.fromkeys(people))),
        notes=[ExportedNote(r, blocks[r["note_id"]], signatures[r["note_id"]]) for r in rows],
        created_at=clock.now(),
    )


# ---------------------------------------------------------------- formatting


def _record(archive: Archive, item: ExportedNote) -> dict[str, Any]:
    note = item.note
    return {
        "format": FORMAT,
        "content": note_document(note, item.blocks),
        "content_hash": note["content_hash"],
        "chain_seq": note["chain_seq"],
        "chain_hash": note["chain_hash"],
        "status": note["status"],
        "project_name": archive.project_name,
        "recorder_display_name": archive.names.get(note["recorder_id"], ""),
        "blocks": [
            {"block_id": b["block_id"], "accepted": b["accepted"], "origin": b["origin"]} for b in item.blocks
        ],
        "witness_required": note["witness_required"],
        "witness_user_ids": list(note["witness_user_ids"] or []) if note["status"] != "DRAFT" else [],
        "signatures": [
            {
                "signer_id": s["signer_id"],
                "signer_display_name": archive.names.get(s["signer_id"], ""),
                "role": s["role"],
                "signed_at": s["signed_at"],
                "content_hash": s["content_hash"],
            }
            for s in item.signatures
        ],
        "submitted_at": note["submitted_at"],
        "signed_at": note["signed_at"],
        "rejected_reason": note["rejected_reason"],
        "created_at": note["created_at"],
        "updated_at": note["updated_at"],
    }


def _kst(value: datetime | None) -> str:
    return value.astimezone(KST).strftime("%Y-%m-%d %H:%M:%S KST") if value else "-"


def _html(archive: Archive, item: ExportedNote) -> str:
    """Human-readable page. Every stored value is HTML-escaped and the page forbids scripts and remote loads."""
    note = item.note

    def e(value: object) -> str:
        return html.escape(str(value), quote=True)

    blocks = []
    for b in item.blocks:
        origin = " <small>(AI 초안)</small>" if b["origin"] == "AI" else ""
        evidence = "".join(
            f"<li>{e(ev['type'])} · {e(ev['label'])} · {e(ev['at'])}</li>"
            for ev in evidence_view(b["evidence"])
        )
        blocks.append(
            f"<section><h2>{e(SECTIONS.get(b['section'], b['section']))}{origin}</h2>"
            f"<p>{e(b['text'])}</p>{f'<ul>{evidence}</ul>' if evidence else ''}</section>"
        )
    signatures = "".join(
        f"<tr><td>{e(ROLES.get(s['role'], s['role']))}</td><td>{e(archive.names.get(s['signer_id'], s['signer_id']))}"
        f"</td><td>{e(_kst(s['signed_at']))}</td><td><code>{e(s['content_hash'])}</code></td></tr>"
        for s in item.signatures
    )
    return (
        '<!doctype html><html lang="ko"><head><meta charset="utf-8">'
        "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline'\">"
        f"<title>연구노트 {e(note['note_date'])} v{e(note['version'])}</title>"
        "<style>body{font-family:sans-serif;max-width:48rem;margin:2rem auto;padding:0 1rem;line-height:1.6}"
        "p{white-space:pre-wrap}code{word-break:break-all}table{border-collapse:collapse}"
        "td,th{border:1px solid #999;padding:.25rem .5rem;text-align:left}</style></head><body>"
        f"<h1>연구노트 {e(note['note_date'])} (v{e(note['version'])})</h1>"
        "<dl>"
        f"<dt>과제</dt><dd>{e(archive.project_name)}</dd>"
        f"<dt>기록자</dt><dd>{e(archive.names.get(note['recorder_id'], note['recorder_id']))}</dd>"
        f"<dt>상태</dt><dd>{e(STATUSES.get(note['status'], note['status']))}</dd>"
        f"<dt>제출</dt><dd>{e(_kst(note['submitted_at']))}</dd>"
        f"<dt>서명 완료</dt><dd>{e(_kst(note['signed_at']))}</dd>"
        f"<dt>내용 해시 (SHA-256)</dt><dd><code>{e(note['content_hash'] or '-')}</code></dd>"
        f"<dt>체인 해시</dt><dd><code>{e(note['chain_hash'] or '-')}</code></dd>"
        f"<dt>노트 ID</dt><dd><code>{e(note['note_id'])}</code></dd>"
        "</dl>"
        f"{''.join(blocks)}"
        f"<h2>서명</h2><table><tr><th>역할</th><th>서명자</th><th>일시</th><th>내용 해시</th></tr>{signatures}</table>"
        "</body></html>"
    )


def _csv(notes: Sequence[ExportedNote]) -> bytes:
    """Only ids, dates, enums and hex digests: no free text, so no spreadsheet formula can be injected."""
    out = io.StringIO()
    writer = csv.writer(out, lineterminator="\n")
    writer.writerow(CSV_COLUMNS)
    for item in notes:
        n = item.note
        writer.writerow(
            [
                n["note_id"],
                n["note_date"].isoformat(),
                n["version"],
                n["recorder_id"],
                n["organization_id"],
                n["status"],
                n["content_hash"] or "",
                n["chain_seq"] or "",
                n["chain_hash"] or "",
                n["submitted_at"].isoformat() if n["submitted_at"] else "",
                n["signed_at"].isoformat() if n["signed_at"] else "",
            ]
        )
    return out.getvalue().encode("utf-8")


class _Sink:
    """Write-only, unseekable target for ZipFile (it then writes data descriptors); drained after every entry."""

    def __init__(self) -> None:
        self._chunks: list[bytes] = []

    def write(self, data: bytes) -> int:
        self._chunks.append(bytes(data))
        return len(data)

    def flush(self) -> None:
        return None

    def close(self) -> None:
        return None

    def drain(self) -> bytes:
        data = b"".join(self._chunks)
        self._chunks.clear()
        return data


def stream(archive: Archive) -> Iterator[bytes]:
    stamp = archive.created_at.astimezone(KST).timetuple()[:6]
    sink = _Sink()
    with zipfile.ZipFile(sink, "w", compression=zipfile.ZIP_DEFLATED) as zf:

        def put(name: str, data: bytes) -> None:
            info = zipfile.ZipInfo(name, date_time=stamp)
            info.compress_type = zipfile.ZIP_DEFLATED
            zf.writestr(info, data)

        for item in archive.notes:
            n = item.note
            base = f"notes/{n['note_date'].isoformat()}_v{n['version']}_{n['note_id']}"
            put(f"{base}.json", canonical_json(_record(archive, item)))
            yield sink.drain()
            put(f"{base}.html", _html(archive, item).encode("utf-8"))
            yield sink.drain()
        put("hashes.csv", _csv(archive.notes))
    yield sink.drain()
