"""Signing, the project x organization hash chain and verification (openapi signNote/verifyNote).

A signature needs a fresh login: the token's auth_time within SIGNATURE_MAX_AGE (401 NOTE_SIGNATURE_EXPIRED otherwise).
- Recorder: from SUBMITTED always; from DRAFT only when the project currently requires no witness, in which case the
  sign runs the submit checks and takes the (witness-free) snapshot in the same transaction.
- Witness: a user of the note's snapshot, SUBMITTED only, when the snapshot requires a witness.
The note becomes SIGNED once it has the RECORDER signature and, when its snapshot requires one, a WITNESS signature.
Only the snapshot is consulted, never the current setting. The SIGNED transition appends the note to its chain under
the chain row's lock: chain_hash = sha256(previous chain_hash + content_hash).
"""

from collections.abc import Sequence
from datetime import timedelta
from uuid import UUID

from sqlalchemy.engine import RowMapping
from sqlalchemy.orm import Session

from api.modules.notes import jobs, repo
from api.modules.notes.access import DRAFT, SIGNED, Relation, load, readable, require_active, witness_snapshot
from api.modules.notes.deps import NotesDeps
from api.modules.notes.errors import conflict, locked, not_witness, signature_expired
from api.modules.notes.hashing import content_hash, next_chain_hash
from api.modules.notes.schemas import NoteVerification, ResearchNote
from api.modules.notes.service.notes import fix_content
from api.modules.notes.views import event_payload, note_view, project_name
from api.platform import clock
from api.platform.auth import CurrentUser
from api.platform.events import EventActor
from api.platform.generated.event_types import EventType
from api.platform.ids import new_id
from api.platform.outbox import outbox

SIGNATURE_MAX_AGE = timedelta(minutes=5)
CLOCK_SKEW = timedelta(seconds=60)  # an auth_time further in the future than this is not trusted
RECORDER, WITNESS = "RECORDER", "WITNESS"


def require_fresh_login(user: CurrentUser) -> None:
    now = clock.now()
    if user.auth_time is None or not (now - SIGNATURE_MAX_AGE <= user.auth_time <= now + CLOCK_SKEW):
        raise signature_expired()


def sign(session: Session, deps: NotesDeps, user: CurrentUser, note_id: UUID) -> ResearchNote:
    note, relation = load(session, deps, user, note_id, for_update=True)
    if relation is Relation.MEMBER:  # not the recorder and not a snapshot witness, whatever the note's state
        raise not_witness()
    require_fresh_login(user)
    if note["status"] == SIGNED:
        raise locked()
    if relation is Relation.RECORDER:
        require_active(deps, note["project_id"], user)
        if note["status"] == DRAFT:
            required, _ = witness_snapshot(session, deps, note["project_id"], note["recorder_id"])
            if required:
                raise conflict("The project requires a witness: submit the note first.")
            note = fix_content(session, note, witness_required=False, witness_user_ids=[])
        role = RECORDER
    else:  # Relation.WITNESS
        require_active(deps, note["project_id"], user)
        role = WITNESS

    note_id = note["note_id"]
    signed_roles = {s["role"] for s in repo.load_signatures(session, [note_id])[note_id]}
    if role in signed_roles:
        raise conflict(f"The note already has its {role} signature.")
    blocks = repo.load_blocks(session, [note_id])[note_id]
    if content_hash(note, blocks) != note["content_hash"]:  # stored content no longer matches its fixed hash
        raise conflict("The note's content does not match its fixed hash; verify the note.")
    now = clock.now()
    repo.insert_signature(
        session,
        signature_id=new_id(),
        note_id=note_id,
        signer_id=user.user_id,
        role=role,
        signed_at=now,
        content_hash=note["content_hash"],
        auth_time=user.auth_time,
    )
    signed_roles.add(role)
    final = RECORDER in signed_roles and (not note["witness_required"] or WITNESS in signed_roles)
    if final:
        note = _append_to_chain(session, note)
    jobs.embed_after_commit(
        session, deps, note_id
    )  # unchanged text is only re-checked (text_hash), not re-embedded
    outbox.write(
        session,
        EventType.NOTES_NOTE_SIGNED_V1,
        event_payload(
            note,
            user.user_id,
            now,
            project_name=project_name(deps, note["project_id"]),
            signer_id=str(user.user_id),
            signer_role=role,
            final=final,
            content_hash=note["content_hash"],
            chain_hash=note["chain_hash"],
        ),
        EventActor.for_user(user),
    )
    return note_view(session, deps, note, user.user_id)


def _append_to_chain(session: Session, note: RowMapping) -> RowMapping:
    project_id, organization_id = note["project_id"], note["organization_id"]
    head = repo.lock_chain(session, project_id, organization_id)
    seq = head["last_seq"] + 1
    chain_hash = next_chain_hash(head["last_chain_hash"], note["content_hash"])
    now = clock.now()
    repo.advance_chain(session, project_id, organization_id, seq=seq, chain_hash=chain_hash, at=now)
    return repo.update_note(
        session,
        note["note_id"],
        status=SIGNED,
        chain_seq=seq,
        chain_hash=chain_hash,
        signed_at=now,
        updated_at=now,
    )


# ---------------------------------------------------------------- verification


def verify(session: Session, deps: NotesDeps, user: CurrentUser, note_id: UUID) -> NoteVerification:
    note, _ = readable(session, deps, user, note_id)
    if note["status"] == DRAFT:
        raise conflict("A DRAFT note has no fixed content to verify.")
    blocks = repo.load_blocks(session, [note_id])[note_id]
    return NoteVerification.model_validate(
        {
            "note_id": note_id,
            "valid": content_hash(note, blocks) == note["content_hash"],
            "content_hash": note["content_hash"],
            "recomputed_hash": content_hash(note, blocks),
            "chain_valid": chain_is_intact(session, note["project_id"], note["organization_id"]),
            "checked_at": clock.now(),
        }
    )


def chain_is_intact(session: Session, project_id: UUID, organization_id: UUID) -> bool:
    """Rebuild the chain from the stored content of every SIGNED note (chain order) and compare it link by link with
    the stored chain hashes and the chain head. Each link also needs its signatures: the RECORDER one (and a WITNESS
    one when the snapshot requires it), each over the note's content hash."""
    notes = repo.signed_chain(session, project_id, organization_id)
    ids = [n["note_id"] for n in notes]
    blocks = repo.load_blocks(session, ids)
    signatures = repo.load_signatures(session, ids)
    previous: str | None = None
    for seq, note in enumerate(notes, start=1):
        recomputed = content_hash(note, blocks[note["note_id"]])
        if note["chain_seq"] != seq or recomputed != note["content_hash"]:
            return False
        if not _signatures_cover(note, recomputed, signatures[note["note_id"]]):
            return False
        previous = next_chain_hash(previous, recomputed)
        if previous != note["chain_hash"]:
            return False
    head = repo.load_chain(session, project_id, organization_id)
    if head is None:
        return not notes
    return bool(head["last_seq"] == len(notes) and head["last_chain_hash"] == previous)


def _signatures_cover(note: RowMapping, recomputed: str, signatures: Sequence[RowMapping]) -> bool:
    """The signatures attest this content and were made by the right people before the note was completed: the
    RECORDER signature by the note's recorder, the WITNESS signature by a snapshot witness other than the recorder."""
    witnesses = set(note["witness_user_ids"] or ())
    roles: set[str] = set()
    for s in signatures:
        if s["content_hash"] != recomputed or s["signed_at"] > note["signed_at"]:
            return False
        if s["role"] == RECORDER and s["signer_id"] != note["recorder_id"]:
            return False
        if s["role"] == WITNESS and (
            s["signer_id"] not in witnesses or s["signer_id"] == note["recorder_id"]
        ):
            return False
        roles.add(s["role"])
    return RECORDER in roles and (not note["witness_required"] or WITNESS in roles)
