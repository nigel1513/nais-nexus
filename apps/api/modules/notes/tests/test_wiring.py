"""Module wiring, fail-closed defaults and the leaf public interface."""

import ast
from datetime import date
from pathlib import Path
from uuid import UUID

import pytest

from api.modules.identity.public import IdentityPublicProfile, IdentityQueryPort, OrganizationSummary
from api.modules.notes.adapters import IdentityDisplayNames, NoNotebooks
from api.modules.notes.deps import NotesDeps, get_deps
from api.modules.notes.interfaces import NotebookActivityPort
from api.modules.notes.tests.fakes import USERS
from api.modules.notes.wiring import build_default_deps, wire
from api.platform import ports
from api.platform.errors import ApiError
from api.platform.ids import new_id
from api.platform.llm import get_llm_client


def test_wire_registers_deps() -> None:
    wire()
    deps = ports.get(NotesDeps)
    assert isinstance(deps.people, IdentityDisplayNames)
    assert deps.llm is get_llm_client  # None unless NAIS_LLM_ENABLED and NAIS_LLM_BASE_URL are set
    assert deps.llm() is None
    assert isinstance(ports.get(NotebookActivityPort), NoNotebooks)  # until M07 provides the real one
    assert isinstance(deps.notebooks, NoNotebooks)


def test_notebook_port_defaults_to_nothing_and_m07_can_replace_it() -> None:
    deps = build_default_deps()
    assert isinstance(deps.notebooks, NoNotebooks)  # nothing provided at all
    today = date(2026, 10, 1)
    assert deps.notebooks.list_notebook_activity(new_id(), None, today) == []
    assert deps.notebooks.list_notebook_authors(today) == []

    class Jupyter:
        def list_notebook_activity(self, *args: object) -> list[object]:
            return ["m07"]

        def list_notebook_authors(self, day: date) -> list[tuple[UUID, UUID]]:
            return []

    ports.provide(NotebookActivityPort, Jupyter())  # type: ignore[arg-type]
    wire()  # notes wired after M07 keeps M07's port
    assert ports.get(NotesDeps).notebooks.list_notebook_activity(new_id(), None, today) == ["m07"]
    replacement = Jupyter()
    ports.provide(NotebookActivityPort, replacement)  # type: ignore[arg-type]
    assert ports.get(NotesDeps).notebooks is replacement  # resolved per call


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
    def get_organization_summary(self, organization_id: UUID) -> OrganizationSummary | None:
        if organization_id != USERS["a.recorder"].organization_id:
            return None
        return OrganizationSummary(
            organization_id=organization_id, code="A", name="A 기관", type="UNIVERSITY"
        )

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
    organizations = IdentityDisplayNames().get_organization_ids([USERS["a.recorder"].user_id, new_id()])
    assert organizations == {USERS["a.recorder"].user_id: USERS["a.recorder"].organization_id}
    org = USERS["a.recorder"].organization_id
    assert IdentityDisplayNames().get_organization_names([org, new_id()]) == {org: "A 기관"}
    assert IdentityDisplayNames().get_organization_names([]) == {}


def test_public_module_is_a_leaf() -> None:
    tree = ast.parse((Path(__file__).parents[1] / "public.py").read_text(encoding="utf-8"))
    imported = [n.module for n in ast.walk(tree) if isinstance(n, ast.ImportFrom)] + [
        a.name for n in ast.walk(tree) if isinstance(n, ast.Import) for a in n.names
    ]
    assert all(not (m or "").startswith("api.") for m in imported)
