"""Project role rules (M02 §5 "Role 변경 규칙", §9 authorization matrix). Pure functions, no I/O."""

from typing import Final

OWNER: Final = "PROJECT_OWNER"
ADMIN: Final = "PROJECT_ADMIN"
RESEARCHER: Final = "RESEARCHER"
VIEWER: Final = "VIEWER"
PROJECT_ROLES: Final = (OWNER, ADMIN, RESEARCHER, VIEWER)

_ADMIN_MANAGEABLE: Final = frozenset({RESEARCHER, VIEWER})


def can_edit_project(actor_role: str | None) -> bool:
    return actor_role in (OWNER, ADMIN)


def can_change_visibility(actor_role: str | None) -> bool:
    return actor_role == OWNER


def can_archive(actor_role: str | None) -> bool:
    return actor_role == OWNER


def can_manage_member(actor_role: str | None, *roles_involved: str) -> bool:
    """May the actor add (new role), change (current + new role) or remove (current role) a member?

    OWNER manages every role. PROJECT_ADMIN only touches RESEARCHER/VIEWER on both sides of the change; granting,
    revoking or removing an ADMIN or OWNER is OWNER-only. Self-leave is handled by the caller, not here.
    """
    if actor_role == OWNER:
        return True
    if actor_role == ADMIN:
        return bool(roles_involved) and all(role in _ADMIN_MANAGEABLE for role in roles_involved)
    return False


def drops_an_owner(current_role: str, new_role: str | None) -> bool:
    """True when the change leaves one ACTIVE owner fewer (demotion or removal; new_role None = removal)."""
    return current_role == OWNER and new_role != OWNER
