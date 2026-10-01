import uuid

from api.modules.project import MODULE
from api.modules.project import ports as project_ports
from api.modules.project.public import ProjectQueryPort
from api.modules.project.query import SqlProjectQueryPort
from api.modules.project.seed_data import ORG_A, USERS_BY_KEY
from api.modules.project.tests.helpers import ProjectApi, seed_member, sql, uid
from api.platform import ports
from api.platform.modules import discover_modules
from api.platform.testing.app import create_test_app
from api.platform.testing.fixtures import PgUrls

A = USERS_BY_KEY["a.researcher"].user_id
B = USERS_BY_KEY["b.researcher"].user_id


def test_ports_module_re_exports_the_public_protocol() -> None:
    assert project_ports.ProjectQueryPort is ProjectQueryPort


def test_wire_registers_the_port_and_module_is_discoverable() -> None:
    create_test_app(modules=[MODULE])
    assert isinstance(ports.get(ProjectQueryPort), SqlProjectQueryPort)
    assert discover_modules(["project"]) == [MODULE]


def test_port_answers_membership_questions(api: ProjectApi, db: PgUrls) -> None:
    project = api.create_project(name="Port Study")
    project_id = uuid.UUID(project["project_id"])
    seed_member(db, project["project_id"], "b.researcher", "RESEARCHER")
    port = SqlProjectQueryPort(db.app)

    assert port.is_active_member(project_id, B)
    assert not port.is_active_member(project_id, USERS_BY_KEY["b.steward"].user_id)
    assert port.get_member_role(project_id, B) == "RESEARCHER"
    assert port.get_member_role(project_id, USERS_BY_KEY["b.steward"].user_id) is None
    assert port.list_active_member_ids(project_id) == [A, B]
    assert port.list_project_ids_for_member(B) == [project_id]

    summary = port.get_summary(project_id)
    assert summary is not None
    assert summary.name == "Port Study"
    assert summary.my_role is None
    assert summary.member_count == 2
    assert summary.lead_organization_id.root == ORG_A
    assert port.get_summary(uuid.uuid4()) is None


def test_at13_archived_project_is_not_active_membership(api: ProjectApi, db: PgUrls) -> None:
    project = api.create_project()
    project_id = uuid.UUID(project["project_id"])
    port = SqlProjectQueryPort(db.app)
    assert port.is_active_member(project_id, A)
    api.post("a.researcher", f"/projects/{project['project_id']}/archive")
    assert not port.is_active_member(project_id, A)
    assert port.get_member_role(project_id, A) == "PROJECT_OWNER"
    assert project_id in port.list_project_ids_for_member(A)
    assert port.list_active_member_ids(project_id) == [A]


def test_removed_member_disappears_from_port(api: ProjectApi, db: PgUrls) -> None:
    project = api.create_project()
    project_id = uuid.UUID(project["project_id"])
    seed_member(db, project["project_id"], "b.researcher", "RESEARCHER")
    api.delete("a.researcher", f"/projects/{project['project_id']}/members/{uid('b.researcher')}")
    port = SqlProjectQueryPort(db.app)
    assert not port.is_active_member(project_id, B)
    assert port.list_project_ids_for_member(B) == []


def test_at15_membership_grants_no_data_access(api: ProjectApi, db: PgUrls) -> None:
    """Membership != dataset permission: adding a member emits only project events, never a governance grant.
    The download-session 403 ACCESS_GRANT_REQUIRED half of AT-15 is verified by M04 / golden E2E."""
    project = api.create_project()
    api.post(
        "a.researcher",
        f"/projects/{project['project_id']}/members",
        json={"user_id": uid("b.researcher"), "role": "RESEARCHER"},
    )
    types = [
        row["event_type"] for row in sql(db, "SELECT event_type FROM platform.outbox_events ORDER BY id")
    ]
    assert types == ["project.created.v1", "project.member.added.v1"]
