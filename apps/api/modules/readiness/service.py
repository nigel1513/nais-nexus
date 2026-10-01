"""Queueing rules shared by the API (manual run) and the publish handler (auto run): M05 §6.2 steps 5-7,
plus the read queries behind getReadiness and ReadinessQueryPort."""

from dataclasses import dataclass
from typing import Any, Literal
from uuid import UUID

from sqlalchemy import RowMapping, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from api.modules.readiness import jobs
from api.modules.readiness.catalog_port import VersionView
from api.modules.readiness.engine import VALIDATOR_VERSION
from api.modules.readiness.engine.canonical import input_fingerprint
from api.modules.readiness.engine.context import is_tabular
from api.modules.readiness.profile_registry import PROFILE_ORDER, PROFILES, Profile
from api.modules.readiness.tables import check_results, validations
from api.platform.auth import CurrentUser
from api.platform.ids import new_id

TriggeredBy = Literal["AUTO_ON_PUBLISH", "USER"]
INFLIGHT = ("QUEUED", "RUNNING")


@dataclass(frozen=True)
class RequestOutcome:
    kind: Literal["REUSED", "IN_PROGRESS", "QUEUED"]
    row: RowMapping


def fingerprint_for(version: VersionView, profile: Profile) -> str:
    if version.manifest_sha256 is None or version.metadata_snapshot is None:
        raise ValueError("fingerprint needs a PUBLISHED version")
    return input_fingerprint(
        version.manifest_sha256,
        version.metadata_snapshot,
        profile.profile_id,
        profile.version,
        VALIDATOR_VERSION,
    )


def auto_profiles(version: VersionView) -> list[Profile]:
    """GENERIC_BASIC always; TABULAR_ML_BASIC when T is not empty (M05 §3.2)."""
    chosen = [PROFILES["GENERIC_BASIC"]]
    if any(is_tabular(f.path) for f in version.files):
        chosen.append(PROFILES["TABULAR_ML_BASIC"])
    return chosen


def _latest(session: Session, version_id: UUID, profile_id: str, *conditions: Any) -> RowMapping | None:
    query = (
        select(validations)
        .where(
            validations.c.dataset_version_id == version_id,
            validations.c.profile_id == profile_id,
            *conditions,
        )
        .order_by(validations.c.created_at.desc(), validations.c.validation_id.desc())
        .limit(1)
    )
    return session.execute(query).mappings().first()


def request_validation(
    session: Session,
    version: VersionView,
    profile: Profile,
    *,
    triggered_by: TriggeredBy,
    requester: CurrentUser | None,
    correlation_id: UUID,
) -> RequestOutcome:
    """REUSED (same fingerprint COMPLETED) > IN_PROGRESS (QUEUED/RUNNING) > insert QUEUED + enqueue after commit."""
    fingerprint = fingerprint_for(version, profile)
    vid, pid = version.dataset_version_id, profile.profile_id
    reused = _latest(
        session,
        vid,
        pid,
        validations.c.run_status == "COMPLETED",
        validations.c.input_fingerprint == fingerprint,
    )
    if reused is not None:
        return RequestOutcome("REUSED", reused)
    running = _latest(session, vid, pid, validations.c.run_status.in_(INFLIGHT))
    if running is not None:
        return RequestOutcome("IN_PROGRESS", running)
    values = {
        "validation_id": new_id(),
        "dataset_version_id": vid,
        "dataset_id": version.dataset_id,
        "owner_organization_id": version.owner_organization_id,
        "profile_id": pid,
        "profile_version": profile.version,
        "validator_version": VALIDATOR_VERSION,
        "input_fingerprint": fingerprint,
        "run_status": "QUEUED",
        "triggered_by": triggered_by,
        "requested_by": requester.user_id if requester else None,
        "requester_organization_id": requester.organization_id if requester else None,
        "attempt": 0,
        "correlation_id": correlation_id,
    }
    try:
        with session.begin_nested():
            row = (
                session.execute(validations.insert().values(**values).returning(validations)).mappings().one()
            )
    except IntegrityError:  # uq_validation_inflight: a concurrent request won the race
        running = _latest(session, vid, pid, validations.c.run_status.in_(INFLIGHT))
        if running is None:
            raise
        return RequestOutcome("IN_PROGRESS", running)
    jobs.enqueue_after_commit(session, row["validation_id"], correlation_id)
    return RequestOutcome("QUEUED", row)


def load_checks(session: Session, validation_ids: list[UUID]) -> dict[UUID, list[dict[str, Any]]]:
    grouped: dict[UUID, list[dict[str, Any]]] = {vid: [] for vid in validation_ids}
    if not validation_ids:
        return grouped
    rows = session.execute(
        select(check_results)
        .where(check_results.c.validation_id.in_(validation_ids))
        .order_by(check_results.c.validation_id, check_results.c.ordinal)
    ).mappings()
    for r in rows:
        grouped[r["validation_id"]].append(
            {
                "check_id": r["check_id"],
                "severity": r["severity"],
                "status": r["status"],
                "message": r["message"],
                "evidence": r["evidence"],
            }
        )
    return grouped


def latest_per_profile(session: Session, version_id: UUID, profile_id: str | None) -> list[RowMapping]:
    """The most recent validation per profile (any run_status, M05 §6.3), in profile registry order."""
    profile_ids = [profile_id] if profile_id is not None else list(PROFILE_ORDER)
    return [row for pid in profile_ids if (row := _latest(session, version_id, pid)) is not None]


def latest_overall(session: Session, version_id: UUID, profile_id: str) -> str | None:
    row = _latest(session, version_id, profile_id, validations.c.run_status == "COMPLETED")
    return None if row is None else str(row["overall_status"])


def to_api(row: RowMapping, checks: list[dict[str, Any]]) -> dict[str, Any]:
    """openapi ReadinessValidation. requester ids and correlation_id stay internal."""

    def ts(value: Any) -> str | None:
        return value.isoformat() if value is not None else None

    body: dict[str, Any] = {
        "validation_id": str(row["validation_id"]),
        "dataset_version_id": str(row["dataset_version_id"]),
        "profile_id": row["profile_id"],
        "profile_version": row["profile_version"],
        "run_status": row["run_status"],
        "overall_status": row["overall_status"],
        "checks": checks,
        "validator_version": row["validator_version"],
        "input_fingerprint": row["input_fingerprint"],
        "error": row["error"],
        "triggered_by": row["triggered_by"],
        "created_at": ts(row["created_at"]),
        "started_at": ts(row["started_at"]),
        "completed_at": ts(row["completed_at"]),
    }
    if row["summary"] is not None:
        body["summary"] = row["summary"]
    return body
