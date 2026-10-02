from typing import Any

import pytest

from api.modules.readiness.tests.builders import make_ctx
from api.modules.readiness.tests.helpers import clean_snapshot, fixture_files
from api.modules.readiness.validators import license_usage, metadata_completeness, provenance_presence
from api.modules.readiness.validators.provenance_presence import readme_provenance_section


def _snap(**changes: Any) -> dict[str, Any]:
    return {**clean_snapshot(), **changes}


# ---------------------------------------------------------------- metadata.completeness


def test_metadata_pass() -> None:
    outcome = metadata_completeness.check(make_ctx())
    assert outcome.status == "PASS"
    assert outcome.evidence == {
        "required_missing": [],
        "recommended_missing": [],
        "description_length": 80,
        "keyword_count": 4,
        "readme_present": True,
    }


def test_metadata_fail_matches_missing_metadata_fixture() -> None:
    snap = _snap(description="측정 데이터", keywords=[], domain=None, contact_email=None)
    outcome = metadata_completeness.check(make_ctx(snapshot=snap))
    assert outcome.status == "FAIL"
    assert outcome.evidence["required_missing"] == ["contact_email", "description", "keywords"]
    assert outcome.evidence["recommended_missing"] == ["domain", "keywords_min_3"]
    assert outcome.evidence["description_length"] == 6
    assert (
        outcome.message
        == "필수 메타데이터 3개가 누락되었습니다: contact_email, description(50자 미만), keywords."
    )


def test_metadata_steward_contact_satisfies_contact() -> None:
    """Ruling P23: the snapshot never carries a private steward email; a frozen steward contact counts as contact."""
    snap = _snap(
        contact_email=None,
        data_steward_contact_id="00000000-0000-7000-8000-000000000b03",
        people={"steward_contact_absent": False},
    )
    outcome = metadata_completeness.check(make_ctx(snapshot=snap))
    assert outcome.status == "PASS" and outcome.evidence["required_missing"] == []
    assert metadata_completeness.check(make_ctx(snapshot=_snap(contact_email=None))).status == "FAIL"


@pytest.mark.parametrize("people", [{"steward_contact_absent": True}, {}, None])
def test_metadata_absent_steward_contact_does_not_satisfy_contact(people: object) -> None:
    """An id whose steward left the owner org (or a snapshot without the people block) is no reachable contact."""
    snap = _snap(
        contact_email=None, data_steward_contact_id="00000000-0000-7000-8000-000000000b03", people=people
    )
    outcome = metadata_completeness.check(make_ctx(snapshot=snap))
    assert outcome.status == "FAIL" and outcome.evidence["required_missing"] == ["contact_email"]


@pytest.mark.parametrize(
    ("changes", "status"),
    [
        ({"description": "가" * 50}, "PASS"),  # exactly the minimum
        ({"description": "  " + "가" * 49 + "  "}, "FAIL"),  # trimmed below the minimum
        ({"title": "ab"}, "FAIL"),
        ({"license": "  "}, "FAIL"),
        ({"keywords": ["a", "b"]}, "WARNING"),  # REQUIRED met, keywords_min_3 not
        ({"domain": ""}, "WARNING"),
        ({"keywords": "not-a-list"}, "FAIL"),
    ],
)
def test_metadata_boundaries(changes: dict[str, Any], status: str) -> None:
    assert metadata_completeness.check(make_ctx(snapshot=_snap(**changes))).status == status


def test_metadata_warns_without_readme() -> None:
    files = {k: v for k, v in fixture_files().items() if k != "README.md"}
    outcome = metadata_completeness.check(make_ctx(files=files))
    assert (outcome.status, outcome.evidence["recommended_missing"]) == ("WARNING", ["readme"])


# ---------------------------------------------------------------- provenance.presence


def test_readme_section_extraction_rules() -> None:
    assert readme_provenance_section("# T\n\n## 데이터 출처\n\n  본문 A  \n\n## 다음\n나머지\n") == "본문 A"
    assert readme_provenance_section("#### Provenance\nbody\n") is None  # only # .. ###
    assert readme_provenance_section("### PROVENANCE ###\nbody\n") == "body"
    assert readme_provenance_section("## Provenance notes\nbody\n") is None


def test_provenance_pass_from_metadata_only() -> None:
    files = {**fixture_files(), "README.md": b"# Title\n"}
    outcome = provenance_presence.check(make_ctx(files=files))
    assert outcome.status == "PASS"
    assert outcome.evidence == {
        "metadata_provenance_length": 72,
        "readme_present": True,
        "readme_section_found": False,
        "readme_section_length": 0,
    }


def test_provenance_pass_from_readme_only() -> None:
    outcome = provenance_presence.check(make_ctx(snapshot=_snap(provenance=None)))
    assert (outcome.status, outcome.evidence["readme_section_found"]) == ("PASS", True)


def test_provenance_warning_when_both_short() -> None:
    files = {**fixture_files(), "README.md": "## 출처\n짧은 설명\n".encode()}
    outcome = provenance_presence.check(make_ctx(files=files, snapshot=_snap(provenance="가" * 49)))
    assert outcome.status == "WARNING"


def test_provenance_fail_when_absent() -> None:
    files = {**fixture_files(), "README.md": b"# Title\n"}
    outcome = provenance_presence.check(make_ctx(files=files, snapshot=_snap(provenance="  ")))
    assert (outcome.status, outcome.evidence["metadata_provenance_length"]) == ("FAIL", 0)


# ---------------------------------------------------------------- policy.license_usage


@pytest.mark.parametrize(
    ("changes", "status"),
    [
        ({}, "PASS"),
        ({"license": "NAIS-RESEARCH-ONLY-1.0"}, "PASS"),
        ({"license": "My-Own-License"}, "WARNING"),
        ({"license": ""}, "FAIL"),
        ({"usage_policy": "가" * 19}, "FAIL"),  # CONTROLLED needs >= 20
        ({"usage_policy": "가" * 20}, "PASS"),
        ({"access_level": "SENSITIVE", "usage_policy": None}, "FAIL"),
        ({"access_level": "PUBLIC", "usage_policy": None}, "PASS"),
        ({"access_level": "INTERNAL", "usage_policy": ""}, "PASS"),
    ],
)
def test_license_usage_rules(changes: dict[str, Any], status: str) -> None:
    assert license_usage.check(make_ctx(snapshot=_snap(**changes))).status == status


def test_license_evidence_has_lengths_not_policy_text() -> None:
    assert license_usage.check(make_ctx()).evidence == {
        "license": "CC-BY-4.0",
        "license_recognized": True,
        "access_level": "CONTROLLED",
        "usage_policy_length": 52,
        "allowed_purposes_count": 2,
    }
