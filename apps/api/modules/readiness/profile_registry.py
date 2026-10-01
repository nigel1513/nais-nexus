"""Profiles live in code (profiles/*.yaml), reviewed like code (M05 §4). Loaded once at import."""

from dataclasses import dataclass, fields
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


_INT_PARAMS = frozenset(f.name for f in fields(ProfileParams) if f.type is int or f.type == "int")
_RATIO_PARAMS = frozenset(f.name for f in fields(ProfileParams)) - _INT_PARAMS
_TOP_KEYS = ("profile_id", "version", "name", "description", "checks", "parameters")


def _load(path: Path) -> Profile:
    def bad(reason: str) -> ValueError:
        return ValueError(f"invalid profile {path.name}: {reason}")

    raw = yaml.safe_load(path.read_text(encoding="utf-8"))
    if not isinstance(raw, dict):
        raise bad("document is not a mapping")
    missing = [k for k in _TOP_KEYS if k not in raw]
    if missing:
        raise bad(f"missing keys {missing}")
    for key in ("profile_id", "name", "description"):
        if not isinstance(raw[key], str) or not raw[key]:
            raise bad(f"{key} must be a non-empty string")
    if not isinstance(raw["version"], str) or not raw["version"]:
        raise bad("version must be a non-empty string")
    if not isinstance(raw["checks"], list) or not raw["checks"]:
        raise bad("checks must be a non-empty list")
    specs: list[CheckSpec] = []
    for i, c in enumerate(raw["checks"], start=1):
        if not isinstance(c, dict) or set(c) != {"check_id", "severity"}:
            raise bad(f"check #{i} must have exactly check_id and severity")
        specs.append(CheckSpec(check_id=c["check_id"], severity=c["severity"], ordinal=i))
    bad_severity = [c.severity for c in specs if c.severity not in ("REQUIRED", "RECOMMENDED")]
    if bad_severity:
        raise bad(f"invalid severity {bad_severity}")
    ids = [c.check_id for c in specs]
    unknown = set(ids) - KNOWN_CHECKS
    if unknown:
        raise bad(f"unknown checks {sorted(unknown, key=str)}")
    if len(set(ids)) != len(ids):
        raise bad("duplicate check_id")
    if raw["profile_id"] != path.stem:
        raise bad(f"declares {raw['profile_id']}")
    params = raw["parameters"]
    if not isinstance(params, dict):
        raise bad("parameters must be a mapping")
    expected = _INT_PARAMS | _RATIO_PARAMS
    if set(params) != expected:
        raise bad(
            f"parameters missing {sorted(expected - set(params))} extra {sorted(set(params) - expected, key=str)}"
        )
    for name, value in params.items():
        if isinstance(value, bool):
            raise bad(f"parameter {name} must not be a boolean")
        if name in _INT_PARAMS:
            if not isinstance(value, int):
                raise bad(f"parameter {name} must be an integer")
        elif not isinstance(value, int | float) or not 0 <= value <= 1:
            raise bad(f"parameter {name} must be a number between 0 and 1")
    coerced: dict[str, Any] = {k: (v if k in _INT_PARAMS else float(v)) for k, v in params.items()}
    return Profile(
        profile_id=raw["profile_id"],
        version=raw["version"],
        name=raw["name"],
        description=raw["description"],
        checks=tuple(specs),
        params=ProfileParams(**coerced),
    )


def load_profiles(directory: Path = PROFILES_DIR) -> dict[str, Profile]:
    loaded: dict[str, Profile] = {}
    for path in sorted(directory.glob("*.yaml")):
        profile = _load(path)
        if profile.profile_id in loaded:
            raise ValueError(f"duplicate profile_id {profile.profile_id} in {path.name}")
        loaded[profile.profile_id] = profile
    if set(loaded) != set(PROFILE_ORDER):
        raise ValueError(f"expected profiles {PROFILE_ORDER}, found {tuple(loaded)}")
    return {name: loaded[name] for name in PROFILE_ORDER}


PROFILES: dict[str, Profile] = load_profiles()
