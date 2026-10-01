from collections.abc import Iterator
from typing import Any

import pytest

from api.modules.audit import email_queue, handlers
from api.modules.audit import ports as audit_ports
from api.modules.audit.fakes import (
    A_RESEARCHER,
    B_DISABLED,
    B_RESEARCHER,
    B_STEWARD,
    ORG_B,
    SEED_USERS,
    FakeIdentity,
    FakeUser,
)
from api.modules.audit.handlers import audit_writer, notifier
from api.modules.audit.tests.support.db import fetch, run, scalar
from api.modules.audit.tests.support.events import envelope
from api.platform import ports
from api.platform.db import session_factory
from api.platform.event_bus import registry
from api.platform.generated.event_types import EventType
from api.platform.testing.fixtures import PgUrls


class RecordingActor:
    def __init__(self) -> None:
        self.calls = 0

    def send(self) -> None:
        self.calls += 1


@pytest.fixture
def actor() -> Iterator[RecordingActor]:
    recording = RecordingActor()
    email_queue.set_send_actor(recording)
    yield recording
    email_queue.set_send_actor(None)


def test_member_added_notifies_and_queues_email(
    db: PgUrls, actor: RecordingActor
) -> None:  # M09-AT-09 (in-app)
    event = envelope("project.member.added.v1")
    run(db, notifier, event)
    [n] = fetch(db, "SELECT * FROM audit.notifications")
    assert (n["recipient_user_id"], n["type"]) == (B_RESEARCHER, "PROJECT_INVITATION")
    assert n["source_event_id"] == event.event_id and n["read_at"] is None
    [mail] = fetch(db, "SELECT * FROM audit.email_deliveries")
    assert (mail["notification_id"], mail["to_address"], mail["status"], mail["attempts"]) == (
        n["notification_id"],
        "b.researcher@inst-b.local",
        "PENDING",
        0,
    )
    assert actor.calls == 1


def test_access_submitted_goes_to_owner_stewards_only(db: PgUrls, actor: RecordingActor) -> None:  # M09-AT-10
    run(db, notifier, envelope("governance.access.requested.v1"))
    rows = fetch(db, "SELECT recipient_user_id, type FROM audit.notifications")
    assert [(r["recipient_user_id"], r["type"]) for r in rows] == [(B_STEWARD, "ACCESS_SUBMITTED")]
    assert (
        scalar(db, "SELECT count(*) FROM audit.notifications WHERE recipient_user_id = :u", u=A_RESEARCHER)
        == 0
    )


def test_expiring_soon_notifies_but_is_not_audited(db: PgUrls, actor: RecordingActor) -> None:  # M09-AT-11
    event = envelope("governance.access.expiring_soon.v1")
    run(db, audit_writer, event)
    run(db, notifier, event)
    assert scalar(db, "SELECT count(*) FROM audit.audit_events") == 0
    rows = fetch(db, "SELECT recipient_user_id, type FROM audit.notifications")
    assert [(r["recipient_user_id"], r["type"]) for r in rows] == [(A_RESEARCHER, "ACCESS_EXPIRING")]
    assert (
        scalar(db, "SELECT count(*) FROM audit.processed_events WHERE event_id = :e", e=event.event_id) == 2
    )


def test_redelivery_notifies_once(db: PgUrls, actor: RecordingActor) -> None:  # M09-AT-02 (notification half)
    event = envelope("project.member.added.v1")
    run(db, notifier, event)
    run(db, notifier, event)
    assert scalar(db, "SELECT count(*) FROM audit.notifications") == 1
    assert scalar(db, "SELECT count(*) FROM audit.email_deliveries") == 1
    assert actor.calls == 1


def test_dataset_published_notifies_grant_holders(db: PgUrls, actor: RecordingActor) -> None:
    run(db, notifier, envelope("catalog.dataset.version_published.v1"))
    rows = fetch(db, "SELECT recipient_user_id, type FROM audit.notifications")
    assert [(r["recipient_user_id"], r["type"]) for r in rows] == [(A_RESEARCHER, "DATASET_PUBLISHED")]


def test_disabled_recipient_gets_nothing(db: PgUrls, actor: RecordingActor) -> None:  # Review Focus 2
    run(db, notifier, envelope("project.member.added.v1", user_id=B_DISABLED))
    assert scalar(db, "SELECT count(*) FROM audit.notifications") == 0
    assert actor.calls == 0


def test_missing_email_keeps_in_app_only(db: PgUrls, actor: RecordingActor) -> None:  # Review Focus 2
    users = [u for u in SEED_USERS if u.user_id != B_RESEARCHER]
    users.append(FakeUser(B_RESEARCHER, "B Researcher", "", ORG_B))
    ports.provide(audit_ports.IdentityQueryPort, FakeIdentity(users))
    run(db, notifier, envelope("project.member.added.v1"))
    assert scalar(db, "SELECT count(*) FROM audit.notifications") == 1
    assert scalar(db, "SELECT count(*) FROM audit.email_deliveries") == 0
    assert actor.calls == 0


def test_email_disabled_keeps_in_app_only(
    db: PgUrls, actor: RecordingActor, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("NOTIFICATION_EMAIL_ENABLED", "false")
    run(db, notifier, envelope("project.member.added.v1"))
    assert scalar(db, "SELECT count(*) FROM audit.notifications") == 1
    assert scalar(db, "SELECT count(*) FROM audit.email_deliveries") == 0


class FlakyIdentity:
    def __init__(self) -> None:
        self.inner = FakeIdentity(SEED_USERS)
        self.fail = True

    def __getattr__(self, name: str) -> Any:
        method = getattr(self.inner, name)

        def call(*args: Any, **kwargs: Any) -> Any:
            if self.fail:
                raise ConnectionError("identity down")
            return method(*args, **kwargs)

        return call


def test_identity_failure_rolls_back_claim_and_retry_succeeds(db: PgUrls, actor: RecordingActor) -> None:
    flaky = FlakyIdentity()  # Review Focus 1
    ports.provide(audit_ports.IdentityQueryPort, flaky)
    event = envelope("project.member.added.v1")
    with pytest.raises(ConnectionError):
        run(db, notifier, event)
    assert scalar(db, "SELECT count(*) FROM audit.processed_events WHERE handler = 'notifier'") == 0
    assert scalar(db, "SELECT count(*) FROM audit.notifications") == 0
    assert actor.calls == 0
    flaky.fail = False
    run(db, notifier, event)
    assert scalar(db, "SELECT count(*) FROM audit.notifications") == 1
    assert actor.calls == 1


@pytest.fixture
def restore_actor() -> Iterator[None]:
    saved = email_queue._state["actor"]
    yield
    email_queue.set_send_actor(saved)


def test_no_actor_configured_is_harmless(db: PgUrls, restore_actor: None) -> None:
    email_queue.set_send_actor(None)
    run(db, notifier, envelope("project.member.added.v1"))
    assert scalar(db, "SELECT count(*) FROM audit.email_deliveries WHERE status = 'PENDING'") == 1


def test_both_handlers_subscribed_to_every_event_type() -> None:
    table = registry.table()
    for e in EventType:
        assert "api.modules.audit.handlers.audit_writer" in table[e.value]
        assert "api.modules.audit.handlers.notifier" in table[e.value]
    assert (audit_writer, notifier) == handlers.HANDLERS


class EmailFailingIdentity:
    def __init__(self) -> None:
        self.inner = FakeIdentity(SEED_USERS)

    def get_email(self, user_id: Any) -> str | None:
        raise ConnectionError("email lookup down")

    def __getattr__(self, name: str) -> Any:
        return getattr(self.inner, name)


def test_email_lookup_failure_keeps_in_app_notification(db: PgUrls, actor: RecordingActor) -> None:
    ports.provide(audit_ports.IdentityQueryPort, EmailFailingIdentity())
    event = envelope("project.member.added.v1")
    run(db, notifier, event)
    assert scalar(db, "SELECT count(*) FROM audit.notifications") == 1
    assert scalar(db, "SELECT count(*) FROM audit.email_deliveries") == 0
    assert scalar(db, "SELECT count(*) FROM audit.processed_events WHERE handler = 'notifier'") == 1
    assert actor.calls == 0


def test_rollback_after_deliver_never_kicks_actor(db: PgUrls, actor: RecordingActor) -> None:
    with pytest.raises(RuntimeError), session_factory(db.app)() as session, session.begin():
        notifier(session, envelope("project.member.added.v1"))
        raise RuntimeError("boom")
    assert scalar(db, "SELECT count(*) FROM audit.notifications") == 0
    assert actor.calls == 0
