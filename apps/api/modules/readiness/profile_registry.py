"""Profiles live in code (profiles/*.yaml), reviewed like code (M05 §4). Loaded once at import."""

from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

import yaml

Severity = Literal["REQUIRED", "RECOMMENDED"]
PROFILES_DIR = Path(__file__).parent / "profiles"
PROFILE_ORDER = ("GENERIC_BASIC", "TABULAR_ML_BASIC")
KNOWN_CHECKS = frozenset(
    {
        "metadata.completeness",
        "schema.presence",
        "schema.datatype_validity",
        "data.missing_values",
        "semantics.units_codebook",
        "provenance.presence",
        "policy.license_usage",
        "integrity.file_checksum",
        "semantics.mapping_status",
    }
)


@dataclass(frozen=True)
class ProfileParams:
    sample_max_rows: int
    sample_max_bytes: int
    max_tabular_files: int
    checksum_max_total_bytes: int
    description_min_length: int
    provenance_min_length: int
    usage_policy_min_length: int
    datatype_warn_ratio: float
    datatype_fail_ratio: float
    malformed_rows_fail_ratio: float
    missing_warn_ratio: float
    missing_fail_ratio: float
    missing_overall_warn_ratio: float
    unit_missing_fail_ratio: float
    mapping_pass_ratio: float


@dataclass(frozen=True)
class CheckSpec:
    check_id: str
    severity: Severity
    ordinal: int


@dataclass(frozen=True)
class Profile:
    profile_id: str
    version: str
    name: str
    description: str
    checks: tuple[CheckSpec, ...]
    params: ProfileParams

    def to_api(self) -> dict[str, Any]:
        return {
            "profile_id": self.profile_id,
            "version": self.version,
            "name": self.name,
            "description": self.description,
            "checks": [{"check_id": c.check_id, "severity": c.severity} for c in self.checks],
        }


def _load(path: Path) -> Profile:
    raw = yaml.safe_load(path.read_text(encoding="utf-8"))
    checks = tuple(
        CheckSpec(check_id=c["check_id"], severity=c["severity"], ordinal=i)
        for i, c in enumerate(raw["checks"], start=1)
    )
    unknown = {c.check_id for c in checks} - KNOWN_CHECKS
    if unknown or any(c.severity not in ("REQUIRED", "RECOMMENDED") for c in checks):
        raise ValueError(f"invalid profile {path.name}: unknown checks {sorted(unknown)}")
    if raw["profile_id"] != path.stem:
        raise ValueError(f"profile file {path.name} declares {raw['profile_id']}")
    return Profile(
        profile_id=raw["profile_id"],
        version=str(raw["version"]),
        name=raw["name"],
        description=raw["description"],
        checks=checks,
        params=ProfileParams(**raw["parameters"]),
    )


def load_profiles(directory: Path = PROFILES_DIR) -> dict[str, Profile]:
    loaded = {p.profile_id: p for p in map(_load, sorted(directory.glob("*.yaml")))}
    if set(loaded) != set(PROFILE_ORDER):
        raise ValueError(f"expected profiles {PROFILE_ORDER}, found {tuple(loaded)}")
    return {name: loaded[name] for name in PROFILE_ORDER}


PROFILES: dict[str, Profile] = load_profiles()
