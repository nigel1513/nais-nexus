"""W1-D2: pg_trgm is installed once in schema public by init.sql and usable by both runtime roles."""

from sqlalchemy import create_engine, text

from api.platform.testing.fixtures import PgUrls


def test_pg_trgm_is_installed_in_public(pg_urls: PgUrls) -> None:
    engine = create_engine(pg_urls.superuser)
    with engine.connect() as conn:
        schema = conn.execute(
            text(
                "SELECT n.nspname FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace "
                "WHERE e.extname = 'pg_trgm'"
            )
        ).scalar_one_or_none()
    engine.dispose()
    assert schema == "public"


def test_app_role_can_use_trigram_functions(pg_urls: PgUrls) -> None:
    engine = create_engine(pg_urls.app)
    with engine.connect() as conn:
        score = conn.execute(text("SELECT public.similarity('researcher', 'research')")).scalar_one()
        matches = conn.execute(text("SELECT 'Institute A' OPERATOR(public.%) 'Institute'")).scalar_one()
    engine.dispose()
    assert 0.5 < score <= 1.0
    assert matches is True


def test_migrator_can_index_with_public_trgm_opclass(pg_urls: PgUrls) -> None:
    engine = create_engine(pg_urls.migrator)
    with engine.begin() as conn:
        conn.execute(text("CREATE TABLE identity.trgm_probe (name text NOT NULL)"))
        conn.execute(
            text("CREATE INDEX ix_trgm_probe ON identity.trgm_probe USING gin (name public.gin_trgm_ops)")
        )
        conn.execute(text("DROP TABLE identity.trgm_probe"))
    engine.dispose()
