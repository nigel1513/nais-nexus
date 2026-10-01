from typing import Any
from uuid import UUID

import pytest
from sqlalchemy import create_engine, text

from api.modules.audit import handlers
from api.modules.audit import ports as audit_ports
from api.modules.audit.fakes import A_RESEARCHER, ORG_A
from api.modules.audit.handlers import audit_writer
from api.modules.audit.mapping import to_audit_record
from api.modules.audit.tests.support.db import fetch, run, scalar
from api.modules.audit.tests.support.events import SYSTEM, envelope
from api.platform import ports
from api.platform.event_bus import HandlerRegistry, registry
from api.platform.generated.event_types import EventType
from api.platform.testing.fixtures import PgUrls


def test_writes_one_denormalized_row(db: PgUrls) -> None:
    event = envelope("governance.access.approved.v1")
    run(db, audit_writer, event)
    [row] = fetch(db, "SELECT * FROM audit.audit_events")
    assert row["action"] == "ACCESS_APPROVED"
    assert row["actor_user_id"] == A_RESEARCHER and row["actor_organization_id"] == ORG_A
    assert row["actor_display_name"] == "A Researcher"
    assert row["trace_id"] == event.correlation_id.hex
    assert row["source_event_id"] == event.event_id
    assert row["details"]["policy_version"] == "policy-2026.10.01"
    assert (
        scalar(db, "SELECT handler FROM audit.processed_events WHERE event_id = :e", e=event.event_id)
        == "audit_writer"
    )


def test_redelivery_writes_once(db: PgUrls) -> None:  # M09-AT-02 (audit half)
    event = envelope("identity.user.logged_in.v1")
    run(db, audit_writer, event)
    run(db, audit_writer, event)
    assert scalar(db, "SELECT count(*) FROM audit.audit_events") == 1


def test_on_conflict_protects_even_if_claim_row_is_lost(db: PgUrls) -> None:
    event = envelope("identity.user.logged_in.v1")
    run(db, audit_writer, event)
    engine = create_engine(db.superuser)
    with engine.begin() as conn:
        conn.execute(text("DELETE FROM audit.processed_events"))
    engine.dispose()
    run(db, audit_writer, event)
    assert scalar(db, "SELECT count(*) FROM audit.audit_events") == 1


@pytest.mark.parametrize(
    "event_type", ["governance.access.expiring_soon.v1", "readiness.validation.started.v1"]
)
def test_non_audited_events_are_claimed_without_rows(db: PgUrls, event_type: str) -> None:
    event = envelope(event_type)
    run(db, audit_writer, event)
    assert scalar(db, "SELECT count(*) FROM audit.audit_events") == 0
    assert scalar(db, "SELECT count(*) FROM audit.processed_events WHERE handler = 'audit_writer'") == 1


def test_system_actor_has_no_display_name(db: PgUrls) -> None:
    run(db, audit_writer, envelope("governance.access.expired.v1", actor=SYSTEM))
    [row] = fetch(db, "SELECT actor_type, actor_display_name FROM audit.audit_events")
    assert (row["actor_type"], row["actor_display_name"]) == ("SYSTEM", None)


class BrokenIdentity:
    def __getattr__(self, name: str) -> Any:
        def fail(*args: Any, **kwargs: Any) -> Any:
            raise ConnectionError("identity down")

        return fail


def test_identity_outage_still_writes_audit_row(db: PgUrls) -> None:  # Review Focus 5
    ports.provide(audit_ports.IdentityQueryPort, BrokenIdentity())
    run(db, audit_writer, envelope("identity.user.logged_in.v1"))
    [row] = fetch(db, "SELECT action, actor_display_name FROM audit.audit_events")
    assert (row["action"], row["actor_display_name"]) == ("LOGIN", None)


def test_audit_writer_subscribed_to_every_event_type() -> None:
    table = registry.table()
    name = "api.modules.audit.handlers.audit_writer"
    assert all(name in table[e.value] for e in EventType)


def test_register_into_a_fresh_registry() -> None:
    fresh = HandlerRegistry()
    handlers.register(fresh)
    assert len(fresh.table()) == 28
    assert all(len(names) == len(handlers.HANDLERS) for names in fresh.table().values())


def test_unknown_owner_uuid_is_stored_as_uuid(db: PgUrls) -> None:
    run(db, audit_writer, envelope("catalog.dataset.created.v1"))
    owner = scalar(db, "SELECT resource_owner_organization_id FROM audit.audit_events")
    assert isinstance(owner, UUID)


def _malformed() -> Any:
    event = envelope("identity.user.logged_in.v1")
    return event.model_copy(update={"payload": {k: v for k, v in event.payload.items() if k != "user_id"}})


def test_malformed_payload_raises_and_rolls_back_the_claim(db: PgUrls) -> None:
    # Poison events must surface (relay retries, then dead-letters) - never silently dropped.
    event = _malformed()
    with pytest.raises(ValueError, match="user_id"):
        run(db, audit_writer, event)
    assert scalar(db, "SELECT count(*) FROM audit.audit_events") == 0
    assert scalar(db, "SELECT count(*) FROM audit.processed_events") == 0


def test_mapping_rejects_null_resource_id_without_assert() -> None:
    event = envelope("identity.user.logged_in.v1")
    event = event.model_copy(update={"payload": {**event.payload, "user_id": None}})
    with pytest.raises(ValueError, match="user_id"):
        to_audit_record(event)
