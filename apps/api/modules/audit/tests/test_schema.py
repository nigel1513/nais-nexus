import uuid

import pytest
from nais_contracts.api_models import AuditAction, NotificationType, ResourceType
from sqlalchemy import Connection, create_engine, inspect, text
from sqlalchemy.exc import IntegrityError

from api.modules.audit import MODULE
from api.modules.audit.settings import AuditSettings
from api.platform.modules import discover_modules
from api.platform.testing.fixtures import PgUrls


def test_module_is_discoverable() -> None:
    assert discover_modules(["audit"]) == [MODULE]
    assert MODULE.db_schema == "audit"
    assert MODULE.migrations_dir is not None and MODULE.migrations_dir.is_dir()


def test_settings_defaults_match_spec(monkeypatch: pytest.MonkeyPatch) -> None:
    for key in (
        "SMTP_HOST",
        "SMTP_PORT",
        "SMTP_FROM",
        "NOTIFICATION_EMAIL_ENABLED",
        "NOTIFICATION_RETENTION_DAYS",
        "NAIS_PUBLIC_BASE_URL",
    ):
        monkeypatch.delenv(key, raising=False)
    s = AuditSettings()
    assert (s.smtp_host, s.smtp_port) == ("mailpit", 1025)
    assert s.smtp_from == "NAIS AI-OS <no-reply@nais.local>"
    assert s.notification_email_enabled is True
    assert s.notification_retention_days == 180
    assert s.nais_public_base_url == "http://localhost:21051"


def test_tables_and_indexes_exist(db: PgUrls) -> None:
    engine = create_engine(db.migrator)
    insp = inspect(engine)
    assert {
        "audit_events",
        "notifications",
        "email_deliveries",
        "processed_events",
        "alembic_version",
    } <= set(insp.get_table_names(schema="audit"))
    audit_idx = {i["name"] for i in insp.get_indexes("audit_events", schema="audit")}
    assert {
        "ix_audit_occurred",
        "ix_audit_actor",
        "ix_audit_actor_org",
        "ix_audit_owner_org",
        "ix_audit_project",
        "ix_audit_resource",
        "ix_audit_action",
    } <= audit_idx
    notif_idx = {i["name"] for i in insp.get_indexes("notifications", schema="audit")}
    assert {"ix_notifications_recipient", "ix_notifications_unread"} <= notif_idx
    assert insp.get_pk_constraint("processed_events", schema="audit")["constrained_columns"] == [
        "event_id",
        "handler",
    ]
    engine.dispose()


def _insert_audit(conn: Connection, **overrides: object) -> None:
    values = {
        "id": uuid.uuid4(),
        "action": "LOGIN",
        "result": "SUCCESS",
        "actor_type": "USER",
        "rtype": "USER",
        "rid": uuid.uuid4(),
        "src": uuid.uuid4(),
    }
    values.update(overrides)
    conn.execute(
        text(
            "INSERT INTO audit.audit_events (audit_event_id, occurred_at, action, result, actor_type, "
            "resource_type, resource_id, source_event_id, source_event_type, trace_id) VALUES "
            "(:id, now(), :action, :result, :actor_type, :rtype, :rid, :src, 'x', 'abc')"
        ),
        values,
    )


@pytest.mark.parametrize(
    "overrides",
    [{"action": "NOPE"}, {"result": "MAYBE"}, {"actor_type": "ROBOT"}, {"rtype": "PLANET"}],
)
def test_check_constraints_reject_unknown_enum_values(db: PgUrls, overrides: dict[str, object]) -> None:
    engine = create_engine(db.app)
    with pytest.raises(IntegrityError), engine.begin() as conn:
        _insert_audit(conn, **overrides)
    engine.dispose()


def test_source_event_id_is_unique(db: PgUrls) -> None:
    engine = create_engine(db.app)
    src = uuid.uuid4()
    with engine.begin() as conn:
        _insert_audit(conn, src=src)
    with pytest.raises(IntegrityError), engine.begin() as conn:
        _insert_audit(conn, src=src)
    engine.dispose()


def test_notification_unique_per_event_and_recipient(db: PgUrls) -> None:
    engine = create_engine(db.app)
    src, rcpt = uuid.uuid4(), uuid.uuid4()
    sql = text(
        "INSERT INTO audit.notifications (notification_id, recipient_user_id, type, title, link, "
        "source_event_id) VALUES (:id, :r, 'PROJECT_INVITATION', 't', '/x', :s)"
    )
    with engine.begin() as conn:
        conn.execute(sql, {"id": uuid.uuid4(), "r": rcpt, "s": src})
    with pytest.raises(IntegrityError), engine.begin() as conn:
        conn.execute(sql, {"id": uuid.uuid4(), "r": rcpt, "s": src})
    engine.dispose()


# audit_0003: the CHECK constraints accept every value of the current contract enums (contract 1.6.0 widening).
# A contract enum value the database refuses would dead-letter its event, so this fails until a migration widens them.


@pytest.mark.parametrize("action", [a.value for a in AuditAction])
def test_every_contract_audit_action_is_accepted(db: PgUrls, action: str) -> None:
    engine = create_engine(db.app)
    with engine.begin() as conn:
        _insert_audit(conn, action=action)
    engine.dispose()


@pytest.mark.parametrize("rtype", [r.value for r in ResourceType])
def test_every_contract_resource_type_is_accepted(db: PgUrls, rtype: str) -> None:
    engine = create_engine(db.app)
    with engine.begin() as conn:
        _insert_audit(conn, rtype=rtype)
    engine.dispose()


@pytest.mark.parametrize("ntype", [n.value for n in NotificationType])
def test_every_contract_notification_type_is_accepted(db: PgUrls, ntype: str) -> None:
    engine = create_engine(db.app)
    with engine.begin() as conn:
        conn.execute(
            text(
                "INSERT INTO audit.notifications (notification_id, recipient_user_id, type, title, link, "
                "source_event_id) VALUES (:id, :r, :t, 't', '/x', :s)"
            ),
            {"id": uuid.uuid4(), "r": uuid.uuid4(), "t": ntype, "s": uuid.uuid4()},
        )
    engine.dispose()


def test_widened_checks_still_reject_unknown_notification_types(db: PgUrls) -> None:
    engine = create_engine(db.app)
    with pytest.raises(IntegrityError), engine.begin() as conn:
        conn.execute(
            text(
                "INSERT INTO audit.notifications (notification_id, recipient_user_id, type, title, link, "
                "source_event_id) VALUES (:id, :r, 'NOPE', 't', '/x', :s)"
            ),
            {"id": uuid.uuid4(), "r": uuid.uuid4(), "s": uuid.uuid4()},
        )
    engine.dispose()
