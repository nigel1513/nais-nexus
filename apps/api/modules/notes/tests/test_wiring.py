"""Module wiring, fail-closed defaults and the leaf public interface."""

import ast
from pathlib import Path
from uuid import UUID

import pytest

from api.modules.identity.public import IdentityPublicProfile, IdentityQueryPort
from api.modules.notes.adapters import IdentityDisplayNames
from api.modules.notes.deps import NotesDeps, get_deps
from api.modules.notes.tests.fakes import USERS
from api.modules.notes.wiring import build_default_deps, wire
from api.platform import ports
from api.platform.errors import ApiError
from api.platform.ids import new_id


def test_wire_registers_deps() -> None:
    wire()
    deps = ports.get(NotesDeps)
    assert isinstance(deps.people, IdentityDisplayNames)
    assert deps.settings.nais_llm_enabled is False


def test_unwired_ports_fail_with_503() -> None:
    with pytest.raises(ApiError) as exc:
        get_deps()
    assert exc.value.status_code == 503
    deps = build_default_deps()
    with pytest.raises(ApiError) as exc:
        _ = deps.projects
    assert exc.value.code == "DEPENDENCY_UNAVAILABLE"
    with pytest.raises(ApiError) as exc:
        deps.people.get_display_names([new_id()])
    assert exc.value.code == "DEPENDENCY_UNAVAILABLE"
    assert deps.people.get_display_names([]) == {}


class _Profiles:
    def get_public_profiles(self, user_ids: list[UUID]) -> dict[UUID, IdentityPublicProfile]:
        user = USERS["a.recorder"]
        return {
            user.user_id: IdentityPublicProfile.model_validate(
                {
                    "user_id": user.user_id,
                    "display_name": user.display_name,
                    "organization_id": user.organization_id,
                    "status": "ACTIVE",
                }
            )
        }


def test_display_names_come_from_identity() -> None:
    ports.provide(IdentityQueryPort, _Profiles())  # type: ignore[type-abstract]
    names = IdentityDisplayNames().get_display_names([USERS["a.recorder"].user_id, new_id()])
    assert names == {USERS["a.recorder"].user_id: "김민준"}


def test_public_module_is_a_leaf() -> None:
    tree = ast.parse((Path(__file__).parents[1] / "public.py").read_text(encoding="utf-8"))
    imported = [n.module for n in ast.walk(tree) if isinstance(n, ast.ImportFrom)] + [
        a.name for n in ast.walk(tree) if isinstance(n, ast.Import) for a in n.names
    ]
    assert all(not (m or "").startswith("api.") for m in imported)
