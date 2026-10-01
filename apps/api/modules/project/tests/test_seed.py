from api.modules.project import MODULE
from api.modules.project.query import SqlProjectQueryPort
from api.modules.project.seed_data import ORG_A, ORG_B, SEED_PROJECT_ID, USERS_BY_KEY
from api.modules.project.tests.helpers import project_events, sql, uid
from api.platform.seed import run_seed
from api.platform.testing.fixtures import PgUrls


def test_seed_is_idempotent_and_matches_seed_spec(db: PgUrls) -> None:
    assert run_seed([MODULE], url=db.app) == ["project"]
    assert run_seed([MODULE], url=db.app) == ["project"]

    projects = sql(
        db,
        "SELECT project_id::text, name, visibility, status, lead_organization_id::text FROM project.projects",
    )
    assert projects == [
        {
            "project_id": str(SEED_PROJECT_ID),
            "name": "Seed: Battery Materials Joint Study",
            "visibility": "PRIVATE",
            "status": "ACTIVE",
            "lead_organization_id": str(ORG_A),
        }
    ]
    members = sql(db, "SELECT user_id::text, role, status FROM project.project_members ORDER BY role")
    assert members == [
        {"user_id": uid("a.researcher"), "role": "PROJECT_OWNER", "status": "ACTIVE"},
        {"user_id": uid("b.researcher"), "role": "RESEARCHER", "status": "ACTIVE"},
    ]
    organizations = sql(
        db,
        "SELECT organization_id::text, role, active_member_count FROM project.project_organizations ORDER BY role",
    )
    assert organizations == [
        {"organization_id": str(ORG_A), "role": "LEAD", "active_member_count": 1},
        {"organization_id": str(ORG_B), "role": "PARTNER", "active_member_count": 1},
    ]
    assert [e["event_type"] for e in project_events(db)] == ["project.created.v1", "project.member.added.v1"]

    port = SqlProjectQueryPort(db.app)
    assert port.is_active_member(SEED_PROJECT_ID, USERS_BY_KEY["a.researcher"].user_id)
    assert port.get_member_role(SEED_PROJECT_ID, USERS_BY_KEY["b.researcher"].user_id) == "RESEARCHER"
