from pathlib import Path

import pytest
from pydantic import ValidationError

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


def _write_variant(tmp_path: Path, edit) -> None:  # type: ignore[no-untyped-def]
    import yaml

    raw = yaml.safe_load((Path(__file__).parents[1] / "profiles" / "GENERIC_BASIC.yaml").read_text("utf-8"))
    edit(raw)
    (tmp_path / "GENERIC_BASIC.yaml").write_text(
        yaml.safe_dump(raw, allow_unicode=True) if isinstance(raw, dict) else "- just\n- a list\n",
        encoding="utf-8",
    )


def _not_mapping(raw: dict) -> None:  # type: ignore[type-arg]
    raw.clear()
    raw["__list__"] = 1


MALFORMED = {
    "not_mapping": lambda raw: _not_mapping(raw),
    "missing_version": lambda raw: raw.pop("version"),
    "missing_name": lambda raw: raw.pop("name"),
    "missing_description": lambda raw: raw.pop("description"),
    "missing_checks": lambda raw: raw.pop("checks"),
    "missing_parameters": lambda raw: raw.pop("parameters"),
    "missing_param": lambda raw: raw["parameters"].pop("sample_max_rows"),
    "extra_param": lambda raw: raw["parameters"].update(bogus=1),
    "int_param_is_float": lambda raw: raw["parameters"].update(sample_max_rows=1.5),
    "int_param_is_bool": lambda raw: raw["parameters"].update(sample_max_rows=True),
    "int_param_is_string": lambda raw: raw["parameters"].update(max_tabular_files="50"),
    "ratio_above_one": lambda raw: raw["parameters"].update(missing_fail_ratio=1.5),
    "ratio_negative": lambda raw: raw["parameters"].update(mapping_pass_ratio=-0.1),
    "ratio_is_bool": lambda raw: raw["parameters"].update(mapping_pass_ratio=True),
    "ratio_is_string": lambda raw: raw["parameters"].update(mapping_pass_ratio="0.8"),
    "duplicate_check_id": lambda raw: raw["checks"].append(dict(raw["checks"][0])),
}


@pytest.mark.parametrize("case", sorted(MALFORMED))
def test_malformed_profile_raises_value_error_naming_file(tmp_path: Path, case: str) -> None:
    _write_variant(tmp_path, MALFORMED[case])
    if case == "not_mapping":
        (tmp_path / "GENERIC_BASIC.yaml").write_text("- just\n- a list\n", encoding="utf-8")
    with pytest.raises(ValueError, match="GENERIC_BASIC.yaml"):
        load_profiles(tmp_path)


def test_invalid_severity_has_its_own_message(tmp_path: Path) -> None:
    _write_variant(tmp_path, lambda raw: raw["checks"][0].update(severity="MANDATORY"))
    with pytest.raises(ValueError, match=r"GENERIC_BASIC.yaml.*invalid severity"):
        load_profiles(tmp_path)


def test_duplicate_profile_id_across_files_is_rejected(tmp_path: Path) -> None:
    source = (Path(__file__).parents[1] / "profiles" / "GENERIC_BASIC.yaml").read_text(encoding="utf-8")
    (tmp_path / "GENERIC_BASIC.yaml").write_text(source, encoding="utf-8")
    other = Path(__file__).parents[1] / "profiles" / "TABULAR_ML_BASIC.yaml"
    (tmp_path / "TABULAR_ML_BASIC.yaml").write_text(
        other.read_text(encoding="utf-8").replace(
            "profile_id: TABULAR_ML_BASIC", "profile_id: GENERIC_BASIC"
        ),
        encoding="utf-8",
    )
    with pytest.raises(ValueError, match="TABULAR_ML_BASIC.yaml"):
        load_profiles(tmp_path)


@pytest.mark.parametrize("name", ["RUN_TIMEOUT_SECONDS", "FILE_TIMEOUT_SECONDS", "WORKER_CONCURRENCY"])
def test_invalid_settings_value_is_rejected(monkeypatch: pytest.MonkeyPatch, name: str) -> None:
    monkeypatch.setenv(f"READINESS_{name}", "0")
    with pytest.raises(ValidationError):
        ReadinessSettings()


# {profile_id: {version: sha256 of the canonical JSON of the parsed YAML}}. Changing a profile's parameters or checks
# requires a version bump (reuse key includes the version) and a new entry here.
PROFILE_SHA256 = {
    "GENERIC_BASIC": {"1.0.0": "c061856d03d82b52df4bc4ac4ed8dc61bdf7b2603e1c412d295fa01adaee01f9"},
    "TABULAR_ML_BASIC": {"1.0.0": "101945462aaea99d14c2ba60830fda10317a6de0f86becfb0f95261f4f6a9cc1"},
}


def test_profile_yaml_content_is_pinned_per_version() -> None:
    import yaml

    from api.modules.readiness.engine.canonical import canonical_json, sha256_hex
    from api.modules.readiness.profile_registry import PROFILES_DIR

    actual: dict[str, dict[str, str]] = {}
    for profile_id, profile in PROFILES.items():
        doc = yaml.safe_load((PROFILES_DIR / f"{profile_id}.yaml").read_text(encoding="utf-8"))
        actual[profile_id] = {profile.version: sha256_hex(canonical_json(doc))}
    assert actual == PROFILE_SHA256, "profile content changed without a version bump (or pin not updated)"
