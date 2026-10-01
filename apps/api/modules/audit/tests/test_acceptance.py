"""Module acceptance through the real write path: outbox.write -> relay.dispatch_batch -> both handlers -> API."""

from uuid import UUID

from fastapi import APIRouter
from fastapi.testclient import TestClient
from sqlalchemy import update

from api.modules.audit import handlers
from api.modules.audit.fakes import ADMIN, B_RESEARCHER
from api.modules.audit.mapping import REQUIRED_ACTIONS
from api.modules.audit.tests.support.auth import auth, make_client
from api.modules.audit.tests.support.db import fetch, scalar
from api.modules.audit.tests.support.events import ACTOR_A, ACTOR_B_STEWARD, SYSTEM, payload_for
from api.platform.db import SessionDep, session_factory
from api.platform.event_bus import HandlerRegistry
from api.platform.events import EventActor
from api.platform.modules import ModuleSpec
from api.platform.outbox import outbox, outbox_events
from api.platform.relay import dispatch_batch
from api.platform.settings import Settings
from api.platform.testing.app import create_test_app
from api.platform.testing.contracts import assert_matches_response
from api.platform.testing.fixtures import PgUrls

GOLDEN: list[tuple[str, EventActor]] = [
    ("identity.user.logged_in.v1", ACTOR_A),
    ("identity.membership.changed.v1", ACTOR_B_STEWARD),
    ("project.member.added.v1", ACTOR_A),
    ("catalog.dataset.created.v1", ACTOR_B_STEWARD),
    ("catalog.dataset.policy_changed.v1", ACTOR_B_STEWARD),
    ("catalog.dataset.version_published.v1", ACTOR_B_STEWARD),
    ("governance.access.requested.v1", ACTOR_A),
    ("governance.access.approved.v1", ACTOR_B_STEWARD),
    ("governance.access.rejected.v1", ACTOR_B_STEWARD),
    ("governance.access.revoked.v1", ACTOR_B_STEWARD),
    ("governance.access.expired.v1", SYSTEM),
    ("governance.download.authorized.v1", ACTOR_A),
]


def audit_registry() -> HandlerRegistry:
    registry = HandlerRegistry()
    handlers.register(registry)
    return registry


def test_golden_flow_produces_all_twelve_required_actions(db: PgUrls) -> None:  # M09-AT-01
    with session_factory(db.app)() as s, s.begin():
        for event_type, actor in GOLDEN:
            outbox.write(s, event_type, payload_for(event_type), actor)
    assert dispatch_batch(session_factory(db.app), audit_registry()).dispatched == len(GOLDEN)
    response = make_client(db).get("/api/v1/audit-events", params={"limit": 100}, headers=auth(ADMIN))
    assert response.status_code == 200
    assert_matches_response("listAuditEvents", 200, response.json())
    items = response.json()["items"]
    assert {i["action"] for i in items} >= REQUIRED_ACTIONS
    for item in items:
        assert item["trace_id"] and item["actor"]["type"] in {"USER", "SYSTEM"}
        assert item["resource"]["type"] and item["resource"]["id"]
    requested = next(i for i in items if i["action"] == "ACCESS_REQUESTED")
    assert "purpose_detail" not in requested["details"]  # M09-AT-16 via the API


def test_relay_redelivery_yields_one_audit_row_and_one_notification(db: PgUrls) -> None:  # M09-AT-02
    with session_factory(db.app)() as s, s.begin():
        outbox.write(s, "project.member.added.v1", payload_for("project.member.added.v1"), ACTOR_A)
    factory = session_factory(db.app)
    assert dispatch_batch(factory, audit_registry()).dispatched == 1
    with factory() as s, s.begin():
        s.execute(update(outbox_events).values(dispatched_at=None))
    assert dispatch_batch(factory, audit_registry()).dispatched == 1
    assert scalar(db, "SELECT count(*) FROM audit.audit_events") == 1
    assert (
        scalar(db, "SELECT count(*) FROM audit.notifications WHERE recipient_user_id = :u", u=B_RESEARCHER)
        == 1
    )
    assert scalar(db, "SELECT count(*) FROM audit.email_deliveries") == 1
    assert scalar(db, "SELECT count(*) FROM audit.processed_events") == 2


def test_audit_trace_id_matches_request_id_of_the_approving_call(db: PgUrls) -> None:  # M09-AT-15
    probe = APIRouter()

    @probe.post("/probe/approve")
    def approve(session: SessionDep) -> dict[str, str]:
        event_id = outbox.write(
            session,
            "governance.access.approved.v1",
            payload_for("governance.access.approved.v1"),
            ACTOR_B_STEWARD,
        )
        return {"event_id": str(event_id)}

    app = create_test_app(
        modules=[ModuleSpec(name="probe", router=probe)], settings=Settings(database_url=db.app)
    )
    response = TestClient(app).post("/api/v1/probe/approve")
    assert response.status_code == 200
    request_id = UUID(response.headers["X-Request-Id"])
    assert dispatch_batch(session_factory(db.app), audit_registry()).dispatched == 1
    [row] = fetch(db, "SELECT action, trace_id FROM audit.audit_events")
    assert row["action"] == "ACCESS_APPROVED"
    assert row["trace_id"] == request_id.hex
