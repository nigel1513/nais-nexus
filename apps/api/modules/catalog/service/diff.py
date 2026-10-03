"""compareDatasetVersions (spec §3.3) and per-version change summaries (spec §3.3b).

Bounded work: the file layer is one query per side (a version holds at most MAX_FILES_PER_VERSION rows); the schema
layer reads READY column profiles only for CHANGED tabular paths, SCHEMA_CHUNK paths at a time, and keeps only the
structural part of each; `summaries` counts in SQL (no file rows are loaded for a version list)."""

from collections.abc import Iterator, Mapping, Sequence
from typing import Any
from uuid import UUID

from sqlalchemy import column, func, select, values
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.engine import RowMapping
from sqlalchemy.orm import Session

from api.modules.catalog.access import can_see_version, not_found
from api.modules.catalog.deps import CatalogDeps
from api.modules.catalog.previews.profile import table_format
from api.modules.catalog.repo import files_of_versions, load_dataset, load_version
from api.modules.catalog.service.snapshot import live_snapshot
from api.modules.catalog.tables import dataset_files, dataset_versions, file_previews
from api.modules.catalog.versioning.diff import (
    FileEntry,
    diff_files,
    diff_metadata,
    diff_schema,
    profile_view,
    summarize,
)
from api.platform.auth import CurrentUser
from api.platform.errors import ApiError
from api.platform.generated.error_codes import ErrorCode

SCHEMA_CHUNK = 500
MAX_INHERIT_HOPS = 16  # an inherited row points at a published row, which may itself be inherited


def default_target(version: Mapping[Any, Any]) -> UUID | None:
    """A DRAFT compares with its base, a published (or withdrawn) version with its predecessor."""
    target: UUID | None = (
        version["base_version_id"] if version["status"] == "DRAFT" else version["previous_version_id"]
    )
    return target


def _entries(files: Sequence[Mapping[Any, Any]]) -> dict[str, FileEntry]:
    return {f["path"]: FileEntry(f["path"], int(f["size_bytes"]), f["sha256"].strip()) for f in files}


def summaries(
    session: Session, versions: Sequence[Mapping[Any, Any]], *, sees_all_versions: bool
) -> dict[UUID, dict[str, int] | None]:
    """change_summary per version against its default target; None when there is nothing to compare with (a first
    version, or a draft created before anything was published) and, Ruling S10, when the caller cannot see the
    target (`sees_all_versions` false and the target is not PUBLISHED, e.g. a WITHDRAWN predecessor); compare()
    answers 404 for that target. One SQL statement for the whole list."""
    result: dict[UUID, dict[str, int] | None] = {v["dataset_version_id"]: None for v in versions}
    pairs = [(v["dataset_version_id"], target) for v in versions if (target := default_target(v)) is not None]
    if pairs and not sees_all_versions:
        published: set[UUID] = set(
            session.execute(
                select(dataset_versions.c.dataset_version_id).where(
                    dataset_versions.c.dataset_version_id.in_({t for _, t in pairs}),
                    dataset_versions.c.status == "PUBLISHED",
                )
            ).scalars()
        )
        pairs = [(v, t) for v, t in pairs if t in published]
    if not pairs:
        return result
    p = values(column("v", PG_UUID(as_uuid=True)), column("t", PG_UUID(as_uuid=True)), name="pairs").data(
        pairs
    )
    after, before = dataset_files.alias("a"), dataset_files.alias("b")
    n_after = select(func.count()).where(after.c.dataset_version_id == p.c.v).scalar_subquery()
    n_before = select(func.count()).where(before.c.dataset_version_id == p.c.t).scalar_subquery()
    a2, b2 = dataset_files.alias("a2"), dataset_files.alias("b2")
    matched = (
        select(func.count())
        .select_from(a2.join(b2, a2.c.path == b2.c.path))
        .where(a2.c.dataset_version_id == p.c.v, b2.c.dataset_version_id == p.c.t)
    )
    same = matched.where(func.btrim(a2.c.sha256) == func.btrim(b2.c.sha256))
    stmt = select(p.c.v, n_after, n_before, matched.scalar_subquery(), same.scalar_subquery())
    for vid, n_a, n_b, n_matched, n_same in session.execute(stmt):
        result[vid] = {
            "added": int(n_a) - int(n_matched),
            "removed": int(n_b) - int(n_matched),
            "changed": int(n_matched) - int(n_same),
            "unchanged": int(n_same),
        }
    return result


def _chunks[T](items: Sequence[T], size: int) -> Iterator[Sequence[T]]:
    for start in range(0, len(items), size):
        yield items[start : start + size]


def _profiles(session: Session, files: Sequence[Mapping[Any, Any]]) -> dict[UUID, dict[str, Any]]:
    """file_id -> structural profile view. A row without a READY profile of its own uses the one of the row it
    inherits from (same stored object), following the chain; a row with neither is absent (PROFILE_MISSING)."""
    source = {f["file_id"]: f["inherited_from_file_id"] for f in files}
    pending = {f["file_id"]: f["file_id"] for f in files}  # row -> candidate whose profile is looked up next
    found: dict[UUID, dict[str, Any]] = {}
    for _ in range(MAX_INHERIT_HOPS):
        if not pending:
            break
        ready = {
            r.file_id: r.column_profile
            for r in session.execute(
                select(file_previews.c.file_id, file_previews.c.column_profile).where(
                    file_previews.c.file_id.in_(set(pending.values())), file_previews.c.status == "READY"
                )
            )
        }
        unresolved = {row: cand for row, cand in pending.items() if cand not in ready}
        for row, cand in pending.items():
            if cand in ready:
                view = profile_view(ready[cand])
                if view is not None:
                    found[row] = view
        missing_sources = {cand for cand in unresolved.values() if cand not in source}
        if missing_sources:
            source.update(
                {
                    r.file_id: r.inherited_from_file_id
                    for r in session.execute(
                        select(dataset_files.c.file_id, dataset_files.c.inherited_from_file_id).where(
                            dataset_files.c.file_id.in_(missing_sources)
                        )
                    )
                }
            )
        pending = {row: nxt for row, cand in unresolved.items() if (nxt := source.get(cand)) is not None}
    return found


def _schema_layer(
    session: Session,
    changes: Sequence[Mapping[str, Any]],
    before: Mapping[str, Mapping[Any, Any]],
    after: Mapping[str, Mapping[Any, Any]],
) -> list[dict[str, Any]]:
    paths = [c["path"] for c in changes if c["status"] == "CHANGED" and table_format(c["path"]) is not None]
    out: list[dict[str, Any]] = []
    for chunk in _chunks(paths, SCHEMA_CHUNK):
        profiles = _profiles(session, [before[p] for p in chunk] + [after[p] for p in chunk])
        out.extend(
            diff_schema(p, profiles.get(before[p]["file_id"]), profiles.get(after[p]["file_id"]))
            for p in chunk
        )
    return out


def _visible_version(session: Session, user: CurrentUser, version_id: UUID) -> tuple[RowMapping, RowMapping]:
    version = load_version(session, version_id)
    ds = load_dataset(session, version["dataset_id"]) if version is not None else None
    if version is None or ds is None or not can_see_version(user, ds, version):
        raise not_found("Dataset version")  # never reveal versions the caller cannot see
    return version, ds


def _snapshot(
    session: Session, deps: CatalogDeps, version: Mapping[Any, Any] | None, ds: Mapping[Any, Any]
) -> Mapping[str, Any] | None:
    if version is None:
        return None
    if version["status"] == "DRAFT":
        return live_snapshot(session, deps, ds)  # what publishing it now would freeze
    snapshot: Mapping[str, Any] | None = version["metadata_snapshot"]
    return snapshot


def compare(
    session: Session, deps: CatalogDeps, user: CurrentUser, version_id: UUID, against: UUID | None
) -> dict[str, Any]:
    """Error order: an invisible or missing version on either side (explicit `against` or the default target, e.g. a
    WITHDRAWN predecessor a researcher cannot see) is 404; a visible version of another dataset is 422."""
    version, ds = _visible_version(session, user, version_id)
    target_id = against if against is not None else default_target(version)
    target: RowMapping | None = None
    if target_id is not None:
        target, _ = _visible_version(session, user, target_id)
        if target["dataset_id"] != version["dataset_id"]:
            raise ApiError(
                ErrorCode.VALIDATION_FAILED,
                "Both versions must belong to the same dataset.",
                {"fields": [{"field": "against", "reason": "DIFFERENT_DATASET"}]},
            )
    files = files_of_versions(session, [version_id, *([target_id] if target_id is not None else [])])
    after_rows = {f["path"]: f for f in files[version_id]}
    before_rows = {f["path"]: f for f in files[target_id]} if target_id is not None else {}
    changes = diff_files(_entries(list(before_rows.values())), _entries(list(after_rows.values())))
    return {
        "from_version_id": target_id,
        "to_version_id": version_id,
        "summary": summarize(changes),
        "files": changes,
        "schema": _schema_layer(session, changes, before_rows, after_rows),
        "metadata": _metadata_layer(session, deps, target, version, ds),
    }


def _metadata_layer(
    session: Session,
    deps: CatalogDeps,
    target: Mapping[Any, Any] | None,
    version: Mapping[Any, Any],
    ds: Mapping[Any, Any],
) -> list[dict[str, Any]]:
    """A published side without a frozen snapshot (data that predates D-029) is unknown: report nothing rather than
    every field as added or removed (the contract has no marker for it). No target at all is "everything added"."""
    before = _snapshot(session, deps, target, ds)
    after = _snapshot(session, deps, version, ds)
    if after is None or (target is not None and before is None):
        return []
    return diff_metadata(before, after)
