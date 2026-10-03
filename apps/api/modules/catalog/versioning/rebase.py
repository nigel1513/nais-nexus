"""3-way rebase of a draft onto the latest published version (spec §3.3b). Pure. Sides map path -> sha256.

base = the draft's base version (empty when the draft has none: a NULL base is stale once anything is published),
mine = the draft, theirs = the latest PUBLISHED version. A path changed on one side only takes that side; the same
change on both sides is kept; different changes (including a delete against a change, or two different additions)
are conflicts that need a resolution (MINE | THEIRS). Resolutions are accepted only for conflicting paths."""

from collections.abc import Mapping
from dataclasses import dataclass


@dataclass(frozen=True)
class Conflict:
    path: str
    base: str | None  # sha256, or None when the path is absent on that side
    mine: str | None
    theirs: str | None


@dataclass(frozen=True)
class RebasePlan:
    take_theirs: tuple[
        str, ...
    ]  # the draft's row becomes an inherited copy of the latest row (or disappears)
    keep_mine: tuple[str, ...]  # the draft's row (or its absence) stays as it is
    conflicts: tuple[Conflict, ...]


def _byte_order(path: str) -> bytes:
    return path.encode("utf-8")


def three_way(
    base: Mapping[str, str],
    mine: Mapping[str, str],
    theirs: Mapping[str, str],
    resolutions: Mapping[str, str],
) -> RebasePlan:
    """Raises ValueError("UNKNOWN_PATH: p, q") when a resolution names a path that is not in conflict."""
    take: list[str] = []
    keep: list[str] = []
    conflicts: list[Conflict] = []
    conflict_paths: set[str] = set()
    for path in sorted(set(base) | set(mine) | set(theirs), key=_byte_order):
        b, m, t = base.get(path), mine.get(path), theirs.get(path)
        if m == b:
            if t != b:
                take.append(path)
        elif t in (b, m):
            keep.append(path)
        else:
            conflict_paths.add(path)
            choice = resolutions.get(path)
            if choice == "THEIRS":
                take.append(path)
            elif choice == "MINE":
                keep.append(path)
            else:
                conflicts.append(Conflict(path, b, m, t))
    unknown = sorted(set(resolutions) - conflict_paths, key=_byte_order)
    if unknown:
        raise ValueError("UNKNOWN_PATH: " + ", ".join(unknown))
    return RebasePlan(tuple(take), tuple(keep), tuple(conflicts))
