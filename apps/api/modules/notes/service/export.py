"""exportNotes: a streamed ZIP of research notes (notes/*.json, notes/*.html, hashes.csv).

Scope: every version of the caller's own notes in the project (any status), plus, for an ORG_ADMIN, the SUBMITTED and
SIGNED notes of other recorders of the admin's organization in that project (never their DRAFTs). Each exported note
of another recorder is logged as notes.note.viewed.v1, as getNote does. A caller who is neither a member of the project
nor gets any note sees 404 (the project is not revealed).

prepare() runs in the request transaction (which commits before the response body streams): scope, the cap of
MAX_EXPORT_NOTES notes (422 beyond: narrow the date range) and the view log. stream() then reads the notes in batches
of BATCH_SIZE through its own read-only snapshot session while writing the ZIP. Each notes/<file>.json is canonical JSON whose `content` object re-hashes
(sha256 of its canonical JSON) to content_hash, so an archive can be checked offline. Only this module's data plus
project and people names go into the archive.
"""

import csv
import html
import io
import zipfile
from collections.abc import Iterable, Iterator, Sequence
from dataclasses import dataclass
from datetime import date, datetime
from typing import Any
from uuid import UUID

from sqlalchemy.engine import RowMapping
from sqlalchemy.orm import Session

from api.modules.notes import repo
from api.modules.notes.deps import NotesDeps
from api.modules.notes.errors import invalid, not_found
from api.modules.notes.hashing import canonical_json, note_document
from api.modules.notes.service.notes import KST, check_range, emit_viewed
from api.modules.notes.views import evidence_view, project_name
from api.platform import clock
from api.platform.auth import CurrentUser
from api.platform.db import session_factory

ORG_ADMIN = "ORG_ADMIN"
MAX_EXPORT_NOTES = 5000  # more -> 422: narrow the date range
BATCH_SIZE = 100
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
    """What prepare() decided inside the request transaction: which notes (in archive order), for whom. The bytes
    are produced later by stream(), which reads the notes in batches through its own read-only session."""

    filename: str
    project_name: str
    viewer_id: UUID
    note_ids: list[UUID]
    created_at: datetime


def prepare(
    session: Session,
    deps: NotesDeps,
    user: CurrentUser,
    project_id: UUID,
    date_from: date | None,
    date_to: date | None,
) -> Archive:
    """Scope check, size cap and view logging, committed with the request before any byte streams: every exported
    note of another recorder is logged as viewed (열람 관리대장) even if the client aborts the download."""
    check_range(date_from, date_to)
    is_admin = ORG_ADMIN in user.org_roles
    rows = repo.export_notes(
        session,
        project_id,
        user.user_id,
        organization_id=user.organization_id if is_admin else None,
        date_from=date_from,
        date_to=date_to,
        limit=MAX_EXPORT_NOTES + 1,
    )
    if not rows and deps.projects.get_member_role(project_id, user.user_id) is None:
        raise not_found("Project")
    if len(rows) > MAX_EXPORT_NOTES:
        raise invalid(
            "from",
            "TOO_MANY_NOTES",
            f"An export holds at most {MAX_EXPORT_NOTES} notes; narrow the date range (from/to).",
        )
    for row in rows:
        if row["recorder_id"] != user.user_id:
            emit_viewed(session, user, row)
    span = f"{date_from.isoformat() if date_from else 'all'}-{date_to.isoformat() if date_to else 'all'}"
    return Archive(
        filename=f"research-notes-{project_id}-{span}.zip",
        project_name=project_name(deps, project_id),
        viewer_id=user.user_id,
        note_ids=[r["note_id"] for r in rows],
        created_at=clock.now(),
    )


def _batches(
    session: Session, deps: NotesDeps, viewer_id: UUID, note_ids: Sequence[UUID]
) -> Iterator[tuple[ExportedNote, dict[UUID, str]]]:
    """Notes with their blocks and signatures, BATCH_SIZE at a time, in archive order. The export scope is applied
    again in the query: a note deleted since prepare() (a DRAFT), or another recorder's note rejected back to DRAFT
    since then, is never loaded and stays out of the archive and hashes.csv."""
    for start in range(0, len(note_ids), BATCH_SIZE):
        ids = list(note_ids[start : start + BATCH_SIZE])
        notes = repo.load_exportable(session, ids, viewer_id)
        ids = [i for i in ids if i in notes]
        blocks = repo.load_blocks(session, ids)
        signatures = repo.load_signatures(session, ids)
        people = [n["recorder_id"] for n in notes.values()] + [
            s["signer_id"] for sig in signatures.values() for s in sig
        ]
        names = deps.people.get_display_names(list(dict.fromkeys(people)))
        for note_id in ids:
            if note_id in notes:
                yield ExportedNote(notes[note_id], blocks[note_id], signatures[note_id]), names


# ---------------------------------------------------------------- formatting


def _record(archive: Archive, item: ExportedNote, names: dict[UUID, str]) -> dict[str, Any]:
    note = item.note
    return {
        "format": FORMAT,
        "content": note_document(note, item.blocks),
        "content_hash": note["content_hash"],
        "chain_seq": note["chain_seq"],
        "chain_hash": note["chain_hash"],
        "status": note["status"],
        "project_name": archive.project_name,
        "recorder_display_name": names.get(note["recorder_id"], ""),
        "blocks": [
            {"block_id": b["block_id"], "accepted": b["accepted"], "origin": b["origin"]} for b in item.blocks
        ],
        "witness_required": note["witness_required"],
        "witness_user_ids": list(note["witness_user_ids"] or []) if note["status"] != "DRAFT" else [],
        "signatures": [
            {
                "signer_id": s["signer_id"],
                "signer_display_name": names.get(s["signer_id"], ""),
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


def _html(archive: Archive, item: ExportedNote, names: dict[UUID, str]) -> str:
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
        f"<tr><td>{e(ROLES.get(s['role'], s['role']))}</td><td>{e(names.get(s['signer_id'], s['signer_id']))}"
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
        f"<dt>기록자</dt><dd>{e(names.get(note['recorder_id'], note['recorder_id']))}</dd>"
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


def _csv_row(n: RowMapping) -> list[Any]:
    """Only ids, dates, enums and hex digests: no free text, so no spreadsheet formula can be injected."""
    return [
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


def _csv(rows: Sequence[list[Any]]) -> bytes:
    out = io.StringIO()
    writer = csv.writer(out, lineterminator="\n")
    writer.writerow(CSV_COLUMNS)
    writer.writerows(rows)
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


def stream(archive: Archive, deps: NotesDeps, database_url: str) -> Iterator[bytes]:
    """The ZIP, entry by entry. Reads through its own session (the request's has committed by now) in one
    REPEATABLE READ READ ONLY transaction, so the archive is a consistent snapshot."""
    session = session_factory(database_url)()
    try:
        session.connection(
            execution_options={"isolation_level": "REPEATABLE READ", "postgresql_readonly": True}
        )
        yield from _zip(archive, _batches(session, deps, archive.viewer_id, archive.note_ids))
    finally:
        session.rollback()
        session.close()


def _zip(archive: Archive, items: Iterable[tuple[ExportedNote, dict[UUID, str]]]) -> Iterator[bytes]:
    stamp = archive.created_at.astimezone(KST).timetuple()[:6]
    csv_rows: list[list[Any]] = []
    sink = _Sink()
    with zipfile.ZipFile(sink, "w", compression=zipfile.ZIP_DEFLATED) as zf:

        def put(name: str, data: bytes) -> None:
            info = zipfile.ZipInfo(name, date_time=stamp)
            info.compress_type = zipfile.ZIP_DEFLATED
            zf.writestr(info, data)

        for item, names in items:
            n = item.note
            base = f"notes/{n['note_date'].isoformat()}_v{n['version']}_{n['note_id']}"
            put(f"{base}.json", canonical_json(_record(archive, item, names)))
            yield sink.drain()
            put(f"{base}.html", _html(archive, item, names).encode("utf-8"))
            yield sink.drain()
            csv_rows.append(_csv_row(n))
        put("hashes.csv", _csv(csv_rows))
    yield sink.drain()
