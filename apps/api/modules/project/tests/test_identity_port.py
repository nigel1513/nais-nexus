import uuid

import pytest

from api.modules.identity import public as identity_public
from api.modules.project import identity as identity_mod
from api.modules.project.identity import IdentityQueryPort, get_identity_port
from api.modules.project.identity_fake import FakeIdentityQueryPort
from api.modules.project.seed_data import ORG_A, ORG_B, USERS_BY_KEY
from api.platform import ports
from api.platform.errors import ApiError
from api.platform.generated.error_codes import ErrorCode

B_RESEARCHER = USERS_BY_KEY["b.researcher"].user_id
B_DISABLED = USERS_BY_KEY["b.disabled"].user_id


@pytest.fixture(autouse=True)
def _clean_ports() -> None:
    ports.reset()


def test_registry_key_is_m01_public_protocol() -> None:
    assert IdentityQueryPort is identity_public.IdentityQueryPort


def test_fake_serves_seed_users() -> None:
    fake = FakeIdentityQueryPort.with_seed_users()
    profile = fake.get_public_profile(B_RESEARCHER)
    assert isinstance(profile, identity_public.IdentityPublicProfile)
    assert profile.display_name == "B Researcher"
    assert profile.organization_id == ORG_B
    assert profile.organization_name == "Institute B"
    assert fake.is_active_user(B_RESEARCHER)
    assert not fake.is_active_user(B_DISABLED)
    unknown = uuid.uuid4()
    assert fake.get_public_profile(unknown) is None
    assert not fake.is_active_user(unknown)
    assert set(fake.get_public_profiles([B_RESEARCHER, unknown])) == {B_RESEARCHER}
    summary = fake.get_organization_summary(ORG_B)
    assert isinstance(summary, identity_public.OrganizationSummary)
    assert summary.code == "inst-b" and summary.name == "Institute B"
    assert fake.get_organization_summary(uuid.uuid4()) is None


def test_fake_org_roles_and_email() -> None:
    fake = FakeIdentityQueryPort.with_seed_users()
    a_admin = USERS_BY_KEY["a.admin"]
    assert fake.has_org_role(a_admin.user_id, ORG_A, "ORG_ADMIN")
    assert not fake.has_org_role(a_admin.user_id, ORG_B, "ORG_ADMIN")
    assert fake.list_users_with_org_role(ORG_B, "DATA_STEWARD") == [USERS_BY_KEY["b.steward"].user_id]
    assert fake.get_email(B_RESEARCHER) == USERS_BY_KEY["b.researcher"].email
    assert fake.get_email(uuid.uuid4()) is None


def test_fake_disable_marks_user_inactive() -> None:
    fake = FakeIdentityQueryPort.with_seed_users()
    fake.disable(B_RESEARCHER)
    assert not fake.is_active_user(B_RESEARCHER)
    profile = fake.get_public_profile(B_RESEARCHER)
    assert profile is not None and profile.status == "DISABLED"


def test_registered_port_wins() -> None:
    fake = FakeIdentityQueryPort.with_seed_users()
    ports.provide(IdentityQueryPort, fake)
    assert get_identity_port() is fake


def test_seed_fake_when_identity_module_is_not_installed(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(identity_mod, "identity_module_installed", lambda: False)
    port = get_identity_port()
    assert isinstance(port, FakeIdentityQueryPort)
    assert port.is_active_user(B_RESEARCHER)


def test_installed_but_unwired_identity_fails_closed() -> None:
    assert identity_mod.identity_module_installed()  # M01 is built before M02
    with pytest.raises(ApiError) as exc:
        get_identity_port()
    assert exc.value.code == ErrorCode.DEPENDENCY_UNAVAILABLE
