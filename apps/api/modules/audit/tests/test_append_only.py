"""M09-AT-03: the app role cannot UPDATE/DELETE/TRUNCATE audit rows; the trigger blocks even the owner."""

import uuid

import psycopg
import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.exc import DBAPIError

from api.platform.testing.fixtures import PgUrls

MUTATIONS = [
    "UPDATE audit.audit_events SET reason = 'tampered'",
    "DELETE FROM audit.audit_events",
    "TRUNCATE audit.audit_events",
]


def _insert_row(url: str) -> None:
    engine = create_engine(url)
    with engine.begin() as conn:
        conn.execute(
            text(
                "INSERT INTO audit.audit_events (audit_event_id, occurred_at, action, result, actor_type, "
                "resource_type, resource_id, source_event_id, source_event_type, trace_id) VALUES "
                "(:id, now(), 'LOGIN', 'SUCCESS', 'USER', 'USER', :rid, :src, 'identity.user.logged_in.v1', 'ab')"
            ),
            {"id": uuid.uuid4(), "rid": uuid.uuid4(), "src": uuid.uuid4()},
        )
    engine.dispose()


def _count(url: str) -> int:
    engine = create_engine(url)
    with engine.connect() as conn:
        value = int(conn.execute(text("SELECT count(*) FROM audit.audit_events")).scalar_one())
    engine.dispose()
    return value


def test_app_role_can_insert_and_select(db: PgUrls) -> None:
    _insert_row(db.app)
    assert _count(db.app) == 1


@pytest.mark.parametrize("sql", MUTATIONS)
def test_app_role_cannot_mutate_audit_rows(db: PgUrls, sql: str) -> None:
    _insert_row(db.app)
    engine = create_engine(db.app)
    with pytest.raises(DBAPIError) as caught, engine.begin() as conn:
        conn.execute(text(sql))
    engine.dispose()
    assert isinstance(caught.value.orig, psycopg.errors.InsufficientPrivilege)
    assert _count(db.app) == 1


@pytest.mark.parametrize("sql", MUTATIONS)
def test_trigger_blocks_even_the_table_owner(db: PgUrls, sql: str) -> None:
    _insert_row(db.app)
    engine = create_engine(db.migrator)
    with pytest.raises(DBAPIError, match="audit_events is append-only"), engine.begin() as conn:
        conn.execute(text(sql))
    engine.dispose()
    assert _count(db.app) == 1


def test_app_role_privileges_are_exactly_insert_and_select(db: PgUrls) -> None:
    engine = create_engine(db.superuser)
    with engine.connect() as conn:
        granted = {
            priv
            for priv in ("SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE")
            if conn.execute(
                text("SELECT has_table_privilege('nais_app', 'audit.audit_events', :p)"), {"p": priv}
            ).scalar_one()
        }
        notif_update = conn.execute(
            text("SELECT has_table_privilege('nais_app', 'audit.notifications', 'UPDATE,DELETE')")
        ).scalar_one()
    engine.dispose()
    assert granted == {"SELECT", "INSERT"}
    assert notif_update is True  # read_at updates + purge job need it
