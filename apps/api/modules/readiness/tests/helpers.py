"""Shared constants and fixture readers for readiness tests (no DB, no engine)."""

import json
from typing import Any
from uuid import UUID

from api.modules.readiness.fakes import FIXTURES_ROOT
from api.platform.auth import CurrentUser

ORG_NAIS = UUID("00000000-0000-7000-8000-000000000001")
ORG_A = UUID("00000000-0000-7000-8000-00000000000a")
ORG_B = UUID("00000000-0000-7000-8000-00000000000b")
FIXTURE_NAMES = ("clean_tabular", "missing_metadata", "invalid_units", "missing_provenance")


def _user(
    suffix: str, org: UUID, name: str, org_roles: set[str] | None = None, admin: bool = False
) -> CurrentUser:
    return CurrentUser(
        user_id=UUID(f"00000000-0000-7000-8000-00000000{suffix}"),
        organization_id=org,
        org_roles=frozenset(org_roles or set()),
        platform_roles=frozenset({"PLATFORM_ADMIN"} if admin else set()),
        session_id=f"s-{suffix}",
        display_name=name,
    )


USERS: dict[str, CurrentUser] = {  # 10_SEED_DATA.md §3 ids
    "admin": _user("0101", ORG_NAIS, "NAIS Admin", {"ORG_ADMIN"}, admin=True),
    "a_researcher": _user("0a02", ORG_A, "A Researcher"),
    "a_steward": _user("0a03", ORG_A, "A Steward", {"DATA_STEWARD"}),
    "b_researcher": _user("0b02", ORG_B, "B Researcher"),
    "b_orgadmin": _user("0b04", ORG_B, "B Org Admin", {"ORG_ADMIN"}),
    "b_steward": _user("0b03", ORG_B, "B Steward", {"DATA_STEWARD"}),
}


def clean_snapshot() -> dict[str, Any]:
    return json.loads((FIXTURES_ROOT / "clean_tabular" / "dataset.json").read_text(encoding="utf-8"))  # type: ignore[no-any-return]


def fixture_files(name: str = "clean_tabular") -> dict[str, bytes]:
    base = FIXTURES_ROOT / name / "files"
    return {p.relative_to(base).as_posix(): p.read_bytes() for p in sorted(base.rglob("*")) if p.is_file()}
