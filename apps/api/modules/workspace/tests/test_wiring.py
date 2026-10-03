"""Module wiring, the fail-closed consumer defaults, the public port and the schema."""

import ast
import subprocess
import sys
from datetime import UTC, datetime
from pathlib import Path
from uuid import UUID

import pytest
from sqlalchemy.exc import IntegrityError

from api.modules.identity.public import IdentityPublicProfile, IdentityQueryPort, OrganizationSummary
from api.modules.workspace.adapters.grants import NoGrants
from api.modules.workspace.adapters.identity import IdentityDisplayNames
from api.modules.workspace.deps import WorkspaceDeps, get_deps
from api.modules.workspace.public import PinnedInput, WorkspaceQueryPort
from api.modules.workspace.public_impl import SqlWorkspaceQuery
from api.modules.workspace.storage import S3OutputStorage
from api.modules.workspace.tables import comments, inputs, threads
from api.modules.workspace.tests.conftest import WorkspaceApi, World
from api.modules.workspace.tests.fakes import ORG_A, USERS
from api.modules.workspace.wiring import build_default_deps, wire
from api.platform import ports
from api.platform.db import session_factory
from api.platform.errors import ApiError
from api.platform.ids import new_id
from api.platform.testing.fixtures import PgUrls


def test_wire_registers_deps_with_fail_closed_grants() -> None:
    wire()
    deps = ports.get(WorkspaceDeps)
    assert isinstance(deps.grants, NoGrants)
    assert isinstance(deps.people, IdentityDisplayNames)
    assert deps.grants.has_active_grant(new_id(), new_id()) is False
    assert isinstance(ports.get(WorkspaceQueryPort), SqlWorkspaceQuery)
    assert isinstance(deps.storage, S3OutputStorage)


def test_unwired_ports_fail_with_503() -> None:
    with pytest.raises(ApiError) as exc:
        get_deps()
    assert exc.value.status_code == 503
    deps = build_default_deps()
    for resolve in (lambda: deps.projects, lambda: deps.catalog):
        with pytest.raises(ApiError) as exc:
            resolve()
        assert exc.value.code == "DEPENDENCY_UNAVAILABLE"
    with pytest.raises(ApiError) as exc:
        deps.people.get_display_names([new_id()])
    assert exc.value.code == "DEPENDENCY_UNAVAILABLE"


class _Profiles:
    """Only get_public_profiles is used by IdentityDisplayNames."""

    def get_public_profiles(self, user_ids: list[UUID]) -> dict[UUID, IdentityPublicProfile]:
        user = USERS["a.researcher"]
        return {
            i: IdentityPublicProfile(
                user_id=i,
                display_name=user.display_name,
                organization_id=user.organization_id,
                status="ACTIVE",
            )
            for i in user_ids
            if i == user.user_id
        }


def test_display_names_come_from_identity_profiles() -> None:
    ports.provide(IdentityQueryPort, _Profiles())  # type: ignore[arg-type]
    names = IdentityDisplayNames()
    known, unknown = USERS["a.researcher"].user_id, new_id()
    assert names.get_display_names([known, unknown, known]) == {known: "A Researcher"}
    assert names.get_display_names([]) == {}


def test_public_module_is_a_leaf() -> None:
    path = Path(__file__).parents[1] / "public.py"
    tree = ast.parse(path.read_text())
    imported = {
        (node.module or "") if isinstance(node, ast.ImportFrom) else alias.name
        for node in ast.walk(tree)
        if isinstance(node, (ast.Import, ast.ImportFrom))
        for alias in (node.names if isinstance(node, ast.Import) else [None])
    }
    assert imported <= {"dataclasses", "typing", "uuid"}, imported
    code = f"import runpy; runpy.run_path({str(path)!r})"
    assert subprocess.run([sys.executable, "-c", code], check=False).returncode == 0


def test_public_port_lists_live_inputs(api: WorkspaceApi, world: World, db: PgUrls) -> None:
    project_id = new_id()
    world.projects.add(project_id, USERS["a.researcher"], "RESEARCHER")
    first = world.catalog.add_dataset("one", "PUBLIC")
    first_v1 = world.catalog.add_version(first, "v1")
    second = world.catalog.add_dataset("two", "PUBLIC")
    world.catalog.add_version(second, "v1")
    path = f"/projects/{project_id}/inputs"
    kept = api.post("a.researcher", path, json={"dataset_id": str(first.dataset_id)}).json()
    gone = api.post("a.researcher", path, json={"dataset_id": str(second.dataset_id)}).json()
    api.delete("a.researcher", f"{path}/{gone['input_id']}")

    port = SqlWorkspaceQuery(db.app)
    assert port.list_pinned_inputs(project_id) == [
        PinnedInput(
            input_id=UUID(kept["input_id"]),
            project_id=project_id,
            dataset_id=first.dataset_id,
            dataset_version_id=first_v1.dataset_version_id,
        )
    ]
    assert port.list_pinned_inputs(new_id()) == []


def test_one_live_input_per_dataset_is_enforced_by_the_database(db: PgUrls) -> None:
    project_id, dataset_id = new_id(), new_id()

    def row() -> dict[str, UUID]:
        return {
            "input_id": new_id(),
            "project_id": project_id,
            "dataset_id": dataset_id,
            "dataset_version_id": new_id(),
            "added_by": new_id(),
        }

    with session_factory(db.app)() as session, session.begin():
        first = row()
        session.execute(inputs.insert().values(**first))
        session.execute(
            inputs.update().where(inputs.c.input_id == first["input_id"]).values(removed_at=inputs.c.added_at)
        )
        session.execute(inputs.insert().values(**row()))  # the removed one does not count
    with pytest.raises(IntegrityError), session_factory(db.app)() as session, session.begin():
        session.execute(inputs.insert().values(**row()))


class _Organizations:
    """Only get_organization_summary is used by IdentityDisplayNames.get_organization_names."""

    def __init__(self) -> None:
        self.calls: list[UUID] = []

    def get_organization_summary(self, organization_id: UUID) -> OrganizationSummary | None:
        self.calls.append(organization_id)
        if organization_id != ORG_A:
            return None
        return OrganizationSummary(
            organization_id=ORG_A, code="inst-a", name="Institute A", type="RESEARCH_INSTITUTE"
        )


def test_organization_names_come_from_identity_summaries() -> None:
    organizations = _Organizations()
    ports.provide(IdentityQueryPort, organizations)  # type: ignore[arg-type]
    unknown = new_id()
    assert IdentityDisplayNames().get_organization_names([ORG_A, unknown, ORG_A]) == {ORG_A: "Institute A"}
    assert organizations.calls == [ORG_A, unknown]
    assert IdentityDisplayNames().get_organization_names([]) == {}


def test_organization_code_comes_from_identity_summaries() -> None:
    ports.provide(IdentityQueryPort, _Organizations())  # type: ignore[arg-type]
    assert IdentityDisplayNames().get_organization_code(ORG_A) == "inst-a"
    assert IdentityDisplayNames().get_organization_code(new_id()) is None


def test_discussion_rules_are_enforced_by_the_database(db: PgUrls) -> None:
    def thread(**values: object) -> dict[str, object]:
        now = datetime(2026, 10, 1, tzinfo=UTC)
        base: dict[str, object] = {
            "thread_id": new_id(),
            "scope": "PROJECT",
            "target_id": new_id(),
            "project_id": new_id(),
            "title": "t",
            "created_by": new_id(),
            "comment_count": 1,
            "last_comment_at": now,
        }
        return base | values

    bad = (
        thread(scope="DATASET"),  # DATASET threads have no project
        thread(project_id=None),  # project threads need one
        thread(scope="NOTE"),
        thread(title=""),
    )
    for values in bad:
        with pytest.raises(IntegrityError), session_factory(db.app)() as session, session.begin():
            session.execute(threads.insert().values(**values))
    good = thread()
    with session_factory(db.app)() as session, session.begin():
        session.execute(threads.insert().values(**good))
    with pytest.raises(IntegrityError), session_factory(db.app)() as session, session.begin():
        session.execute(
            comments.insert().values(
                comment_id=new_id(), thread_id=good["thread_id"], body="x" * 10_001, author_id=new_id()
            )
        )
