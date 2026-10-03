"""Three-layer version comparison (spec §3.3 "변경 내역 보기"). Pure; never returns raw data values (D-018).

Mirrored by apps/web/src/mocks/versioning.ts (diffFiles, summarize, diffSchema, flatten, diffMetadata)."""

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any

MISSING_RATIO_EPSILON = 0.001
# Person blocks and lists are compared whole; nested organization dicts inside a person stay inside it.
WHOLE_KEYS = frozenset({"people.principal_investigator", "people.steward_contact", "people.contributors"})
# The only column keys the schema layer ever reads: structure, never values (min/max/top values stay out).
COLUMN_KEYS = ("name", "type", "unit", "missing_ratio")


@dataclass(frozen=True)
class FileEntry:
    path: str
    size_bytes: int
    sha256: str


def _side(e: FileEntry | None) -> dict[str, Any] | None:
    return None if e is None else {"size_bytes": e.size_bytes, "sha256": e.sha256}


def file_status(before: FileEntry | None, after: FileEntry | None) -> str:
    if before is None:
        return "ADDED"
    if after is None:
        return "REMOVED"
    return "CHANGED" if after.sha256 != before.sha256 else "UNCHANGED"


def diff_files(before: Mapping[str, FileEntry], after: Mapping[str, FileEntry]) -> list[dict[str, Any]]:
    """One entry per path in either version, in byte order of the path (paths are ASCII by contract)."""
    out: list[dict[str, Any]] = []
    for path in sorted(set(before) | set(after), key=lambda p: p.encode("utf-8")):
        b, a = before.get(path), after.get(path)
        size_delta = (a.size_bytes if a else 0) - (b.size_bytes if b else 0)
        out.append(
            {
                "path": path,
                "status": file_status(b, a),
                "before": _side(b),
                "after": _side(a),
                "size_delta": size_delta,
            }
        )
    return out


def summarize(changes: Sequence[Mapping[str, Any]]) -> dict[str, int]:
    counts = {"added": 0, "removed": 0, "changed": 0, "unchanged": 0}
    for c in changes:
        counts[str(c["status"]).lower()] += 1
    return counts


def profile_view(column_profile: Mapping[str, Any] | None) -> dict[str, Any] | None:
    """The structural part of a stored READY column profile. `total_rows` is absent from profiles generated before
    Wave 1.5 Stage 2: a complete read (not truncated) counted every row, a truncated one does not know."""
    if column_profile is None:
        return None
    total = column_profile.get("total_rows")
    if "total_rows" not in column_profile:
        total = None if column_profile.get("truncated", True) else column_profile.get("rows_sampled")
    return {
        "total_rows": total,
        "columns": [{k: c.get(k) for k in COLUMN_KEYS} for c in column_profile.get("columns", [])],
    }


def _pair(b: Any, a: Any) -> list[Any] | None:
    return None if b == a else [b, a]


def diff_schema(
    path: str, before: Mapping[str, Any] | None, after: Mapping[str, Any] | None
) -> dict[str, Any]:
    """A missing side (no profile, or not READY yet) is PROFILE_MISSING: unknown, never "all columns removed"."""
    if before is None or after is None:
        return {"path": path, "status": "PROFILE_MISSING"}
    bcols = {c["name"]: c for c in before.get("columns", [])}
    acols = {c["name"]: c for c in after.get("columns", [])}
    changed: list[dict[str, Any]] = []
    for name in [n for n in acols if n in bcols]:
        b, a = bcols[name], acols[name]
        ratio: list[float] | None = None
        b_ratio, a_ratio = b.get("missing_ratio"), a.get("missing_ratio")
        # An unknown ratio on either side (absent / null in an old or foreign profile) is not a change.
        if (
            isinstance(b_ratio, int | float)
            and isinstance(a_ratio, int | float)
            and abs(float(a_ratio) - float(b_ratio)) >= MISSING_RATIO_EPSILON
        ):
            ratio = [round(float(b_ratio), 4), round(float(a_ratio), 4)]
        entry = {
            "name": name,
            "type": _pair(b.get("type"), a.get("type")),
            "unit": _pair(b.get("unit"), a.get("unit")),
            "missing_ratio": ratio,
        }
        if entry["type"] or entry["unit"] or entry["missing_ratio"]:
            changed.append(entry)
    return {
        "path": path,
        "status": "COMPARED",
        "rows": [before.get("total_rows"), after.get("total_rows")],
        "columns_added": [n for n in acols if n not in bcols],
        "columns_removed": [n for n in bcols if n not in acols],
        "columns_changed": changed,
    }


def flatten(snapshot: Mapping[str, Any] | None, prefix: str = "") -> dict[str, Any]:
    out: dict[str, Any] = {}
    for key, value in (snapshot or {}).items():
        dotted = f"{prefix}{key}"
        if isinstance(value, Mapping) and dotted not in WHOLE_KEYS:
            out.update(flatten(value, f"{dotted}."))
        else:
            out[dotted] = value
    return out


def diff_metadata(before: Mapping[str, Any] | None, after: Mapping[str, Any] | None) -> list[dict[str, Any]]:
    """Field-level changes of two metadata snapshots; a field missing on one side compares as null."""
    b, a = flatten(before), flatten(after)
    return [
        {"field": key, "before": b.get(key), "after": a.get(key)}
        for key in sorted(set(b) | set(a), key=lambda k: k.encode("utf-8"))
        if b.get(key) != a.get(key)
    ]
