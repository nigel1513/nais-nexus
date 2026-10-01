"""Pure catalog rules (M03 §4, §6). No I/O here."""

import base64
import hashlib
import math
import re
from collections.abc import Iterable
from dataclasses import dataclass
from typing import Any
from uuid import UUID

ACCESS_LEVELS: tuple[str, ...] = ("PUBLIC", "INTERNAL", "CONTROLLED", "SENSITIVE")
PURPOSES: tuple[str, ...] = (
    "ACADEMIC_RESEARCH",
    "AI_TRAINING",
    "COMMERCIAL_RESEARCH",
    "EDUCATION",
    "PUBLIC_INTEREST",
)
APPROVAL_LEVELS = frozenset({"CONTROLLED", "SENSITIVE"})
DATA_STEWARD = "DATA_STEWARD"
ORG_ADMIN = "ORG_ADMIN"
DEFAULT_MAX_GRANT_DAYS = 180
SENSITIVE_MAX_GRANT_DAYS = 30
MAX_FILE_BYTES = 50 * 1024**3
MAX_FILES_PER_VERSION = 10_000
MAX_PARTS = 10_000
MAX_PATH_LENGTH = 512

FAILURE_CODES: tuple[str, ...] = (
    "OBJECT_MISSING",
    "SIZE_MISMATCH",
    "CHECKSUM_MISMATCH",
    "TYPE_MISMATCH",
    "ARCHIVE_UNSAFE",
    "MALWARE_DETECTED",
    "SESSION_EXPIRED",
)
FAILURE_ERROR_CODES: dict[str, str] = {
    "CHECKSUM_MISMATCH": "UPLOAD_CHECKSUM_MISMATCH",
    "SIZE_MISMATCH": "UPLOAD_CHECKSUM_MISMATCH",
    "TYPE_MISMATCH": "FILE_TYPE_NOT_ALLOWED",
    "ARCHIVE_UNSAFE": "UPLOAD_ARCHIVE_UNSAFE",
    "MALWARE_DETECTED": "MALWARE_DETECTED",
}

ALLOWED_MEDIA_TYPES: dict[str, str] = {
    ".csv": "text/csv",
    ".tsv": "text/tab-separated-values",
    ".json": "application/json",
    ".jsonl": "application/x-ndjson",
    ".txt": "text/plain",
    ".md": "text/markdown",
    ".parquet": "application/vnd.apache.parquet",
    ".h5": "application/x-hdf5",
    ".hdf5": "application/x-hdf5",
    ".nc": "application/x-netcdf",
    ".zip": "application/zip",
}

# Dataset fields frozen into dataset_versions.metadata_snapshot at publish (M03 §6.9, D-029).
SNAPSHOT_FIELDS: tuple[str, ...] = (
    "access_level",
    "allowed_purposes",
    "collecting_organization_id",
    "collecting_organization_name",
    "contact_email",
    "data_steward_contact_id",
    "description",
    "domain",
    "funding_agency",
    "keywords",
    "license",
    "material_codes",
    "max_grant_days",
    "method_codes",
    "method_detail",
    "project_code",
    "project_title",
    "provenance",
    "related_publications",
    "subject_codes",
    "subtitle",
    "temporal_end",
    "temporal_start",
    "title",
    "update_frequency",
    "usage_policy",
)

_PATH_CHARS = re.compile(r"^[A-Za-z0-9._/-]+$")


class InvalidPolicy(ValueError):
    pass


@dataclass(frozen=True)
class Policy:
    access_level: str
    allowed_purposes: tuple[str, ...]
    approval_required: bool
    max_grant_days: int

    def as_event(self) -> dict[str, Any]:
        """The contract `DatasetPolicy` shape used in catalog.dataset.policy_changed.v1."""
        return {
            "allowed_purposes": list(self.allowed_purposes),
            "approval_required": self.approval_required,
            "max_grant_days": self.max_grant_days,
        }


def normalize_purposes(purposes: Iterable[str]) -> tuple[str, ...]:
    chosen = set(purposes)
    unknown = chosen - set(PURPOSES)
    if unknown:
        raise InvalidPolicy(f"unknown purposes: {', '.join(sorted(unknown))}")
    return tuple(p for p in PURPOSES if p in chosen)


def build_policy(access_level: str, allowed_purposes: Iterable[str], max_grant_days: int | None) -> Policy:
    """Normalize and validate a dataset policy. approval_required is derived, never requested (M03 §6.1)."""
    if access_level not in ACCESS_LEVELS:
        raise InvalidPolicy(f"unknown access level {access_level!r}")
    purposes = normalize_purposes(allowed_purposes)
    if not purposes:
        raise InvalidPolicy("allowed_purposes must contain at least one purpose")
    if max_grant_days is None:
        days = SENSITIVE_MAX_GRANT_DAYS if access_level == "SENSITIVE" else DEFAULT_MAX_GRANT_DAYS
    else:
        days = max_grant_days
    if not 1 <= days <= 365:
        raise InvalidPolicy("max_grant_days must be between 1 and 365")
    if access_level == "SENSITIVE" and days > SENSITIVE_MAX_GRANT_DAYS:
        raise InvalidPolicy("SENSITIVE datasets allow at most 30 grant days")
    return Policy(access_level, purposes, access_level in APPROVAL_LEVELS, days)


def normalize_keywords(keywords: Iterable[str]) -> list[str]:
    return list(dict.fromkeys(k.strip() for k in keywords if k.strip()))


def path_problem(path: str) -> str | None:
    """None for a safe relative manifest path, else a reason code for details.fields[].reason."""
    if not 1 <= len(path) <= MAX_PATH_LENGTH:
        return "LENGTH"
    if not _PATH_CHARS.fullmatch(path):
        return "CHARACTERS"
    if path.startswith("/"):
        return "ABSOLUTE"
    if "//" in path or path.endswith("/"):
        return "EMPTY_SEGMENT"
    if any(segment in (".", "..") for segment in path.split("/")):
        return "DOT_SEGMENT"
    return None


def basename(path: str) -> str:
    return path.rsplit("/", 1)[-1]


def extension(path: str) -> str:
    name = basename(path)
    dot = name.rfind(".")
    return name[dot:].lower() if dot > 0 else ""


def canonical_media_type(media_type: str) -> str:
    return media_type.strip().lower()


def media_type_allowed(path: str, media_type: str) -> bool:
    expected = ALLOWED_MEDIA_TYPES.get(extension(path))
    return expected is not None and canonical_media_type(media_type) == expected


def manifest_sha256(files: Iterable[tuple[str, int, str]]) -> str:
    """M03 §4.9: deterministic over the sorted (path, size, sha256) lines."""
    lines = sorted(files, key=lambda item: item[0].encode("utf-8"))
    text = "".join(f"{path}\t{size}\t{sha}\n" for path, size, sha in lines)
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def storage_key(
    dataset_id: UUID | str, version_id: UUID | str, upload_session_id: UUID | str, path: str
) -> str:
    """D-039: one key per upload session, so a live presigned PUT of an earlier upload never hits a later object."""
    return f"datasets/{dataset_id}/{version_id}/{upload_session_id}/{path}"


def checksum_b64(sha256_hex: str) -> str:
    return base64.b64encode(bytes.fromhex(sha256_hex)).decode("ascii")


def part_count(size: int, part_size: int) -> int:
    return max(1, math.ceil(size / part_size))
