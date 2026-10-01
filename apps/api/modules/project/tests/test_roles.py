import pytest

from api.modules.project import roles

O, A, R, V = roles.OWNER, roles.ADMIN, roles.RESEARCHER, roles.VIEWER  # noqa: E741


@pytest.mark.parametrize(
    ("actor", "edit", "visibility", "archive"),
    [
        (O, True, True, True),
        (A, True, False, False),
        (R, False, False, False),
        (V, False, False, False),
        (None, False, False, False),
    ],
)
def test_project_level_matrix(actor: str | None, edit: bool, visibility: bool, archive: bool) -> None:
    assert roles.can_edit_project(actor) is edit
    assert roles.can_change_visibility(actor) is visibility
    assert roles.can_archive(actor) is archive


@pytest.mark.parametrize(
    ("actor", "involved", "allowed"),
    [
        (O, (O,), True),
        (O, (R, A), True),
        (O, (O, V), True),
        (A, (R,), True),
        (A, (V, R), True),
        (A, (R, A), False),  # granting ADMIN is OWNER-only
        (A, (A, R), False),  # revoking ADMIN (including the actor's own) is OWNER-only
        (A, (A,), False),  # removing an ADMIN is OWNER-only
        (A, (R, O), False),
        (A, (O,), False),
        (R, (V,), False),
        (V, (V,), False),
        (None, (V,), False),
    ],
)
def test_member_management_matrix(actor: str | None, involved: tuple[str, ...], allowed: bool) -> None:
    assert roles.can_manage_member(actor, *involved) is allowed


@pytest.mark.parametrize(
    ("current", "new", "drops"),
    [(O, A, True), (O, None, True), (O, O, False), (A, None, False), (R, O, False)],
)
def test_drops_an_owner(current: str, new: str | None, drops: bool) -> None:
    assert roles.drops_an_owner(current, new) is drops


def test_role_order_matches_contract() -> None:
    assert roles.PROJECT_ROLES == ("PROJECT_OWNER", "PROJECT_ADMIN", "RESEARCHER", "VIEWER")
