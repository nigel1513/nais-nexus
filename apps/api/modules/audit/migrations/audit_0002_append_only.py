"""audit_events append-only: DB grants + mutation triggers (spec §4 불변성 보장, D-027)

Revision ID: audit_0002
Revises: audit_0001
"""

from alembic import op

revision = "audit_0002"
down_revision = "audit_0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # init.sql's default privileges grant SELECT/INSERT/UPDATE/DELETE on every new table; take the mutating ones back.
    op.execute("REVOKE UPDATE, DELETE, TRUNCATE ON audit.audit_events FROM nais_app")
    op.execute("GRANT SELECT, INSERT ON audit.audit_events TO nais_app")
    op.execute(
        """
        CREATE FUNCTION audit.forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          RAISE EXCEPTION 'audit_events is append-only' USING ERRCODE = 'insufficient_privilege';
        END
        $$
        """
    )
    op.execute(
        "CREATE TRIGGER audit_events_forbid_row_mutation BEFORE UPDATE OR DELETE ON audit.audit_events "
        "FOR EACH ROW EXECUTE FUNCTION audit.forbid_mutation()"
    )
    op.execute(
        "CREATE TRIGGER audit_events_forbid_truncate BEFORE TRUNCATE ON audit.audit_events "
        "FOR EACH STATEMENT EXECUTE FUNCTION audit.forbid_mutation()"
    )


def downgrade() -> None:
    op.execute("DROP TRIGGER audit_events_forbid_truncate ON audit.audit_events")
    op.execute("DROP TRIGGER audit_events_forbid_row_mutation ON audit.audit_events")
    op.execute("DROP FUNCTION audit.forbid_mutation()")
    op.execute("GRANT UPDATE, DELETE ON audit.audit_events TO nais_app")
