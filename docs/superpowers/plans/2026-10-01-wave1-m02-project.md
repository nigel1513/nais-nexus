# M02 Project Collaboration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `project` module: inter-institution research projects with members, project roles, derived partner organizations, visibility, archive, the five `project.*` events and the `ProjectQueryPort` other modules use.

**Architecture:** One plug-in package `apps/api/modules/project` (D-036) with its own Alembic migration in schema `project`, SQLAlchemy Core tables, a thin FastAPI router over a service layer that enforces the M02 role rules, and a pure `roles.py` for the authorization matrix. Every mutation locks the `project.projects` row (`SELECT ... FOR UPDATE`) before reading membership, which serializes membership changes per project and guarantees "at least one ACTIVE PROJECT_OWNER". M01 is reached only through `IdentityQueryPort` imported from `api.modules.identity.public` (resolved via `api.platform.ports`; seed-user `FakeIdentityQueryPort` only when the identity module is not installed); M02 publishes `ProjectQueryPort` (`api.modules.project.public`) through `wire()`.

**Tech Stack:** Python 3.13, FastAPI (installed 0.142, `SessionDep` needs `Depends(scope=)`), SQLAlchemy 2 Core + psycopg 3, Alembic, pydantic v2 / pydantic-settings, PostgreSQL 16 (`pg_trgm`), pytest + testcontainers.

**Spec:** `NAIS_PRD/modules/M02_project_collaboration.md` (binding). Also `NAIS_PRD/contracts/openapi.yaml` (tag `projects`), `NAIS_PRD/contracts/events/p0_events.schema.json`, `NAIS_PRD/contracts/error_codes.json`, `NAIS_PRD/10_SEED_DATA.md` §2-4, `NAIS_PRD/11_DECISION_LOG.md` (D-007, D-023, D-036, D-037).

## Global Constraints

- Execution order (W1): M00 kickoff → M01 → M02 → M03 → M05 → M09 → M10. Prerequisites from M00: pg_trgm in public, openapi 1.2.0, mypy covers apps/api/modules, .env.example keys.
- pg_trgm is provided by the platform (M00 kickoff, W1-D2: `init.sql` installs it in schema `public`); module migrations never `CREATE EXTENSION`; use `public.gin_trgm_ops`.
- Ports (W1-D1 / D-038): consume `IdentityQueryPort` + DTOs from `api.modules.identity.public`; publish `ProjectQueryPort` in `api.modules.project.public`.
- Owned path only: `apps/api/modules/project` (module_ownership.json M02). No shared-file changes in this plan.
- DB schema `project`; migrations in `apps/api/modules/project/migrations`, version table `project.alembic_version` (platform runner does this); every `op.*` call passes `schema="project"`; no FK to other schemas (`lead_organization_id`, `user_id`, `organization_id` are plain uuids).
- IDs are UUIDv7 generated in the app with `api.platform.ids.new_id()`; "now" comes from `api.platform.clock.now()`.
- Endpoints take `session: SessionDep` and `user: CurrentUserDep`; never call `session.commit()` in request code.
- Events only via `api.platform.outbox.outbox.write(session, ...)` in the same session as the change. Produced: `project.created.v1`, `project.archived.v1`, `project.member.added.v1`, `project.member.removed.v1`, `project.member.role_changed.v1`. No events consumed; no `project.processed_events` table.
- Error codes only from `error_codes.json`: `VALIDATION_FAILED`, `UNAUTHENTICATED`, `FORBIDDEN`, `NOT_FOUND`, `PROJECT_ARCHIVED`, `PROJECT_MEMBER_EXISTS`, `PROJECT_LAST_OWNER`, `PROJECT_MEMBER_NOT_FOUND`, `DEPENDENCY_UNAVAILABLE`.
- `VALIDATION_FAILED` details use the platform shape `{"fields": [{"field": "<name>", "reason": "<REASON>"}]}`.
- Project roles `PROJECT_OWNER`, `PROJECT_ADMIN`, `RESEARCHER`, `VIEWER`; visibility `PRIVATE` (default) / `PUBLIC`; status `ACTIVE` / `ARCHIVED`; organization role `LEAD` / `PARTNER`.
- Config: `PROJECT_MAX_MEMBERS` default `200` (over the limit → 422 `VALIDATION_FAILED`).
- Every API response in tests (success and error) is checked with `api.platform.testing.contracts.assert_matches_response` against openapi.yaml 1.2.0 (all M02 error statuses are declared after M00); every emitted event with `assert_valid_event`.
- Dev environment: ports 21051-21058, every login `nais`/`nais` (D-037); seed password `nais`. Never run `docker compose down` or delete volumes; rebuilding/restarting `api`/`worker` is fine.
- Every commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Before each commit: `uv run ruff check --fix apps/api/modules/project && uv run ruff format apps/api/modules/project`.

## Review Focus

1. Whitespace-only or padded project `name` (`"   "`, `"  ab  "`): expected 422 for blank, stored trimmed otherwise — never a stored blank name. Pinned in Task 5.
2. `PATCH /projects/{id}` with `{}` or an explicit `null` for a non-nullable field (`{"name": null}`): expected 422 `VALIDATION_FAILED`, never a 500 from a NOT NULL violation. Pinned in Task 7.
3. `PATCH` that sends only `end_date` earlier than the stored `start_date`: expected 422 with `fields[0].field == "end_date"`, never a 500 from the CHECK constraint. Pinned in Task 7.
4. `q` containing LIKE wildcards (`%`, `_`) must match literally; a tampered or foreign cursor must be 422, not 500; projects with identical `updated_at` must paginate without loss or duplicates. Pinned in Task 6.
5. A removed member who is added again: history row stays `REMOVED`, a new `ACTIVE` row is created, and the PARTNER organization row comes back with count 1. Pinned in Task 10.

---

## File Structure

All paths under `apps/api/modules/project/` (owned by M02):

| File | Responsibility |
|---|---|
| `__init__.py` | `MODULE = ModuleSpec(name="project", db_schema="project", router, migrations_dir, wire, seed)` |
| `seed_data.py` | Fixed seed organizations/users/project ids from 10_SEED_DATA (code, not docs) |
| `settings.py` | `ProjectSettings` (`PROJECT_MAX_MEMBERS`) + `get_project_settings()` |
| `tables.py` | SQLAlchemy Core `Table`s for `project.*` |
| `migrations/0001_project_initial.py` | Alembic revision `project_0001` |
| `roles.py` | Pure role rules (authorization matrix, last-owner predicate) |
| `identity.py` | Re-exports M01's `IdentityQueryPort`/DTOs from `api.modules.identity.public`; `get_identity_port()` resolution/fallback |
| `identity_fake.py` | `FakeIdentityQueryPort` with seed users (tests + Wave 1 runtime fallback) |
| `schemas.py` | Request bodies (`ProjectCreateIn`, `ProjectUpdateIn`, `MemberAddIn`, `MemberRoleIn`) |
| `repository.py` | All SQL (Core) for projects, members, organizations |
| `service.py` | Use cases: access checks, row lock, invariants, outbox writes |
| `views.py` | Response dict builders matching openapi `Project`, `ProjectSummary`, `ProjectMember` |
| `router.py` | FastAPI endpoints for the 9 `projects` operations |
| `public.py` | Public `ProjectQueryPort` Protocol (D-038 registry key; consumers import it from here and call `ports.get(ProjectQueryPort)`) |
| `ports.py` | Re-export of `public.py` (spec compatibility) |
| `query.py` | `SqlProjectQueryPort` implementation + `wire()` |
| `seed.py` | Idempotent `seed(session)` for project `...1001` |
| `README.md` | Module overview + integration notes (spec §13 deliverable) |
| `tests/__init__.py`, `tests/conftest.py`, `tests/helpers.py` | DB fixture (runs M02 migration), app/client, fake auth, helpers |
| `tests/test_*.py` | Unit, API, contract, concurrency, port, seed tests |

Shared file changes: **none**.

---

### Task 1: Module skeleton, tables and migration

**Files:**
- Create: `apps/api/modules/project/__init__.py`
- Create: `apps/api/modules/project/seed_data.py`
- Create: `apps/api/modules/project/settings.py`
- Create: `apps/api/modules/project/tables.py`
- Create: `apps/api/modules/project/migrations/0001_project_initial.py`
- Create: `apps/api/modules/project/tests/__init__.py` (empty)
- Create: `apps/api/modules/project/tests/conftest.py`
- Test: `apps/api/modules/project/tests/test_migration.py`

**Interfaces:**
- Produces: `MODULE: ModuleSpec`; `seed_uuid(suffix: str) -> UUID`; `SeedOrganization`, `SeedUser` dataclasses; `ORG_NAIS`, `ORG_A`, `ORG_B`, `SEED_ORGANIZATIONS`, `SEED_USERS`, `USERS_BY_KEY: dict[str, SeedUser]` (keys `admin`, `a.admin`, `a.researcher`, `a.steward`, `b.admin`, `b.researcher`, `b.steward`, `b.disabled`), `SEED_PROJECT_ID`, `SEED_PROJECT_NAME`, `SEED_OWNER_MEMBER_ID`, `SEED_PARTNER_MEMBER_ID`; `ProjectSettings(project_max_members: int = 200)`, `get_project_settings() -> ProjectSettings`; tables `projects`, `project_members`, `project_organizations` in `tables.py`; fixtures `project_db` (session) and `db` (per test, truncates) yielding `PgUrls`.

- [ ] **Step 1: Write the seed constants, settings, tables and a minimal module spec**

`apps/api/modules/project/seed_data.py`:

```python
"""Fixed seed ids and identities from 10_SEED_DATA.md §2-4.

Kept as code: seed() must not read NAIS_PRD at runtime (docs are not in the image). The users/organizations
here also back the Wave 1 FakeIdentityQueryPort (M02 §3) and the test PrincipalResolver.
"""

from dataclasses import dataclass
from uuid import UUID


def seed_uuid(suffix: str) -> UUID:
    """10_SEED_DATA id format 00000000-0000-7000-8000-00000000XXXX (XXXX = hex suffix)."""
    return UUID(f"00000000-0000-7000-8000-{int(suffix, 16):012x}")


@dataclass(frozen=True)
class SeedOrganization:
    organization_id: UUID
    code: str
    name: str
    type: str


@dataclass(frozen=True)
class SeedUser:
    key: str
    user_id: UUID
    email: str
    display_name: str
    organization_id: UUID
    org_roles: frozenset[str] = frozenset()
    platform_roles: frozenset[str] = frozenset()
    active: bool = True


ORG_NAIS = seed_uuid("0001")
ORG_A = seed_uuid("000a")
ORG_B = seed_uuid("000b")

SEED_ORGANIZATIONS: tuple[SeedOrganization, ...] = (
    SeedOrganization(ORG_NAIS, "nais", "NAIS", "PLATFORM_OPERATOR"),
    SeedOrganization(ORG_A, "inst-a", "Institute A", "RESEARCH_INSTITUTE"),
    SeedOrganization(ORG_B, "inst-b", "Institute B", "RESEARCH_INSTITUTE"),
)

SEED_USERS: tuple[SeedUser, ...] = (
    SeedUser(
        "admin",
        seed_uuid("0101"),
        "admin@nais.local",
        "NAIS Admin",
        ORG_NAIS,
        frozenset({"ORG_ADMIN"}),
        frozenset({"PLATFORM_ADMIN"}),
    ),
    SeedUser("a.admin", seed_uuid("0a01"), "a.admin@inst-a.local", "A Admin", ORG_A, frozenset({"ORG_ADMIN"})),
    SeedUser("a.researcher", seed_uuid("0a02"), "a.researcher@inst-a.local", "A Researcher", ORG_A),
    SeedUser(
        "a.steward", seed_uuid("0a03"), "a.steward@inst-a.local", "A Steward", ORG_A, frozenset({"DATA_STEWARD"})
    ),
    SeedUser("b.admin", seed_uuid("0b01"), "b.admin@inst-b.local", "B Admin", ORG_B, frozenset({"ORG_ADMIN"})),
    SeedUser("b.researcher", seed_uuid("0b02"), "b.researcher@inst-b.local", "B Researcher", ORG_B),
    SeedUser(
        "b.steward", seed_uuid("0b03"), "b.steward@inst-b.local", "B Steward", ORG_B, frozenset({"DATA_STEWARD"})
    ),
    SeedUser("b.disabled", seed_uuid("0b04"), "b.disabled@inst-b.local", "B Disabled", ORG_B, active=False),
)

USERS_BY_KEY: dict[str, SeedUser] = {user.key: user for user in SEED_USERS}

SEED_PROJECT_ID = seed_uuid("1001")
SEED_PROJECT_NAME = "Seed: Battery Materials Joint Study"
SEED_OWNER_MEMBER_ID = seed_uuid("1101")
SEED_PARTNER_MEMBER_ID = seed_uuid("1102")
```

`apps/api/modules/project/settings.py`:

```python
"""M02 §11 configuration."""

from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class ProjectSettings(BaseSettings):
    model_config = SettingsConfigDict(extra="ignore")

    project_max_members: int = Field(default=200, ge=1)  # env PROJECT_MAX_MEMBERS


@lru_cache(maxsize=1)
def get_project_settings() -> ProjectSettings:
    return ProjectSettings()
```

`apps/api/modules/project/tables.py`:

```python
"""SQLAlchemy Core view of the project schema (source of truth: migrations/)."""

from sqlalchemy import Column, Date, DateTime, ForeignKey, Integer, MetaData, String, Table, Text
from sqlalchemy.dialects.postgresql import ARRAY
from sqlalchemy.dialects.postgresql import UUID as PG_UUID

metadata = MetaData(schema="project")

projects = Table(
    "projects",
    metadata,
    Column("project_id", PG_UUID(as_uuid=True), primary_key=True),
    Column("name", String(200), nullable=False),
    Column("description", Text, nullable=False),
    Column("visibility", String(16), nullable=False),
    Column("status", String(16), nullable=False),
    Column("lead_organization_id", PG_UUID(as_uuid=True), nullable=False),
    Column("keywords", ARRAY(Text), nullable=False),
    Column("start_date", Date, nullable=True),
    Column("end_date", Date, nullable=True),
    Column("created_by", PG_UUID(as_uuid=True), nullable=False),
    Column("created_at", DateTime(timezone=True), nullable=False),
    Column("updated_at", DateTime(timezone=True), nullable=False),
    Column("archived_at", DateTime(timezone=True), nullable=True),
)

project_members = Table(
    "project_members",
    metadata,
    Column("project_member_id", PG_UUID(as_uuid=True), primary_key=True),
    Column("project_id", PG_UUID(as_uuid=True), ForeignKey("project.projects.project_id"), nullable=False),
    Column("user_id", PG_UUID(as_uuid=True), nullable=False),
    Column("organization_id", PG_UUID(as_uuid=True), nullable=False),
    Column("role", String(16), nullable=False),
    Column("status", String(16), nullable=False),
    Column("joined_at", DateTime(timezone=True), nullable=False),
    Column("added_by", PG_UUID(as_uuid=True), nullable=False),
    Column("removed_at", DateTime(timezone=True), nullable=True),
    Column("removed_by", PG_UUID(as_uuid=True), nullable=True),
    Column("removal_reason", Text, nullable=True),
)

project_organizations = Table(
    "project_organizations",
    metadata,
    Column(
        "project_id", PG_UUID(as_uuid=True), ForeignKey("project.projects.project_id"), primary_key=True
    ),
    Column("organization_id", PG_UUID(as_uuid=True), primary_key=True),
    Column("role", String(8), nullable=False),
    Column("active_member_count", Integer, nullable=False),
)
```

`apps/api/modules/project/__init__.py`:

```python
"""M02 Project Collaboration (NAIS_PRD/modules/M02_project_collaboration.md)."""

from pathlib import Path

from api.platform.modules import ModuleSpec

MODULE = ModuleSpec(
    name="project",
    db_schema="project",
    migrations_dir=Path(__file__).parent / "migrations",
)
```

- [ ] **Step 2: Write the DB fixtures and the failing migration test**

`apps/api/modules/project/tests/__init__.py`: empty file.

`apps/api/modules/project/tests/conftest.py`:

```python
from collections.abc import Iterator

import pytest
from sqlalchemy import create_engine, text

from api.modules.project import MODULE
from api.platform.migrate import upgrade_all
from api.platform.testing.fixtures import PgUrls


@pytest.fixture(scope="session")
def project_db(migrated_db: PgUrls) -> PgUrls:
    """Platform + project migrations applied once per test session."""
    upgrade_all(migrated_db.migrator, [MODULE])
    return migrated_db


@pytest.fixture
def db(project_db: PgUrls) -> Iterator[PgUrls]:
    """Empty project tables and outbox for every test."""
    engine = create_engine(project_db.migrator)
    with engine.begin() as conn:
        conn.execute(
            text("TRUNCATE project.project_members, project.project_organizations, project.projects")
        )
        conn.execute(text("DELETE FROM platform.outbox_events"))
    engine.dispose()
    yield project_db
```

`apps/api/modules/project/tests/test_migration.py`:

```python
import uuid

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.exc import IntegrityError

from api.modules.project.seed_data import ORG_A, USERS_BY_KEY
from api.platform.db import session_scope
from api.platform.testing.fixtures import PgUrls

OWNER = USERS_BY_KEY["a.researcher"].user_id


def _insert_project(urls: PgUrls, **extra: object) -> uuid.UUID:
    project_id = uuid.uuid4()
    columns = ", ".join(["project_id", "name", "lead_organization_id", "created_by", *extra])
    values = ", ".join([":project_id", ":name", ":org", ":user", *(f":{key}" for key in extra)])
    with session_scope(urls.app) as session:
        session.execute(
            text(f"INSERT INTO project.projects ({columns}) VALUES ({values})"),
            {"project_id": project_id, "name": "Study", "org": ORG_A, "user": OWNER, **extra},
        )
    return project_id


def _insert_member(urls: PgUrls, project_id: uuid.UUID, status: str) -> None:
    with session_scope(urls.app) as session:
        session.execute(
            text(
                "INSERT INTO project.project_members "
                "(project_member_id, project_id, user_id, organization_id, role, status, added_by) "
                "VALUES (:id, :project_id, :user, :org, 'VIEWER', :status, :user)"
            ),
            {"id": uuid.uuid4(), "project_id": project_id, "user": OWNER, "org": ORG_A, "status": status},
        )


def test_tables_and_indexes_exist(project_db: PgUrls) -> None:
    engine = create_engine(project_db.migrator)
    with engine.connect() as conn:
        tables = set(
            conn.execute(
                text("SELECT table_name FROM information_schema.tables WHERE table_schema = 'project'")
            ).scalars()
        )
        indexes = set(
            conn.execute(text("SELECT indexname FROM pg_indexes WHERE schemaname = 'project'")).scalars()
        )
    engine.dispose()
    assert {"projects", "project_members", "project_organizations", "alembic_version"} <= tables
    assert {
        "ix_projects_visibility_status",
        "ix_projects_name_trgm",
        "ux_project_members_active",
        "ix_project_members_user",
    } <= indexes


def test_column_defaults(db: PgUrls) -> None:
    project_id = _insert_project(db)
    with session_scope(db.app) as session:
        row = (
            session.execute(
                text("SELECT description, visibility, status, keywords FROM project.projects WHERE project_id = :id"),
                {"id": project_id},
            )
            .mappings()
            .one()
        )
    assert dict(row) == {"description": "", "visibility": "PRIVATE", "status": "ACTIVE", "keywords": []}


def test_end_date_before_start_date_is_rejected(db: PgUrls) -> None:
    with pytest.raises(IntegrityError):
        _insert_project(db, start_date="2026-10-02", end_date="2026-10-01")


def test_one_active_membership_per_user(db: PgUrls) -> None:
    project_id = _insert_project(db)
    _insert_member(db, project_id, "REMOVED")
    _insert_member(db, project_id, "ACTIVE")  # a REMOVED history row does not block a new ACTIVE row
    with pytest.raises(IntegrityError):
        _insert_member(db, project_id, "ACTIVE")
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `uv run pytest apps/api/modules/project/tests/test_migration.py -v`
Expected: FAIL — alembic finds no revisions for `project` so `project.projects` does not exist (`UndefinedTable` / missing tables in the set assertion).

- [ ] **Step 4: Write the migration**

`apps/api/modules/project/migrations/0001_project_initial.py`:

```python
"""project schema: projects, members, participating organizations

Revision ID: project_0001
Revises:
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import ARRAY, UUID

revision = "project_0001"
down_revision = None
branch_labels = None
depends_on = None

SCHEMA = "project"
NOW = sa.text("now()")


def upgrade() -> None:
    op.create_table(
        "projects",
        sa.Column("project_id", UUID(as_uuid=True), primary_key=True),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("description", sa.Text, nullable=False, server_default=""),
        sa.Column("visibility", sa.String(16), nullable=False, server_default="PRIVATE"),
        sa.Column("status", sa.String(16), nullable=False, server_default="ACTIVE"),
        sa.Column("lead_organization_id", UUID(as_uuid=True), nullable=False),
        sa.Column("keywords", ARRAY(sa.Text), nullable=False, server_default=sa.text("'{}'::text[]")),
        sa.Column("start_date", sa.Date, nullable=True),
        sa.Column("end_date", sa.Date, nullable=True),
        sa.Column("created_by", UUID(as_uuid=True), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=NOW),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=NOW),
        sa.Column("archived_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint("char_length(name) >= 2", name="ck_projects_name_length"),
        sa.CheckConstraint("char_length(description) <= 10000", name="ck_projects_description_length"),
        sa.CheckConstraint("visibility IN ('PRIVATE', 'PUBLIC')", name="ck_projects_visibility"),
        sa.CheckConstraint("status IN ('ACTIVE', 'ARCHIVED')", name="ck_projects_status"),
        sa.CheckConstraint("cardinality(keywords) <= 20", name="ck_projects_keywords_count"),
        sa.CheckConstraint(
            "end_date IS NULL OR start_date IS NULL OR end_date >= start_date", name="ck_projects_dates"
        ),
        schema=SCHEMA,
    )
    op.create_index("ix_projects_visibility_status", "projects", ["visibility", "status"], schema=SCHEMA)
    # pg_trgm lives in schema public, installed once by the platform (M00 kickoff, W1-D2); never CREATE EXTENSION here.
    op.execute(f"CREATE INDEX ix_projects_name_trgm ON {SCHEMA}.projects USING gin (name public.gin_trgm_ops)")

    op.create_table(
        "project_members",
        sa.Column("project_member_id", UUID(as_uuid=True), primary_key=True),
        sa.Column("project_id", UUID(as_uuid=True), nullable=False),
        sa.Column("user_id", UUID(as_uuid=True), nullable=False),
        sa.Column("organization_id", UUID(as_uuid=True), nullable=False),
        sa.Column("role", sa.String(16), nullable=False),
        sa.Column("status", sa.String(16), nullable=False, server_default="ACTIVE"),
        sa.Column("joined_at", sa.DateTime(timezone=True), nullable=False, server_default=NOW),
        sa.Column("added_by", UUID(as_uuid=True), nullable=False),
        sa.Column("removed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("removed_by", UUID(as_uuid=True), nullable=True),
        sa.Column("removal_reason", sa.Text, nullable=True),
        sa.ForeignKeyConstraint(
            ["project_id"], [f"{SCHEMA}.projects.project_id"], name="fk_project_members_project"
        ),
        sa.CheckConstraint(
            "role IN ('PROJECT_OWNER', 'PROJECT_ADMIN', 'RESEARCHER', 'VIEWER')", name="ck_project_members_role"
        ),
        sa.CheckConstraint("status IN ('ACTIVE', 'REMOVED')", name="ck_project_members_status"),
        schema=SCHEMA,
    )
    op.create_index(
        "ux_project_members_active",
        "project_members",
        ["project_id", "user_id"],
        unique=True,
        schema=SCHEMA,
        postgresql_where=sa.text("status = 'ACTIVE'"),
    )
    op.create_index("ix_project_members_user", "project_members", ["user_id", "status"], schema=SCHEMA)

    op.create_table(
        "project_organizations",
        sa.Column("project_id", UUID(as_uuid=True), primary_key=True),
        sa.Column("organization_id", UUID(as_uuid=True), primary_key=True),
        sa.Column("role", sa.String(8), nullable=False),
        sa.Column("active_member_count", sa.Integer, nullable=False, server_default="0"),
        sa.ForeignKeyConstraint(
            ["project_id"], [f"{SCHEMA}.projects.project_id"], name="fk_project_organizations_project"
        ),
        sa.CheckConstraint("role IN ('LEAD', 'PARTNER')", name="ck_project_organizations_role"),
        sa.CheckConstraint("active_member_count >= 0", name="ck_project_organizations_count"),
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_table("project_organizations", schema=SCHEMA)
    op.drop_table("project_members", schema=SCHEMA)
    op.drop_table("projects", schema=SCHEMA)
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `uv run pytest apps/api/modules/project/tests/test_migration.py -v`
Expected: 4 passed.

Also confirm the offline dry run renders: `PYTHONPATH=apps:packages/contracts/python uv run python -c "from api.platform.migrate import upgrade_all; from api.modules.project import MODULE; upgrade_all('postgresql+psycopg://x:y@localhost/nais', [MODULE], sql=True)" | grep -c "CREATE TABLE project"`
Expected: `3`.

- [ ] **Step 6: Commit**

```bash
uv run ruff check --fix apps/api/modules/project && uv run ruff format apps/api/modules/project
git add apps/api/modules/project
git commit -m "feat(project): module skeleton, project schema migration and seed ids

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Pure project-role rules

**Files:**
- Create: `apps/api/modules/project/roles.py`
- Test: `apps/api/modules/project/tests/test_roles.py`

**Interfaces:**
- Produces: constants `OWNER="PROJECT_OWNER"`, `ADMIN="PROJECT_ADMIN"`, `RESEARCHER="RESEARCHER"`, `VIEWER="VIEWER"`, `PROJECT_ROLES`; `can_edit_project(actor_role: str | None) -> bool`; `can_change_visibility(actor_role: str | None) -> bool`; `can_archive(actor_role: str | None) -> bool`; `can_manage_member(actor_role: str | None, *roles_involved: str) -> bool`; `drops_an_owner(current_role: str, new_role: str | None) -> bool`.

- [ ] **Step 1: Write the failing test**

`apps/api/modules/project/tests/test_roles.py`:

```python
import pytest

from api.modules.project import roles

O, A, R, V = roles.OWNER, roles.ADMIN, roles.RESEARCHER, roles.VIEWER


@pytest.mark.parametrize(
    ("actor", "edit", "visibility", "archive"),
    [(O, True, True, True), (A, True, False, False), (R, False, False, False), (V, False, False, False), (None, False, False, False)],
)
def test_project_level_matrix(actor: str | None, edit: bool, visibility: bool, archive: bool) -> None:
    assert roles.can_edit_project(actor) is edit
    assert roles.can_change_visibility(actor) is visibility
    assert roles.can_archive(actor) is archive


@pytest.mark.parametrize(
    ("actor", "involved", "allowed"),
    [
        (O, (O,), True),
        (O, (R, A), True),
        (O, (O, V), True),
        (A, (R,), True),
        (A, (V, R), True),
        (A, (R, A), False),  # granting ADMIN is OWNER-only
        (A, (A, R), False),  # revoking ADMIN (including the actor's own) is OWNER-only
        (A, (A,), False),  # removing an ADMIN is OWNER-only
        (A, (R, O), False),
        (A, (O,), False),
        (R, (V,), False),
        (V, (V,), False),
        (None, (V,), False),
    ],
)
def test_member_management_matrix(actor: str | None, involved: tuple[str, ...], allowed: bool) -> None:
    assert roles.can_manage_member(actor, *involved) is allowed


@pytest.mark.parametrize(
    ("current", "new", "drops"),
    [(O, A, True), (O, None, True), (O, O, False), (A, None, False), (R, O, False)],
)
def test_drops_an_owner(current: str, new: str | None, drops: bool) -> None:
    assert roles.drops_an_owner(current, new) is drops


def test_role_order_matches_contract() -> None:
    assert roles.PROJECT_ROLES == ("PROJECT_OWNER", "PROJECT_ADMIN", "RESEARCHER", "VIEWER")
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest apps/api/modules/project/tests/test_roles.py -v`
Expected: FAIL with `ImportError: cannot import name 'roles'`.

- [ ] **Step 3: Write the implementation**

`apps/api/modules/project/roles.py`:

```python
"""Project role rules (M02 §5 "Role 변경 규칙", §9 authorization matrix). Pure functions, no I/O."""

from typing import Final

OWNER: Final = "PROJECT_OWNER"
ADMIN: Final = "PROJECT_ADMIN"
RESEARCHER: Final = "RESEARCHER"
VIEWER: Final = "VIEWER"
PROJECT_ROLES: Final = (OWNER, ADMIN, RESEARCHER, VIEWER)

_ADMIN_MANAGEABLE: Final = frozenset({RESEARCHER, VIEWER})


def can_edit_project(actor_role: str | None) -> bool:
    return actor_role in (OWNER, ADMIN)


def can_change_visibility(actor_role: str | None) -> bool:
    return actor_role == OWNER


def can_archive(actor_role: str | None) -> bool:
    return actor_role == OWNER


def can_manage_member(actor_role: str | None, *roles_involved: str) -> bool:
    """May the actor add (new role), change (current + new role) or remove (current role) a member?

    OWNER manages every role. PROJECT_ADMIN only touches RESEARCHER/VIEWER on both sides of the change; granting,
    revoking or removing an ADMIN or OWNER is OWNER-only. Self-leave is handled by the caller, not here.
    """
    if actor_role == OWNER:
        return True
    if actor_role == ADMIN:
        return all(role in _ADMIN_MANAGEABLE for role in roles_involved)
    return False


def drops_an_owner(current_role: str, new_role: str | None) -> bool:
    """True when the change leaves one ACTIVE owner fewer (demotion or removal; new_role None = removal)."""
    return current_role == OWNER and new_role != OWNER
```

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run pytest apps/api/modules/project/tests/test_roles.py -v`
Expected: all passed.

- [ ] **Step 5: Commit**

```bash
uv run ruff check --fix apps/api/modules/project && uv run ruff format apps/api/modules/project
git add apps/api/modules/project/roles.py apps/api/modules/project/tests/test_roles.py
git commit -m "feat(project): pure project role rules

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: IdentityQueryPort consumer side, fake and runtime resolution

**Files:**
- Create: `apps/api/modules/project/identity.py`
- Create: `apps/api/modules/project/identity_fake.py`
- Test: `apps/api/modules/project/tests/test_identity_port.py`

**Interfaces:**
- Consumes: `SEED_USERS`, `SEED_ORGANIZATIONS`, `SeedUser`, `SeedOrganization` (Task 1); from M01 (built before M02; W1-D1 / D-038) `api.modules.identity.public`: `IdentityQueryPort` (Protocol: `get_public_profile(user_id: UUID) -> IdentityPublicProfile | None`, `get_public_profiles(user_ids: list[UUID]) -> dict[UUID, IdentityPublicProfile]`, `get_organization_summary(organization_id: UUID) -> OrganizationSummary | None`, `is_active_user(user_id: UUID) -> bool`, `has_org_role(user_id: UUID, organization_id: UUID, role: str) -> bool`, `list_users_with_org_role(organization_id: UUID, role: str) -> list[UUID]`, `get_email(user_id: UUID) -> str | None`), `IdentityPublicProfile` (frozen pydantic: `user_id: UUID`, `display_name: str`, `organization_id: UUID`, `organization_name: str | None`, `status: Literal["ACTIVE", "DISABLED"]`), `OrganizationSummary` (frozen pydantic: `organization_id: UUID`, `code: str`, `name: str`, `type: Literal["RESEARCH_INSTITUTE", "UNIVERSITY", "COMPANY", "PLATFORM_OPERATOR"]`).
- Produces: `api.modules.project.identity` re-exports `IdentityQueryPort`, `IdentityPublicProfile`, `OrganizationSummary` (the SAME class objects as `api.modules.identity.public`, so `ports.provide(IdentityQueryPort, ...)` anywhere uses M01's registry key); `identity_module_installed() -> bool`; `get_identity_port() -> IdentityQueryPort` (FastAPI-dependency-compatible); constant `IDENTITY_PACKAGE = "api.modules.identity"`; `FakeIdentityQueryPort(users, organizations)` implementing all 7 Protocol methods, with `.with_seed_users()` and `.disable(user_id)`.

Resolution order of `get_identity_port()` (W1-D1 / D-038: the registry key is M01's `public.IdentityQueryPort`):
1. `ports.get(IdentityQueryPort)` — M01's `wire_ports` registers `SqlIdentityQuery`; tests register `FakeIdentityQueryPort` under the same key.
2. Not registered while the identity module is installed (`api.modules.identity` defines `MODULE = ModuleSpec(...)`) → 503 `DEPENDENCY_UNAVAILABLE` (fail closed; never silently use fake data next to a real M01).
3. Identity module not installed (`identity_module_installed()` is false, e.g. a stripped deployment) → the seed-user `FakeIdentityQueryPort` (M02 §3), with one warning log.

- [ ] **Step 1: Write the failing test**

`apps/api/modules/project/tests/test_identity_port.py`:

```python
import uuid

import pytest

from api.modules.identity import public as identity_public
from api.modules.project import identity as identity_mod
from api.modules.project.identity import IdentityQueryPort, get_identity_port
from api.modules.project.identity_fake import FakeIdentityQueryPort
from api.modules.project.seed_data import ORG_A, ORG_B, USERS_BY_KEY
from api.platform import ports
from api.platform.errors import ApiError
from api.platform.generated.error_codes import ErrorCode

B_RESEARCHER = USERS_BY_KEY["b.researcher"].user_id
B_DISABLED = USERS_BY_KEY["b.disabled"].user_id


@pytest.fixture(autouse=True)
def _clean_ports() -> None:
    ports.reset()


def test_registry_key_is_m01_public_protocol() -> None:
    assert IdentityQueryPort is identity_public.IdentityQueryPort


def test_fake_serves_seed_users() -> None:
    fake = FakeIdentityQueryPort.with_seed_users()
    profile = fake.get_public_profile(B_RESEARCHER)
    assert isinstance(profile, identity_public.IdentityPublicProfile)
    assert profile.display_name == "B Researcher"
    assert profile.organization_id == ORG_B
    assert profile.organization_name == "Institute B"
    assert fake.is_active_user(B_RESEARCHER)
    assert not fake.is_active_user(B_DISABLED)
    unknown = uuid.uuid4()
    assert fake.get_public_profile(unknown) is None
    assert not fake.is_active_user(unknown)
    assert set(fake.get_public_profiles([B_RESEARCHER, unknown])) == {B_RESEARCHER}
    summary = fake.get_organization_summary(ORG_B)
    assert isinstance(summary, identity_public.OrganizationSummary)
    assert summary.code == "inst-b" and summary.name == "Institute B"
    assert fake.get_organization_summary(uuid.uuid4()) is None


def test_fake_org_roles_and_email() -> None:
    fake = FakeIdentityQueryPort.with_seed_users()
    a_admin = USERS_BY_KEY["a.admin"]
    assert fake.has_org_role(a_admin.user_id, ORG_A, "ORG_ADMIN")
    assert not fake.has_org_role(a_admin.user_id, ORG_B, "ORG_ADMIN")
    assert fake.list_users_with_org_role(ORG_B, "DATA_STEWARD") == [USERS_BY_KEY["b.steward"].user_id]
    assert fake.get_email(B_RESEARCHER) == USERS_BY_KEY["b.researcher"].email
    assert fake.get_email(uuid.uuid4()) is None


def test_fake_disable_marks_user_inactive() -> None:
    fake = FakeIdentityQueryPort.with_seed_users()
    fake.disable(B_RESEARCHER)
    assert not fake.is_active_user(B_RESEARCHER)
    profile = fake.get_public_profile(B_RESEARCHER)
    assert profile is not None and profile.status == "DISABLED"


def test_registered_port_wins() -> None:
    fake = FakeIdentityQueryPort.with_seed_users()
    ports.provide(IdentityQueryPort, fake)
    assert get_identity_port() is fake


def test_seed_fake_when_identity_module_is_not_installed(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(identity_mod, "identity_module_installed", lambda: False)
    port = get_identity_port()
    assert isinstance(port, FakeIdentityQueryPort)
    assert port.is_active_user(B_RESEARCHER)


def test_installed_but_unwired_identity_fails_closed() -> None:
    assert identity_mod.identity_module_installed()  # M01 is built before M02
    with pytest.raises(ApiError) as exc:
        get_identity_port()
    assert exc.value.code == ErrorCode.DEPENDENCY_UNAVAILABLE
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest apps/api/modules/project/tests/test_identity_port.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'api.modules.project.identity'`.

- [ ] **Step 3: Write the implementation**

`apps/api/modules/project/identity_fake.py`:

```python
"""FakeIdentityQueryPort backed by the 10_SEED_DATA users (M02 §3, mock-first Wave 1)."""

from collections.abc import Iterable
from uuid import UUID

from api.modules.identity.public import IdentityPublicProfile, OrganizationSummary
from api.modules.project.seed_data import SEED_ORGANIZATIONS, SEED_USERS, SeedOrganization, SeedUser


class FakeIdentityQueryPort:
    """Implements every method of api.modules.identity.public.IdentityQueryPort."""

    def __init__(self, users: Iterable[SeedUser], organizations: Iterable[SeedOrganization]) -> None:
        self._users = {user.user_id: user for user in users}
        self._organizations = {org.organization_id: org for org in organizations}
        self._disabled = {user.user_id for user in self._users.values() if not user.active}

    @classmethod
    def with_seed_users(cls) -> "FakeIdentityQueryPort":
        return cls(SEED_USERS, SEED_ORGANIZATIONS)

    def disable(self, user_id: UUID) -> None:
        self._disabled.add(user_id)

    def get_public_profile(self, user_id: UUID) -> IdentityPublicProfile | None:
        user = self._users.get(user_id)
        if user is None:
            return None
        organization = self._organizations.get(user.organization_id)
        return IdentityPublicProfile(
            user_id=user.user_id,
            display_name=user.display_name,
            organization_id=user.organization_id,
            organization_name=organization.name if organization else None,
            status="DISABLED" if user_id in self._disabled else "ACTIVE",
        )

    def get_public_profiles(self, user_ids: list[UUID]) -> dict[UUID, IdentityPublicProfile]:
        profiles: dict[UUID, IdentityPublicProfile] = {}
        for user_id in user_ids:
            profile = self.get_public_profile(user_id)
            if profile is not None:
                profiles[user_id] = profile
        return profiles

    def get_organization_summary(self, organization_id: UUID) -> OrganizationSummary | None:
        organization = self._organizations.get(organization_id)
        if organization is None:
            return None
        return OrganizationSummary.model_validate(
            {
                "organization_id": organization.organization_id,
                "code": organization.code,
                "name": organization.name,
                "type": organization.type,
            }
        )

    def is_active_user(self, user_id: UUID) -> bool:
        return user_id in self._users and user_id not in self._disabled

    def has_org_role(self, user_id: UUID, organization_id: UUID, role: str) -> bool:
        user = self._users.get(user_id)
        return (
            user is not None
            and user_id not in self._disabled
            and user.organization_id == organization_id
            and role in user.org_roles
        )

    def list_users_with_org_role(self, organization_id: UUID, role: str) -> list[UUID]:
        return [
            user.user_id for user in self._users.values() if self.has_org_role(user.user_id, organization_id, role)
        ]

    def get_email(self, user_id: UUID) -> str | None:
        user = self._users.get(user_id)
        return user.email if user else None
```

`apps/api/modules/project/identity.py`:

```python
"""IdentityQueryPort (M01 §8, api.modules.identity.public) as M02 consumes it, and runtime resolution."""

import logging
from functools import lru_cache

from api.modules import identity as identity_package
from api.modules.identity.public import IdentityPublicProfile, IdentityQueryPort, OrganizationSummary
from api.modules.project.identity_fake import FakeIdentityQueryPort
from api.platform import ports
from api.platform.errors import ApiError
from api.platform.generated.error_codes import ErrorCode
from api.platform.modules import ModuleSpec

logger = logging.getLogger("nais.project")

IDENTITY_PACKAGE = "api.modules.identity"

__all__ = [
    "IDENTITY_PACKAGE",
    "IdentityPublicProfile",
    "IdentityQueryPort",
    "OrganizationSummary",
    "get_identity_port",
    "identity_module_installed",
]


def identity_module_installed() -> bool:
    """True when api.modules.identity is a real module package (defines MODULE = ModuleSpec)."""
    return isinstance(getattr(identity_package, "MODULE", None), ModuleSpec)


@lru_cache(maxsize=1)
def _seed_fallback() -> IdentityQueryPort:
    logger.warning("identity module not installed; project uses the seed-user FakeIdentityQueryPort (Wave 1)")
    return FakeIdentityQueryPort.with_seed_users()


def get_identity_port() -> IdentityQueryPort:
    """Resolve the identity read port. Also used as a FastAPI dependency."""
    try:
        return ports.get(IdentityQueryPort)
    except ports.PortNotProvided:
        pass
    if not identity_module_installed():
        return _seed_fallback()
    raise ApiError(ErrorCode.DEPENDENCY_UNAVAILABLE, "Identity directory is not available.")
```

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run pytest apps/api/modules/project/tests/test_identity_port.py -v`
Expected: 7 passed.

- [ ] **Step 5: Commit**

```bash
uv run ruff check --fix apps/api/modules/project && uv run ruff format apps/api/modules/project
git add apps/api/modules/project/identity.py apps/api/modules/project/identity_fake.py apps/api/modules/project/tests/test_identity_port.py
git commit -m "feat(project): consume IdentityQueryPort with seed fake and fail-closed resolution

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Request schemas and repository

**Files:**
- Create: `apps/api/modules/project/schemas.py`
- Create: `apps/api/modules/project/repository.py`
- Test: `apps/api/modules/project/tests/test_repository.py`

**Interfaces:**
- Consumes: tables (Task 1), `new_id()`.
- Produces (schemas): `RoleName = Literal[...4 roles]`, `Visibility = Literal["PRIVATE","PUBLIC"]`, `ProjectCreateIn(name, description, visibility="PRIVATE", keywords=[], start_date=None, end_date=None)`, `ProjectUpdateIn` (all optional, non-nullable `name/description/visibility/keywords`, at least one field), `MemberAddIn(user_id: UUID, role: RoleName)`, `MemberRoleIn(role: RoleName)`; all `extra="forbid"`.
- Produces (repository, all take `session: Session` first):
  `insert_project(session, *, project_id, name, description, visibility, lead_organization_id, keywords, start_date, end_date, created_by, now) -> None`;
  `get_project(session, project_id, *, lock=False) -> RowMapping | None`;
  `update_project(session, project_id, values: dict[str, Any], *, now) -> None`;
  `archive_project(session, project_id, *, now) -> None`;
  `touch_project(session, project_id, *, now) -> None`;
  `list_projects(session, *, user_id, scope, status, q, after: tuple[datetime, UUID] | None, limit) -> Sequence[RowMapping]`;
  `member_role(session, project_id, user_id) -> str | None`;
  `active_member(session, project_id, user_id) -> RowMapping | None`;
  `insert_member(session, *, project_id, user_id, organization_id, role, added_by, now, project_member_id=None) -> RowMapping`;
  `set_member_role(session, project_member_id, role) -> RowMapping`;
  `remove_member(session, project_member_id, *, removed_by, now) -> None`;
  `count_active_members(session, project_id) -> int`; `count_active_owners(session, project_id) -> int`;
  `list_active_members(session, project_id) -> Sequence[RowMapping]`;
  `member_counts(session, project_ids) -> dict[UUID, int]`; `roles_for_user(session, project_ids, user_id) -> dict[UUID, str]`;
  `add_org_member(session, project_id, organization_id, *, lead=False) -> None`; `drop_org_member(session, project_id, organization_id) -> None`;
  `list_organizations(session, project_id) -> Sequence[RowMapping]`;
  `is_active_member(session, project_id, user_id) -> bool`; `project_ids_for_member(session, user_id) -> list[UUID]`.

- [ ] **Step 1: Write the failing tests**

`apps/api/modules/project/tests/test_repository.py`:

```python
import uuid
from datetime import UTC, date, datetime, timedelta

import pytest
from pydantic import ValidationError
from sqlalchemy.orm import Session

from api.modules.project import repository as repo
from api.modules.project.schemas import MemberAddIn, ProjectCreateIn, ProjectUpdateIn
from api.modules.project.seed_data import ORG_A, ORG_B, USERS_BY_KEY
from api.platform.db import session_scope
from api.platform.testing.fixtures import PgUrls

A = USERS_BY_KEY["a.researcher"]
B = USERS_BY_KEY["b.researcher"]
B2 = USERS_BY_KEY["b.steward"]
T0 = datetime(2026, 10, 1, tzinfo=UTC)


def _project(session: Session, *, name: str = "Study", visibility: str = "PRIVATE", now: datetime = T0) -> uuid.UUID:
    project_id = uuid.uuid4()
    repo.insert_project(
        session,
        project_id=project_id,
        name=name,
        description="",
        visibility=visibility,
        lead_organization_id=ORG_A,
        keywords=[],
        start_date=None,
        end_date=None,
        created_by=A.user_id,
        now=now,
    )
    repo.insert_member(
        session,
        project_id=project_id,
        user_id=A.user_id,
        organization_id=ORG_A,
        role="PROJECT_OWNER",
        added_by=A.user_id,
        now=now,
    )
    repo.add_org_member(session, project_id, ORG_A, lead=True)
    return project_id


def test_create_schema_trims_and_defaults() -> None:
    body = ProjectCreateIn.model_validate({"name": "  ab  ", "description": ""})
    assert body.name == "ab"
    assert body.visibility == "PRIVATE"
    assert body.keywords == []
    with pytest.raises(ValidationError):
        ProjectCreateIn.model_validate({"name": "   ", "description": ""})
    with pytest.raises(ValidationError):
        ProjectCreateIn.model_validate({"name": "ok name", "description": "", "extra": 1})
    with pytest.raises(ValidationError):
        ProjectCreateIn.model_validate({"name": "ok name", "description": "", "keywords": ["k"] * 21})
    with pytest.raises(ValidationError):
        ProjectCreateIn.model_validate({"name": "ok name", "description": "", "keywords": ["x" * 51]})


def test_update_schema_rejects_empty_and_nulls_but_allows_null_dates() -> None:
    with pytest.raises(ValidationError):
        ProjectUpdateIn.model_validate({})
    for field in ("name", "description", "visibility", "keywords"):
        with pytest.raises(ValidationError):
            ProjectUpdateIn.model_validate({field: None})
    patch = ProjectUpdateIn.model_validate({"start_date": None})
    assert patch.model_dump(exclude_unset=True) == {"start_date": None}


def test_member_schema_rejects_unknown_role() -> None:
    with pytest.raises(ValidationError):
        MemberAddIn.model_validate({"user_id": str(uuid.uuid4()), "role": "OWNER"})


def test_organization_counts_follow_members(db: PgUrls) -> None:
    with session_scope(db.app) as session:
        project_id = _project(session)
        repo.add_org_member(session, project_id, ORG_B)
        repo.add_org_member(session, project_id, ORG_B)
        repo.add_org_member(session, project_id, ORG_A)
        counts = {r["organization_id"]: (r["role"], r["active_member_count"]) for r in repo.list_organizations(session, project_id)}
        assert counts == {ORG_A: ("LEAD", 2), ORG_B: ("PARTNER", 2)}
        repo.drop_org_member(session, project_id, ORG_B)
        repo.drop_org_member(session, project_id, ORG_B)
        repo.drop_org_member(session, project_id, ORG_A)
        repo.drop_org_member(session, project_id, ORG_A)
        rows = repo.list_organizations(session, project_id)
        assert [(r["organization_id"], r["role"], r["active_member_count"]) for r in rows] == [(ORG_A, "LEAD", 0)]


def test_membership_queries(db: PgUrls) -> None:
    with session_scope(db.app) as session:
        project_id = _project(session)
        member = repo.insert_member(
            session, project_id=project_id, user_id=B.user_id, organization_id=ORG_B, role="RESEARCHER", added_by=A.user_id, now=T0
        )
        assert repo.member_role(session, project_id, B.user_id) == "RESEARCHER"
        assert repo.count_active_members(session, project_id) == 2
        assert repo.count_active_owners(session, project_id) == 1
        assert repo.set_member_role(session, member["project_member_id"], "VIEWER")["role"] == "VIEWER"
        assert repo.is_active_member(session, project_id, B.user_id)
        assert repo.project_ids_for_member(session, B.user_id) == [project_id]
        repo.remove_member(session, member["project_member_id"], removed_by=A.user_id, now=T0)
        assert repo.member_role(session, project_id, B.user_id) is None
        assert repo.active_member(session, project_id, B.user_id) is None
        assert [m["user_id"] for m in repo.list_active_members(session, project_id)] == [A.user_id]
        assert repo.member_counts(session, [project_id]) == {project_id: 1}
        assert repo.roles_for_user(session, [project_id], A.user_id) == {project_id: "PROJECT_OWNER"}
        repo.archive_project(session, project_id, now=T0)
        assert not repo.is_active_member(session, project_id, A.user_id)
        assert repo.member_role(session, project_id, A.user_id) == "PROJECT_OWNER"


def test_list_projects_scopes_filters_and_keyset(db: PgUrls) -> None:
    with session_scope(db.app) as session:
        older = _project(session, name="Older Study", visibility="PUBLIC", now=T0)
        newer = _project(session, name="Newer Study", now=T0 + timedelta(minutes=1))
        repo.update_project(session, newer, {"start_date": date(2026, 1, 1)}, now=T0 + timedelta(minutes=2))
        mine = repo.list_projects(session, user_id=A.user_id, scope="mine", status=None, q=None, after=None, limit=10)
        assert [r["project_id"] for r in mine] == [newer, older]
        discover = repo.list_projects(session, user_id=B.user_id, scope="discover", status=None, q=None, after=None, limit=10)
        assert [r["project_id"] for r in discover] == [older]
        assert repo.list_projects(session, user_id=B.user_id, scope="mine", status=None, q=None, after=None, limit=10) == []
        by_name = repo.list_projects(session, user_id=A.user_id, scope="mine", status=None, q="older", after=None, limit=10)
        assert [r["project_id"] for r in by_name] == [older]
        first = mine[0]
        after = repo.list_projects(
            session, user_id=A.user_id, scope="mine", status=None, q=None, after=(first["updated_at"], first["project_id"]), limit=10
        )
        assert [r["project_id"] for r in after] == [older]
        assert repo.list_projects(session, user_id=B2.user_id, scope="mine", status=None, q=None, after=None, limit=10) == []
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest apps/api/modules/project/tests/test_repository.py -v`
Expected: FAIL with `ImportError: cannot import name 'repository'`.

- [ ] **Step 3: Write the schemas**

`apps/api/modules/project/schemas.py`:

```python
"""Request bodies (openapi ProjectCreate, ProjectUpdate, member add/role bodies). Responses are built in views.py."""

from datetime import date
from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, field_validator, model_validator

RoleName = Literal["PROJECT_OWNER", "PROJECT_ADMIN", "RESEARCHER", "VIEWER"]
Visibility = Literal["PRIVATE", "PUBLIC"]
ProjectName = Annotated[str, StringConstraints(strip_whitespace=True, min_length=2, max_length=200)]
Description = Annotated[str, StringConstraints(max_length=10000)]
Keyword = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=50)]
Keywords = Annotated[list[Keyword], Field(max_length=20)]

_NOT_NULLABLE = ("name", "description", "visibility", "keywords")


class ProjectCreateIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: ProjectName
    description: Description
    visibility: Visibility = "PRIVATE"
    keywords: Keywords = Field(default_factory=list)
    start_date: date | None = None
    end_date: date | None = None


class ProjectUpdateIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: ProjectName | None = None
    description: Description | None = None
    visibility: Visibility | None = None
    keywords: Keywords | None = None
    start_date: date | None = None  # explicit null clears the date
    end_date: date | None = None

    @field_validator(*_NOT_NULLABLE, mode="before")
    @classmethod
    def _not_null(cls, value: object) -> object:
        if value is None:
            raise ValueError("must not be null")
        return value

    @model_validator(mode="after")
    def _at_least_one_field(self) -> "ProjectUpdateIn":
        if not self.model_fields_set:
            raise ValueError("at least one field is required")
        return self


class MemberAddIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    user_id: UUID
    role: RoleName


class MemberRoleIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    role: RoleName
```

- [ ] **Step 4: Write the repository**

`apps/api/modules/project/repository.py`:

```python
"""All SQL for the project schema (SQLAlchemy Core). No authorization here: see service.py."""

from collections.abc import Sequence
from datetime import date, datetime
from typing import Any
from uuid import UUID

from sqlalchemy import RowMapping, and_, delete, func, insert, or_, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.orm import Session

from api.modules.project.tables import project_members as m
from api.modules.project.tables import project_organizations as o
from api.modules.project.tables import projects as p
from api.platform.ids import new_id

ACTIVE = "ACTIVE"
REMOVED = "REMOVED"
ARCHIVED = "ARCHIVED"
OWNER = "PROJECT_OWNER"


def insert_project(
    session: Session,
    *,
    project_id: UUID,
    name: str,
    description: str,
    visibility: str,
    lead_organization_id: UUID,
    keywords: list[str],
    start_date: date | None,
    end_date: date | None,
    created_by: UUID,
    now: datetime,
) -> None:
    session.execute(
        insert(p).values(
            project_id=project_id,
            name=name,
            description=description,
            visibility=visibility,
            status=ACTIVE,
            lead_organization_id=lead_organization_id,
            keywords=keywords,
            start_date=start_date,
            end_date=end_date,
            created_by=created_by,
            created_at=now,
            updated_at=now,
        )
    )


def get_project(session: Session, project_id: UUID, *, lock: bool = False) -> RowMapping | None:
    stmt = select(p).where(p.c.project_id == project_id)
    if lock:
        stmt = stmt.with_for_update()
    return session.execute(stmt).mappings().first()


def update_project(session: Session, project_id: UUID, values: dict[str, Any], *, now: datetime) -> None:
    session.execute(update(p).where(p.c.project_id == project_id).values(**values, updated_at=now))


def archive_project(session: Session, project_id: UUID, *, now: datetime) -> None:
    session.execute(
        update(p).where(p.c.project_id == project_id).values(status=ARCHIVED, archived_at=now, updated_at=now)
    )


def touch_project(session: Session, project_id: UUID, *, now: datetime) -> None:
    session.execute(update(p).where(p.c.project_id == project_id).values(updated_at=now))


def _escape_like(value: str) -> str:
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def list_projects(
    session: Session,
    *,
    user_id: UUID,
    scope: str,
    status: str | None,
    q: str | None,
    after: tuple[datetime, UUID] | None,
    limit: int,
) -> Sequence[RowMapping]:
    """scope=mine: caller's ACTIVE memberships (any project status). scope=discover: PUBLIC + ACTIVE projects.
    Ordered updated_at desc, project_id desc; returns up to limit + 1 rows for has_more."""
    stmt = select(p)
    if scope == "mine":
        stmt = stmt.join(m, and_(m.c.project_id == p.c.project_id, m.c.user_id == user_id, m.c.status == ACTIVE))
    else:
        stmt = stmt.where(p.c.visibility == "PUBLIC", p.c.status == ACTIVE)
    if status is not None:
        stmt = stmt.where(p.c.status == status)
    if q:
        stmt = stmt.where(p.c.name.ilike(f"%{_escape_like(q)}%", escape="\\"))
    if after is not None:
        updated_at, project_id = after
        stmt = stmt.where(
            or_(p.c.updated_at < updated_at, and_(p.c.updated_at == updated_at, p.c.project_id < project_id))
        )
    stmt = stmt.order_by(p.c.updated_at.desc(), p.c.project_id.desc()).limit(limit + 1)
    return session.execute(stmt).mappings().all()


def member_role(session: Session, project_id: UUID, user_id: UUID) -> str | None:
    return session.execute(
        select(m.c.role).where(m.c.project_id == project_id, m.c.user_id == user_id, m.c.status == ACTIVE)
    ).scalar_one_or_none()


def active_member(session: Session, project_id: UUID, user_id: UUID) -> RowMapping | None:
    return (
        session.execute(
            select(m).where(m.c.project_id == project_id, m.c.user_id == user_id, m.c.status == ACTIVE)
        )
        .mappings()
        .first()
    )


def insert_member(
    session: Session,
    *,
    project_id: UUID,
    user_id: UUID,
    organization_id: UUID,
    role: str,
    added_by: UUID,
    now: datetime,
    project_member_id: UUID | None = None,
) -> RowMapping:
    return (
        session.execute(
            insert(m)
            .values(
                project_member_id=project_member_id or new_id(),
                project_id=project_id,
                user_id=user_id,
                organization_id=organization_id,
                role=role,
                status=ACTIVE,
                joined_at=now,
                added_by=added_by,
            )
            .returning(m)
        )
        .mappings()
        .one()
    )


def set_member_role(session: Session, project_member_id: UUID, role: str) -> RowMapping:
    return (
        session.execute(
            update(m).where(m.c.project_member_id == project_member_id).values(role=role).returning(m)
        )
        .mappings()
        .one()
    )


def remove_member(session: Session, project_member_id: UUID, *, removed_by: UUID, now: datetime) -> None:
    session.execute(
        update(m)
        .where(m.c.project_member_id == project_member_id)
        .values(status=REMOVED, removed_at=now, removed_by=removed_by)
    )


def count_active_members(session: Session, project_id: UUID) -> int:
    return int(
        session.execute(
            select(func.count()).select_from(m).where(m.c.project_id == project_id, m.c.status == ACTIVE)
        ).scalar_one()
    )


def count_active_owners(session: Session, project_id: UUID) -> int:
    return int(
        session.execute(
            select(func.count())
            .select_from(m)
            .where(m.c.project_id == project_id, m.c.status == ACTIVE, m.c.role == OWNER)
        ).scalar_one()
    )


def list_active_members(session: Session, project_id: UUID) -> Sequence[RowMapping]:
    return (
        session.execute(
            select(m)
            .where(m.c.project_id == project_id, m.c.status == ACTIVE)
            .order_by(m.c.joined_at, m.c.project_member_id)
        )
        .mappings()
        .all()
    )


def member_counts(session: Session, project_ids: Sequence[UUID]) -> dict[UUID, int]:
    if not project_ids:
        return {}
    rows = session.execute(
        select(m.c.project_id, func.count())
        .where(m.c.project_id.in_(project_ids), m.c.status == ACTIVE)
        .group_by(m.c.project_id)
    ).all()
    return {project_id: int(count) for project_id, count in rows}


def roles_for_user(session: Session, project_ids: Sequence[UUID], user_id: UUID) -> dict[UUID, str]:
    if not project_ids:
        return {}
    rows = session.execute(
        select(m.c.project_id, m.c.role).where(
            m.c.project_id.in_(project_ids), m.c.user_id == user_id, m.c.status == ACTIVE
        )
    ).all()
    return {project_id: role for project_id, role in rows}


def add_org_member(session: Session, project_id: UUID, organization_id: UUID, *, lead: bool = False) -> None:
    """One more ACTIVE member from this organization; creates the LEAD/PARTNER row on first use."""
    stmt = pg_insert(o).values(
        project_id=project_id,
        organization_id=organization_id,
        role="LEAD" if lead else "PARTNER",
        active_member_count=1,
    )
    session.execute(
        stmt.on_conflict_do_update(
            index_elements=[o.c.project_id, o.c.organization_id],
            set_={"active_member_count": o.c.active_member_count + 1},
        )
    )


def drop_org_member(session: Session, project_id: UUID, organization_id: UUID) -> None:
    """One ACTIVE member fewer; a PARTNER row at 0 is deleted, the LEAD row always stays (M02 §4)."""
    key = and_(o.c.project_id == project_id, o.c.organization_id == organization_id)
    session.execute(update(o).where(key).values(active_member_count=o.c.active_member_count - 1))
    session.execute(delete(o).where(key, o.c.role == "PARTNER", o.c.active_member_count == 0))


def list_organizations(session: Session, project_id: UUID) -> Sequence[RowMapping]:
    return (
        session.execute(select(o).where(o.c.project_id == project_id).order_by(o.c.role, o.c.organization_id))
        .mappings()
        .all()
    )


def is_active_member(session: Session, project_id: UUID, user_id: UUID) -> bool:
    """ACTIVE membership in an ACTIVE project (ARCHIVED projects answer False, M02 §8)."""
    stmt = (
        select(m.c.project_member_id)
        .join(p, p.c.project_id == m.c.project_id)
        .where(m.c.project_id == project_id, m.c.user_id == user_id, m.c.status == ACTIVE, p.c.status == ACTIVE)
    )
    return session.execute(stmt).first() is not None


def project_ids_for_member(session: Session, user_id: UUID) -> list[UUID]:
    rows = session.execute(
        select(m.c.project_id).where(m.c.user_id == user_id, m.c.status == ACTIVE).order_by(m.c.joined_at)
    ).scalars()
    return list(rows)
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `uv run pytest apps/api/modules/project/tests/test_repository.py -v`
Expected: 6 passed.

- [ ] **Step 6: Commit**

```bash
uv run ruff check --fix apps/api/modules/project && uv run ruff format apps/api/modules/project
git add apps/api/modules/project/schemas.py apps/api/modules/project/repository.py apps/api/modules/project/tests/test_repository.py
git commit -m "feat(project): request schemas and project repository

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: createProject and getProject (AT-01, AT-04, AT-05 detail)

**Files:**
- Create: `apps/api/modules/project/service.py`
- Create: `apps/api/modules/project/views.py`
- Create: `apps/api/modules/project/router.py`
- Create: `apps/api/modules/project/tests/helpers.py`
- Modify: `apps/api/modules/project/__init__.py` (add `router`)
- Modify: `apps/api/modules/project/tests/conftest.py` (full replacement below)
- Test: `apps/api/modules/project/tests/test_projects_create_get.py`

**Interfaces:**
- Consumes: repository (Task 4), `ProjectCreateIn` (Task 4), `roles` (Task 2), `IdentityQueryPort`, `IdentityPublicProfile`, `get_identity_port` (Task 3).
- Produces (service): `ProjectAccess(project: RowMapping, my_role: str | None)` (frozen dataclass); `create_project(session, user: CurrentUser, data: ProjectCreateIn) -> UUID`; `read_project(session, user, project_id) -> ProjectAccess`; private `_validation_error(field, reason, message=...) -> ApiError`, `_check_dates(start, end) -> None`, `_access(session, user, project_id, *, lock) -> ProjectAccess`, `_mutable(session, user, project_id, *, allow_archived=False) -> ProjectAccess`.
- Produces (views): `summary_view(project: RowMapping, *, my_role: str | None, member_count: int) -> dict[str, Any]`; `detail_view(session, identity, access: ProjectAccess) -> dict[str, Any]`; `member_view(member, profile, org_names) -> dict[str, Any]`; `members_view(identity, members: Sequence[RowMapping]) -> list[dict[str, Any]]`.
- Produces (router): `router: APIRouter`; `IdentityDep = Annotated[IdentityQueryPort, Depends(get_identity_port)]`.
- Produces (test helpers): `ISSUER: FakeIssuer`; `current_user_for(key: str) -> CurrentUser`; `SeedPrincipalResolver`; `ProjectApi(client)` with `.request/.get/.post/.patch/.delete(user_key | None, path, **kw)` and `.create_project(user="a.researcher", **fields) -> dict`; `uid(key) -> str`; `sql(urls, statement, **params) -> list[dict]`; `project_events(urls) -> list[dict]` (validated); `assert_error(response, status, code, operation_id: str)` (always contract-checks); `seed_member(urls, project_id: str, key: str, role: str) -> None`. Fixtures `identity` (FakeIdentityQueryPort registered under M01's `IdentityQueryPort` key), `app`, `api`.

Access rules implemented here (M02 §6, §9): unknown project → 404 `NOT_FOUND`; non-member, non-PLATFORM_ADMIN → 404 on PRIVATE, 403 `FORBIDDEN` on PUBLIC; PLATFORM_ADMIN reads with `my_role = null`. Mutations (`_mutable`) lock the projects row first, then do the same visibility check, then 403 for a PLATFORM_ADMIN non-member, then 409 `PROJECT_ARCHIVED` unless `allow_archived`.

- [ ] **Step 1: Write the test harness**

`apps/api/modules/project/tests/helpers.py`:

```python
"""Test helpers for the project module: fake auth mapped to seed users, API wrapper, DB/outbox readers."""

from typing import Any
from uuid import UUID

import httpx
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, text

from api.modules.project import repository as repo
from api.modules.project.seed_data import USERS_BY_KEY
from api.platform import clock
from api.platform.auth import CurrentUser
from api.platform.db import session_scope
from api.platform.testing.contracts import assert_matches_response, assert_valid_event
from api.platform.testing.fixtures import PgUrls
from api.platform.testing.tokens import FakeIssuer

ISSUER = FakeIssuer()


def current_user_for(key: str, session_id: str = "session-1") -> CurrentUser:
    user = USERS_BY_KEY[key]
    return CurrentUser(
        user_id=user.user_id,
        organization_id=user.organization_id,
        org_roles=user.org_roles,
        platform_roles=user.platform_roles,
        session_id=session_id,
        display_name=user.display_name,
    )


class SeedPrincipalResolver:
    """Stands in for M01's PrincipalResolver: the token `sub` is a seed user key such as "a.researcher"."""

    def resolve(self, claims: dict[str, Any], correlation_id: UUID) -> CurrentUser:
        return current_user_for(claims["sub"], claims["sid"])


def uid(key: str) -> str:
    return str(USERS_BY_KEY[key].user_id)


class ProjectApi:
    def __init__(self, client: TestClient) -> None:
        self.client = client

    def request(self, method: str, user: str | None, path: str, **kwargs: Any) -> httpx.Response:
        headers = {"Authorization": f"Bearer {ISSUER.token(sub=user)}"} if user else {}
        return self.client.request(method, f"/api/v1{path}", headers=headers, **kwargs)

    def get(self, user: str | None, path: str, **kwargs: Any) -> httpx.Response:
        return self.request("GET", user, path, **kwargs)

    def post(self, user: str | None, path: str, **kwargs: Any) -> httpx.Response:
        return self.request("POST", user, path, **kwargs)

    def patch(self, user: str | None, path: str, **kwargs: Any) -> httpx.Response:
        return self.request("PATCH", user, path, **kwargs)

    def delete(self, user: str | None, path: str, **kwargs: Any) -> httpx.Response:
        return self.request("DELETE", user, path, **kwargs)

    def create_project(self, user: str = "a.researcher", **fields: Any) -> dict[str, Any]:
        body = {"name": "Joint Battery Study", "description": "Cross-institute work."} | fields
        response = self.post(user, "/projects", json=body)
        assert response.status_code == 201, response.text
        result: dict[str, Any] = response.json()
        return result


def sql(urls: PgUrls, statement: str, **params: Any) -> list[dict[str, Any]]:
    """Run SQL as the schema owner (bypasses the API) and return rows as dicts."""
    engine = create_engine(urls.migrator)
    try:
        with engine.begin() as conn:
            result = conn.execute(text(statement), params)
            return [dict(row) for row in result.mappings()] if result.returns_rows else []
    finally:
        engine.dispose()


def project_events(urls: PgUrls) -> list[dict[str, Any]]:
    rows = sql(
        urls,
        "SELECT envelope FROM platform.outbox_events WHERE envelope->>'producer' = 'project' ORDER BY id",
    )
    envelopes = [row["envelope"] for row in rows]
    for envelope in envelopes:
        assert_valid_event(envelope)
    return envelopes


def assert_error(response: httpx.Response, status: int, code: str, operation_id: str) -> None:
    """Every error status the module returns is declared in openapi.yaml 1.2.0 (M00 kickoff, W1-D3)."""
    assert response.status_code == status, response.text
    body = response.json()
    assert body["error"]["code"] == code, body
    assert_matches_response(operation_id, status, body)


def seed_member(urls: PgUrls, project_id: str, key: str, role: str) -> None:
    """Insert an ACTIVE member directly (no API rules, no event) to set up a scenario."""
    user = USERS_BY_KEY[key]
    with session_scope(urls.app) as session:
        repo.insert_member(
            session,
            project_id=UUID(project_id),
            user_id=user.user_id,
            organization_id=user.organization_id,
            role=role,
            added_by=user.user_id,
            now=clock.now(),
        )
        repo.add_org_member(session, UUID(project_id), user.organization_id)
```

Replace `apps/api/modules/project/tests/conftest.py` with:

```python
from collections.abc import Iterator

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, text

from api.modules.project import MODULE
from api.modules.project.identity import IdentityQueryPort
from api.modules.project.identity_fake import FakeIdentityQueryPort
from api.modules.project.tests.helpers import ISSUER, ProjectApi, SeedPrincipalResolver
from api.platform import ports
from api.platform.auth import PrincipalResolver, TokenVerifier, get_token_verifier
from api.platform.migrate import upgrade_all
from api.platform.settings import Settings
from api.platform.testing.app import create_test_app
from api.platform.testing.fixtures import PgUrls


@pytest.fixture(scope="session")
def project_db(migrated_db: PgUrls) -> PgUrls:
    """Platform + project migrations applied once per test session."""
    upgrade_all(migrated_db.migrator, [MODULE])
    return migrated_db


@pytest.fixture
def db(project_db: PgUrls) -> Iterator[PgUrls]:
    """Empty project tables and outbox for every test."""
    engine = create_engine(project_db.migrator)
    with engine.begin() as conn:
        conn.execute(
            text("TRUNCATE project.project_members, project.project_organizations, project.projects")
        )
        conn.execute(text("DELETE FROM platform.outbox_events"))
    engine.dispose()
    yield project_db


@pytest.fixture
def identity() -> FakeIdentityQueryPort:
    fake = FakeIdentityQueryPort.with_seed_users()
    ports.provide(IdentityQueryPort, fake)
    return fake


@pytest.fixture
def app(db: PgUrls, identity: FakeIdentityQueryPort) -> FastAPI:
    application = create_test_app(modules=[MODULE], settings=Settings(database_url=db.app))
    application.dependency_overrides[get_token_verifier] = lambda: TokenVerifier(
        issuer=ISSUER.issuer, audience=ISSUER.audience, jwk_client=ISSUER.jwk_client()
    )
    ports.provide(PrincipalResolver, SeedPrincipalResolver())
    return application


@pytest.fixture
def api(app: FastAPI) -> ProjectApi:
    return ProjectApi(TestClient(app, raise_server_exceptions=False))
```

- [ ] **Step 2: Write the failing API tests**

`apps/api/modules/project/tests/test_projects_create_get.py`:

```python
from api.modules.project.seed_data import ORG_A
from api.modules.project.tests.helpers import ProjectApi, assert_error, project_events, sql, uid
from api.platform.testing.contracts import assert_matches_response
from api.platform.testing.fixtures import PgUrls


def test_at01_creator_becomes_owner_and_lead(api: ProjectApi, db: PgUrls) -> None:
    response = api.post("a.researcher", "/projects", json={"name": "Battery Study", "description": "Joint work"})
    assert response.status_code == 201, response.text
    body = response.json()
    assert_matches_response("createProject", 201, body)
    assert body["lead_organization_id"] == str(ORG_A)
    assert body["my_role"] == "PROJECT_OWNER"
    assert body["visibility"] == "PRIVATE"
    assert body["status"] == "ACTIVE"
    assert body["member_count"] == 1
    assert body["created_by"] == uid("a.researcher")
    assert body["archived_at"] is None
    assert body["organizations"] == [{"organization_id": str(ORG_A), "name": "Institute A", "role": "LEAD"}]

    members = sql(db, "SELECT user_id::text, role, status FROM project.project_members")
    assert members == [{"user_id": uid("a.researcher"), "role": "PROJECT_OWNER", "status": "ACTIVE"}]

    events = project_events(db)
    assert [e["event_type"] for e in events] == ["project.created.v1"]  # no member.added for the creator
    assert events[0]["payload"] == {
        "project_id": body["project_id"],
        "name": "Battery Study",
        "lead_organization_id": str(ORG_A),
        "visibility": "PRIVATE",
        "owner_user_id": uid("a.researcher"),
    }
    assert events[0]["actor"] == {"type": "USER", "user_id": uid("a.researcher"), "organization_id": str(ORG_A)}


def test_create_with_optional_fields(api: ProjectApi) -> None:
    body = api.create_project(
        visibility="PUBLIC", keywords=["battery", " anode "], start_date="2026-10-01", end_date="2027-03-31"
    )
    assert body["visibility"] == "PUBLIC"
    assert body["keywords"] == ["battery", "anode"]
    assert body["start_date"] == "2026-10-01"
    assert body["end_date"] == "2027-03-31"


def test_create_rejects_end_before_start(api: ProjectApi, db: PgUrls) -> None:
    response = api.post(
        "a.researcher",
        "/projects",
        json={"name": "Study", "description": "", "start_date": "2026-10-02", "end_date": "2026-10-01"},
    )
    assert_error(response, 422, "VALIDATION_FAILED", "createProject")
    assert response.json()["error"]["details"]["fields"][0]["field"] == "end_date"
    assert sql(db, "SELECT count(*) AS n FROM project.projects") == [{"n": 0}]


def test_create_blank_name_is_rejected_and_padding_trimmed(api: ProjectApi) -> None:
    blank = api.post("a.researcher", "/projects", json={"name": "   ", "description": ""})
    assert_error(blank, 422, "VALIDATION_FAILED", "createProject")
    assert api.create_project(name="  ab  ")["name"] == "ab"


def test_create_rejects_unknown_fields(api: ProjectApi) -> None:
    response = api.post("a.researcher", "/projects", json={"name": "Study", "description": "", "owner": "x"})
    assert_error(response, 422, "VALIDATION_FAILED", "createProject")


def test_create_requires_a_token(api: ProjectApi) -> None:
    assert_error(api.post(None, "/projects", json={"name": "Study", "description": ""}), 401, "UNAUTHENTICATED", "createProject")


def test_member_reads_project(api: ProjectApi) -> None:
    project = api.create_project()
    response = api.get("a.researcher", f"/projects/{project['project_id']}")
    assert response.status_code == 200
    assert_matches_response("getProject", 200, response.json())
    assert response.json()["my_role"] == "PROJECT_OWNER"


def test_at04_private_project_is_404_for_non_member(api: ProjectApi) -> None:
    project = api.create_project()
    response = api.get("b.steward", f"/projects/{project['project_id']}")
    assert_error(response, 404, "NOT_FOUND", "getProject")


def test_at05_public_project_detail_is_403_for_non_member(api: ProjectApi) -> None:
    project = api.create_project(visibility="PUBLIC")
    response = api.get("b.steward", f"/projects/{project['project_id']}")
    assert_error(response, 403, "FORBIDDEN", "getProject")


def test_platform_admin_reads_private_project_without_role(api: ProjectApi) -> None:
    project = api.create_project()
    response = api.get("admin", f"/projects/{project['project_id']}")
    assert response.status_code == 200
    assert response.json()["my_role"] is None


def test_unknown_project_is_404(api: ProjectApi) -> None:
    response = api.get("a.researcher", "/projects/00000000-0000-7000-8000-00000000ffff")
    assert_error(response, 404, "NOT_FOUND", "getProject")
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `uv run pytest apps/api/modules/project/tests/test_projects_create_get.py -v`
Expected: FAIL — every request returns 404 (no router mounted) / `ImportError` for `service`.

- [ ] **Step 4: Write service, views, router**

`apps/api/modules/project/service.py`:

```python
"""Project use cases (M02 §5-§7).

Every mutation first locks the projects row (SELECT ... FOR UPDATE) and only then reads memberships, so changes
to one project are serialized and "count(ACTIVE PROJECT_OWNER) >= 1" holds under concurrent requests (AT-14).
"""

from dataclasses import dataclass
from datetime import date
from uuid import UUID

from sqlalchemy import RowMapping
from sqlalchemy.orm import Session

from api.modules.project import repository as repo
from api.modules.project import roles
from api.modules.project.schemas import ProjectCreateIn
from api.platform import clock
from api.platform.auth import CurrentUser
from api.platform.errors import ApiError
from api.platform.events import EventActor
from api.platform.generated.error_codes import ErrorCode
from api.platform.ids import new_id
from api.platform.outbox import outbox

ARCHIVED = "ARCHIVED"
PUBLIC = "PUBLIC"


@dataclass(frozen=True)
class ProjectAccess:
    project: RowMapping
    my_role: str | None


def _validation_error(field: str, reason: str, message: str = "Request validation failed.") -> ApiError:
    return ApiError(ErrorCode.VALIDATION_FAILED, message, {"fields": [{"field": field, "reason": reason}]})


def _check_dates(start: date | None, end: date | None) -> None:
    if start is not None and end is not None and end < start:
        raise _validation_error("end_date", "END_BEFORE_START", "end_date must not be before start_date.")


def _access(session: Session, user: CurrentUser, project_id: UUID, *, lock: bool) -> ProjectAccess:
    project = repo.get_project(session, project_id, lock=lock)
    if project is None:
        raise ApiError(ErrorCode.NOT_FOUND)
    my_role = repo.member_role(session, project_id, user.user_id)
    if my_role is None and not user.is_platform_admin:
        if project["visibility"] == PUBLIC:
            raise ApiError(ErrorCode.FORBIDDEN)
        raise ApiError(ErrorCode.NOT_FOUND)
    return ProjectAccess(project, my_role)


def _mutable(
    session: Session, user: CurrentUser, project_id: UUID, *, allow_archived: bool = False
) -> ProjectAccess:
    access = _access(session, user, project_id, lock=True)
    if access.my_role is None:  # PLATFORM_ADMIN without membership: read-only
        raise ApiError(ErrorCode.FORBIDDEN)
    if not allow_archived and access.project["status"] == ARCHIVED:
        raise ApiError(ErrorCode.PROJECT_ARCHIVED)
    return access


def read_project(session: Session, user: CurrentUser, project_id: UUID) -> ProjectAccess:
    return _access(session, user, project_id, lock=False)


def create_project(session: Session, user: CurrentUser, data: ProjectCreateIn) -> UUID:
    _check_dates(data.start_date, data.end_date)
    now = clock.now()
    project_id = new_id()
    repo.insert_project(
        session,
        project_id=project_id,
        name=data.name,
        description=data.description,
        visibility=data.visibility,
        lead_organization_id=user.organization_id,
        keywords=list(data.keywords),
        start_date=data.start_date,
        end_date=data.end_date,
        created_by=user.user_id,
        now=now,
    )
    repo.insert_member(
        session,
        project_id=project_id,
        user_id=user.user_id,
        organization_id=user.organization_id,
        role=roles.OWNER,
        added_by=user.user_id,
        now=now,
    )
    repo.add_org_member(session, project_id, user.organization_id, lead=True)
    outbox.write(
        session,
        "project.created.v1",
        {
            "project_id": str(project_id),
            "name": data.name,
            "lead_organization_id": str(user.organization_id),
            "visibility": data.visibility,
            "owner_user_id": str(user.user_id),
        },
        EventActor.for_user(user),
    )
    return project_id
```

`apps/api/modules/project/views.py`:

```python
"""Response shapes for openapi Project / ProjectSummary / ProjectMember. Optional names are omitted, not null."""

from collections.abc import Iterable, Sequence
from typing import Any
from uuid import UUID

from sqlalchemy import RowMapping
from sqlalchemy.orm import Session

from api.modules.project import repository as repo
from api.modules.project.identity import IdentityPublicProfile, IdentityQueryPort
from api.modules.project.service import ProjectAccess


def summary_view(project: RowMapping, *, my_role: str | None, member_count: int) -> dict[str, Any]:
    return {
        "project_id": project["project_id"],
        "name": project["name"],
        "status": project["status"],
        "visibility": project["visibility"],
        "lead_organization_id": project["lead_organization_id"],
        "my_role": my_role,
        "member_count": member_count,
        "updated_at": project["updated_at"],
    }


def detail_view(session: Session, identity: IdentityQueryPort, access: ProjectAccess) -> dict[str, Any]:
    project = access.project
    project_id = project["project_id"]
    organizations: list[dict[str, Any]] = []
    for row in repo.list_organizations(session, project_id):
        item: dict[str, Any] = {"organization_id": row["organization_id"], "role": row["role"]}
        summary = identity.get_organization_summary(row["organization_id"])
        if summary is not None:
            item["name"] = summary.name
        organizations.append(item)
    return {
        **summary_view(project, my_role=access.my_role, member_count=repo.count_active_members(session, project_id)),
        "description": project["description"],
        "keywords": list(project["keywords"]),
        "start_date": project["start_date"],
        "end_date": project["end_date"],
        "organizations": organizations,
        "created_by": project["created_by"],
        "created_at": project["created_at"],
        "archived_at": project["archived_at"],
    }


def _organization_names(
    identity: IdentityQueryPort, organization_ids: set[UUID], profiles: Iterable[IdentityPublicProfile]
) -> dict[UUID, str]:
    names = {p.organization_id: p.organization_name for p in profiles if p.organization_name}
    for organization_id in organization_ids - names.keys():
        summary = identity.get_organization_summary(organization_id)
        if summary is not None:
            names[organization_id] = summary.name
    return names


def member_view(
    member: RowMapping, profile: IdentityPublicProfile | None, org_names: dict[UUID, str]
) -> dict[str, Any]:
    item: dict[str, Any] = {
        "project_id": member["project_id"],
        "user_id": member["user_id"],
        "organization_id": member["organization_id"],
        "role": member["role"],
        "joined_at": member["joined_at"],
        "added_by": member["added_by"],
    }
    if profile is not None:
        item["display_name"] = profile.display_name
    organization_name = org_names.get(member["organization_id"])
    if organization_name:
        item["organization_name"] = organization_name
    return item


def members_view(identity: IdentityQueryPort, members: Sequence[RowMapping]) -> list[dict[str, Any]]:
    if not members:
        return []
    profiles = identity.get_public_profiles([member["user_id"] for member in members])
    org_names = _organization_names(identity, {member["organization_id"] for member in members}, profiles.values())
    return [member_view(member, profiles.get(member["user_id"]), org_names) for member in members]
```

`apps/api/modules/project/router.py`:

```python
"""M02 HTTP surface (openapi tag `projects`). Handlers stay thin: service enforces rules, views shape bodies."""

from typing import Annotated, Any
from uuid import UUID

from fastapi import APIRouter, Depends

from api.modules.project import service, views
from api.modules.project.identity import IdentityQueryPort, get_identity_port
from api.modules.project.schemas import ProjectCreateIn
from api.platform.auth import CurrentUserDep
from api.platform.db import SessionDep

router = APIRouter(tags=["projects"])

IdentityDep = Annotated[IdentityQueryPort, Depends(get_identity_port)]


@router.post("/projects", status_code=201, operation_id="createProject")
def create_project(
    body: ProjectCreateIn, user: CurrentUserDep, session: SessionDep, identity: IdentityDep
) -> dict[str, Any]:
    project_id = service.create_project(session, user, body)
    return views.detail_view(session, identity, service.read_project(session, user, project_id))


@router.get("/projects/{project_id}", operation_id="getProject")
def get_project(
    project_id: UUID, user: CurrentUserDep, session: SessionDep, identity: IdentityDep
) -> dict[str, Any]:
    return views.detail_view(session, identity, service.read_project(session, user, project_id))
```

Replace `apps/api/modules/project/__init__.py` with:

```python
"""M02 Project Collaboration (NAIS_PRD/modules/M02_project_collaboration.md)."""

from pathlib import Path

from api.modules.project.router import router
from api.platform.modules import ModuleSpec

MODULE = ModuleSpec(
    name="project",
    db_schema="project",
    router=router,
    migrations_dir=Path(__file__).parent / "migrations",
)
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `uv run pytest apps/api/modules/project/tests -v`
Expected: all passed (Tasks 1-5).

- [ ] **Step 6: Commit**

```bash
uv run ruff check --fix apps/api/modules/project && uv run ruff format apps/api/modules/project
git add apps/api/modules/project
git commit -m "feat(project): createProject and getProject with visibility rules

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: listProjects (mine / discover, status, q, cursor)

**Files:**
- Modify: `apps/api/modules/project/service.py` (add `decode_after`)
- Modify: `apps/api/modules/project/router.py` (add `list_projects`)
- Test: `apps/api/modules/project/tests/test_projects_list.py`

**Interfaces:**
- Consumes: `repo.list_projects`, `repo.member_counts`, `repo.roles_for_user`, `views.summary_view`, platform `page_params`/`PageParams`/`build_page`.
- Produces: `service.decode_after(cursor: list[Any] | None) -> tuple[datetime, UUID] | None` (422 `VALIDATION_FAILED`, field `cursor`, reason `INVALID_CURSOR` on a malformed decoded cursor); endpoint `GET /projects` (`listProjects`), cursor = `[updated_at ISO-8601, project_id]`.

- [ ] **Step 1: Write the failing tests**

`apps/api/modules/project/tests/test_projects_list.py`:

```python
from datetime import UTC, datetime

from api.modules.project.tests.helpers import ProjectApi, assert_error, sql
from api.platform import clock
from api.platform.pagination import encode_cursor
from api.platform.testing.contracts import assert_matches_response
from api.platform.testing.fixtures import PgUrls


def _names(response_json: dict) -> list[str]:  # type: ignore[type-arg]
    return [item["name"] for item in response_json["items"]]


def test_mine_lists_my_projects_newest_first(api: ProjectApi) -> None:
    api.create_project(name="First Study")
    api.create_project(name="Second Study")
    api.create_project(user="b.researcher", name="Other Institute Study")
    response = api.get("a.researcher", "/projects")
    assert response.status_code == 200
    body = response.json()
    assert_matches_response("listProjects", 200, body)
    assert _names(body) == ["Second Study", "First Study"]
    assert {item["my_role"] for item in body["items"]} == {"PROJECT_OWNER"}
    assert {item["member_count"] for item in body["items"]} == {1}
    assert body["page"] == {"next_cursor": None, "has_more": False}


def test_mine_includes_archived_and_filters_by_status(api: ProjectApi, db: PgUrls) -> None:
    archived = api.create_project(name="Archived Study")
    api.create_project(name="Active Study")
    sql(db, "UPDATE project.projects SET status = 'ARCHIVED' WHERE project_id = :id", id=archived["project_id"])
    assert set(_names(api.get("a.researcher", "/projects").json())) == {"Archived Study", "Active Study"}
    assert _names(api.get("a.researcher", "/projects", params={"status": "ARCHIVED"}).json()) == ["Archived Study"]
    assert _names(api.get("a.researcher", "/projects", params={"status": "ACTIVE"}).json()) == ["Active Study"]


def test_at05_discover_lists_public_active_projects_only(api: ProjectApi, db: PgUrls) -> None:
    api.create_project(name="Open Study", visibility="PUBLIC")
    api.create_project(name="Closed Study")
    old = api.create_project(name="Old Public Study", visibility="PUBLIC")
    sql(db, "UPDATE project.projects SET status = 'ARCHIVED' WHERE project_id = :id", id=old["project_id"])

    stranger = api.get("b.steward", "/projects", params={"scope": "discover"})
    assert stranger.status_code == 200
    assert_matches_response("listProjects", 200, stranger.json())
    assert _names(stranger.json()) == ["Open Study"]
    assert stranger.json()["items"][0]["my_role"] is None
    assert stranger.json()["items"][0]["member_count"] == 1

    owner = api.get("a.researcher", "/projects", params={"scope": "discover"}).json()
    assert [(i["name"], i["my_role"]) for i in owner["items"]] == [("Open Study", "PROJECT_OWNER")]
    assert api.get("b.steward", "/projects").json()["items"] == []


def test_q_is_case_insensitive_and_wildcards_are_literal(api: ProjectApi) -> None:
    api.create_project(name="100% Solar")
    api.create_project(name="1000 Solar Cells")
    assert _names(api.get("a.researcher", "/projects", params={"q": "solar"}).json()) == ["1000 Solar Cells", "100% Solar"]
    assert _names(api.get("a.researcher", "/projects", params={"q": "100%"}).json()) == ["100% Solar"]
    assert _names(api.get("a.researcher", "/projects", params={"q": "0_S"}).json()) == []
    assert len(api.get("a.researcher", "/projects", params={"q": "   "}).json()["items"]) == 2


def test_cursor_pages_through_identical_timestamps(api: ProjectApi) -> None:
    with clock.frozen(datetime(2026, 10, 1, 9, 0, tzinfo=UTC)):
        for index in range(3):
            api.create_project(name=f"Tied Study {index}")
    first = api.get("a.researcher", "/projects", params={"limit": 2}).json()
    assert len(first["items"]) == 2 and first["page"]["has_more"] is True
    second = api.get("a.researcher", "/projects", params={"limit": 2, "cursor": first["page"]["next_cursor"]}).json()
    assert len(second["items"]) == 1 and second["page"] == {"next_cursor": None, "has_more": False}
    seen = [i["project_id"] for i in first["items"] + second["items"]]
    assert len(set(seen)) == 3


def test_tampered_cursor_is_422(api: ProjectApi) -> None:
    api.create_project()
    garbage = api.get("a.researcher", "/projects", params={"cursor": "not-a-cursor!!"})
    assert_error(garbage, 422, "VALIDATION_FAILED", "listProjects")
    foreign = api.get("a.researcher", "/projects", params={"cursor": encode_cursor(["x"])})
    assert_error(foreign, 422, "VALIDATION_FAILED", "listProjects")
    assert foreign.json()["error"]["details"]["fields"][0] == {"field": "cursor", "reason": "INVALID_CURSOR"}
    naive = api.get("a.researcher", "/projects", params={"cursor": encode_cursor(["2026-10-01T00:00:00", "00000000-0000-7000-8000-000000000001"])})
    assert_error(naive, 422, "VALIDATION_FAILED", "listProjects")


def test_invalid_scope_is_422_and_token_required(api: ProjectApi) -> None:
    assert_error(api.get("a.researcher", "/projects", params={"scope": "all"}), 422, "VALIDATION_FAILED", "listProjects")
    assert_error(api.get(None, "/projects"), 401, "UNAUTHENTICATED", "listProjects")
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest apps/api/modules/project/tests/test_projects_list.py -v`
Expected: FAIL — `GET /api/v1/projects` returns 404/405 (`NOT_FOUND`).

- [ ] **Step 3: Implement**

In `apps/api/modules/project/service.py`, change the imports `from datetime import date` → `from datetime import date, datetime`, add `from typing import Any`, and append:

```python
def decode_after(cursor: list[Any] | None) -> tuple[datetime, UUID] | None:
    """Decoded listProjects cursor -> (updated_at, project_id) keyset position."""
    if cursor is None:
        return None
    try:
        updated_at_raw, project_id_raw = cursor
        updated_at = datetime.fromisoformat(updated_at_raw)
        if updated_at.tzinfo is None:
            raise ValueError("cursor timestamp must carry a UTC offset")
        return updated_at, UUID(project_id_raw)
    except (TypeError, ValueError, AttributeError) as exc:
        raise _validation_error("cursor", "INVALID_CURSOR", "Invalid pagination cursor.") from exc
```

In `apps/api/modules/project/router.py`, change imports to:

```python
from typing import Annotated, Any, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, Query

from api.modules.project import repository as repo
from api.modules.project import service, views
from api.modules.project.identity import IdentityQueryPort, get_identity_port
from api.modules.project.schemas import ProjectCreateIn
from api.platform.auth import CurrentUserDep
from api.platform.db import SessionDep
from api.platform.pagination import PageParams, build_page, page_params
```

add below `IdentityDep`:

```python
PageDep = Annotated[PageParams, Depends(page_params)]
```

and append:

```python
@router.get("/projects", operation_id="listProjects")
def list_projects(
    user: CurrentUserDep,
    session: SessionDep,
    page: PageDep,
    scope: Literal["mine", "discover"] = "mine",
    status: Literal["ACTIVE", "ARCHIVED"] | None = None,
    q: Annotated[str | None, Query(max_length=200)] = None,
) -> dict[str, Any]:
    rows = repo.list_projects(
        session,
        user_id=user.user_id,
        scope=scope,
        status=status,
        q=(q or "").strip() or None,
        after=service.decode_after(page.cursor),
        limit=page.limit,
    )
    result = build_page(rows, page.limit, lambda row: [row["updated_at"].isoformat(), str(row["project_id"])])
    project_ids = [row["project_id"] for row in result.items]
    counts = repo.member_counts(session, project_ids)
    my_roles = repo.roles_for_user(session, project_ids, user.user_id)
    items = [
        views.summary_view(row, my_role=my_roles.get(row["project_id"]), member_count=counts.get(row["project_id"], 0))
        for row in result.items
    ]
    return {"items": items, "page": result.page.model_dump()}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run pytest apps/api/modules/project/tests/test_projects_list.py -v`
Expected: 7 passed.

- [ ] **Step 5: Commit**

```bash
uv run ruff check --fix apps/api/modules/project && uv run ruff format apps/api/modules/project
git add apps/api/modules/project
git commit -m "feat(project): listProjects with mine/discover scopes, search and keyset cursor

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: updateProject and archiveProject (AT-13 part 1)

**Files:**
- Modify: `apps/api/modules/project/service.py` (add `update_project`, `archive_project`)
- Modify: `apps/api/modules/project/router.py` (add two endpoints)
- Test: `apps/api/modules/project/tests/test_projects_update_archive.py`

**Interfaces:**
- Consumes: `_mutable`, `_check_dates`, `roles.can_edit_project/can_change_visibility/can_archive`, `repo.update_project/archive_project/get_project`, `ProjectUpdateIn`.
- Produces: `service.update_project(session, user, project_id, patch: ProjectUpdateIn) -> ProjectAccess`; `service.archive_project(session, user, project_id) -> ProjectAccess`; endpoints `PATCH /projects/{project_id}` (`updateProject`), `POST /projects/{project_id}/archive` (`archiveProject`).

Rules: OWNER/ADMIN edit; a `visibility` value different from the stored one needs OWNER (sending the unchanged value is allowed for ADMIN); ARCHIVED → 409; dates are validated after merging the patch with stored values; no event on update (M02 §6). Archive: OWNER only, emits `project.archived.v1`; already ARCHIVED → 409 `PROJECT_ARCHIVED`.

- [ ] **Step 1: Write the failing tests**

`apps/api/modules/project/tests/test_projects_update_archive.py`:

```python
from datetime import datetime

from api.modules.project.tests.helpers import ProjectApi, assert_error, project_events, seed_member, uid
from api.platform.testing.contracts import assert_matches_response
from api.platform.testing.fixtures import PgUrls


def test_owner_updates_fields_without_event(api: ProjectApi, db: PgUrls) -> None:
    project = api.create_project()
    response = api.patch(
        "a.researcher",
        f"/projects/{project['project_id']}",
        json={"name": "Renamed Study", "description": "New text", "keywords": ["k1"], "visibility": "PUBLIC"},
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert_matches_response("updateProject", 200, body)
    assert (body["name"], body["description"], body["keywords"], body["visibility"]) == (
        "Renamed Study",
        "New text",
        ["k1"],
        "PUBLIC",
    )
    assert datetime.fromisoformat(body["updated_at"]) > datetime.fromisoformat(project["updated_at"])
    assert [e["event_type"] for e in project_events(db)] == ["project.created.v1"]


def test_admin_edits_but_cannot_change_visibility(api: ProjectApi, db: PgUrls) -> None:
    project = api.create_project()
    seed_member(db, project["project_id"], "a.admin", "PROJECT_ADMIN")
    path = f"/projects/{project['project_id']}"
    assert api.patch("a.admin", path, json={"description": "by admin"}).status_code == 200
    assert api.patch("a.admin", path, json={"visibility": "PRIVATE"}).status_code == 200  # unchanged value
    assert_error(api.patch("a.admin", path, json={"visibility": "PUBLIC"}), 403, "FORBIDDEN", "updateProject")


def test_researcher_and_viewer_cannot_edit(api: ProjectApi, db: PgUrls) -> None:
    project = api.create_project()
    seed_member(db, project["project_id"], "b.researcher", "RESEARCHER")
    seed_member(db, project["project_id"], "b.steward", "VIEWER")
    for user in ("b.researcher", "b.steward"):
        response = api.patch(user, f"/projects/{project['project_id']}", json={"description": "x"})
        assert_error(response, 403, "FORBIDDEN", "updateProject")


def test_non_member_update_is_404_on_private_and_admin_cannot_write(api: ProjectApi) -> None:
    project = api.create_project()
    path = f"/projects/{project['project_id']}"
    assert_error(api.patch("b.steward", path, json={"description": "x"}), 404, "NOT_FOUND", "updateProject")
    assert_error(api.patch("admin", path, json={"description": "x"}), 403, "FORBIDDEN", "updateProject")


def test_patch_rejects_empty_body_and_nulls(api: ProjectApi) -> None:
    project = api.create_project()
    path = f"/projects/{project['project_id']}"
    assert_error(api.patch("a.researcher", path, json={}), 422, "VALIDATION_FAILED", "updateProject")
    for field in ("name", "description", "visibility", "keywords"):
        assert_error(api.patch("a.researcher", path, json={field: None}), 422, "VALIDATION_FAILED", "updateProject")


def test_patch_dates_are_checked_against_stored_values(api: ProjectApi) -> None:
    project = api.create_project(start_date="2026-10-10")
    path = f"/projects/{project['project_id']}"
    response = api.patch("a.researcher", path, json={"end_date": "2026-10-01"})
    assert_error(response, 422, "VALIDATION_FAILED", "updateProject")
    assert response.json()["error"]["details"]["fields"][0]["field"] == "end_date"
    cleared = api.patch("a.researcher", path, json={"start_date": None, "end_date": "2026-10-01"})
    assert cleared.status_code == 200
    assert (cleared.json()["start_date"], cleared.json()["end_date"]) == (None, "2026-10-01")


def test_owner_archives_once(api: ProjectApi, db: PgUrls) -> None:
    project = api.create_project()
    path = f"/projects/{project['project_id']}/archive"
    response = api.post("a.researcher", path)
    assert response.status_code == 200, response.text
    body = response.json()
    assert_matches_response("archiveProject", 200, body)
    assert body["status"] == "ARCHIVED" and body["archived_at"] is not None
    events = project_events(db)
    assert [e["event_type"] for e in events] == ["project.created.v1", "project.archived.v1"]
    assert events[1]["payload"] == {"project_id": project["project_id"]}
    assert events[1]["actor"]["user_id"] == uid("a.researcher")
    assert_error(api.post("a.researcher", path), 409, "PROJECT_ARCHIVED", "archiveProject")
    assert api.get("a.researcher", f"/projects/{project['project_id']}").status_code == 200  # still readable


def test_only_owner_archives(api: ProjectApi, db: PgUrls) -> None:
    project = api.create_project()
    seed_member(db, project["project_id"], "a.admin", "PROJECT_ADMIN")
    assert_error(api.post("a.admin", f"/projects/{project['project_id']}/archive"), 403, "FORBIDDEN", "archiveProject")


def test_at13_archived_project_rejects_updates(api: ProjectApi) -> None:
    project = api.create_project()
    api.post("a.researcher", f"/projects/{project['project_id']}/archive")
    response = api.patch("a.researcher", f"/projects/{project['project_id']}", json={"description": "late"})
    assert_error(response, 409, "PROJECT_ARCHIVED", "updateProject")
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest apps/api/modules/project/tests/test_projects_update_archive.py -v`
Expected: FAIL — PATCH returns 405→`NOT_FOUND` 404; archive returns 404.

- [ ] **Step 3: Implement**

In `apps/api/modules/project/service.py` change `from api.modules.project.schemas import ProjectCreateIn` → `from api.modules.project.schemas import ProjectCreateIn, ProjectUpdateIn` and append:

```python
def _reload(session: Session, project_id: UUID, my_role: str | None) -> ProjectAccess:
    project = repo.get_project(session, project_id)
    assert project is not None  # locked by this transaction
    return ProjectAccess(project, my_role)


def update_project(session: Session, user: CurrentUser, project_id: UUID, patch: ProjectUpdateIn) -> ProjectAccess:
    access = _mutable(session, user, project_id)
    if not roles.can_edit_project(access.my_role):
        raise ApiError(ErrorCode.FORBIDDEN)
    values = patch.model_dump(exclude_unset=True)
    visibility = values.get("visibility", access.project["visibility"])
    if visibility != access.project["visibility"] and not roles.can_change_visibility(access.my_role):
        raise ApiError(ErrorCode.FORBIDDEN, "Only PROJECT_OWNER can change visibility.")
    _check_dates(
        values.get("start_date", access.project["start_date"]), values.get("end_date", access.project["end_date"])
    )
    repo.update_project(session, project_id, values, now=clock.now())
    return _reload(session, project_id, access.my_role)


def archive_project(session: Session, user: CurrentUser, project_id: UUID) -> ProjectAccess:
    access = _mutable(session, user, project_id)
    if not roles.can_archive(access.my_role):
        raise ApiError(ErrorCode.FORBIDDEN)
    repo.archive_project(session, project_id, now=clock.now())
    outbox.write(session, "project.archived.v1", {"project_id": str(project_id)}, EventActor.for_user(user))
    return _reload(session, project_id, access.my_role)
```

In `apps/api/modules/project/router.py` change `from api.modules.project.schemas import ProjectCreateIn` → `from api.modules.project.schemas import ProjectCreateIn, ProjectUpdateIn` and append:

```python
@router.patch("/projects/{project_id}", operation_id="updateProject")
def update_project(
    project_id: UUID, body: ProjectUpdateIn, user: CurrentUserDep, session: SessionDep, identity: IdentityDep
) -> dict[str, Any]:
    return views.detail_view(session, identity, service.update_project(session, user, project_id, body))


@router.post("/projects/{project_id}/archive", operation_id="archiveProject")
def archive_project(
    project_id: UUID, user: CurrentUserDep, session: SessionDep, identity: IdentityDep
) -> dict[str, Any]:
    return views.detail_view(session, identity, service.archive_project(session, user, project_id))
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run pytest apps/api/modules/project/tests/test_projects_update_archive.py -v`
Expected: 9 passed.

- [ ] **Step 5: Commit**

```bash
uv run ruff check --fix apps/api/modules/project && uv run ruff format apps/api/modules/project
git add apps/api/modules/project
git commit -m "feat(project): updateProject and archiveProject

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: listProjectMembers and addProjectMember (AT-02, AT-03, AT-09, AT-10, AT-11, AT-13 part 2)

**Files:**
- Modify: `apps/api/modules/project/service.py` (add `read_members`, `add_member`)
- Modify: `apps/api/modules/project/router.py` (add two endpoints)
- Test: `apps/api/modules/project/tests/test_members_add_list.py`

**Interfaces:**
- Consumes: `IdentityQueryPort` (`get_public_profile`, `is_active_user`), `MemberAddIn`, `ProjectSettings`/`get_project_settings`, `views.members_view`.
- Produces: `service.read_members(session, user, project_id) -> Sequence[RowMapping]`; `service.add_member(session, user, identity, project_id, data: MemberAddIn, *, max_members: int) -> RowMapping`; endpoints `GET /projects/{project_id}/members` (`listProjectMembers`), `POST /projects/{project_id}/members` (`addProjectMember`, 201).

Rules: members list is ACTIVE members only; caller must be an ACTIVE member or PLATFORM_ADMIN, otherwise 404 regardless of visibility. Add: OWNER any role, ADMIN only RESEARCHER/VIEWER (else 403); already ACTIVE → 409 `PROJECT_MEMBER_EXISTS`; unknown or not `is_active_user` → 422 (`fields[0] = {"field": "user_id", "reason": "USER_NOT_ACTIVE"}`); ACTIVE members already `>= PROJECT_MAX_MEMBERS` → 422 (`reason "PROJECT_MAX_MEMBERS"`); member `organization_id` is copied from the identity profile; organizations table updated in the same transaction; `project.member.added.v1` emitted.

- [ ] **Step 1: Write the failing tests**

`apps/api/modules/project/tests/test_members_add_list.py`:

```python
from fastapi import FastAPI

from api.modules.project.seed_data import ORG_A, ORG_B
from api.modules.project.settings import ProjectSettings, get_project_settings
from api.modules.project.tests.helpers import ProjectApi, assert_error, project_events, seed_member, uid
from api.platform.testing.contracts import assert_matches_response
from api.platform.testing.fixtures import PgUrls


def _add(api: ProjectApi, project_id: str, key: str, role: str, by: str = "a.researcher"):  # type: ignore[no-untyped-def]
    return api.post(by, f"/projects/{project_id}/members", json={"user_id": uid(key), "role": role})


def test_at02_owner_adds_partner_institute_researcher(api: ProjectApi, db: PgUrls) -> None:
    project = api.create_project(name="Battery Study")
    response = _add(api, project["project_id"], "b.researcher", "RESEARCHER")
    assert response.status_code == 201, response.text
    member = response.json()
    assert_matches_response("addProjectMember", 201, member)
    assert member["user_id"] == uid("b.researcher")
    assert member["organization_id"] == str(ORG_B)
    assert member["display_name"] == "B Researcher"
    assert member["organization_name"] == "Institute B"
    assert member["role"] == "RESEARCHER"
    assert member["added_by"] == uid("a.researcher")

    detail = api.get("a.researcher", f"/projects/{project['project_id']}").json()
    assert detail["member_count"] == 2
    assert [(o["organization_id"], o["role"]) for o in detail["organizations"]] == [(str(ORG_A), "LEAD"), (str(ORG_B), "PARTNER")]

    added = project_events(db)[-1]
    assert added["event_type"] == "project.member.added.v1"
    assert added["payload"] == {
        "project_id": project["project_id"],
        "project_name": "Battery Study",
        "user_id": uid("b.researcher"),
        "organization_id": str(ORG_B),
        "role": "RESEARCHER",
        "added_by": uid("a.researcher"),
    }


def test_at03_added_member_sees_project_with_role(api: ProjectApi) -> None:
    project = api.create_project()
    _add(api, project["project_id"], "b.researcher", "RESEARCHER")
    response = api.get("b.researcher", f"/projects/{project['project_id']}")
    assert response.status_code == 200
    assert response.json()["my_role"] == "RESEARCHER"
    mine = api.get("b.researcher", "/projects").json()["items"]
    assert [(i["project_id"], i["my_role"]) for i in mine] == [(project["project_id"], "RESEARCHER")]


def test_same_institute_member_creates_no_partner_row(api: ProjectApi) -> None:
    project = api.create_project()
    assert _add(api, project["project_id"], "a.steward", "VIEWER").status_code == 201
    detail = api.get("a.researcher", f"/projects/{project['project_id']}").json()
    assert detail["organizations"] == [{"organization_id": str(ORG_A), "name": "Institute A", "role": "LEAD"}]


def test_list_members_for_members_and_platform_admin(api: ProjectApi) -> None:
    project = api.create_project(visibility="PUBLIC")
    _add(api, project["project_id"], "b.researcher", "VIEWER")
    for user in ("a.researcher", "b.researcher", "admin"):
        response = api.get(user, f"/projects/{project['project_id']}/members")
        assert response.status_code == 200, user
        body = response.json()
        assert_matches_response("listProjectMembers", 200, body)
        assert [(m["display_name"], m["role"]) for m in body["items"]] == [
            ("A Researcher", "PROJECT_OWNER"),
            ("B Researcher", "VIEWER"),
        ]


def test_list_members_is_404_for_non_member_even_if_public(api: ProjectApi) -> None:
    project = api.create_project(visibility="PUBLIC")
    response = api.get("b.steward", f"/projects/{project['project_id']}/members")
    assert_error(response, 404, "NOT_FOUND", "listProjectMembers")


def test_at09_researcher_cannot_add(api: ProjectApi, db: PgUrls) -> None:
    project = api.create_project()
    seed_member(db, project["project_id"], "b.researcher", "RESEARCHER")
    response = _add(api, project["project_id"], "b.steward", "VIEWER", by="b.researcher")
    assert_error(response, 403, "FORBIDDEN", "addProjectMember")


def test_admin_adds_only_researcher_or_viewer(api: ProjectApi, db: PgUrls) -> None:
    project = api.create_project()
    seed_member(db, project["project_id"], "a.admin", "PROJECT_ADMIN")
    assert _add(api, project["project_id"], "b.researcher", "RESEARCHER", by="a.admin").status_code == 201
    for role in ("PROJECT_ADMIN", "PROJECT_OWNER"):
        assert_error(_add(api, project["project_id"], "b.steward", role, by="a.admin"), 403, "FORBIDDEN", "addProjectMember")


def test_at10_existing_member_is_409(api: ProjectApi) -> None:
    project = api.create_project()
    _add(api, project["project_id"], "b.researcher", "RESEARCHER")
    assert_error(_add(api, project["project_id"], "b.researcher", "VIEWER"), 409, "PROJECT_MEMBER_EXISTS", "addProjectMember")
    assert_error(_add(api, project["project_id"], "a.researcher", "VIEWER"), 409, "PROJECT_MEMBER_EXISTS", "addProjectMember")


def test_at11_disabled_or_unknown_user_is_422(api: ProjectApi, db: PgUrls) -> None:
    project = api.create_project()
    response = _add(api, project["project_id"], "b.disabled", "RESEARCHER")
    assert_error(response, 422, "VALIDATION_FAILED", "addProjectMember")
    assert response.json()["error"]["details"]["fields"] == [{"field": "user_id", "reason": "USER_NOT_ACTIVE"}]
    unknown = api.post(
        "a.researcher",
        f"/projects/{project['project_id']}/members",
        json={"user_id": "00000000-0000-7000-8000-00000000ffff", "role": "VIEWER"},
    )
    assert_error(unknown, 422, "VALIDATION_FAILED", "addProjectMember")
    assert [e["event_type"] for e in project_events(db)] == ["project.created.v1"]


def test_member_limit_is_enforced(app: FastAPI, api: ProjectApi) -> None:
    app.dependency_overrides[get_project_settings] = lambda: ProjectSettings(project_max_members=2)
    project = api.create_project()
    assert _add(api, project["project_id"], "b.researcher", "RESEARCHER").status_code == 201
    response = _add(api, project["project_id"], "b.steward", "VIEWER")
    assert_error(response, 422, "VALIDATION_FAILED", "addProjectMember")
    assert response.json()["error"]["details"]["fields"][0]["reason"] == "PROJECT_MAX_MEMBERS"


def test_at13_archived_project_rejects_new_members(api: ProjectApi) -> None:
    project = api.create_project()
    api.post("a.researcher", f"/projects/{project['project_id']}/archive")
    assert_error(_add(api, project["project_id"], "b.researcher", "RESEARCHER"), 409, "PROJECT_ARCHIVED", "addProjectMember")


def test_invalid_role_is_422(api: ProjectApi) -> None:
    project = api.create_project()
    assert_error(_add(api, project["project_id"], "b.researcher", "OWNER"), 422, "VALIDATION_FAILED", "addProjectMember")
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest apps/api/modules/project/tests/test_members_add_list.py -v`
Expected: FAIL — `/members` routes return 404.

- [ ] **Step 3: Implement**

In `apps/api/modules/project/service.py`:
- add `from collections.abc import Sequence` to the imports;
- change the schemas import to `from api.modules.project.schemas import MemberAddIn, ProjectCreateIn, ProjectUpdateIn`;
- add `from api.modules.project.identity import IdentityQueryPort`;

and append:

```python
def read_members(session: Session, user: CurrentUser, project_id: UUID) -> Sequence[RowMapping]:
    """ACTIVE members. Non-members get 404 whatever the visibility (M02 §6 listProjectMembers)."""
    if repo.get_project(session, project_id) is None:
        raise ApiError(ErrorCode.NOT_FOUND)
    if repo.member_role(session, project_id, user.user_id) is None and not user.is_platform_admin:
        raise ApiError(ErrorCode.NOT_FOUND)
    return repo.list_active_members(session, project_id)


def add_member(
    session: Session,
    user: CurrentUser,
    identity: IdentityQueryPort,
    project_id: UUID,
    data: MemberAddIn,
    *,
    max_members: int,
) -> RowMapping:
    access = _mutable(session, user, project_id)
    if not roles.can_manage_member(access.my_role, data.role):
        raise ApiError(ErrorCode.FORBIDDEN)
    if repo.member_role(session, project_id, data.user_id) is not None:
        raise ApiError(ErrorCode.PROJECT_MEMBER_EXISTS)
    profile = identity.get_public_profile(data.user_id)
    if profile is None or not identity.is_active_user(data.user_id):
        raise _validation_error("user_id", "USER_NOT_ACTIVE", "User does not exist or is not active.")
    if repo.count_active_members(session, project_id) >= max_members:
        raise _validation_error("user_id", "PROJECT_MAX_MEMBERS", f"A project can have at most {max_members} members.")
    organization_id = profile.organization_id
    now = clock.now()
    member = repo.insert_member(
        session,
        project_id=project_id,
        user_id=data.user_id,
        organization_id=organization_id,
        role=data.role,
        added_by=user.user_id,
        now=now,
    )
    repo.add_org_member(session, project_id, organization_id)
    repo.touch_project(session, project_id, now=now)
    outbox.write(
        session,
        "project.member.added.v1",
        {
            "project_id": str(project_id),
            "project_name": access.project["name"],
            "user_id": str(data.user_id),
            "organization_id": str(organization_id),
            "role": data.role,
            "added_by": str(user.user_id),
        },
        EventActor.for_user(user),
    )
    return member
```

In `apps/api/modules/project/router.py`:
- change the schemas import to `from api.modules.project.schemas import MemberAddIn, ProjectCreateIn, ProjectUpdateIn`;
- add `from api.modules.project.settings import ProjectSettings, get_project_settings`;
- add below `PageDep`: `SettingsDep = Annotated[ProjectSettings, Depends(get_project_settings)]`;

and append:

```python
@router.get("/projects/{project_id}/members", operation_id="listProjectMembers")
def list_project_members(
    project_id: UUID, user: CurrentUserDep, session: SessionDep, identity: IdentityDep
) -> dict[str, Any]:
    return {"items": views.members_view(identity, service.read_members(session, user, project_id))}


@router.post("/projects/{project_id}/members", status_code=201, operation_id="addProjectMember")
def add_project_member(
    project_id: UUID,
    body: MemberAddIn,
    user: CurrentUserDep,
    session: SessionDep,
    identity: IdentityDep,
    settings: SettingsDep,
) -> dict[str, Any]:
    member = service.add_member(
        session, user, identity, project_id, body, max_members=settings.project_max_members
    )
    return views.members_view(identity, [member])[0]
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run pytest apps/api/modules/project/tests/test_members_add_list.py -v`
Expected: 12 passed.

- [ ] **Step 5: Commit**

```bash
uv run ruff check --fix apps/api/modules/project && uv run ruff format apps/api/modules/project
git add apps/api/modules/project
git commit -m "feat(project): list and add project members with partner organizations

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: updateProjectMemberRole (AT-07, AT-08)

**Files:**
- Modify: `apps/api/modules/project/service.py` (add `change_member_role`)
- Modify: `apps/api/modules/project/router.py` (add endpoint)
- Test: `apps/api/modules/project/tests/test_members_role.py`

**Interfaces:**
- Consumes: `_mutable`, `roles.can_manage_member`, `roles.drops_an_owner`, `repo.active_member/count_active_owners/set_member_role/touch_project`, `MemberRoleIn`.
- Produces: `service.change_member_role(session, user, project_id, target_user_id: UUID, role: str) -> RowMapping`; endpoint `PATCH /projects/{project_id}/members/{user_id}` (`updateProjectMemberRole`).

Order of checks: lock + visibility + archived (`_mutable`) → target ACTIVE member else 404 `PROJECT_MEMBER_NOT_FOUND` → `can_manage_member(actor, current, new)` else 403 → same role → 200 with no event → last-owner check (409 `PROJECT_LAST_OWNER`) → update + `project.member.role_changed.v1`.

- [ ] **Step 1: Write the failing tests**

`apps/api/modules/project/tests/test_members_role.py`:

```python
from api.modules.project.tests.helpers import ProjectApi, assert_error, project_events, seed_member, uid
from api.platform.testing.contracts import assert_matches_response
from api.platform.testing.fixtures import PgUrls


def _set_role(api: ProjectApi, project_id: str, key: str, role: str, by: str = "a.researcher"):  # type: ignore[no-untyped-def]
    return api.patch(by, f"/projects/{project_id}/members/{uid(key)}", json={"role": role})


def test_owner_promotes_member_and_event_is_emitted(api: ProjectApi, db: PgUrls) -> None:
    project = api.create_project()
    seed_member(db, project["project_id"], "b.researcher", "RESEARCHER")
    response = _set_role(api, project["project_id"], "b.researcher", "PROJECT_ADMIN")
    assert response.status_code == 200, response.text
    assert_matches_response("updateProjectMemberRole", 200, response.json())
    assert response.json()["role"] == "PROJECT_ADMIN"
    event = project_events(db)[-1]
    assert event["event_type"] == "project.member.role_changed.v1"
    assert event["payload"] == {
        "project_id": project["project_id"],
        "user_id": uid("b.researcher"),
        "previous_role": "RESEARCHER",
        "role": "PROJECT_ADMIN",
        "changed_by": uid("a.researcher"),
    }


def test_same_role_is_200_without_event(api: ProjectApi, db: PgUrls) -> None:
    project = api.create_project()
    seed_member(db, project["project_id"], "b.researcher", "RESEARCHER")
    assert _set_role(api, project["project_id"], "b.researcher", "RESEARCHER").status_code == 200
    assert [e["event_type"] for e in project_events(db)] == ["project.created.v1"]


def test_at07_second_owner_can_be_demoted_but_not_the_last(api: ProjectApi, db: PgUrls) -> None:
    project = api.create_project()
    seed_member(db, project["project_id"], "a.admin", "PROJECT_OWNER")
    assert _set_role(api, project["project_id"], "a.admin", "RESEARCHER").status_code == 200
    response = _set_role(api, project["project_id"], "a.researcher", "PROJECT_ADMIN")  # self-demotion, last owner
    assert_error(response, 409, "PROJECT_LAST_OWNER", "updateProjectMemberRole")


def test_at08_admin_cannot_grant_owner(api: ProjectApi, db: PgUrls) -> None:
    project = api.create_project()
    seed_member(db, project["project_id"], "a.admin", "PROJECT_ADMIN")
    seed_member(db, project["project_id"], "b.researcher", "RESEARCHER")
    response = _set_role(api, project["project_id"], "b.researcher", "PROJECT_OWNER", by="a.admin")
    assert_error(response, 403, "FORBIDDEN", "updateProjectMemberRole")


def test_admin_scope_is_researcher_and_viewer(api: ProjectApi, db: PgUrls) -> None:
    project = api.create_project()
    seed_member(db, project["project_id"], "a.admin", "PROJECT_ADMIN")
    seed_member(db, project["project_id"], "a.steward", "PROJECT_ADMIN")
    seed_member(db, project["project_id"], "b.researcher", "RESEARCHER")
    assert _set_role(api, project["project_id"], "b.researcher", "VIEWER", by="a.admin").status_code == 200
    for key, role in (("b.researcher", "PROJECT_ADMIN"), ("a.steward", "RESEARCHER"), ("a.admin", "RESEARCHER"), ("a.researcher", "RESEARCHER")):
        response = _set_role(api, project["project_id"], key, role, by="a.admin")
        assert_error(response, 403, "FORBIDDEN", "updateProjectMemberRole")


def test_researcher_cannot_change_roles(api: ProjectApi, db: PgUrls) -> None:
    project = api.create_project()
    seed_member(db, project["project_id"], "b.researcher", "RESEARCHER")
    seed_member(db, project["project_id"], "b.steward", "VIEWER")
    response = _set_role(api, project["project_id"], "b.steward", "RESEARCHER", by="b.researcher")
    assert_error(response, 403, "FORBIDDEN", "updateProjectMemberRole")


def test_unknown_member_is_404(api: ProjectApi) -> None:
    project = api.create_project()
    assert_error(_set_role(api, project["project_id"], "b.steward", "VIEWER"), 404, "PROJECT_MEMBER_NOT_FOUND", "updateProjectMemberRole")


def test_archived_project_rejects_role_change(api: ProjectApi, db: PgUrls) -> None:
    project = api.create_project()
    seed_member(db, project["project_id"], "b.researcher", "RESEARCHER")
    api.post("a.researcher", f"/projects/{project['project_id']}/archive")
    response = _set_role(api, project["project_id"], "b.researcher", "VIEWER")
    assert_error(response, 409, "PROJECT_ARCHIVED", "updateProjectMemberRole")


def test_invalid_role_body_is_422(api: ProjectApi, db: PgUrls) -> None:
    project = api.create_project()
    seed_member(db, project["project_id"], "b.researcher", "RESEARCHER")
    assert_error(_set_role(api, project["project_id"], "b.researcher", "ADMIN"), 422, "VALIDATION_FAILED", "updateProjectMemberRole")
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest apps/api/modules/project/tests/test_members_role.py -v`
Expected: FAIL — PATCH on `/members/{user_id}` returns 404/405.

- [ ] **Step 3: Implement**

Append to `apps/api/modules/project/service.py`:

```python
def change_member_role(
    session: Session, user: CurrentUser, project_id: UUID, target_user_id: UUID, role: str
) -> RowMapping:
    access = _mutable(session, user, project_id)
    member = repo.active_member(session, project_id, target_user_id)
    if member is None:
        raise ApiError(ErrorCode.PROJECT_MEMBER_NOT_FOUND)
    current = member["role"]
    if not roles.can_manage_member(access.my_role, current, role):
        raise ApiError(ErrorCode.FORBIDDEN)
    if current == role:
        return member
    if roles.drops_an_owner(current, role) and repo.count_active_owners(session, project_id) <= 1:
        raise ApiError(ErrorCode.PROJECT_LAST_OWNER)
    updated = repo.set_member_role(session, member["project_member_id"], role)
    repo.touch_project(session, project_id, now=clock.now())
    outbox.write(
        session,
        "project.member.role_changed.v1",
        {
            "project_id": str(project_id),
            "user_id": str(target_user_id),
            "previous_role": current,
            "role": role,
            "changed_by": str(user.user_id),
        },
        EventActor.for_user(user),
    )
    return updated
```

In `apps/api/modules/project/router.py` change the schemas import to `from api.modules.project.schemas import MemberAddIn, MemberRoleIn, ProjectCreateIn, ProjectUpdateIn` and append:

```python
@router.patch("/projects/{project_id}/members/{user_id}", operation_id="updateProjectMemberRole")
def update_project_member_role(
    project_id: UUID,
    user_id: UUID,
    body: MemberRoleIn,
    user: CurrentUserDep,
    session: SessionDep,
    identity: IdentityDep,
) -> dict[str, Any]:
    member = service.change_member_role(session, user, project_id, user_id, body.role)
    return views.members_view(identity, [member])[0]
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run pytest apps/api/modules/project/tests/test_members_role.py -v`
Expected: 9 passed.

- [ ] **Step 5: Commit**

```bash
uv run ruff check --fix apps/api/modules/project && uv run ruff format apps/api/modules/project
git add apps/api/modules/project
git commit -m "feat(project): member role changes with owner/admin rules and last-owner guard

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: removeProjectMember and self-leave (AT-06, AT-12)

**Files:**
- Modify: `apps/api/modules/project/service.py` (add `remove_member`)
- Modify: `apps/api/modules/project/router.py` (add endpoint)
- Test: `apps/api/modules/project/tests/test_members_remove.py`

**Interfaces:**
- Consumes: `_mutable(..., allow_archived=True)`, `roles`, `repo.active_member/remove_member/drop_org_member/count_active_owners/touch_project`.
- Produces: `service.remove_member(session, user, project_id, target_user_id: UUID) -> None`; endpoint `DELETE /projects/{project_id}/members/{user_id}` (`removeProjectMember`, 204).

Rules: caller == target is a leave (allowed for any member, also on ARCHIVED projects); otherwise OWNER any, ADMIN only RESEARCHER/VIEWER targets, else 403; others on ARCHIVED → 409 `PROJECT_ARCHIVED`; target not ACTIVE → 404 `PROJECT_MEMBER_NOT_FOUND`; last owner → 409 `PROJECT_LAST_OWNER`; soft delete (`REMOVED`, `removed_at`, `removed_by`); organizations decremented; `project.member.removed.v1` with `reason: null`.

- [ ] **Step 1: Write the failing tests**

`apps/api/modules/project/tests/test_members_remove.py`:

```python
from api.modules.project.seed_data import ORG_A, ORG_B
from api.modules.project.tests.helpers import ProjectApi, assert_error, project_events, seed_member, sql, uid
from api.platform.testing.contracts import assert_matches_response
from api.platform.testing.fixtures import PgUrls


def _remove(api: ProjectApi, project_id: str, key: str, by: str = "a.researcher"):  # type: ignore[no-untyped-def]
    return api.delete(by, f"/projects/{project_id}/members/{uid(key)}")


def _org_roles(api: ProjectApi, project_id: str) -> list[tuple[str, str]]:
    detail = api.get("a.researcher", f"/projects/{project_id}").json()
    return [(o["organization_id"], o["role"]) for o in detail["organizations"]]


def test_at12_removing_last_partner_member_drops_partner_row(api: ProjectApi, db: PgUrls) -> None:
    project = api.create_project()
    api.post("a.researcher", f"/projects/{project['project_id']}/members", json={"user_id": uid("b.researcher"), "role": "RESEARCHER"})
    response = _remove(api, project["project_id"], "b.researcher")
    assert response.status_code == 204
    assert_matches_response("removeProjectMember", 204, response.content)
    assert _org_roles(api, project["project_id"]) == [(str(ORG_A), "LEAD")]
    event = project_events(db)[-1]
    assert event["event_type"] == "project.member.removed.v1"
    assert event["payload"] == {
        "project_id": project["project_id"],
        "user_id": uid("b.researcher"),
        "organization_id": str(ORG_B),
        "removed_by": uid("a.researcher"),
        "reason": None,
    }
    history = sql(db, "SELECT status, removed_by::text, removed_at IS NOT NULL AS stamped FROM project.project_members WHERE user_id = :u", u=uid("b.researcher"))
    assert history == [{"status": "REMOVED", "removed_by": uid("a.researcher"), "stamped": True}]
    assert_error(api.get("b.researcher", f"/projects/{project['project_id']}"), 404, "NOT_FOUND", "getProject")


def test_partner_row_stays_while_institute_has_members(api: ProjectApi, db: PgUrls) -> None:
    project = api.create_project()
    seed_member(db, project["project_id"], "b.researcher", "RESEARCHER")
    seed_member(db, project["project_id"], "b.steward", "VIEWER")
    assert _remove(api, project["project_id"], "b.steward").status_code == 204
    assert _org_roles(api, project["project_id"]) == [(str(ORG_A), "LEAD"), (str(ORG_B), "PARTNER")]


def test_member_leaves_on_their_own(api: ProjectApi, db: PgUrls) -> None:
    project = api.create_project()
    seed_member(db, project["project_id"], "b.researcher", "VIEWER")
    assert _remove(api, project["project_id"], "b.researcher", by="b.researcher").status_code == 204
    assert project_events(db)[-1]["payload"]["removed_by"] == uid("b.researcher")


def test_at06_sole_owner_cannot_leave(api: ProjectApi) -> None:
    project = api.create_project()
    response = _remove(api, project["project_id"], "a.researcher", by="a.researcher")
    assert_error(response, 409, "PROJECT_LAST_OWNER", "removeProjectMember")


def test_owner_can_leave_when_another_owner_remains(api: ProjectApi, db: PgUrls) -> None:
    project = api.create_project()
    seed_member(db, project["project_id"], "a.admin", "PROJECT_OWNER")
    assert _remove(api, project["project_id"], "a.researcher", by="a.researcher").status_code == 204


def test_admin_removes_researchers_but_not_owners_or_admins(api: ProjectApi, db: PgUrls) -> None:
    project = api.create_project()
    seed_member(db, project["project_id"], "a.admin", "PROJECT_ADMIN")
    seed_member(db, project["project_id"], "a.steward", "PROJECT_ADMIN")
    seed_member(db, project["project_id"], "b.researcher", "RESEARCHER")
    assert _remove(api, project["project_id"], "b.researcher", by="a.admin").status_code == 204
    for key in ("a.researcher", "a.steward"):
        assert_error(_remove(api, project["project_id"], key, by="a.admin"), 403, "FORBIDDEN", "removeProjectMember")


def test_viewer_cannot_remove_others(api: ProjectApi, db: PgUrls) -> None:
    project = api.create_project()
    seed_member(db, project["project_id"], "b.steward", "VIEWER")
    seed_member(db, project["project_id"], "b.researcher", "RESEARCHER")
    assert_error(_remove(api, project["project_id"], "b.researcher", by="b.steward"), 403, "FORBIDDEN", "removeProjectMember")


def test_removing_non_member_is_404(api: ProjectApi) -> None:
    project = api.create_project()
    response = _remove(api, project["project_id"], "b.steward")
    assert_error(response, 404, "PROJECT_MEMBER_NOT_FOUND", "removeProjectMember")


def test_archived_project_allows_leave_but_not_removal(api: ProjectApi, db: PgUrls) -> None:
    project = api.create_project()
    seed_member(db, project["project_id"], "b.researcher", "RESEARCHER")
    seed_member(db, project["project_id"], "b.steward", "VIEWER")
    api.post("a.researcher", f"/projects/{project['project_id']}/archive")
    assert_error(_remove(api, project["project_id"], "b.researcher"), 409, "PROJECT_ARCHIVED", "removeProjectMember")
    assert _remove(api, project["project_id"], "b.steward", by="b.steward").status_code == 204
    assert_error(_remove(api, project["project_id"], "a.researcher", by="a.researcher"), 409, "PROJECT_LAST_OWNER", "removeProjectMember")


def test_removed_member_can_be_added_again(api: ProjectApi, db: PgUrls) -> None:
    project = api.create_project()
    path = f"/projects/{project['project_id']}/members"
    api.post("a.researcher", path, json={"user_id": uid("b.researcher"), "role": "RESEARCHER"})
    _remove(api, project["project_id"], "b.researcher")
    again = api.post("a.researcher", path, json={"user_id": uid("b.researcher"), "role": "VIEWER"})
    assert again.status_code == 201, again.text
    rows = sql(db, "SELECT status, role FROM project.project_members WHERE user_id = :u ORDER BY joined_at", u=uid("b.researcher"))
    assert rows == [{"status": "REMOVED", "role": "RESEARCHER"}, {"status": "ACTIVE", "role": "VIEWER"}]
    counts = sql(db, "SELECT role, active_member_count FROM project.project_organizations WHERE organization_id = :o", o=str(ORG_B))
    assert counts == [{"role": "PARTNER", "active_member_count": 1}]
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest apps/api/modules/project/tests/test_members_remove.py -v`
Expected: FAIL — DELETE returns 404/405.

- [ ] **Step 3: Implement**

Append to `apps/api/modules/project/service.py`:

```python
def remove_member(session: Session, user: CurrentUser, project_id: UUID, target_user_id: UUID) -> None:
    leaving = target_user_id == user.user_id
    access = _mutable(session, user, project_id, allow_archived=leaving)
    member = repo.active_member(session, project_id, target_user_id)
    if member is None:
        raise ApiError(ErrorCode.PROJECT_MEMBER_NOT_FOUND)
    if not leaving and not roles.can_manage_member(access.my_role, member["role"]):
        raise ApiError(ErrorCode.FORBIDDEN)
    if roles.drops_an_owner(member["role"], None) and repo.count_active_owners(session, project_id) <= 1:
        raise ApiError(ErrorCode.PROJECT_LAST_OWNER)
    now = clock.now()
    repo.remove_member(session, member["project_member_id"], removed_by=user.user_id, now=now)
    repo.drop_org_member(session, project_id, member["organization_id"])
    repo.touch_project(session, project_id, now=now)
    outbox.write(
        session,
        "project.member.removed.v1",
        {
            "project_id": str(project_id),
            "user_id": str(target_user_id),
            "organization_id": str(member["organization_id"]),
            "removed_by": str(user.user_id),
            "reason": None,
        },
        EventActor.for_user(user),
    )
```

In `apps/api/modules/project/router.py` change `from fastapi import APIRouter, Depends, Query` → `from fastapi import APIRouter, Depends, Query, Response` and append:

```python
@router.delete(
    "/projects/{project_id}/members/{user_id}",
    status_code=204,
    response_class=Response,
    operation_id="removeProjectMember",
)
def remove_project_member(project_id: UUID, user_id: UUID, user: CurrentUserDep, session: SessionDep) -> Response:
    service.remove_member(session, user, project_id, user_id)
    return Response(status_code=204)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run pytest apps/api/modules/project/tests/test_members_remove.py -v`
Expected: 10 passed.

- [ ] **Step 5: Commit**

```bash
uv run ruff check --fix apps/api/modules/project && uv run ruff format apps/api/modules/project
git add apps/api/modules/project
git commit -m "feat(project): remove members and self-leave with soft delete

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Concurrency guarantee for the owner invariant (AT-14)

**Files:**
- Test: `apps/api/modules/project/tests/test_concurrency.py`
- Modify (only if a test fails): `apps/api/modules/project/service.py`

**Interfaces:**
- Consumes: `service.create_project`, `service.change_member_role`, `service.remove_member`, `ProjectCreateIn`, `current_user_for`, `seed_member`, `session_factory`.
- Produces: nothing new; proves that `_mutable` locks the projects row before reading roles.

- [ ] **Step 1: Write the test**

`apps/api/modules/project/tests/test_concurrency.py`:

```python
"""AT-14: two OWNERs acting on each other at the same time must leave >= 1 ACTIVE owner."""

import threading
from collections.abc import Callable
from uuid import UUID

from sqlalchemy.orm import Session

from api.modules.project import service
from api.modules.project.schemas import ProjectCreateIn
from api.modules.project.seed_data import USERS_BY_KEY
from api.modules.project.tests.helpers import current_user_for, seed_member, sql
from api.platform.db import session_factory, session_scope
from api.platform.errors import ApiError
from api.platform.testing.fixtures import PgUrls

A_RESEARCHER = USERS_BY_KEY["a.researcher"].user_id
A_ADMIN = USERS_BY_KEY["a.admin"].user_id


def _two_owner_project(db: PgUrls) -> UUID:
    with session_scope(db.app) as session:
        project_id = service.create_project(
            session, current_user_for("a.researcher"), ProjectCreateIn(name="Race Study", description="")
        )
    seed_member(db, str(project_id), "a.admin", "PROJECT_OWNER")
    return project_id


def _race(db: PgUrls, first: Callable[[Session], object], rival: Callable[[Session], object]) -> str:
    """Run `first` in an open transaction, start `rival` (must block on the row lock), then commit `first`."""
    factory = session_factory(db.app)
    outcome: dict[str, str] = {}

    def run_rival() -> None:
        with factory() as session:
            try:
                rival(session)
                session.commit()
                outcome["code"] = "OK"
            except ApiError as exc:
                session.rollback()
                outcome["code"] = exc.code.value

    first_session = factory()
    try:
        first(first_session)
        thread = threading.Thread(target=run_rival)
        thread.start()
        thread.join(timeout=1.0)
        assert thread.is_alive(), "rival must wait for the projects row lock"
        first_session.commit()
        thread.join(timeout=10)
        assert not thread.is_alive()
    finally:
        first_session.close()
    return outcome["code"]


def _owners(db: PgUrls, project_id: UUID) -> int:
    rows = sql(
        db,
        "SELECT count(*) AS n FROM project.project_members "
        "WHERE project_id = :p AND status = 'ACTIVE' AND role = 'PROJECT_OWNER'",
        p=str(project_id),
    )
    return int(rows[0]["n"])


def test_at14_owners_demoting_each_other_concurrently(db: PgUrls) -> None:
    project_id = _two_owner_project(db)
    code = _race(
        db,
        lambda s: service.change_member_role(s, current_user_for("a.researcher"), project_id, A_ADMIN, "RESEARCHER"),
        lambda s: service.change_member_role(s, current_user_for("a.admin"), project_id, A_RESEARCHER, "RESEARCHER"),
    )
    # After the lock is released the rival re-reads its own role: it is no longer an OWNER.
    assert code == "FORBIDDEN"
    assert _owners(db, project_id) == 1


def test_at14_owners_leaving_concurrently(db: PgUrls) -> None:
    project_id = _two_owner_project(db)
    code = _race(
        db,
        lambda s: service.remove_member(s, current_user_for("a.researcher"), project_id, A_RESEARCHER),
        lambda s: service.remove_member(s, current_user_for("a.admin"), project_id, A_ADMIN),
    )
    assert code == "PROJECT_LAST_OWNER"
    assert _owners(db, project_id) == 1
```

- [ ] **Step 2: Run the test**

Run: `uv run pytest apps/api/modules/project/tests/test_concurrency.py -v`
Expected: 2 passed. If `rival must wait for the projects row lock` fails, `_mutable` is not locking before reading roles: make `_access(..., lock=True)` call `repo.get_project(..., lock=True)` before `repo.member_role(...)` (as written in Task 5) and rerun.

- [ ] **Step 3: Commit**

```bash
uv run ruff check --fix apps/api/modules/project && uv run ruff format apps/api/modules/project
git add apps/api/modules/project/tests/test_concurrency.py
git commit -m "test(project): concurrent owner changes keep at least one owner

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: ProjectQueryPort and wire() (AT-13 part 3, AT-15)

**Files:**
- Create: `apps/api/modules/project/public.py` (the Protocol; W1-D1 / D-038 registry key)
- Create: `apps/api/modules/project/ports.py` (re-export of `public.py` for spec compatibility)
- Create: `apps/api/modules/project/query.py`
- Modify: `apps/api/modules/project/__init__.py` (add `wire`)
- Test: `apps/api/modules/project/tests/test_query_port.py`

**Interfaces:**
- Consumes: `repo.is_active_member/member_role/get_project/count_active_members/list_active_members/project_ids_for_member`, `views.summary_view`, `session_factory`.
- Produces: `ProjectQueryPort` Protocol in `api.modules.project.public` (re-exported unchanged by `api.modules.project.ports`; consumers import it from `public`) with `is_active_member(project_id, user_id) -> bool`, `get_member_role(project_id, user_id) -> str | None`, `get_summary(project_id) -> nais_contracts.api_models.ProjectSummary | None` (`my_role=None`), `list_active_member_ids(project_id) -> list[UUID]`, `list_project_ids_for_member(user_id) -> list[UUID]`; `SqlProjectQueryPort(database_url: str | None = None)`; `wire() -> None` (registers `SqlProjectQueryPort()` under `ProjectQueryPort`).

- [ ] **Step 1: Write the failing tests**

`apps/api/modules/project/tests/test_query_port.py`:

```python
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
    api.post("a.researcher", f"/projects/{project['project_id']}/members", json={"user_id": uid("b.researcher"), "role": "RESEARCHER"})
    types = [row["event_type"] for row in sql(db, "SELECT event_type FROM platform.outbox_events ORDER BY id")]
    assert types == ["project.created.v1", "project.member.added.v1"]
    assert not any(name for name in dir(ProjectQueryPort) if "grant" in name or "access" in name)
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest apps/api/modules/project/tests/test_query_port.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'api.modules.project.public'`.

- [ ] **Step 3: Implement**

`apps/api/modules/project/public.py`:

```python
"""M02 public port (M02 §8, D-038). Consumers: `from api.modules.project.public import ProjectQueryPort` then
`api.platform.ports.get(ProjectQueryPort)`. Never query project.* tables directly.
Imports nothing from project internals (only stdlib/typing and the generated contract models)."""

from typing import Protocol
from uuid import UUID

from nais_contracts.api_models import ProjectSummary


class ProjectQueryPort(Protocol):
    def is_active_member(self, project_id: UUID, user_id: UUID) -> bool:
        """True only when project.status == ACTIVE and member.status == ACTIVE (ARCHIVED -> False).
        Governance trusts only this value for project-scoped checks."""
        ...

    def get_member_role(self, project_id: UUID, user_id: UUID) -> str | None: ...

    def get_summary(self, project_id: UUID) -> ProjectSummary | None:
        """openapi ProjectSummary with my_role=None."""
        ...

    def list_active_member_ids(self, project_id: UUID) -> list[UUID]: ...

    def list_project_ids_for_member(self, user_id: UUID) -> list[UUID]:
        """Projects with an ACTIVE membership of this user (any project status)."""
        ...
```

`apps/api/modules/project/ports.py`:

```python
"""Spec-compatible alias of public.py (D-038). New code imports from api.modules.project.public."""

from api.modules.project.public import ProjectQueryPort

__all__ = ["ProjectQueryPort"]
```

`apps/api/modules/project/query.py`:

```python
"""SqlProjectQueryPort: read-only implementation of ProjectQueryPort, one short session per call."""

from uuid import UUID

from nais_contracts.api_models import ProjectSummary
from sqlalchemy.orm import Session

from api.modules.project import repository as repo
from api.modules.project.public import ProjectQueryPort
from api.modules.project.views import summary_view
from api.platform import ports
from api.platform.db import session_factory


class SqlProjectQueryPort:
    def __init__(self, database_url: str | None = None) -> None:
        self._database_url = database_url  # None -> platform settings DATABASE_URL at call time

    def _session(self) -> Session:
        return session_factory(self._database_url)()

    def is_active_member(self, project_id: UUID, user_id: UUID) -> bool:
        with self._session() as session:
            return repo.is_active_member(session, project_id, user_id)

    def get_member_role(self, project_id: UUID, user_id: UUID) -> str | None:
        with self._session() as session:
            return repo.member_role(session, project_id, user_id)

    def get_summary(self, project_id: UUID) -> ProjectSummary | None:
        with self._session() as session:
            project = repo.get_project(session, project_id)
            if project is None:
                return None
            count = repo.count_active_members(session, project_id)
        return ProjectSummary.model_validate(summary_view(project, my_role=None, member_count=count))

    def list_active_member_ids(self, project_id: UUID) -> list[UUID]:
        with self._session() as session:
            return [member["user_id"] for member in repo.list_active_members(session, project_id)]

    def list_project_ids_for_member(self, user_id: UUID) -> list[UUID]:
        with self._session() as session:
            return repo.project_ids_for_member(session, user_id)


def wire() -> None:
    ports.provide(ProjectQueryPort, SqlProjectQueryPort())
```

Replace `apps/api/modules/project/__init__.py` with:

```python
"""M02 Project Collaboration (NAIS_PRD/modules/M02_project_collaboration.md)."""

from pathlib import Path

from api.modules.project.query import wire
from api.modules.project.router import router
from api.platform.modules import ModuleSpec

MODULE = ModuleSpec(
    name="project",
    db_schema="project",
    router=router,
    migrations_dir=Path(__file__).parent / "migrations",
    wire=wire,
)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run pytest apps/api/modules/project/tests -v`
Expected: all passed.

- [ ] **Step 5: Commit**

```bash
uv run ruff check --fix apps/api/modules/project && uv run ruff format apps/api/modules/project
git add apps/api/modules/project
git commit -m "feat(project): ProjectQueryPort implementation wired for other modules

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: Seed project, module README, and running-stack verification

**Files:**
- Create: `apps/api/modules/project/seed.py`
- Create: `apps/api/modules/project/README.md`
- Modify: `apps/api/modules/project/__init__.py` (add `seed`)
- Test: `apps/api/modules/project/tests/test_seed.py`

**Interfaces:**
- Consumes: `SEED_PROJECT_ID`, `SEED_PROJECT_NAME`, `SEED_OWNER_MEMBER_ID`, `SEED_PARTNER_MEMBER_ID`, `USERS_BY_KEY`, `ORG_A`, `ORG_B`, repository insert functions, `outbox.write`.
- Produces: `seed(session: Session) -> None` — idempotent: project `...1001` "Seed: Battery Materials Joint Study", lead inst-a, PRIVATE, a.researcher PROJECT_OWNER + b.researcher RESEARCHER, organizations inst-a LEAD(1) / inst-b PARTNER(1); emits `project.created.v1` and `project.member.added.v1` only on the first run.

- [ ] **Step 1: Write the failing test**

`apps/api/modules/project/tests/test_seed.py`:

```python
from api.modules.project import MODULE
from api.modules.project.query import SqlProjectQueryPort
from api.modules.project.seed_data import ORG_A, ORG_B, SEED_PROJECT_ID, USERS_BY_KEY
from api.modules.project.tests.helpers import project_events, sql, uid
from api.platform.seed import run_seed
from api.platform.testing.fixtures import PgUrls


def test_seed_is_idempotent_and_matches_seed_spec(db: PgUrls) -> None:
    assert run_seed([MODULE], url=db.app) == ["project"]
    assert run_seed([MODULE], url=db.app) == ["project"]

    projects = sql(db, "SELECT project_id::text, name, visibility, status, lead_organization_id::text FROM project.projects")
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
    organizations = sql(db, "SELECT organization_id::text, role, active_member_count FROM project.project_organizations ORDER BY role")
    assert organizations == [
        {"organization_id": str(ORG_A), "role": "LEAD", "active_member_count": 1},
        {"organization_id": str(ORG_B), "role": "PARTNER", "active_member_count": 1},
    ]
    assert [e["event_type"] for e in project_events(db)] == ["project.created.v1", "project.member.added.v1"]

    port = SqlProjectQueryPort(db.app)
    assert port.is_active_member(SEED_PROJECT_ID, USERS_BY_KEY["a.researcher"].user_id)
    assert port.get_member_role(SEED_PROJECT_ID, USERS_BY_KEY["b.researcher"].user_id) == "RESEARCHER"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest apps/api/modules/project/tests/test_seed.py -v`
Expected: FAIL — `run_seed` returns `[]` (MODULE has no `seed`).

- [ ] **Step 3: Implement seed and register it**

`apps/api/modules/project/seed.py`:

```python
"""10_SEED_DATA §4 seed project (idempotent: fixed ids, skipped when the project exists)."""

from sqlalchemy.orm import Session

from api.modules.project import repository as repo
from api.modules.project.seed_data import (
    ORG_A,
    ORG_B,
    SEED_OWNER_MEMBER_ID,
    SEED_PARTNER_MEMBER_ID,
    SEED_PROJECT_ID,
    SEED_PROJECT_NAME,
    USERS_BY_KEY,
)
from api.platform import clock
from api.platform.events import EventActor
from api.platform.outbox import outbox


def seed(session: Session) -> None:
    if repo.get_project(session, SEED_PROJECT_ID) is not None:
        return
    owner = USERS_BY_KEY["a.researcher"]
    partner = USERS_BY_KEY["b.researcher"]
    now = clock.now()
    repo.insert_project(
        session,
        project_id=SEED_PROJECT_ID,
        name=SEED_PROJECT_NAME,
        description="Seed project shared by Institute A and Institute B (dev only).",
        visibility="PRIVATE",
        lead_organization_id=ORG_A,
        keywords=[],
        start_date=None,
        end_date=None,
        created_by=owner.user_id,
        now=now,
    )
    repo.insert_member(
        session,
        project_member_id=SEED_OWNER_MEMBER_ID,
        project_id=SEED_PROJECT_ID,
        user_id=owner.user_id,
        organization_id=ORG_A,
        role="PROJECT_OWNER",
        added_by=owner.user_id,
        now=now,
    )
    repo.add_org_member(session, SEED_PROJECT_ID, ORG_A, lead=True)
    repo.insert_member(
        session,
        project_member_id=SEED_PARTNER_MEMBER_ID,
        project_id=SEED_PROJECT_ID,
        user_id=partner.user_id,
        organization_id=ORG_B,
        role="RESEARCHER",
        added_by=owner.user_id,
        now=now,
    )
    repo.add_org_member(session, SEED_PROJECT_ID, ORG_B)
    actor = EventActor(type="USER", user_id=owner.user_id, organization_id=owner.organization_id)
    outbox.write(
        session,
        "project.created.v1",
        {
            "project_id": str(SEED_PROJECT_ID),
            "name": SEED_PROJECT_NAME,
            "lead_organization_id": str(ORG_A),
            "visibility": "PRIVATE",
            "owner_user_id": str(owner.user_id),
        },
        actor,
    )
    outbox.write(
        session,
        "project.member.added.v1",
        {
            "project_id": str(SEED_PROJECT_ID),
            "project_name": SEED_PROJECT_NAME,
            "user_id": str(partner.user_id),
            "organization_id": str(ORG_B),
            "role": "RESEARCHER",
            "added_by": str(owner.user_id),
        },
        actor,
    )
```

Replace `apps/api/modules/project/__init__.py` with:

```python
"""M02 Project Collaboration (NAIS_PRD/modules/M02_project_collaboration.md)."""

from pathlib import Path

from api.modules.project.query import wire
from api.modules.project.router import router
from api.modules.project.seed import seed
from api.platform.modules import ModuleSpec

MODULE = ModuleSpec(
    name="project",
    db_schema="project",
    router=router,
    migrations_dir=Path(__file__).parent / "migrations",
    wire=wire,
    seed=seed,
)
```

`apps/api/modules/project/README.md`:

```markdown
# M02 Project Collaboration (`api.modules.project`)

Spec: `NAIS_PRD/modules/M02_project_collaboration.md`. Schema `project`, migrations in `migrations/`.

## What it does
- Projects (create / update / archive, no delete, no unarchive), visibility PRIVATE (default) / PUBLIC.
- Members with roles PROJECT_OWNER / PROJECT_ADMIN / RESEARCHER / VIEWER, added directly (D-007), soft-removed.
- `project_organizations`: LEAD = creator's institute, PARTNER rows derived from members' institutes.
- Events: `project.created.v1`, `project.archived.v1`, `project.member.added.v1`, `project.member.removed.v1`,
  `project.member.role_changed.v1` (outbox, same transaction).

## Integration notes
- Other modules import `ProjectQueryPort` from `api.modules.project.public` (D-038; `api.modules.project.ports` is an
  alias) and call `ports.get(ProjectQueryPort)`, never `project.*` tables.
- `is_active_member()` is False for ARCHIVED projects; governance must trust only this value.
- Project membership never implies dataset access (grants are M04).
- Identity: M02 resolves `ports.get(IdentityQueryPort)` with the class from `api.modules.identity.public` (D-038).
  If the identity module is not installed it uses the seed-user fake (Wave 1); if it is installed but not wired,
  requests fail with 503 `DEPENDENCY_UNAVAILABLE`.
- Every mutation locks the project row (`SELECT ... FOR UPDATE`): at least one ACTIVE PROJECT_OWNER always remains.

## Config
`PROJECT_MAX_MEMBERS` (default 200).

## Seed
Project `00000000-0000-7000-8000-000000001001` "Seed: Battery Materials Joint Study": a.researcher (OWNER),
b.researcher (RESEARCHER). Local login for all seed users: password `nais`.
```

- [ ] **Step 4: Run the whole module suite, lint and the platform suite**

Run: `uv run pytest apps/api/modules/project -v`
Expected: all passed.

Run: `uv run pytest apps/api/platform -q`
Expected: all passed (the project package must not break discovery/app tests).

Run: `uv run ruff check apps/api/modules/project && uv run ruff format --check apps/api/modules/project`
Expected: no findings.

- [ ] **Step 5: Verify against the running stack**

Rebuild the image (the api image copies `apps/api` at build time), migrate, seed twice (idempotent), restart:

```bash
docker compose build api worker
docker compose run --rm --no-deps api python -m api.platform.cli migrate
docker compose run --rm --no-deps api python -m api.platform.cli seed
docker compose run --rm --no-deps api python -m api.platform.cli seed
docker compose up -d api worker
```

Expected: migrate prints `migrated platform` and `migrated project` (plus any other installed modules); both seed runs print `seeded project`.

Check the data:

```bash
docker compose exec -T postgres psql -U nais -d nais \
  -c "SELECT project_id, name, visibility, status FROM project.projects" \
  -c "SELECT user_id, role, status FROM project.project_members ORDER BY joined_at, role" \
  -c "SELECT organization_id, role, active_member_count FROM project.project_organizations ORDER BY role" \
  -c "SELECT event_type, dispatched_at IS NOT NULL AS dispatched FROM platform.outbox_events WHERE event_type LIKE 'project.%' ORDER BY id"
```

Expected: exactly one project `00000000-0000-7000-8000-000000001001` PRIVATE ACTIVE; members `...0a02` PROJECT_OWNER and `...0b02` RESEARCHER; organizations `...000a` LEAD 1 and `...000b` PARTNER 1; two `project.*` outbox events, `dispatched = t` within a few seconds (worker relay running).

Check the HTTP surface through the gateway:

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:21051/api/v1/projects
curl -s http://localhost:21051/api/v1/openapi.json | python3 -c "import json,sys; d=json.load(sys.stdin); print(sorted(o['operationId'] for p in d['paths'].values() for o in p.values() if 'projects' in o.get('tags', [])))"
docker compose logs --tail=50 api | grep -i error || true
```

Expected: `401`; the list `['addProjectMember', 'archiveProject', 'createProject', 'getProject', 'listProjectMembers', 'listProjects', 'removeProjectMember', 'updateProject', 'updateProjectMemberRole']`; no error lines from startup.

Only if the identity module is already merged on this branch (`test -f apps/api/modules/identity/__init__.py`), also exercise an authenticated call with a dev token from the `nais-e2e` client (M01 §Keycloak; D-037 dev secret `nais` unless M01 documents another):

```bash
TOKEN=$(curl -s -d grant_type=password -d client_id=nais-e2e -d client_secret="${NAIS_E2E_CLIENT_SECRET:-nais}" \
  -d username=a.researcher@inst-a.local -d password=nais \
  http://localhost:21051/auth/realms/nais/protocol/openid-connect/token | python3 -c "import json,sys; print(json.load(sys.stdin)['access_token'])")
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:21051/api/v1/projects | python3 -m json.tool
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:21051/api/v1/projects/00000000-0000-7000-8000-000000001001/members | python3 -m json.tool
```

Expected: the seed project in `items` with `my_role` `PROJECT_OWNER` and `member_count` 2; members list with display names "A Researcher" / "B Researcher". If identity is not merged yet, skip this block and note it in the task report.

- [ ] **Step 6: Commit**

```bash
uv run ruff check --fix apps/api/modules/project && uv run ruff format apps/api/modules/project
git add apps/api/modules/project
git commit -m "feat(project): seed project, module README

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Spec coverage map

| Spec item | Task |
|---|---|
| §4 tables, checks, indexes (incl. trgm, partial unique) | 1 |
| §5 role rules, last-owner invariant, FOR UPDATE | 2, 9, 10, 11 |
| §3 IdentityQueryPort + Wave 1 fake | 3 |
| §6 createProject / getProject | 5 |
| §6 listProjects (mine/discover/status/q, updated_at desc) | 6 |
| §6 updateProject / archiveProject | 7 |
| §6 listProjectMembers / addProjectMember, `PROJECT_MAX_MEMBERS` | 8 |
| §6 updateProjectMemberRole | 9 |
| §6 removeProjectMember, leave on ARCHIVED | 10 |
| §7 five events | 5, 7, 8, 9, 10 |
| §8 ProjectQueryPort via wire() | 12 |
| §12 AT-01..AT-15 | AT-01/04/05 T5, AT-05 T6, AT-13 T7/T8/T12, AT-02/03/09/10/11 T8, AT-07/08 T9, AT-06/12 T10, AT-14 T11, AT-15 T12 (M04 half out of module) |
| §13 README, migration, seed, tests | 1, 13 |

## Contract/shared changes needed

All resolved by the Wave 1 controller decisions (`wave1-controller-decisions.md`); nothing left for this plan:
1. Port location (W1-D1 / D-038): M02 consumes `api.modules.identity.public.IdentityQueryPort` and publishes `api.modules.project.public.ProjectQueryPort` (`ports.py` re-exports it).
2. openapi.yaml statuses (W1-D3): `updateProject` 404/422, `archiveProject` 404, `addProjectMember` 404, `updateProjectMemberRole` 404/422, `listProjects` 422 and 401 on every operation are added by the M00 kickoff (contract 1.2.0); every error test contract-checks.
3. pg_trgm (W1-D2): installed in schema `public` by `init.sql` / M00 kickoff; M02's migration only uses `public.gin_trgm_ops`.
4. `.env.example` (W1-D4): `PROJECT_MAX_MEMBERS=200` is added by the M00 kickoff; this plan does not touch it.
