"""Canonical JSON, rounding, evidence bounds, manifest and fingerprints (09 §4, M03 §4.9, D-029)."""

import copy
import hashlib
import json
from collections.abc import Iterable
from typing import Any

from api.modules.readiness.catalog_port import FileRef

EVIDENCE_MAX_BYTES = 64 * 1024


def r6(value: float) -> float:
    return round(float(value), 6)


def ratio(numerator: int, denominator: int) -> float:
    return r6(numerator / denominator) if denominator else 0.0


def canonical_json(obj: Any) -> str:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False)


def sha256_hex(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _size(obj: Any) -> int:
    return len(canonical_json(obj).encode("utf-8"))


def bound_evidence(evidence: dict[str, Any], limit: int = EVIDENCE_MAX_BYTES) -> dict[str, Any]:
    """M05 §4.2: evidence <= 64 KiB. Halve the largest top-level array until it fits, mark truncated."""
    if _size(evidence) <= limit:
        return evidence
    bounded = copy.deepcopy(evidence)
    bounded["truncated"] = True
    while _size(bounded) > limit:
        arrays = [(_size(v), k) for k, v in bounded.items() if isinstance(v, list) and v]
        if not arrays:
            break
        _, key = max(arrays)
        bounded[key] = bounded[key][: len(bounded[key]) // 2]
    return bounded


def manifest_sha256(files: Iterable[FileRef]) -> str:
    """M03 §4.9: sorted by UTF-8 path bytes, one "path\\tsize\\tsha256\\n" line per file."""
    ordered = sorted(files, key=lambda f: f.path.encode("utf-8"))
    return sha256_hex("".join(f"{f.path}\t{f.size_bytes}\t{f.sha256}\n" for f in ordered))


def metadata_snapshot_sha256(snapshot: dict[str, Any]) -> str:
    return sha256_hex(canonical_json(snapshot))


def input_fingerprint(
    manifest: str, snapshot: dict[str, Any], profile_id: str, profile_version: str, validator_version: str
) -> str:
    """D-029: manifest + metadata snapshot + profile id/version + validator version, '|'-joined (09 §4 form)."""
    parts = [manifest, metadata_snapshot_sha256(snapshot), profile_id, profile_version, validator_version]
    return sha256_hex("|".join(parts))
