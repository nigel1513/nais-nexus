"""Canonical JSON, rounding, evidence bounds, manifest and fingerprints (09 §4, M03 §4.9, D-029)."""

import copy
import hashlib
import json
from collections.abc import Iterable, Iterator
from fractions import Fraction
from typing import Any

from api.modules.readiness.catalog_port import FileRef

EVIDENCE_MAX_BYTES = 64 * 1024


def r6(value: float) -> float:
    rounded = round(float(value), 6)
    return 0.0 if rounded == 0 else rounded  # normalise -0.0


def ratio(numerator: int, denominator: int) -> float:
    return r6(numerator / denominator) if denominator else 0.0


def fraction(numerator: int, denominator: int) -> Fraction:
    """Exact ratio for verdict comparisons (r6 rounding is for evidence only)."""
    return Fraction(numerator, denominator) if denominator else Fraction(0)


def exceeds(value: Fraction, threshold: float) -> bool:
    """value > threshold, comparing against the decimal literal of the profile parameter (0.01 is exactly 1/100)."""
    return value > Fraction(repr(threshold))


def _check_keys(obj: Any) -> None:
    if isinstance(obj, dict):
        for key, value in obj.items():
            if not isinstance(key, str):
                raise TypeError(f"canonical_json requires str keys, got {type(key).__name__}")
            _check_keys(value)
    elif isinstance(obj, list | tuple):
        for item in obj:
            _check_keys(item)


def canonical_json(obj: Any) -> str:
    _check_keys(obj)
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False)


def sha256_hex(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _size(obj: Any) -> int:
    return len(canonical_json(obj).encode("utf-8"))


def _lists(obj: Any, path: tuple[str | int, ...] = ()) -> Iterator[tuple[tuple[str | int, ...], list[Any]]]:
    if isinstance(obj, dict):
        for key, value in obj.items():
            yield from _lists(value, (*path, key))
    elif isinstance(obj, list):
        if obj:
            yield path, obj
        for index, item in enumerate(obj):
            yield from _lists(item, (*path, index))


def bound_evidence(evidence: dict[str, Any], limit: int = EVIDENCE_MAX_BYTES) -> dict[str, Any]:
    """M05 §4.2: evidence <= 64 KiB. Halve the largest list anywhere in the tree until it fits, mark truncated.

    Ties break on the smallest path (str keys / int indexes compared by their string form). Raises ValueError
    when nothing is left to shrink: validators own the evidence shape.
    """
    if _size(evidence) <= limit:
        return evidence
    bounded = copy.deepcopy(evidence)
    bounded["truncated"] = True
    while _size(bounded) > limit:
        candidates = [(_size(lst), path, lst) for path, lst in _lists(bounded)]
        if not candidates:
            raise ValueError("evidence exceeds the size limit and has no list left to truncate")
        best = max(size for size, _, _ in candidates)
        _, _, target = min(
            ((s, tuple(str(p) for p in path), lst) for s, path, lst in candidates if s == best),
            key=lambda item: item[1],
        )
        del target[len(target) // 2 :]
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
