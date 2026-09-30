from pathlib import Path

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.exc import ProgrammingError

from api.platform.migrate import MigrationTarget, new_revision, upgrade_all
from api.platform.modules import ModuleSpec
from api.platform.testing.fixtures import PgUrls

PROBE_REVISION = '''
revision = "probe_0001"
down_revision = None
branch_labels = None
depends_on = None

import sqlalchemy as sa
from alembic import op


def upgrade() -> None:
    op.create_table("probe", sa.Column("id", sa.Integer, primary_key=True), schema="knowledge")


def downgrade() -> None:
    op.drop_table("probe", schema="knowledge")
'''


def scalar(url: str, sql: str) -> object:
    engine = create_engine(url)
    try:
        with engine.connect() as conn:
            return conn.execute(text(sql)).scalar()
    finally:
        engine.dispose()


def test_platform_migration_creates_outbox_and_version_table(migrated_db: PgUrls) -> None:
    assert scalar(migrated_db.app, "SELECT to_regclass('platform.outbox_events')::text") == "platform.outbox_events"
    assert scalar(migrated_db.migrator, "SELECT version_num FROM platform.alembic_version") == "platform_0001"


def test_upgrade_is_idempotent(migrated_db: PgUrls) -> None:
    assert upgrade_all(migrated_db.migrator, []) == ["platform"]


def test_module_migrations_use_their_own_schema_version_table(migrated_db: PgUrls, tmp_path: Path) -> None:
    (tmp_path / "probe_0001.py").write_text(PROBE_REVISION)
    spec = ModuleSpec(name="knowledge", db_schema="knowledge", migrations_dir=tmp_path)
    try:
        assert upgrade_all(migrated_db.migrator, [spec]) == ["platform", "knowledge"]
        assert scalar(migrated_db.migrator, "SELECT version_num FROM knowledge.alembic_version") == "probe_0001"
    finally:
        engine = create_engine(migrated_db.migrator)
        with engine.begin() as conn:
            conn.execute(text("DROP TABLE IF EXISTS knowledge.probe, knowledge.alembic_version"))
        engine.dispose()


def test_app_role_can_write_rows_but_not_create_tables(migrated_db: PgUrls) -> None:
    engine = create_engine(migrated_db.app)
    try:
        with engine.begin() as conn:
            conn.execute(text("SELECT count(*) FROM platform.outbox_events"))
        with pytest.raises(ProgrammingError), engine.begin() as conn:
            conn.execute(text("CREATE TABLE platform.sneaky (id int)"))
    finally:
        engine.dispose()


def test_module_with_migrations_but_no_schema_is_rejected(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="db_schema"):
        upgrade_all("postgresql+psycopg://x@localhost/nais", [ModuleSpec(name="bad", migrations_dir=tmp_path)], sql=True)


def test_offline_sql_mode_renders_ddl(capsys: pytest.CaptureFixture[str]) -> None:
    upgrade_all("postgresql+psycopg://x@localhost/nais", [], sql=True)
    assert "CREATE TABLE platform.outbox_events" in capsys.readouterr().out


def test_new_revision_writes_a_file_in_the_target_dir(tmp_path: Path) -> None:
    target = MigrationTarget(name="knowledge", schema="knowledge", versions_dir=tmp_path)
    path = new_revision("postgresql+psycopg://x@localhost/nais", target, "create concepts")
    assert path.parent == tmp_path
    assert "create_concepts" in path.name
    assert "down_revision = None" in path.read_text()
