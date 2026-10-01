from uuid import UUID

import pytest

from api.modules.audit import ports as audit_ports
from api.modules.audit.fakes import (
    A_RESEARCHER,
    A_STEWARD,
    B_DISABLED,
    B_RESEARCHER,
    B_STEWARD,
    DATASET_BATTERY,
    ORG_A,
    ORG_B,
    SEED_PROJECT,
    FakeIdentity,
    FakeUser,
    seed_catalog,
    seed_grants,
    seed_id,
    seed_identity,
    seed_projects,
)
from api.platform import ports


def test_seed_id_format() -> None:
    assert seed_id("0a02") == UUID("00000000-0000-7000-8000-000000000a02")
    assert seed_id("0a02") == A_RESEARCHER and seed_id("000b") == ORG_B


def test_seed_identity_matches_seed_data() -> None:
    identity = seed_identity()
    assert identity.get_email(B_RESEARCHER) == "b.researcher@inst-b.local"
    assert identity.is_active_user(B_RESEARCHER) is True
    assert identity.is_active_user(B_DISABLED) is False
    assert identity.list_users_with_org_role(ORG_B, "DATA_STEWARD") == [B_STEWARD]
    assert identity.has_org_role(A_STEWARD, ORG_A, "DATA_STEWARD") is True
    assert identity.get_public_profiles([A_RESEARCHER])[A_RESEARCHER].display_name == "A Researcher"
    assert identity.get_email(UUID(int=1)) is None


def test_seed_projects_catalog_grants() -> None:
    assert seed_projects().is_active_member(SEED_PROJECT, B_RESEARCHER) is True
    assert seed_projects().list_project_ids_for_member(A_RESEARCHER) == [SEED_PROJECT]
    view = seed_catalog().get_policy_view(DATASET_BATTERY)
    assert (
        view is not None
        and view.title == "Battery Cycling Measurements"
        and view.owner_organization_id == ORG_B
    )
    assert seed_grants().list_active_grant_subjects(DATASET_BATTERY) == [A_RESEARCHER]


def test_consumed_port_keys_are_the_provider_public_classes() -> None:
    from api.modules.catalog import public as catalog_public
    from api.modules.identity import public as identity_public
    from api.modules.project import public as project_public

    assert audit_ports.IdentityQueryPort is identity_public.IdentityQueryPort
    assert audit_ports.ProjectQueryPort is project_public.ProjectQueryPort
    assert audit_ports.CatalogQueryPort is catalog_public.CatalogQueryPort
    assert audit_ports.GrantQueryPort.__module__ == "api.modules.audit.ports"  # M04 not in Wave 1


def test_seed_fakes_return_provider_dtos() -> None:
    from api.modules.catalog.public import DatasetPolicyView
    from api.modules.identity.public import IdentityPublicProfile

    profile = seed_identity().get_public_profile(B_DISABLED)
    assert isinstance(profile, IdentityPublicProfile)
    assert profile.status == "DISABLED" and profile.organization_name == "Institute B"
    summary = seed_identity().get_organization_summary(ORG_B)
    assert summary is not None and summary.code == "inst-b"
    view = seed_catalog().get_policy_view(DATASET_BATTERY)
    assert isinstance(view, DatasetPolicyView) and view.access_level == "CONTROLLED"
    assert seed_projects().get_member_role(SEED_PROJECT, A_RESEARCHER) == "PROJECT_OWNER"
    assert seed_projects().list_active_member_ids(SEED_PROJECT) == [A_RESEARCHER, B_RESEARCHER]


def test_resolver_prefers_provided_adapter() -> None:
    custom = FakeIdentity([FakeUser(A_RESEARCHER, "Custom", "c@x", ORG_A)])
    ports.provide(audit_ports.IdentityQueryPort, custom)
    assert audit_ports.identity() is custom


def test_resolver_falls_back_to_seed_fake_with_warning(caplog: pytest.LogCaptureFixture) -> None:
    ports.reset()
    audit_ports.reset_fallback_warnings()
    with caplog.at_level("WARNING", logger="nais.audit"):
        assert audit_ports.projects().is_active_member(SEED_PROJECT, A_RESEARCHER) is True
    assert "seed-backed fake" in caplog.text
