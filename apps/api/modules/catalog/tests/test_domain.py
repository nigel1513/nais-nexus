import hashlib

import pytest

from api.modules.catalog.domain import (
    FAILURE_CODES,
    FAILURE_ERROR_CODES,
    InvalidPolicy,
    basename,
    build_policy,
    checksum_b64,
    extension,
    manifest_sha256,
    media_type_allowed,
    normalize_keywords,
    part_count,
    path_problem,
    storage_key,
)
from api.modules.catalog.settings import CatalogSettings
from api.platform.generated.error_codes import HTTP_STATUS, ErrorCode

A, B, C = "a" * 64, "b" * 64, "c" * 64


def test_failure_codes_map_to_contract_error_codes() -> None:  # deliverable 5: error code mapping
    assert set(FAILURE_ERROR_CODES) <= set(FAILURE_CODES)
    assert FAILURE_ERROR_CODES == {
        "CHECKSUM_MISMATCH": "UPLOAD_CHECKSUM_MISMATCH",
        "SIZE_MISMATCH": "UPLOAD_CHECKSUM_MISMATCH",
        "TYPE_MISMATCH": "FILE_TYPE_NOT_ALLOWED",
        "ARCHIVE_UNSAFE": "UPLOAD_ARCHIVE_UNSAFE",
        "MALWARE_DETECTED": "MALWARE_DETECTED",
    }
    for code in FAILURE_ERROR_CODES.values():
        assert HTTP_STATUS[ErrorCode(code)] == 422
    for code in (
        "DATASET_VERSION_IMMUTABLE",
        "DATASET_VERSION_INCOMPLETE",
        "DATASET_VERSION_LABEL_EXISTS",
        "UPLOAD_SESSION_EXPIRED",
    ):
        assert HTTP_STATUS[ErrorCode(code)] == 409
    assert HTTP_STATUS[ErrorCode("INVALID_POLICY")] == 422 and HTTP_STATUS[ErrorCode("FILE_TOO_LARGE")] == 422


def test_manifest_sorts_by_utf8_path_and_ignores_input_order() -> None:
    files = [("data/b.csv", 10, B), ("README.md", 5, A), ("data/a.csv", 7, C)]
    text = f"README.md\t5\t{A}\ndata/a.csv\t7\t{C}\ndata/b.csv\t10\t{B}\n"
    assert manifest_sha256(files) == hashlib.sha256(text.encode("utf-8")).hexdigest()
    assert manifest_sha256(list(reversed(files))) == manifest_sha256(files)


@pytest.mark.parametrize(
    ("path", "reason"),
    [
        ("../etc/passwd", "DOT_SEGMENT"),
        ("a/../b.csv", "DOT_SEGMENT"),
        ("./a.csv", "DOT_SEGMENT"),
        ("/abs.csv", "ABSOLUTE"),
        ("a//b.csv", "EMPTY_SEGMENT"),
        ("dir/", "EMPTY_SEGMENT"),
        ("a b.csv", "CHARACTERS"),
        ("a\x00.csv", "CHARACTERS"),
        ("a\\b.csv", "CHARACTERS"),
        ("", "LENGTH"),
        ("a" * 513, "LENGTH"),
    ],
)
def test_unsafe_paths_are_rejected(path: str, reason: str) -> None:
    assert path_problem(path) == reason


@pytest.mark.parametrize("path", ["data/a.csv", "README.md", "_schema.json", "a/b/c.d.parquet", "x..y.txt"])
def test_safe_paths_are_accepted(path: str) -> None:
    assert path_problem(path) is None


def test_allow_list_matches_extension_and_media_type() -> None:
    assert media_type_allowed("data/a.csv", "text/csv")
    assert media_type_allowed("data/A.CSV", "Text/CSV")
    assert media_type_allowed("x.hdf5", "application/x-hdf5")
    assert media_type_allowed("x.h5", "application/x-hdf5")
    assert media_type_allowed("t.parquet", "application/vnd.apache.parquet")
    assert not media_type_allowed("run.exe", "application/octet-stream")
    assert not media_type_allowed("data/a.csv", "application/json")
    assert not media_type_allowed("data/a.csv", "text/csv; charset=utf-8")
    assert not media_type_allowed(".csv", "text/csv")
    assert extension("a/b.tar.zip") == ".zip"
    assert basename("data/sub/a.csv") == "a.csv"


def test_controlled_requires_approval_and_normalizes_purposes() -> None:
    policy = build_policy("CONTROLLED", ["AI_TRAINING", "ACADEMIC_RESEARCH", "AI_TRAINING"], None)
    assert policy.approval_required is True
    assert policy.max_grant_days == 180
    assert policy.allowed_purposes == ("ACADEMIC_RESEARCH", "AI_TRAINING")


@pytest.mark.parametrize("level", ["PUBLIC", "INTERNAL"])
def test_public_and_internal_do_not_require_approval(level: str) -> None:
    assert build_policy(level, ["EDUCATION"], 90).approval_required is False


def test_sensitive_defaults_to_30_days_and_rejects_longer() -> None:
    assert build_policy("SENSITIVE", ["ACADEMIC_RESEARCH"], None).max_grant_days == 30
    assert build_policy("SENSITIVE", ["ACADEMIC_RESEARCH"], 30).approval_required is True
    with pytest.raises(InvalidPolicy, match="30"):
        build_policy("SENSITIVE", ["ACADEMIC_RESEARCH"], 60)


@pytest.mark.parametrize(
    ("purposes", "days"), [([], 10), (["MINING"], 10), (["EDUCATION"], 0), (["EDUCATION"], 366)]
)
def test_invalid_policies(purposes: list[str], days: int) -> None:
    with pytest.raises(InvalidPolicy):
        build_policy("PUBLIC", purposes, days)


def test_policy_event_shape() -> None:
    assert build_policy("CONTROLLED", ["AI_TRAINING"], 90).as_event() == {
        "allowed_purposes": ["AI_TRAINING"],
        "approval_required": True,
        "max_grant_days": 90,
    }


def test_small_helpers() -> None:
    assert storage_key("d", "v", "data/a.csv") == "datasets/d/v/data/a.csv"
    assert checksum_b64(hashlib.sha256(b"").hexdigest()) == "47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU="
    assert part_count(100 * 1024 * 1024, 64 * 1024 * 1024) == 2
    assert part_count(64 * 1024 * 1024, 64 * 1024 * 1024) == 1
    assert normalize_keywords([" a", "a", "", "b ", "  "]) == ["a", "b"]


def test_settings_defaults_and_env_override(monkeypatch: pytest.MonkeyPatch) -> None:
    settings = CatalogSettings()
    assert settings.storage_multipart_threshold_bytes == 67108864
    assert settings.catalog_multipart_part_size_bytes == 67108864
    assert settings.catalog_sync_verify_max_bytes == 268435456
    assert (settings.upload_url_ttl_seconds, settings.upload_session_ttl_seconds) == (3600, 3600)
    assert settings.storage_presign_ttl_seconds == 300
    assert settings.catalog_index_alias == "nais-datasets"
    assert settings.malware_scanner == "noop"
    monkeypatch.setenv("UPLOAD_URL_TTL_SECONDS", "60")
    monkeypatch.setenv("STORAGE_ORG_CODES", "inst-a, inst-b")
    assert CatalogSettings().upload_url_ttl_seconds == 60
    assert CatalogSettings().storage_org_code_list == ["inst-a", "inst-b"]
