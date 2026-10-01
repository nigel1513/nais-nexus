from pathlib import Path

import pytest

from api.modules.readiness.profile_registry import PROFILE_ORDER, PROFILES, load_profiles
from api.modules.readiness.settings import ReadinessSettings


def test_two_profiles_in_contract_order() -> None:
    assert tuple(PROFILES) == PROFILE_ORDER == ("GENERIC_BASIC", "TABULAR_ML_BASIC")
    assert {p.version for p in PROFILES.values()} == {"1.0.0"}


def test_generic_basic_checks_and_severities() -> None:
    checks = [(c.ordinal, c.check_id, c.severity) for c in PROFILES["GENERIC_BASIC"].checks]
    assert checks == [
        (1, "metadata.completeness", "REQUIRED"),
        (2, "provenance.presence", "REQUIRED"),
        (3, "policy.license_usage", "REQUIRED"),
        (4, "integrity.file_checksum", "REQUIRED"),
        (5, "schema.presence", "RECOMMENDED"),
        (6, "semantics.units_codebook", "RECOMMENDED"),
        (7, "semantics.mapping_status", "RECOMMENDED"),
    ]


def test_tabular_ml_basic_checks_and_severities() -> None:
    checks = [(c.check_id, c.severity) for c in PROFILES["TABULAR_ML_BASIC"].checks]
    assert checks == [
        ("metadata.completeness", "REQUIRED"),
        ("provenance.presence", "REQUIRED"),
        ("policy.license_usage", "REQUIRED"),
        ("integrity.file_checksum", "REQUIRED"),
        ("schema.presence", "REQUIRED"),
        ("schema.datatype_validity", "REQUIRED"),
        ("data.missing_values", "RECOMMENDED"),
        ("semantics.units_codebook", "REQUIRED"),
        ("semantics.mapping_status", "RECOMMENDED"),
    ]


def test_parameters_match_09_section_2_3() -> None:
    for profile in PROFILES.values():
        p = profile.params
        assert (p.sample_max_rows, p.sample_max_bytes, p.max_tabular_files) == (100000, 268435456, 50)
        assert p.checksum_max_total_bytes == 10737418240
        assert (p.description_min_length, p.provenance_min_length, p.usage_policy_min_length) == (50, 50, 20)
        assert (p.datatype_warn_ratio, p.datatype_fail_ratio, p.malformed_rows_fail_ratio) == (
            0.0,
            0.01,
            0.001,
        )
        assert (p.missing_warn_ratio, p.missing_fail_ratio, p.missing_overall_warn_ratio) == (0.05, 0.5, 0.05)
        assert (p.unit_missing_fail_ratio, p.mapping_pass_ratio) == (0.2, 0.8)


def test_api_shape_lists_checks_in_order() -> None:
    body = PROFILES["GENERIC_BASIC"].to_api()
    assert set(body) == {"profile_id", "version", "name", "description", "checks"}
    assert body["checks"][0] == {"check_id": "metadata.completeness", "severity": "REQUIRED"}


def test_unknown_check_id_is_rejected(tmp_path: Path) -> None:
    source = (Path(__file__).parents[1] / "profiles" / "GENERIC_BASIC.yaml").read_text(encoding="utf-8")
    (tmp_path / "GENERIC_BASIC.yaml").write_text(
        source.replace("schema.presence", "schema.bogus"), encoding="utf-8"
    )
    with pytest.raises(ValueError, match="unknown checks"):
        load_profiles(tmp_path)


def test_env_only_tunes_operations_not_verdicts(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("READINESS_RUN_TIMEOUT_SECONDS", "60")
    monkeypatch.setenv("READINESS_SAMPLE_MAX_ROWS", "5")
    settings = ReadinessSettings()
    assert settings.run_timeout_seconds == 60
    assert not hasattr(settings, "sample_max_rows")
    assert (settings.file_timeout_seconds, settings.worker_concurrency) == (600, 2)
