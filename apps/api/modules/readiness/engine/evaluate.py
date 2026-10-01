"""Run a profile's checks in ordinal order over one version and aggregate (09 §2.4, §4)."""

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any, Literal

from api.modules.readiness.catalog_port import CatalogReadPort, VersionView
from api.modules.readiness.engine import VALIDATOR_VERSION
from api.modules.readiness.engine.canonical import bound_evidence, canonical_json, sha256_hex
from api.modules.readiness.engine.context import CheckStatus, EvaluationContext
from api.modules.readiness.profile_registry import Profile, Severity
from api.modules.readiness.validators import VALIDATORS

Overall = Literal["PASS", "WARNING", "FAIL"]


@dataclass(frozen=True)
class CheckResult:
    check_id: str
    ordinal: int
    severity: Severity
    status: CheckStatus
    message: str
    evidence: dict[str, Any]

    def to_api(self) -> dict[str, Any]:
        return {
            "check_id": self.check_id,
            "severity": self.severity,
            "status": self.status,
            "message": self.message,
            "evidence": self.evidence,
        }


@dataclass(frozen=True)
class ValidationResult:
    profile_id: str
    profile_version: str
    validator_version: str
    overall_status: Overall
    summary: dict[str, int]
    checks: tuple[CheckResult, ...]
    result_sha256: str


def overall_status(checks: Sequence[CheckResult]) -> Overall:
    if any(c.status == "FAIL" and c.severity == "REQUIRED" for c in checks):
        return "FAIL"
    if any(c.status in ("FAIL", "WARNING") for c in checks):
        return "WARNING"
    return "PASS"


def summarize(checks: Sequence[CheckResult]) -> dict[str, int]:
    return {
        "pass": sum(c.status == "PASS" for c in checks),
        "warning": sum(c.status == "WARNING" for c in checks),
        "fail": sum(c.status == "FAIL" for c in checks),
        "not_applicable": sum(c.status == "NOT_APPLICABLE" for c in checks),
    }


def result_sha256(checks: Sequence[CheckResult], overall: str, summary: dict[str, int]) -> str:
    document = {"checks": [c.to_api() for c in checks], "overall_status": overall, "summary": summary}
    return sha256_hex(canonical_json(document))


def evaluate(
    version: VersionView, profile: Profile, reader: CatalogReadPort, *, file_timeout_s: float | None = None
) -> ValidationResult:
    """Pure function of (snapshot, manifest, bytes, profile, VALIDATOR_VERSION). Lets the reader's
    StorageUnavailable / ObjectMissing and parsing.FileTimeout propagate: the job maps them to run outcomes."""
    if version.metadata_snapshot is None:
        raise ValueError("only PUBLISHED versions (with a metadata snapshot) can be evaluated")
    ctx = EvaluationContext(
        snapshot=version.metadata_snapshot,
        files=version.files,
        manifest_sha256=version.manifest_sha256,
        reader=reader,
        params=profile.params,
        file_timeout_s=file_timeout_s,
    )
    checks: list[CheckResult] = []
    for spec in profile.checks:  # sequential, ordinal order (M05 §10)
        outcome = VALIDATORS[spec.check_id](ctx)
        checks.append(
            CheckResult(
                check_id=spec.check_id,
                ordinal=spec.ordinal,
                severity=spec.severity,
                status=outcome.status,
                message=outcome.message,
                evidence=bound_evidence(outcome.evidence),
            )
        )
    overall = overall_status(checks)
    summary = summarize(checks)
    return ValidationResult(
        profile_id=profile.profile_id,
        profile_version=profile.version,
        validator_version=VALIDATOR_VERSION,
        overall_status=overall,
        summary=summary,
        checks=tuple(checks),
        result_sha256=result_sha256(checks, overall, summary),
    )
