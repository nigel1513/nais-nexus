"""Canonical JSON, the note content hash and the project x organization hash chain.

canonical_json: UTF-8 JSON with keys sorted, no insignificant whitespace, every string (keys included) Unicode NFC
normalized, timestamps as UTC `YYYY-MM-DDTHH:MM:SS.ffffffZ`, dates as `YYYY-MM-DD`, UUIDs in their canonical lower-case
form. Floats are refused (no float has a single canonical text form across JSON implementations) and so are naive
datetimes (they name no instant).

content_hash = sha256(canonical_json(note_document(note, blocks))): the note's identity metadata and its blocks in
order (section, text, origin, evidence). Block ids and AI acceptance flags are not content: submit requires every AI
block accepted, and a revision copies blocks under new ids.

chain_hash(n) = sha256(chain_hash(n-1) + content_hash(n)) over the hex strings, starting from GENESIS_CHAIN_HASH.
"""

import hashlib
import json
import re
import unicodedata
from collections.abc import Mapping, Sequence
from datetime import UTC, date, datetime
from enum import Enum
from typing import Any
from uuid import UUID

GENESIS_CHAIN_HASH = "0" * 64
_HEX64 = re.compile(r"^[a-f0-9]{64}$")


def _timestamp(value: datetime | str) -> str:
    moment = datetime.fromisoformat(value) if isinstance(value, str) else value
    if moment.tzinfo is None:
        raise ValueError("timestamps in research notes must be timezone-aware")
    return moment.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def _normalize(value: Any) -> Any:
    if value is None or isinstance(value, bool):
        return value
    if isinstance(value, Enum):
        return _normalize(value.value)
    if isinstance(value, str):
        return unicodedata.normalize("NFC", value)
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        raise TypeError("floats have no canonical form in research-note hashes")
    if isinstance(value, datetime):
        return _timestamp(value)
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, UUID):
        return str(value)
    if isinstance(value, Mapping):
        out: dict[str, Any] = {}
        for key, item in value.items():
            if not isinstance(key, str):
                raise TypeError("object keys must be strings")
            normalized = unicodedata.normalize("NFC", key)
            if normalized in out:
                raise ValueError(f"duplicate key after NFC normalization: {normalized!r}")
            out[normalized] = _normalize(item)
        return out
    if isinstance(value, list | tuple):
        return [_normalize(item) for item in value]
    raise TypeError(f"{type(value).__name__} has no canonical JSON form")


def canonical_json(value: Any) -> bytes:
    return json.dumps(
        _normalize(value), ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False
    ).encode("utf-8")


def _uuid(value: Any) -> str:
    return str(value if isinstance(value, UUID) else UUID(str(value)))


def _evidence(item: Mapping[Any, Any]) -> dict[str, Any]:
    return {
        "type": str(item["type"]),
        "ref_id": _uuid(item["ref_id"]),
        "label": str(item["label"]),
        "at": _timestamp(item["at"]),
    }


def note_document(note: Mapping[Any, Any], blocks: Sequence[Mapping[Any, Any]]) -> dict[str, Any]:
    """The hashed document: identity metadata + ordered blocks (callers pass blocks in position order)."""
    previous = note["previous_version_id"]
    note_date = note["note_date"]
    return {
        "note_id": _uuid(note["note_id"]),
        "project_id": _uuid(note["project_id"]),
        "organization_id": _uuid(note["organization_id"]),
        "recorder_id": _uuid(note["recorder_id"]),
        "note_date": note_date.isoformat()
        if isinstance(note_date, date)
        else date.fromisoformat(note_date).isoformat(),
        "version": int(note["version"]),
        "previous_version_id": _uuid(previous) if previous is not None else None,
        "blocks": [
            {
                "section": str(block["section"]),
                "text": unicodedata.normalize("NFC", block["text"]),
                "origin": str(block["origin"]),
                "evidence": [_evidence(item) for item in block["evidence"]],
            }
            for block in blocks
        ],
    }


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def content_hash(note: Mapping[Any, Any], blocks: Sequence[Mapping[Any, Any]]) -> str:
    return sha256_hex(canonical_json(note_document(note, blocks)))


def next_chain_hash(previous: str | None, content: str) -> str:
    """The chain hash of a note whose content hash is `content`, after the chain head `previous` (None: first)."""
    head = previous or GENESIS_CHAIN_HASH
    if not _HEX64.match(head) or not _HEX64.match(content):
        raise ValueError("chain links are lower-case hex sha256 digests")
    return sha256_hex((head + content).encode("ascii"))
