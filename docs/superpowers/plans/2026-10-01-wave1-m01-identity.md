# M01 Identity & Organization — Wave 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the `identity` module: NAIS-side users, organizations and memberships, the `PrincipalResolver` that turns every verified Keycloak token into a `CurrentUser` (JIT provisioning, DISABLED blocking, once-per-session login audit), the `/me`, `/users`, `/organizations/**` endpoints, the `IdentityQueryPort` for other modules, the Keycloak realm `nais` with 8 seed users, and the seed.

**Architecture:** A self-contained module package `apps/api/modules/identity` plugged in through `MODULE = ModuleSpec(...)`. SQLAlchemy Core tables in schema `identity` (Alembic revision in the module), all events through `api.platform.outbox.outbox.write` in the same transaction as the change. The platform's `current_user` dependency verifies the JWT and calls our `IdentityPrincipalResolver.resolve(claims, correlation_id)`, which opens its own short transaction (it gets no request session) and reads roles/status from the DB on every request (no cache). The Keycloak realm is a static import file in `infra/keycloak/import/` (the directory the compose `keycloak` service already mounts).

**Tech Stack:** Python 3.13, FastAPI ≥0.121, SQLAlchemy 2 Core + psycopg 3, Alembic, PostgreSQL 16 (`pg_trgm`), PyJWT (platform), Keycloak 26.0, pytest + testcontainers, httpx.

**Execution order (W1):** M00 kickoff → M01 → M02 → M03 → M05 → M09 → M10. Prerequisites from M00 (`2026-10-01-wave1-m00-kickoff.md`): pg_trgm in schema public, openapi 1.2.0 (all statuses below declared), mypy covers `apps/api/modules`, `.env.example` module keys. Binding decisions: `wave1-controller-decisions.md` (W1-D1…D6).

**Spec:** `NAIS_PRD/modules/M01_identity_org.md` (binding). Also `NAIS_PRD/10_SEED_DATA.md` §2–3, `NAIS_PRD/11_DECISION_LOG.md` (D-019, D-020, D-021, D-027, D-036, D-037), `NAIS_PRD/contracts/openapi.yaml` (tag `identity`), `NAIS_PRD/contracts/events/p0_events.schema.json`, `NAIS_PRD/contracts/error_codes.json`, and the platform code under `apps/api/platform/`.

## Global Constraints

- Owned paths only: `apps/api/modules/identity/**`, `infra/keycloak/**`. Single shared exception: `pyproject.toml` + `uv.lock` fastapi floor (Task 1, Agent 0 approved).
- DB schema `identity`; every `op.*` call passes `schema="identity"` (raw `op.execute` SQL schema-qualifies every name); version table `identity.alembic_version` (automatic via `migration_targets`, D-021).
- Keycloak authenticates only; roles and status live in `identity` tables (D-019). No custom realm roles.
- "역할과 status는 캐시하지 않는다 (요청마다 PK 조회 1회)" — resolver reads the DB on every request.
- Events only through `outbox.write(session, ...)` in the same session as the change: `identity.organization.created.v1`, `identity.user.created.v1`, `identity.user.logged_in.v1`, `identity.membership.changed.v1`. Seed actor = `SYSTEM`; JIT/login actor = the user; membership change actor = the admin. `correlation_id` = request trace id.
- Error codes used (all exist in `error_codes.json`): `UNAUTHENTICATED`, `FORBIDDEN`, `NOT_FOUND`, `CONFLICT`, `VALIDATION_FAILED`, `USER_DISABLED`, `ORGANIZATION_UNKNOWN`, `MEMBERSHIP_DISABLED`, `ROLE_NOT_ASSIGNABLE`. Raise with `api.platform.errors.ApiError(ErrorCode.X, ...)`.
- Endpoints take `session: SessionDep`; never call `session.commit()`.
- Every tested response passes `api.platform.testing.contracts.assert_matches_response(operationId, status, body)`; every emitted event passes `assert_valid_event`.
- Seed IDs: `00000000-0000-7000-8000-00000000XXXX` (10_SEED_DATA §2–3); Keycloak user `id` == NAIS `user_id` == token `sub`; dev password `nais` (D-037); seed is idempotent (upsert) and keeps its rows in Python (`seed()` must not read files at runtime).
- Realm `nais`: `nais-web` public + PKCE S256, direct grants off; `nais-api` bearer-only audience; `nais-e2e` confidential + direct grants (dev/test only). Access token 300 s, SSO idle 1800 s, SSO max 36000 s. `org_code` user attribute → token claim.
- Env (already in `.env.example`/`Settings`): `OIDC_ISSUER`, `OIDC_INTERNAL_JWKS_URL`, `OIDC_AUDIENCE=nais-api`, `OIDC_CLOCK_SKEW_SECONDS=30`. The running stack's issuer is `${NAIS_PUBLIC_BASE_URL}/auth/realms/nais` (currently `http://<NAIS_EXTERNAL_HOST>:21051/...` in `.env`) — never hard-code `localhost` as the issuer in live checks.
- Other modules use only `CurrentUser` and `IdentityQueryPort`; they never read `identity.*` tables.
- W1-D1 (D-038): `api/modules/identity/public.py` is the provider-owned public module (Protocol + DTOs; imports only stdlib/pydantic/typing/api.platform). The `IdentityQueryPort` class object there is THE `ports` registry key; consumers (M02, M03, M09) import it from `api.modules.identity.public`.
- W1-D6: the realm owns the `nais-web` client M10 needs (public, PKCE S256, both callback hosts, post-logout `/`, `org_code` + audience `nais-api` mappers).
- Stack rules: ports 21051–21058; never `docker compose down` or delete volumes; restarting/recreating `api`, `worker`, `keycloak` is fine.
- ruff: line length 110, rules E,F,I,B,UP,SIM; run `uv run ruff check --fix` and `uv run ruff format` on touched files before each commit.
- Every commit message ends with the trailer line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Parallel first requests of a brand-new user** (the web portal fires several API calls right after login): expect every request 200, exactly one `users` row, one membership, one `identity.user.created.v1` and one `identity.user.logged_in.v1` — never a 409/500 from the unique indexes. Pinned in Task 4 (`test_parallel_first_requests_provision_once`).
2. **Search text containing LIKE wildcards or padding** (`q=%%`, `q=__`, `q="  a "`): `%`/`_` are literal, never match-all; a query that is shorter than 2 characters after trimming is 422 `VALIDATION_FAILED`. Pinned in Task 6 (`test_like_wildcards_are_literal`, `test_padded_short_query_is_rejected`).
3. **Tampered or foreign pagination cursors** (garbage base64, a cursor of the wrong shape): 422 `VALIDATION_FAILED` with `details.fields[0].field == "cursor"`, never 500. Pinned in Task 6 (`test_bad_cursor_is_422`).
4. **Tokens with an unusual `sid`** (missing, or longer than the 64-char column): no 500; a missing sid falls back to `sha256("<sub>:<iat>")`, an over-long sid is hashed; the login event still fires exactly once per session. Pinned in Task 4 (`test_session_id_fallbacks`).
5. **A user editing their own `org_code` in the Keycloak account console** (would let a new user JIT-join any institute): the user profile must make `org_code` required and admin-edit-only. Pinned in Task 10 (`test_org_code_is_required_and_admin_editable_only`).

---

## File Structure

| Path | Responsibility |
|---|---|
| `pyproject.toml`, `uv.lock` | **shared file change (Agent 0 approved)**: `fastapi>=0.121` floor (SessionDep uses `Depends(scope=)`) |
| `apps/api/modules/identity/__init__.py` | `MODULE = ModuleSpec(...)`, `wire()`, `wire_ports(sessions)` |
| `apps/api/modules/identity/tables.py` | SQLAlchemy Core `Table`s for `identity.*` (no DDL) |
| `apps/api/modules/identity/migrations/identity_0001_initial.py` | Alembic revision: 4 tables, constraints, indexes (trigram index uses `public.gin_trgm_ops`; the extension comes from M00) |
| `apps/api/modules/identity/seed_data.py` | Fixed seed orgs/users (Python data), `ORGS_BY_CODE`, `USERS_BY_EMAIL` |
| `apps/api/modules/identity/seed.py` | Idempotent `seed(session)` with outbox events |
| `apps/api/modules/identity/resolver.py` | `IdentityPrincipalResolver`, `SessionFactory`, `session_id_for` |
| `apps/api/modules/identity/public.py` | Public DTOs `OrganizationSummary`, `IdentityPublicProfile` and `IdentityQueryPort` Protocol |
| `apps/api/modules/identity/schemas.py` | API models `MeOut`, `OrganizationOut`, `MembershipOut`, `MemberUpdateIn` |
| `apps/api/modules/identity/directory.py` | Read queries: me, organizations, user directory, cursor helpers |
| `apps/api/modules/identity/members.py` | Member list + role/status update rules, `membership.changed` event |
| `apps/api/modules/identity/router.py` | FastAPI routes (thin) |
| `apps/api/modules/identity/query.py` | `SqlIdentityQuery` (IdentityQueryPort implementation) |
| `apps/api/modules/identity/jobs.py` | `prune_sessions`, `register_worker` (`identity.prune_sessions`, daily) |
| `apps/api/modules/identity/README.md` | Module overview, local login, integration notes (spec §13 deliverable) |
| `apps/api/modules/identity/tests/__init__.py` | Makes `api.modules.identity.tests.support` importable |
| `apps/api/modules/identity/tests/conftest.py` | `identity_db`, `db`, `seeded` fixtures |
| `apps/api/modules/identity/tests/support.py` | Shared helpers: `scalar`, `events`, `seed_all`, `claims_for`, `ISSUER`, `make_client`, `token_for`, `bearer` |
| `apps/api/modules/identity/tests/test_schema.py` | Migration/constraint tests |
| `apps/api/modules/identity/tests/test_seed.py` | Seed + `seed_ids.json` tests |
| `apps/api/modules/identity/tests/test_resolver.py` | Resolver: lookup, status checks, sessions, JIT, concurrency |
| `apps/api/modules/identity/tests/test_api_me.py` | `/me` + auth acceptance tests over HTTP |
| `apps/api/modules/identity/tests/test_api_directory.py` | `/organizations`, `/organizations/{id}`, `/users` |
| `apps/api/modules/identity/tests/test_api_members.py` | `/organizations/{id}/members[/{user_id}]` |
| `apps/api/modules/identity/tests/test_query_port.py` | `IdentityQueryPort` |
| `apps/api/modules/identity/tests/test_jobs.py` | Session pruning job |
| `apps/api/modules/identity/tests/test_realm.py` | Static checks of the realm import file |
| `apps/api/modules/identity/tests/test_live_stack.py` | Opt-in (`NAIS_LIVE=1`) checks against Keycloak + API through the 21051 gateway |
| `infra/keycloak/import/realm-nais.json` | Realm `nais` import (clients, mappers, user profile, 8 users) |
| `infra/keycloak/seed_ids.json` | Fixed seed UUIDs for other modules' seeds |

Spec deviation (path): the spec names `infra/keycloak/realm-nais.json`, but compose mounts `./infra/keycloak/import` into Keycloak's import dir, so the realm lives at `infra/keycloak/import/realm-nais.json`.

Test command convention: `uv run pytest <path> -v` from `/data/project/nst-nexus` (Docker must be reachable for testcontainers).

---

### Task 1: Raise the FastAPI floor (shared file change, Agent 0 approved)

**Files:**
- Modify: `pyproject.toml` (the `"fastapi>=0.115",` line)
- Modify: `uv.lock` (regenerated)

**Interfaces:**
- Consumes: nothing.
- Produces: guaranteed `fastapi>=0.121` so `Depends(get_session, scope="function")` in `api.platform.db.SessionDep` is valid for every install.

- [ ] **Step 1: Confirm the current floor**

Run: `grep -n '"fastapi' pyproject.toml`
Expected: `    "fastapi>=0.115",`

- [ ] **Step 2: Raise the floor**

In `pyproject.toml` replace `    "fastapi>=0.115",` with:

```toml
    "fastapi>=0.121",
```

- [ ] **Step 3: Relock**

Run: `uv lock && git diff --stat uv.lock`
Expected: `uv.lock` changes only in the `fastapi` specifier line of the `nais-ai-os` package (`{ name = "fastapi", specifier = ">=0.121" }`); the resolved fastapi version stays `0.142.2`.

- [ ] **Step 4: Run the SessionDep tests**

Run: `uv run pytest apps/api/platform/tests/test_db.py apps/api/platform/tests/test_write_path_e2e.py -q`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add pyproject.toml uv.lock
git commit -m "build: require fastapi>=0.121 for SessionDep Depends(scope=)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Identity schema (tables, migration, test fixtures)

**Files:**
- Create: `apps/api/modules/identity/__init__.py`
- Create: `apps/api/modules/identity/tables.py`
- Create: `apps/api/modules/identity/migrations/identity_0001_initial.py`
- Create: `apps/api/modules/identity/tests/__init__.py` (empty)
- Create: `apps/api/modules/identity/tests/conftest.py`
- Create: `apps/api/modules/identity/tests/support.py`
- Test: `apps/api/modules/identity/tests/test_schema.py`

**Interfaces:**
- Consumes: `api.platform.modules.ModuleSpec`, `api.platform.migrate.upgrade_all(url, modules)`, fixture `migrated_db` → `PgUrls(superuser, migrator, app)`.
- Produces:
  - `api.modules.identity.MODULE: ModuleSpec` (name `"identity"`, `db_schema="identity"`, `migrations_dir`).
  - `api.modules.identity.tables`: `metadata`, `organizations`, `users`, `memberships` (table `organization_memberships`), `user_sessions` — Core `Table`s with the spec §4 columns.
  - Fixtures `identity_db` (session scope, identity migrated) and `db` (function scope, identity tables truncated and `identity.*` outbox rows deleted before the test), both returning `PgUrls`.
  - `support.scalar(urls: PgUrls, sql: str, **params) -> Any`, `support.events(urls: PgUrls, event_type: str, **payload_match: str) -> list[dict[str, Any]]` (envelopes in outbox order, filtered by `payload[k] == v`).

- [ ] **Step 1: Write the fixtures, helpers and failing schema tests**

`apps/api/modules/identity/tests/__init__.py`: empty file.

`apps/api/modules/identity/tests/support.py`:

```python
"""Shared helpers for identity tests. Import as api.modules.identity.tests.support."""

from typing import Any

from sqlalchemy import text

from api.platform.db import session_factory
from api.platform.testing.fixtures import PgUrls


def scalar(urls: PgUrls, sql: str, **params: Any) -> Any:
    with session_factory(urls.app)() as session:
        return session.execute(text(sql), params).scalar_one()


def events(urls: PgUrls, event_type: str, **payload_match: str) -> list[dict[str, Any]]:
    """Outbox envelopes of one event type (oldest first) whose payload has every given key/value."""
    with session_factory(urls.app)() as session:
        rows = session.execute(
            text("SELECT envelope FROM platform.outbox_events WHERE event_type = :t ORDER BY id"),
            {"t": event_type},
        ).scalars()
        envelopes = [dict(row) for row in rows]
    return [
        env
        for env in envelopes
        if all(env["payload"].get(key) == value for key, value in payload_match.items())
    ]
```

`apps/api/modules/identity/tests/conftest.py`:

```python
"""Identity fixtures: schema migrated once per session, identity tables emptied before each test."""

from collections.abc import Iterator

import pytest
from sqlalchemy import create_engine, text

from api.modules.identity import MODULE
from api.platform.migrate import upgrade_all
from api.platform.testing.fixtures import PgUrls

IDENTITY_TABLES = (
    "identity.user_sessions, identity.organization_memberships, identity.users, identity.organizations"
)


@pytest.fixture(scope="session")
def identity_db(migrated_db: PgUrls) -> PgUrls:
    upgrade_all(migrated_db.migrator, [MODULE])
    return migrated_db


@pytest.fixture
def db(identity_db: PgUrls) -> Iterator[PgUrls]:
    engine = create_engine(identity_db.migrator)
    with engine.begin() as conn:
        conn.execute(text(f"TRUNCATE {IDENTITY_TABLES}"))
        conn.execute(text("DELETE FROM platform.outbox_events WHERE event_type LIKE 'identity.%'"))
    engine.dispose()
    yield identity_db
```

`apps/api/modules/identity/tests/test_schema.py`:

```python
import uuid
from typing import Any

import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from api.modules.identity.tests.support import scalar
from api.platform.db import session_scope
from api.platform.testing.fixtures import PgUrls


def add_org(session: Session, code: str = "inst-x", type_: str = "RESEARCH_INSTITUTE") -> uuid.UUID:
    org_id = uuid.uuid4()
    session.execute(
        text("INSERT INTO identity.organizations (organization_id, code, name, type) VALUES (:i, :c, 'X', :t)"),
        {"i": org_id, "c": code, "t": type_},
    )
    return org_id


def add_user(session: Session, email: str = "x@inst-x.local", **extra: Any) -> uuid.UUID:
    user_id = uuid.uuid4()
    session.execute(
        text(
            "INSERT INTO identity.users (user_id, keycloak_sub, email, display_name, platform_roles) "
            "VALUES (:i, :s, :e, 'X', :p)"
        ),
        {"i": user_id, "s": str(user_id), "e": email, "p": extra.get("platform_roles", [])},
    )
    return user_id


def add_membership(session: Session, user_id: uuid.UUID, org_id: uuid.UUID, roles: list[str]) -> None:
    session.execute(
        text(
            "INSERT INTO identity.organization_memberships (membership_id, user_id, organization_id, roles) "
            "VALUES (:m, :u, :o, :r)"
        ),
        {"m": uuid.uuid4(), "u": user_id, "o": org_id, "r": roles},
    )


def test_version_table_lives_in_identity_schema(db: PgUrls) -> None:
    assert scalar(db, "SELECT version_num FROM identity.alembic_version") == "identity_0001"


def test_app_role_can_write_every_table_with_defaults(db: PgUrls) -> None:
    with session_scope(db.app) as session:
        org_id = add_org(session)
        user_id = add_user(session)
        add_membership(session, user_id, org_id, ["DATA_STEWARD"])
        session.execute(
            text("INSERT INTO identity.user_sessions (session_id, user_id) VALUES ('s-1', :u)"), {"u": user_id}
        )
    assert scalar(db, "SELECT status FROM identity.users WHERE user_id = :u", u=user_id) == "ACTIVE"
    assert scalar(db, "SELECT platform_roles FROM identity.users WHERE user_id = :u", u=user_id) == []
    assert scalar(db, "SELECT status FROM identity.organization_memberships WHERE user_id = :u", u=user_id) == "ACTIVE"
    assert scalar(db, "SELECT count(*) FROM identity.user_sessions") == 1


@pytest.mark.parametrize("code", ["Inst-A", "a", "inst_a", "inst a"])
def test_org_code_must_match_pattern(db: PgUrls, code: str) -> None:
    with pytest.raises(IntegrityError), session_scope(db.app) as session:
        add_org(session, code=code)


def test_org_type_is_restricted(db: PgUrls) -> None:
    with pytest.raises(IntegrityError), session_scope(db.app) as session:
        add_org(session, type_="HOSPITAL")


def test_email_is_stored_lowercase_only(db: PgUrls) -> None:
    with pytest.raises(IntegrityError), session_scope(db.app) as session:
        add_user(session, email="Upper@inst-x.local")


def test_platform_roles_are_restricted(db: PgUrls) -> None:
    with pytest.raises(IntegrityError), session_scope(db.app) as session:
        add_user(session, platform_roles=["ORG_ADMIN"])


def test_membership_roles_are_restricted(db: PgUrls) -> None:
    with pytest.raises(IntegrityError), session_scope(db.app) as session:
        add_membership(session, add_user(session), add_org(session), ["PLATFORM_ADMIN"])


def test_one_membership_per_user(db: PgUrls) -> None:
    with pytest.raises(IntegrityError), session_scope(db.app) as session:
        user_id = add_user(session)
        add_membership(session, user_id, add_org(session, code="inst-x"), [])
        add_membership(session, user_id, add_org(session, code="inst-y"), [])


def test_search_indexes_exist(db: PgUrls) -> None:
    names = scalar(
        db, "SELECT array_agg(indexname ORDER BY indexname) FROM pg_indexes WHERE schemaname = 'identity'"
    )
    for index in (
        "ix_users_display_name_trgm",
        "ix_users_email_prefix",
        "ix_memberships_org_status",
        "ix_memberships_roles",
        "ix_user_sessions_user",
    ):
        assert index in names
```

- [ ] **Step 2: Run to verify it fails**

Run: `uv run pytest apps/api/modules/identity/tests/test_schema.py -v`
Expected: collection error `ModuleNotFoundError: No module named 'api.modules.identity'` (or `ImportError: cannot import name 'MODULE'`).

- [ ] **Step 3: Write the module package, tables and migration**

`apps/api/modules/identity/__init__.py`:

```python
"""M01 Identity & Organization: NAIS users, organizations and memberships (Keycloak authenticates, D-019)."""

from pathlib import Path

from api.platform.modules import ModuleSpec

MODULE = ModuleSpec(
    name="identity",
    db_schema="identity",
    migrations_dir=Path(__file__).parent / "migrations",
)
```

`apps/api/modules/identity/tables.py`:

```python
"""SQLAlchemy Core tables of schema identity. DDL lives in migrations/, not here."""

from sqlalchemy import Column, DateTime, MetaData, String, Table, Text
from sqlalchemy.dialects.postgresql import ARRAY, UUID

metadata = MetaData(schema="identity")

organizations = Table(
    "organizations",
    metadata,
    Column("organization_id", UUID(as_uuid=True), primary_key=True),
    Column("code", String(32), nullable=False),
    Column("name", String(200), nullable=False),
    Column("type", String(32), nullable=False),
    Column("ror_id", String(64)),
    Column("homepage_url", Text),
    Column("created_at", DateTime(timezone=True)),
    Column("updated_at", DateTime(timezone=True)),
)

users = Table(
    "users",
    metadata,
    Column("user_id", UUID(as_uuid=True), primary_key=True),
    Column("keycloak_sub", String(64), nullable=False),
    Column("email", String(320), nullable=False),
    Column("display_name", String(200), nullable=False),
    Column("status", String(16)),
    Column("platform_roles", ARRAY(Text)),
    Column("last_login_at", DateTime(timezone=True)),
    Column("created_at", DateTime(timezone=True)),
    Column("updated_at", DateTime(timezone=True)),
)

memberships = Table(
    "organization_memberships",
    metadata,
    Column("membership_id", UUID(as_uuid=True), primary_key=True),
    Column("user_id", UUID(as_uuid=True), nullable=False),
    Column("organization_id", UUID(as_uuid=True), nullable=False),
    Column("roles", ARRAY(Text)),
    Column("status", String(16)),
    Column("created_at", DateTime(timezone=True)),
    Column("updated_at", DateTime(timezone=True)),
    Column("updated_by", UUID(as_uuid=True)),
)

user_sessions = Table(
    "user_sessions",
    metadata,
    Column("session_id", String(64), primary_key=True),
    Column("user_id", UUID(as_uuid=True), nullable=False),
    Column("first_seen_at", DateTime(timezone=True)),
)
```

`apps/api/modules/identity/migrations/identity_0001_initial.py` (no `__init__.py` in `migrations/`, same as the platform's `versions/`):

```python
"""identity initial schema

Revision ID: identity_0001
Revises:
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import ARRAY, UUID

revision = "identity_0001"
down_revision = None
branch_labels = None
depends_on = None

SCHEMA = "identity"
NOW = sa.text("now()")
EMPTY_TEXT_ARRAY = sa.text("'{}'::text[]")


def _timestamps() -> list[sa.Column[sa.DateTime]]:
    return [
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=NOW),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=NOW),
    ]


def upgrade() -> None:
    # pg_trgm is installed once in schema public by the platform (init.sql, M00 kickoff, W1-D2).
    # Modules never create extensions; they reference public.gin_trgm_ops.
    op.create_table(
        "organizations",
        sa.Column("organization_id", UUID(as_uuid=True), primary_key=True),
        sa.Column("code", sa.String(32), nullable=False),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("type", sa.String(32), nullable=False),
        sa.Column("ror_id", sa.String(64), nullable=True),
        sa.Column("homepage_url", sa.Text, nullable=True),
        *_timestamps(),
        sa.UniqueConstraint("code", name="uq_organizations_code"),
        sa.CheckConstraint("code ~ '^[a-z0-9-]{2,32}$'", name="ck_organizations_code"),
        sa.CheckConstraint(
            "type IN ('RESEARCH_INSTITUTE', 'UNIVERSITY', 'COMPANY', 'PLATFORM_OPERATOR')",
            name="ck_organizations_type",
        ),
        schema=SCHEMA,
    )
    op.create_table(
        "users",
        sa.Column("user_id", UUID(as_uuid=True), primary_key=True),
        sa.Column("keycloak_sub", sa.String(64), nullable=False),
        sa.Column("email", sa.String(320), nullable=False),
        sa.Column("display_name", sa.String(200), nullable=False),
        sa.Column("status", sa.String(16), nullable=False, server_default="ACTIVE"),
        sa.Column("platform_roles", ARRAY(sa.Text), nullable=False, server_default=EMPTY_TEXT_ARRAY),
        sa.Column("last_login_at", sa.DateTime(timezone=True), nullable=True),
        *_timestamps(),
        sa.UniqueConstraint("keycloak_sub", name="uq_users_keycloak_sub"),
        sa.UniqueConstraint("email", name="uq_users_email"),
        sa.CheckConstraint("email = lower(email)", name="ck_users_email_lower"),
        sa.CheckConstraint("status IN ('ACTIVE', 'DISABLED')", name="ck_users_status"),
        sa.CheckConstraint(
            "platform_roles <@ ARRAY['PLATFORM_ADMIN']::text[]", name="ck_users_platform_roles"
        ),
        schema=SCHEMA,
    )
    op.create_table(
        "organization_memberships",
        sa.Column("membership_id", UUID(as_uuid=True), primary_key=True),
        sa.Column("user_id", UUID(as_uuid=True), sa.ForeignKey("identity.users.user_id"), nullable=False),
        sa.Column(
            "organization_id",
            UUID(as_uuid=True),
            sa.ForeignKey("identity.organizations.organization_id"),
            nullable=False,
        ),
        sa.Column("roles", ARRAY(sa.Text), nullable=False, server_default=EMPTY_TEXT_ARRAY),
        sa.Column("status", sa.String(16), nullable=False, server_default="ACTIVE"),
        *_timestamps(),
        sa.Column("updated_by", UUID(as_uuid=True), nullable=True),
        sa.UniqueConstraint("user_id", name="uq_memberships_user"),
        sa.CheckConstraint(
            "roles <@ ARRAY['ORG_ADMIN', 'DATA_STEWARD', 'RESOURCE_MANAGER']::text[]",
            name="ck_memberships_roles",
        ),
        sa.CheckConstraint("status IN ('ACTIVE', 'DISABLED')", name="ck_memberships_status"),
        schema=SCHEMA,
    )
    op.create_table(
        "user_sessions",
        sa.Column("session_id", sa.String(64), primary_key=True),
        sa.Column("user_id", UUID(as_uuid=True), sa.ForeignKey("identity.users.user_id"), nullable=False),
        sa.Column("first_seen_at", sa.DateTime(timezone=True), nullable=False, server_default=NOW),
        schema=SCHEMA,
    )
    op.execute(
        "CREATE INDEX ix_users_display_name_trgm ON identity.users "
        "USING gin (display_name public.gin_trgm_ops)"
    )
    op.create_index(
        "ix_users_email_prefix", "users", ["email"], schema=SCHEMA, postgresql_ops={"email": "text_pattern_ops"}
    )
    op.create_index(
        "ix_memberships_org_status", "organization_memberships", ["organization_id", "status"], schema=SCHEMA
    )
    op.create_index(
        "ix_memberships_roles", "organization_memberships", ["roles"], schema=SCHEMA, postgresql_using="gin"
    )
    op.create_index(
        "ix_user_sessions_user", "user_sessions", ["user_id", sa.text("first_seen_at DESC")], schema=SCHEMA
    )


def downgrade() -> None:
    op.drop_table("user_sessions", schema=SCHEMA)
    op.drop_table("organization_memberships", schema=SCHEMA)
    op.drop_table("users", schema=SCHEMA)
    op.drop_table("organizations", schema=SCHEMA)
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `uv run pytest apps/api/modules/identity/tests/test_schema.py -v`
Expected: all PASS.

- [ ] **Step 5: Lint and commit**

```bash
uv run ruff check --fix apps/api/modules/identity && uv run ruff format apps/api/modules/identity
git add apps/api/modules/identity
git commit -m "feat(identity): identity schema, tables and test fixtures

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Seed data, idempotent seed, `seed_ids.json`

**Files:**
- Create: `apps/api/modules/identity/seed_data.py`
- Create: `apps/api/modules/identity/seed.py`
- Create: `infra/keycloak/seed_ids.json`
- Modify: `apps/api/modules/identity/__init__.py` (add `seed=seed`)
- Modify: `apps/api/modules/identity/tests/support.py` (add `seed_all`)
- Modify: `apps/api/modules/identity/tests/conftest.py` (add `seeded` fixture)
- Test: `apps/api/modules/identity/tests/test_seed.py`

**Interfaces:**
- Consumes: `tables.organizations/users/memberships` (Task 2), `api.platform.outbox.outbox.write(session, event_type, payload, actor, correlation_id)`, `EventActor.system()`, `EventType`, `api.platform.ids.new_id`, `api.platform.clock.now`.
- Produces:
  - `seed_data.fixed_id(suffix: str) -> UUID`, dataclasses `SeedOrganization(organization_id, code, name, type)`, `SeedUser(user_id, email, display_name, org_code, org_roles: tuple[str, ...], platform_roles: tuple[str, ...], membership_status: str)` with property `keycloak_sub -> str`; tuples `ORGANIZATIONS`, `USERS`; dicts `ORGS_BY_CODE: dict[str, SeedOrganization]`, `USERS_BY_EMAIL: dict[str, SeedUser]`.
  - `seed.seed(session: Session) -> None` (idempotent upsert; events only for newly inserted rows; one correlation id per run).
  - `support.seed_all(urls: PgUrls) -> None`; fixture `seeded` (a `db` with the seed loaded) → `PgUrls`.

- [ ] **Step 1: Write the failing tests**

Append to `apps/api/modules/identity/tests/support.py`:

```python
def seed_all(urls: PgUrls) -> None:
    from api.modules.identity.seed import seed
    from api.platform.db import session_scope

    with session_scope(urls.app) as session:
        seed(session)
```

Append to `apps/api/modules/identity/tests/conftest.py`:

```python
@pytest.fixture
def seeded(db: PgUrls) -> PgUrls:
    from api.modules.identity.tests.support import seed_all

    seed_all(db)
    return db
```

`apps/api/modules/identity/tests/test_seed.py`:

```python
import json
import uuid

import pytest
from sqlalchemy import text

from api.modules.identity import MODULE
from api.modules.identity.seed import seed
from api.modules.identity.seed_data import ORGANIZATIONS, ORGS_BY_CODE, USERS, USERS_BY_EMAIL
from api.modules.identity.tests.support import events, scalar, seed_all
from api.platform.db import session_scope
from api.platform.seed import run_seed
from api.platform.settings import REPO_ROOT
from api.platform.testing.contracts import assert_valid_event
from api.platform.testing.fixtures import PgUrls

ORG_CREATED = "identity.organization.created.v1"
USER_CREATED = "identity.user.created.v1"


def membership(db: PgUrls, email: str, column: str) -> object:
    user_id = USERS_BY_EMAIL[email].user_id
    return scalar(db, f"SELECT {column} FROM identity.organization_memberships WHERE user_id = :u", u=user_id)


def test_seed_creates_orgs_users_and_memberships(db: PgUrls) -> None:
    seed_all(db)
    assert scalar(db, "SELECT count(*) FROM identity.organizations") == 3
    assert scalar(db, "SELECT count(*) FROM identity.users") == 8
    assert scalar(db, "SELECT count(*) FROM identity.organization_memberships") == 8
    admin = USERS_BY_EMAIL["admin@nais.local"]
    assert scalar(db, "SELECT platform_roles FROM identity.users WHERE user_id = :u", u=admin.user_id) == [
        "PLATFORM_ADMIN"
    ]
    assert scalar(db, "SELECT keycloak_sub FROM identity.users WHERE user_id = :u", u=admin.user_id) == str(
        admin.user_id
    )
    assert membership(db, "admin@nais.local", "roles") == ["ORG_ADMIN"]
    assert membership(db, "a.steward@inst-a.local", "roles") == ["DATA_STEWARD"]
    assert membership(db, "a.steward@inst-a.local", "organization_id") == ORGS_BY_CODE["inst-a"].organization_id
    assert membership(db, "b.disabled@inst-b.local", "status") == "DISABLED"
    assert membership(db, "b.researcher@inst-b.local", "roles") == []


def test_seed_emits_valid_system_events_with_one_correlation_id(db: PgUrls) -> None:
    seed_all(db)
    created = events(db, ORG_CREATED) + events(db, USER_CREATED)
    assert len(events(db, ORG_CREATED)) == 3
    assert len(events(db, USER_CREATED)) == 8
    for envelope in created:
        assert_valid_event(envelope)
        assert envelope["actor"] == {"type": "SYSTEM", "user_id": None, "organization_id": None}
    assert len({envelope["correlation_id"] for envelope in created}) == 1


def test_seed_is_idempotent_and_restores_seed_values(db: PgUrls) -> None:
    seed_all(db)
    researcher = USERS_BY_EMAIL["a.researcher@inst-a.local"]
    with session_scope(db.app) as session:
        session.execute(
            text(
                "UPDATE identity.organization_memberships SET roles = '{ORG_ADMIN}', status = 'DISABLED' "
                "WHERE user_id = :u"
            ),
            {"u": researcher.user_id},
        )
    seed_all(db)
    assert scalar(db, "SELECT count(*) FROM identity.users") == 8
    assert scalar(db, "SELECT count(*) FROM identity.organization_memberships") == 8
    assert len(events(db, ORG_CREATED)) == 3
    assert len(events(db, USER_CREATED)) == 8
    assert membership(db, "a.researcher@inst-a.local", "roles") == []
    assert membership(db, "a.researcher@inst-a.local", "status") == "ACTIVE"


def test_seed_refuses_a_user_that_took_a_seed_sub(db: PgUrls) -> None:
    researcher = USERS_BY_EMAIL["a.researcher@inst-a.local"]
    with session_scope(db.app) as session:
        session.execute(
            text(
                "INSERT INTO identity.users (user_id, keycloak_sub, email, display_name) "
                "VALUES (:i, :s, 'someone@inst-a.local', 'Someone')"
            ),
            {"i": uuid.uuid4(), "s": researcher.keycloak_sub},
        )
    with pytest.raises(RuntimeError, match="a.researcher@inst-a.local"):
        seed_all(db)
    assert scalar(db, "SELECT count(*) FROM identity.organizations") == 0  # whole seed rolled back


def test_module_exposes_seed_to_the_platform_orchestrator(db: PgUrls) -> None:
    assert MODULE.seed is seed
    assert run_seed([MODULE], url=db.app) == ["identity"]
    assert scalar(db, "SELECT count(*) FROM identity.users") == 8


def test_seed_ids_file_matches_seed_data() -> None:
    data = json.loads((REPO_ROOT / "infra" / "keycloak" / "seed_ids.json").read_text(encoding="utf-8"))
    assert data["organizations"] == {org.code: str(org.organization_id) for org in ORGANIZATIONS}
    assert data["users"] == {user.email: str(user.user_id) for user in USERS}
```

- [ ] **Step 2: Run to verify it fails**

Run: `uv run pytest apps/api/modules/identity/tests/test_seed.py -v`
Expected: collection error `ModuleNotFoundError: No module named 'api.modules.identity.seed'`.

- [ ] **Step 3: Implement seed data, seed and the ids file**

`apps/api/modules/identity/seed_data.py`:

```python
"""Seed organizations and users (10_SEED_DATA.md §2-3). Kept in code: seed() must not read docs at runtime.

Keycloak user id == NAIS user_id == token sub (infra/keycloak/import/realm-nais.json uses the same ids).
"""

from dataclasses import dataclass
from uuid import UUID


def fixed_id(suffix: str) -> UUID:
    """00000000-0000-7000-8000-00000000XXXX with the given hex suffix."""
    return UUID(f"00000000-0000-7000-8000-{suffix.rjust(12, '0')}")


@dataclass(frozen=True)
class SeedOrganization:
    organization_id: UUID
    code: str
    name: str
    type: str


@dataclass(frozen=True)
class SeedUser:
    user_id: UUID
    email: str
    display_name: str
    org_code: str
    org_roles: tuple[str, ...] = ()
    platform_roles: tuple[str, ...] = ()
    membership_status: str = "ACTIVE"

    @property
    def keycloak_sub(self) -> str:
        return str(self.user_id)


ORGANIZATIONS: tuple[SeedOrganization, ...] = (
    SeedOrganization(fixed_id("1"), "nais", "NAIS", "PLATFORM_OPERATOR"),
    SeedOrganization(fixed_id("a"), "inst-a", "Institute A", "RESEARCH_INSTITUTE"),
    SeedOrganization(fixed_id("b"), "inst-b", "Institute B", "RESEARCH_INSTITUTE"),
)

USERS: tuple[SeedUser, ...] = (
    SeedUser(fixed_id("101"), "admin@nais.local", "NAIS Admin", "nais", ("ORG_ADMIN",), ("PLATFORM_ADMIN",)),
    SeedUser(fixed_id("a01"), "a.admin@inst-a.local", "A Admin", "inst-a", ("ORG_ADMIN",)),
    SeedUser(fixed_id("a02"), "a.researcher@inst-a.local", "A Researcher", "inst-a"),
    SeedUser(fixed_id("a03"), "a.steward@inst-a.local", "A Steward", "inst-a", ("DATA_STEWARD",)),
    SeedUser(fixed_id("b01"), "b.admin@inst-b.local", "B Admin", "inst-b", ("ORG_ADMIN",)),
    SeedUser(fixed_id("b02"), "b.researcher@inst-b.local", "B Researcher", "inst-b"),
    SeedUser(fixed_id("b03"), "b.steward@inst-b.local", "B Steward", "inst-b", ("DATA_STEWARD",)),
    SeedUser(fixed_id("b04"), "b.disabled@inst-b.local", "B Disabled", "inst-b", membership_status="DISABLED"),
)

ORGS_BY_CODE: dict[str, SeedOrganization] = {org.code: org for org in ORGANIZATIONS}
USERS_BY_EMAIL: dict[str, SeedUser] = {user.email: user for user in USERS}
```

`apps/api/modules/identity/seed.py`:

```python
"""Idempotent identity seed (upsert by fixed id). Events only for rows this run actually inserted."""

from uuid import UUID

from sqlalchemy import or_, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.orm import Session

from api.modules.identity.seed_data import ORGANIZATIONS, ORGS_BY_CODE, USERS, SeedOrganization, SeedUser
from api.modules.identity.tables import memberships, organizations, users
from api.platform import clock
from api.platform.events import EventActor
from api.platform.generated.event_types import EventType
from api.platform.ids import new_id
from api.platform.outbox import outbox


def seed(session: Session) -> None:
    correlation_id = new_id()
    for org in ORGANIZATIONS:
        _seed_organization(session, org, correlation_id)
    for user in USERS:
        _seed_user(session, user, correlation_id)


def _seed_organization(session: Session, org: SeedOrganization, correlation_id: UUID) -> None:
    created = session.execute(
        pg_insert(organizations)
        .values(organization_id=org.organization_id, code=org.code, name=org.name, type=org.type)
        .on_conflict_do_nothing(index_elements=[organizations.c.organization_id])
        .returning(organizations.c.organization_id)
    ).first()
    if created is None:
        session.execute(
            update(organizations)
            .where(organizations.c.organization_id == org.organization_id)
            .values(code=org.code, name=org.name, type=org.type, updated_at=clock.now())
        )
        return
    outbox.write(
        session,
        EventType.IDENTITY_ORGANIZATION_CREATED_V1,
        {"organization_id": str(org.organization_id), "code": org.code, "name": org.name, "type": org.type},
        EventActor.system(),
        correlation_id,
    )


def _seed_user(session: Session, user: SeedUser, correlation_id: UUID) -> None:
    organization_id = ORGS_BY_CODE[user.org_code].organization_id
    clash = session.execute(
        select(users.c.user_id).where(
            or_(users.c.keycloak_sub == user.keycloak_sub, users.c.email == user.email),
            users.c.user_id != user.user_id,
        )
    ).first()
    if clash is not None:
        raise RuntimeError(
            f"seed user {user.email} conflicts with existing user {clash.user_id} "
            "(same Keycloak sub or email); remove that user before seeding"
        )
    created = session.execute(
        pg_insert(users)
        .values(
            user_id=user.user_id,
            keycloak_sub=user.keycloak_sub,
            email=user.email,
            display_name=user.display_name,
            platform_roles=list(user.platform_roles),
        )
        .on_conflict_do_nothing(index_elements=[users.c.user_id])
        .returning(users.c.user_id)
    ).first()
    if created is None:
        session.execute(
            update(users)
            .where(users.c.user_id == user.user_id)
            .values(
                email=user.email,
                display_name=user.display_name,
                platform_roles=list(user.platform_roles),
                status="ACTIVE",
                updated_at=clock.now(),
            )
        )
    roles = sorted(user.org_roles)
    session.execute(
        pg_insert(memberships)
        .values(
            membership_id=new_id(),
            user_id=user.user_id,
            organization_id=organization_id,
            roles=roles,
            status=user.membership_status,
        )
        .on_conflict_do_update(
            index_elements=[memberships.c.user_id],
            set_={
                "organization_id": organization_id,
                "roles": roles,
                "status": user.membership_status,
                "updated_at": clock.now(),
                "updated_by": None,
            },
        )
    )
    if created is not None:
        outbox.write(
            session,
            EventType.IDENTITY_USER_CREATED_V1,
            {
                "user_id": str(user.user_id),
                "organization_id": str(organization_id),
                "display_name": user.display_name,
                "email": user.email,
            },
            EventActor.system(),
            correlation_id,
        )
```

`infra/keycloak/seed_ids.json`:

```json
{
  "$comment": "Fixed seed UUIDs (NAIS_PRD/10_SEED_DATA.md §2-3). Keycloak user id == NAIS user_id == token sub. Other modules' seeds reference these; source of truth is apps/api/modules/identity/seed_data.py (a test keeps them equal).",
  "organizations": {
    "nais": "00000000-0000-7000-8000-000000000001",
    "inst-a": "00000000-0000-7000-8000-00000000000a",
    "inst-b": "00000000-0000-7000-8000-00000000000b"
  },
  "users": {
    "admin@nais.local": "00000000-0000-7000-8000-000000000101",
    "a.admin@inst-a.local": "00000000-0000-7000-8000-000000000a01",
    "a.researcher@inst-a.local": "00000000-0000-7000-8000-000000000a02",
    "a.steward@inst-a.local": "00000000-0000-7000-8000-000000000a03",
    "b.admin@inst-b.local": "00000000-0000-7000-8000-000000000b01",
    "b.researcher@inst-b.local": "00000000-0000-7000-8000-000000000b02",
    "b.steward@inst-b.local": "00000000-0000-7000-8000-000000000b03",
    "b.disabled@inst-b.local": "00000000-0000-7000-8000-000000000b04"
  }
}
```

Replace `apps/api/modules/identity/__init__.py` with:

```python
"""M01 Identity & Organization: NAIS users, organizations and memberships (Keycloak authenticates, D-019)."""

from pathlib import Path

from api.modules.identity.seed import seed
from api.platform.modules import ModuleSpec

MODULE = ModuleSpec(
    name="identity",
    db_schema="identity",
    migrations_dir=Path(__file__).parent / "migrations",
    seed=seed,
)
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `uv run pytest apps/api/modules/identity/tests/test_seed.py apps/api/modules/identity/tests/test_schema.py -v`
Expected: all PASS.

- [ ] **Step 5: Lint and commit**

```bash
uv run ruff check --fix apps/api/modules/identity && uv run ruff format apps/api/modules/identity
git add apps/api/modules/identity infra/keycloak/seed_ids.json
git commit -m "feat(identity): idempotent seed of institutes and users with fixed ids

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: `IdentityPrincipalResolver` (lookup, status checks, JIT, once-per-session login)

**Files:**
- Create: `apps/api/modules/identity/resolver.py`
- Modify: `apps/api/modules/identity/tests/support.py` (add `claims_for`)
- Test: `apps/api/modules/identity/tests/test_resolver.py`

**Interfaces:**
- Consumes: tables (Task 2), `seed_data.USERS_BY_EMAIL` (Task 3, tests), `api.platform.auth.CurrentUser`, `api.platform.db.session_scope`, `outbox.write`, `EventActor`, `ApiError`, `ErrorCode`.
- Produces:
  - `resolver.SessionFactory = Callable[[], AbstractContextManager[Session]]` (a zero-arg callable returning a committing session context, e.g. `session_scope` or `lambda: session_scope(url)`).
  - `resolver.session_id_for(claims: dict[str, Any]) -> str`.
  - `resolver.IdentityPrincipalResolver(sessions: SessionFactory = session_scope)` with `resolve(claims: dict[str, Any], correlation_id: UUID) -> CurrentUser` (satisfies `api.platform.auth.PrincipalResolver`). Raises `ApiError` with `UNAUTHENTICATED`, `ORGANIZATION_UNKNOWN`, `USER_DISABLED`, `MEMBERSHIP_DISABLED`, `CONFLICT`.
  - `support.claims_for(email: str, *, sid: str | None = "s-1", **overrides: Any) -> dict[str, Any]`.

Resolution order (spec §6, steps 2–8): unknown/missing `org_code` → `ORGANIZATION_UNKNOWN`; unknown `sub` → JIT (users + membership roles `{}` ACTIVE + `user.created`, email clash → `CONFLICT`); user DISABLED → `USER_DISABLED`; no membership → `ORGANIZATION_UNKNOWN`; membership DISABLED → `MEMBERSHIP_DISABLED`; membership org ≠ token org → `ORGANIZATION_UNKNOWN`; then `user_sessions` insert-once → `last_login_at` + `logged_in`. Everything happens in one transaction; any error rolls it back (so a rejected request provisions nothing and logs no login).

- [ ] **Step 1: Write the failing tests**

Append to `apps/api/modules/identity/tests/support.py`:

```python
def claims_for(email: str, *, sid: str | None = "s-1", **overrides: Any) -> dict[str, Any]:
    """Verified-token claims for a seed user, as the platform hands them to the resolver."""
    import time

    from api.modules.identity.seed_data import USERS_BY_EMAIL

    user = USERS_BY_EMAIL[email]
    claims: dict[str, Any] = {
        "sub": user.keycloak_sub,
        "email": user.email,
        "name": user.display_name,
        "org_code": user.org_code,
        "iat": int(time.time()),
    }
    if sid is not None:
        claims["sid"] = sid
    claims.update(overrides)
    return claims
```

`apps/api/modules/identity/tests/test_resolver.py`:

```python
import hashlib
import threading
import uuid
from typing import Any

import pytest
from sqlalchemy import text

from api.modules.identity.resolver import IdentityPrincipalResolver, session_id_for
from api.modules.identity.seed_data import ORGS_BY_CODE, USERS_BY_EMAIL
from api.modules.identity.tests.support import claims_for, events, scalar
from api.platform.auth import CurrentUser
from api.platform.db import session_scope
from api.platform.errors import ApiError
from api.platform.testing.contracts import assert_valid_event
from api.platform.testing.fixtures import PgUrls

LOGGED_IN = "identity.user.logged_in.v1"
USER_CREATED = "identity.user.created.v1"
RESEARCHER = "a.researcher@inst-a.local"


def resolver_for(urls: PgUrls) -> IdentityPrincipalResolver:
    return IdentityPrincipalResolver(lambda: session_scope(urls.app))


def resolve(urls: PgUrls, claims: dict[str, Any]) -> CurrentUser:
    return resolver_for(urls).resolve(claims, uuid.uuid4())


def error_of(urls: PgUrls, claims: dict[str, Any]) -> str:
    with pytest.raises(ApiError) as caught:
        resolve(urls, claims)
    return caught.value.code.value


def execute(urls: PgUrls, sql: str, **params: Any) -> None:
    with session_scope(urls.app) as session:
        session.execute(text(sql), params)


def new_user_claims(**overrides: Any) -> dict[str, Any]:
    claims: dict[str, Any] = {
        "sub": "kc-new-user",
        "email": "new.user@inst-a.local",
        "name": "New User",
        "org_code": "inst-a",
        "sid": "s-new",
        "iat": 1_790_000_000,
    }
    claims.update(overrides)
    return claims


# --- existing users (M01-AT-01, AT-03, AT-04, AT-05, AT-15) ---


def test_seed_users_resolve_to_their_institute(seeded: PgUrls) -> None:
    a = resolve(seeded, claims_for(RESEARCHER))
    b = resolve(seeded, claims_for("b.researcher@inst-b.local"))
    assert a.user_id == USERS_BY_EMAIL[RESEARCHER].user_id
    assert a.organization_id == ORGS_BY_CODE["inst-a"].organization_id
    assert b.organization_id == ORGS_BY_CODE["inst-b"].organization_id
    assert a.org_roles == frozenset() and a.platform_roles == frozenset()
    assert a.session_id == "s-1" and a.display_name == "A Researcher"


def test_roles_come_from_the_database(seeded: PgUrls) -> None:
    admin = resolve(seeded, claims_for("admin@nais.local"))
    assert admin.is_platform_admin
    assert admin.has_org_role(ORGS_BY_CODE["nais"].organization_id, "ORG_ADMIN")
    steward = resolve(seeded, claims_for("a.steward@inst-a.local"))
    assert steward.org_roles == frozenset({"DATA_STEWARD"})


def test_role_changes_apply_on_the_next_request(seeded: PgUrls) -> None:
    claims = claims_for(RESEARCHER)
    assert resolve(seeded, claims).org_roles == frozenset()
    execute(
        seeded,
        "UPDATE identity.organization_memberships SET roles = '{DATA_STEWARD}' WHERE user_id = :u",
        u=USERS_BY_EMAIL[RESEARCHER].user_id,
    )
    assert resolve(seeded, claims).org_roles == frozenset({"DATA_STEWARD"})


def test_login_event_once_per_session(seeded: PgUrls) -> None:
    user_id = str(USERS_BY_EMAIL[RESEARCHER].user_id)
    correlation_id = uuid.uuid4()
    for _ in range(3):
        resolver_for(seeded).resolve(claims_for(RESEARCHER, sid="sess-1"), correlation_id)
    logged = events(seeded, LOGGED_IN, user_id=user_id)
    assert len(logged) == 1
    assert_valid_event(logged[0])
    assert logged[0]["payload"] == {
        "user_id": user_id,
        "organization_id": str(ORGS_BY_CODE["inst-a"].organization_id),
        "session_id": "sess-1",
    }
    assert logged[0]["actor"] == {
        "type": "USER",
        "user_id": user_id,
        "organization_id": str(ORGS_BY_CODE["inst-a"].organization_id),
    }
    assert logged[0]["correlation_id"] == str(correlation_id)
    assert scalar(
        seeded,
        "SELECT last_login_at IS NOT NULL FROM identity.users WHERE user_id = :u",
        u=USERS_BY_EMAIL[RESEARCHER].user_id,
    )

    resolve(seeded, claims_for(RESEARCHER, sid="sess-2"))
    assert [e["payload"]["session_id"] for e in events(seeded, LOGGED_IN, user_id=user_id)] == [
        "sess-1",
        "sess-2",
    ]


def test_session_id_fallbacks(seeded: PgUrls) -> None:
    no_sid = claims_for(RESEARCHER, sid=None, iat=1_790_000_000)
    expected = hashlib.sha256(f"{no_sid['sub']}:1790000000".encode()).hexdigest()
    assert session_id_for(no_sid) == expected
    long_sid = "x" * 100
    assert session_id_for(claims_for(RESEARCHER, sid=long_sid)) == hashlib.sha256(long_sid.encode()).hexdigest()

    assert resolve(seeded, no_sid).session_id == expected
    assert resolve(seeded, no_sid).session_id == expected
    assert len(resolve(seeded, claims_for(RESEARCHER, sid=long_sid)).session_id) == 64
    user_id = str(USERS_BY_EMAIL[RESEARCHER].user_id)
    assert len(events(seeded, LOGGED_IN, user_id=user_id)) == 2


def test_disabled_membership_is_rejected_without_login_event(seeded: PgUrls) -> None:
    assert error_of(seeded, claims_for("b.disabled@inst-b.local")) == "MEMBERSHIP_DISABLED"
    disabled_id = str(USERS_BY_EMAIL["b.disabled@inst-b.local"].user_id)
    assert events(seeded, LOGGED_IN, user_id=disabled_id) == []


def test_disabled_user_is_rejected(seeded: PgUrls) -> None:
    execute(
        seeded,
        "UPDATE identity.users SET status = 'DISABLED' WHERE user_id = :u",
        u=USERS_BY_EMAIL[RESEARCHER].user_id,
    )
    assert error_of(seeded, claims_for(RESEARCHER)) == "USER_DISABLED"


@pytest.mark.parametrize("org_code", ["unknown-org", None, 42])
def test_unknown_or_missing_org_code_is_rejected(seeded: PgUrls, org_code: object) -> None:
    claims = claims_for(RESEARCHER)
    if org_code is None:
        del claims["org_code"]
    else:
        claims["org_code"] = org_code
    assert error_of(seeded, claims) == "ORGANIZATION_UNKNOWN"


def test_token_org_must_match_membership_org(seeded: PgUrls) -> None:
    assert error_of(seeded, claims_for(RESEARCHER, org_code="inst-b")) == "ORGANIZATION_UNKNOWN"


@pytest.mark.parametrize("sub", ["", None, "s" * 65])
def test_unusable_sub_is_unauthenticated(seeded: PgUrls, sub: object) -> None:
    assert error_of(seeded, claims_for(RESEARCHER, sub=sub)) == "UNAUTHENTICATED"


# --- JIT provisioning (M01-AT-02, AT-07) ---


def test_first_request_provisions_user_and_membership(seeded: PgUrls) -> None:
    correlation_id = uuid.uuid4()
    user = resolver_for(seeded).resolve(new_user_claims(email="New.User@Inst-A.local"), correlation_id)
    assert user.organization_id == ORGS_BY_CODE["inst-a"].organization_id
    assert user.org_roles == frozenset() and user.display_name == "New User"
    assert scalar(seeded, "SELECT email FROM identity.users WHERE keycloak_sub = 'kc-new-user'") == (
        "new.user@inst-a.local"
    )
    assert scalar(
        seeded, "SELECT roles FROM identity.organization_memberships WHERE user_id = :u", u=user.user_id
    ) == []
    created = events(seeded, USER_CREATED, user_id=str(user.user_id))
    assert len(created) == 1
    assert_valid_event(created[0])
    assert created[0]["payload"] == {
        "user_id": str(user.user_id),
        "organization_id": str(ORGS_BY_CODE["inst-a"].organization_id),
        "display_name": "New User",
        "email": "new.user@inst-a.local",
    }
    assert created[0]["actor"]["type"] == "USER" and created[0]["actor"]["user_id"] == str(user.user_id)
    assert created[0]["correlation_id"] == str(correlation_id)
    assert len(events(seeded, LOGGED_IN, user_id=str(user.user_id))) == 1

    again = resolve(seeded, new_user_claims(sid="s-new-2"))
    assert again.user_id == user.user_id
    assert len(events(seeded, USER_CREATED, user_id=str(user.user_id))) == 1


def test_display_name_falls_back_to_username_then_email(seeded: PgUrls) -> None:
    claims = new_user_claims(preferred_username="newbie")
    del claims["name"]
    assert resolve(seeded, claims).display_name == "newbie"
    bare = new_user_claims(sub="kc-bare", email="bare.person@inst-a.local", sid="s-bare")
    del bare["name"]
    assert resolve(seeded, bare).display_name == "bare.person"


def test_email_owned_by_another_sub_is_conflict(seeded: PgUrls) -> None:
    claims = new_user_claims(sub="kc-imposter", email="A.Researcher@inst-a.local")
    assert error_of(seeded, claims) == "CONFLICT"
    assert scalar(seeded, "SELECT count(*) FROM identity.users WHERE keycloak_sub = 'kc-imposter'") == 0


def test_unknown_org_provisions_nothing(seeded: PgUrls) -> None:
    assert error_of(seeded, new_user_claims(org_code="unknown-org")) == "ORGANIZATION_UNKNOWN"
    assert scalar(seeded, "SELECT count(*) FROM identity.users WHERE keycloak_sub = 'kc-new-user'") == 0
    assert events(seeded, USER_CREATED, email="new.user@inst-a.local") == []


def test_missing_email_cannot_provision(seeded: PgUrls) -> None:
    claims = new_user_claims()
    del claims["email"]
    assert error_of(seeded, claims) == "UNAUTHENTICATED"


def test_parallel_first_requests_provision_once(seeded: PgUrls) -> None:
    resolver = resolver_for(seeded)
    barrier = threading.Barrier(4)
    results: list[CurrentUser] = []
    errors: list[BaseException] = []

    def call() -> None:
        barrier.wait()
        try:
            results.append(resolver.resolve(new_user_claims(), uuid.uuid4()))
        except BaseException as exc:  # collected and asserted below
            errors.append(exc)

    threads = [threading.Thread(target=call) for _ in range(4)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert errors == []
    assert len({user.user_id for user in results}) == 1
    user_id = str(results[0].user_id)
    assert scalar(seeded, "SELECT count(*) FROM identity.users WHERE keycloak_sub = 'kc-new-user'") == 1
    assert len(events(seeded, USER_CREATED, user_id=user_id)) == 1
    assert len(events(seeded, LOGGED_IN, user_id=user_id)) == 1
```

- [ ] **Step 2: Run to verify it fails**

Run: `uv run pytest apps/api/modules/identity/tests/test_resolver.py -v`
Expected: collection error `ModuleNotFoundError: No module named 'api.modules.identity.resolver'`.

- [ ] **Step 3: Implement the resolver**

`apps/api/modules/identity/resolver.py`:

```python
"""M01 PrincipalResolver (spec §6): verified token claims -> CurrentUser.

Runs in its own short transaction (the platform auth dependency has no request session). Roles and status are read
on every call (no cache), so DISABLED takes effect on the next request.
"""

import hashlib
from collections.abc import Callable
from contextlib import AbstractContextManager
from typing import Any
from uuid import UUID

from sqlalchemy import Row, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from api.modules.identity.tables import memberships, organizations, user_sessions, users
from api.platform import clock
from api.platform.auth import CurrentUser
from api.platform.db import session_scope
from api.platform.errors import ApiError
from api.platform.events import EventActor
from api.platform.generated.error_codes import ErrorCode
from api.platform.generated.event_types import EventType
from api.platform.ids import new_id
from api.platform.outbox import outbox

SessionFactory = Callable[[], AbstractContextManager[Session]]

MAX_SUB_LENGTH = 64
MAX_SESSION_ID_LENGTH = 64
MAX_EMAIL_LENGTH = 320
MAX_DISPLAY_NAME_LENGTH = 200


def session_id_for(claims: dict[str, Any]) -> str:
    """The token's sid; sha256(sid) when it does not fit the column; sha256("<sub>:<iat>") without a sid."""
    sid = claims.get("sid")
    if isinstance(sid, str) and sid:
        if len(sid) <= MAX_SESSION_ID_LENGTH:
            return sid
        return hashlib.sha256(sid.encode()).hexdigest()
    return hashlib.sha256(f"{claims['sub']}:{claims.get('iat')}".encode()).hexdigest()


def _display_name(claims: dict[str, Any], email: str) -> str:
    for key in ("name", "preferred_username"):
        value = claims.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()[:MAX_DISPLAY_NAME_LENGTH]
    return email.split("@", 1)[0][:MAX_DISPLAY_NAME_LENGTH]


def _user_actor(user_id: UUID, organization_id: UUID) -> EventActor:
    return EventActor(type="USER", user_id=user_id, organization_id=organization_id)


class IdentityPrincipalResolver:
    def __init__(self, sessions: SessionFactory = session_scope) -> None:
        self._sessions = sessions

    def resolve(self, claims: dict[str, Any], correlation_id: UUID) -> CurrentUser:
        sub = claims.get("sub")
        if not isinstance(sub, str) or not sub or len(sub) > MAX_SUB_LENGTH:
            raise ApiError(ErrorCode.UNAUTHENTICATED)
        with self._sessions() as session:
            organization_id = self._organization_id(session, claims.get("org_code"))
            row = self._load(session, sub)
            if row is None:
                self._provision(session, claims, sub, organization_id, correlation_id)
                row = self._load(session, sub)
                if row is None:
                    raise RuntimeError("provisioned user is not visible")
            self._check(row, organization_id)
            session_id = session_id_for(claims)
            self._record_session(session, row, session_id, correlation_id)
            return CurrentUser(
                user_id=row.user_id,
                organization_id=row.organization_id,
                org_roles=frozenset(row.roles),
                platform_roles=frozenset(row.platform_roles),
                session_id=session_id,
                display_name=row.display_name,
            )

    @staticmethod
    def _organization_id(session: Session, org_code: object) -> UUID:
        if isinstance(org_code, str) and org_code:
            found = session.execute(
                select(organizations.c.organization_id).where(organizations.c.code == org_code)
            ).first()
            if found is not None:
                return UUID(str(found.organization_id))
        raise ApiError(ErrorCode.ORGANIZATION_UNKNOWN)

    @staticmethod
    def _load(session: Session, sub: str) -> Row[Any] | None:
        return session.execute(
            select(
                users.c.user_id,
                users.c.status.label("user_status"),
                users.c.platform_roles,
                users.c.display_name,
                memberships.c.organization_id,
                memberships.c.roles,
                memberships.c.status.label("membership_status"),
            )
            .select_from(users.outerjoin(memberships, memberships.c.user_id == users.c.user_id))
            .where(users.c.keycloak_sub == sub)
        ).first()

    @staticmethod
    def _check(row: Row[Any], organization_id: UUID) -> None:
        if row.user_status != "ACTIVE":
            raise ApiError(ErrorCode.USER_DISABLED)
        if row.membership_status is None:
            raise ApiError(ErrorCode.ORGANIZATION_UNKNOWN)
        if row.membership_status != "ACTIVE":
            raise ApiError(ErrorCode.MEMBERSHIP_DISABLED)
        if row.organization_id != organization_id:
            raise ApiError(ErrorCode.ORGANIZATION_UNKNOWN, "Token org_code does not match your organization.")

    def _provision(
        self,
        session: Session,
        claims: dict[str, Any],
        sub: str,
        organization_id: UUID,
        correlation_id: UUID,
    ) -> None:
        raw_email = claims.get("email")
        if not isinstance(raw_email, str) or "@" not in raw_email:
            raise ApiError(ErrorCode.UNAUTHENTICATED, "Token has no usable email claim.")
        email = raw_email.strip().lower()
        if len(email) > MAX_EMAIL_LENGTH:
            raise ApiError(ErrorCode.UNAUTHENTICATED, "Token email claim is too long.")
        taken = session.execute(
            select(users.c.user_id).where(users.c.email == email, users.c.keycloak_sub != sub)
        ).first()
        if taken is not None:
            raise ApiError(ErrorCode.CONFLICT, "This email already belongs to another account.")
        display_name = _display_name(claims, email)
        user_id = new_id()
        try:
            with session.begin_nested():
                created = session.execute(
                    pg_insert(users)
                    .values(user_id=user_id, keycloak_sub=sub, email=email, display_name=display_name)
                    .on_conflict_do_nothing(index_elements=[users.c.keycloak_sub])
                    .returning(users.c.user_id)
                ).first()
        except IntegrityError as exc:  # email taken by a concurrent request with a different sub
            if self._load(session, sub) is None:
                raise ApiError(ErrorCode.CONFLICT, "This email already belongs to another account.") from exc
            return
        if created is None:  # a concurrent request provisioned this sub first
            return
        session.execute(
            pg_insert(memberships).values(
                membership_id=new_id(), user_id=user_id, organization_id=organization_id
            )
        )
        outbox.write(
            session,
            EventType.IDENTITY_USER_CREATED_V1,
            {
                "user_id": str(user_id),
                "organization_id": str(organization_id),
                "display_name": display_name,
                "email": email,
            },
            _user_actor(user_id, organization_id),
            correlation_id,
        )

    @staticmethod
    def _record_session(session: Session, row: Row[Any], session_id: str, correlation_id: UUID) -> None:
        inserted = session.execute(
            pg_insert(user_sessions)
            .values(session_id=session_id, user_id=row.user_id)
            .on_conflict_do_nothing(index_elements=[user_sessions.c.session_id])
            .returning(user_sessions.c.session_id)
        ).first()
        if inserted is None:
            return
        session.execute(update(users).where(users.c.user_id == row.user_id).values(last_login_at=clock.now()))
        outbox.write(
            session,
            EventType.IDENTITY_USER_LOGGED_IN_V1,
            {
                "user_id": str(row.user_id),
                "organization_id": str(row.organization_id),
                "session_id": session_id,
            },
            _user_actor(row.user_id, row.organization_id),
            correlation_id,
        )
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `uv run pytest apps/api/modules/identity/tests/test_resolver.py -v`
Expected: all PASS. If `test_parallel_first_requests_provision_once` fails with a 409/`CONFLICT` in `errors`, the savepoint branch is wrong — the loser must re-load by `sub` and return, not raise.

- [ ] **Step 5: Lint and commit**

```bash
uv run ruff check --fix apps/api/modules/identity && uv run ruff format apps/api/modules/identity
git add apps/api/modules/identity
git commit -m "feat(identity): PrincipalResolver with JIT provisioning and per-session login audit

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Wire the resolver and serve `GET /me` (auth acceptance tests over HTTP)

**Files:**
- Create: `apps/api/modules/identity/public.py`
- Create: `apps/api/modules/identity/schemas.py`
- Create: `apps/api/modules/identity/directory.py`
- Create: `apps/api/modules/identity/router.py`
- Modify: `apps/api/modules/identity/__init__.py` (router, `wire`, `wire_ports`)
- Modify: `apps/api/modules/identity/tests/support.py` (add `ISSUER`, `make_client`, `token_for`, `bearer`)
- Test: `apps/api/modules/identity/tests/test_api_me.py`

**Interfaces:**
- Consumes: `IdentityPrincipalResolver`, `SessionFactory` (Task 4); `api.platform.auth.CurrentUserDep`, `PrincipalResolver`, `TokenVerifier`, `get_token_verifier`; `api.platform.db.SessionDep`, `session_scope`; `api.platform.testing.app.create_test_app`; `api.platform.testing.tokens.FakeIssuer`.
- Produces:
  - `public.OrganizationSummary(organization_id: UUID, code: str, name: str, type: Literal[...])`, `public.IdentityPublicProfile(user_id: UUID, display_name: str, organization_id: UUID, organization_name: str | None, status: Literal["ACTIVE","DISABLED"])` — frozen Pydantic models, field-identical to the openapi components.
  - `schemas.MeOut`, `schemas.OrganizationOut`, `schemas.MembershipOut`, `schemas.MemberUpdateIn`.
  - `directory.get_me(session: Session, user_id: UUID) -> MeOut`.
  - `router.router: APIRouter` with `GET /me` (operationId `getMe`).
  - `api.modules.identity.wire_ports(sessions: SessionFactory = session_scope) -> None` (provides `PrincipalResolver`), `wire() -> None`.
  - `support.ISSUER: FakeIssuer`, `support.make_client(urls: PgUrls, *extra: ModuleSpec) -> TestClient` (app with identity + extra modules, fake JWKS, ports bound to the test DB), `support.token_for(email: str, *, sid: str = "s-1", **claims: Any) -> str`, `support.bearer(token: str) -> dict[str, str]`.

Why module-local DTOs: the generated `nais_contracts.api_models` use `EmailStr` (rejects the seed `.local` addresses) and `Id` RootModels (callers would need `.root`). The local models carry the same fields; `assert_matches_response` proves they match openapi.

- [ ] **Step 1: Write the failing tests**

Add to the import block at the top of `apps/api/modules/identity/tests/support.py`:

```python
from fastapi.testclient import TestClient

from api.platform.modules import ModuleSpec
from api.platform.testing.tokens import FakeIssuer
```

Then append to the same file:

```python
ISSUER = FakeIssuer()


def make_client(urls: PgUrls, *extra: ModuleSpec) -> TestClient:
    """Test app with identity (+ extra probe modules), fake JWKS, and identity ports bound to the test DB."""
    from api.modules.identity import MODULE, wire_ports
    from api.platform.auth import TokenVerifier, get_token_verifier
    from api.platform.db import session_scope
    from api.platform.settings import Settings
    from api.platform.testing.app import create_test_app

    app = create_test_app(modules=[MODULE, *extra], settings=Settings(database_url=urls.app))
    app.dependency_overrides[get_token_verifier] = lambda: TokenVerifier(
        issuer=ISSUER.issuer, audience=ISSUER.audience, jwk_client=ISSUER.jwk_client()
    )
    # create_test_app ran MODULE.wire() against the default DATABASE_URL; rebind to the test database.
    wire_ports(lambda: session_scope(urls.app))
    return TestClient(app, raise_server_exceptions=False)


def token_for(email: str, *, sid: str = "s-1", **claims: Any) -> str:
    from api.modules.identity.seed_data import USERS_BY_EMAIL

    user = USERS_BY_EMAIL[email]
    base: dict[str, Any] = {
        "sub": user.keycloak_sub,
        "email": user.email,
        "name": user.display_name,
        "org_code": user.org_code,
        "sid": sid,
    }
    base.update(claims)
    return ISSUER.token(**base)


def bearer(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}
```

`apps/api/modules/identity/tests/test_api_me.py`:

```python
import pytest
from fastapi import APIRouter

from api.modules.identity.seed_data import ORGS_BY_CODE, USERS_BY_EMAIL
from api.modules.identity.tests.support import ISSUER, bearer, events, make_client, scalar, token_for
from api.platform.auth import CurrentUserDep
from api.platform.modules import ModuleSpec
from api.platform.testing.contracts import assert_matches_response, assert_valid_event
from api.platform.testing.fixtures import PgUrls
from api.platform.testing.tokens import FakeIssuer

LOGGED_IN = "identity.user.logged_in.v1"
USER_CREATED = "identity.user.created.v1"
RESEARCHER = "a.researcher@inst-a.local"


def probe_module() -> ModuleSpec:
    """Stand-ins for other modules' endpoints: every route depends on CurrentUser, like M02/M03 will."""
    router = APIRouter()

    @router.get("/projects")
    def projects(user: CurrentUserDep) -> dict[str, str]:
        return {"user_id": str(user.user_id)}

    @router.get("/datasets")
    def datasets(user: CurrentUserDep) -> dict[str, str]:
        return {"user_id": str(user.user_id)}

    return ModuleSpec(name="probe", router=router)


def test_me_for_each_institute(seeded: PgUrls) -> None:  # M01-AT-01
    client = make_client(seeded)
    for email, code in ((RESEARCHER, "inst-a"), ("b.researcher@inst-b.local", "inst-b")):
        response = client.get("/api/v1/me", headers=bearer(token_for(email)))
        assert response.status_code == 200, response.text
        body = response.json()
        assert_matches_response("getMe", 200, body)
        assert body["organization"]["code"] == code
        assert body["user_id"] == str(USERS_BY_EMAIL[email].user_id)
        assert body["email"] == email
        assert body["status"] == "ACTIVE"
        assert body["org_roles"] == [] and body["platform_roles"] == []


def test_me_lists_roles(seeded: PgUrls) -> None:
    client = make_client(seeded)
    admin = client.get("/api/v1/me", headers=bearer(token_for("admin@nais.local"))).json()
    assert admin["platform_roles"] == ["PLATFORM_ADMIN"]
    assert admin["org_roles"] == ["ORG_ADMIN"]
    assert admin["organization"] == {
        "organization_id": str(ORGS_BY_CODE["nais"].organization_id),
        "code": "nais",
        "name": "NAIS",
        "type": "PLATFORM_OPERATOR",
    }


def test_first_call_provisions_new_user(seeded: PgUrls) -> None:  # M01-AT-02
    token = ISSUER.token(
        sub="kc-fresh", email="fresh@inst-a.local", name="Fresh Person", org_code="inst-a", sid="s-fresh"
    )
    response = make_client(seeded).get("/api/v1/me", headers=bearer(token))
    assert response.status_code == 200, response.text
    body = response.json()
    assert_matches_response("getMe", 200, body)
    assert body["org_roles"] == [] and body["organization"]["code"] == "inst-a"
    created = events(seeded, USER_CREATED, email="fresh@inst-a.local")
    assert len(created) == 1
    assert_valid_event(created[0])
    assert created[0]["correlation_id"] == response.headers["x-request-id"]


def test_login_event_once_per_session(seeded: PgUrls) -> None:  # M01-AT-03, M01-AT-04
    client = make_client(seeded)
    user_id = str(USERS_BY_EMAIL[RESEARCHER].user_id)
    first = bearer(token_for(RESEARCHER, sid="sess-1"))
    for _ in range(3):
        assert client.get("/api/v1/me", headers=first).status_code == 200
    assert len(events(seeded, LOGGED_IN, user_id=user_id)) == 1
    assert client.get("/api/v1/me", headers=bearer(token_for(RESEARCHER, sid="sess-2"))).status_code == 200
    logged = events(seeded, LOGGED_IN, user_id=user_id)
    assert [e["payload"]["session_id"] for e in logged] == ["sess-1", "sess-2"]
    for envelope in logged:
        assert_valid_event(envelope)


def test_disabled_membership_blocks_every_request(seeded: PgUrls) -> None:  # M01-AT-05
    client = make_client(seeded, probe_module())
    headers = bearer(token_for("b.disabled@inst-b.local"))
    for path in ("/api/v1/me", "/api/v1/projects", "/api/v1/datasets"):
        response = client.get(path, headers=headers)
        assert response.status_code == 403, path
        assert response.json()["error"]["code"] == "MEMBERSHIP_DISABLED"
    assert_matches_response("getMe", 403, client.get("/api/v1/me", headers=headers).json())


def test_unknown_org_is_rejected_without_provisioning(seeded: PgUrls) -> None:  # M01-AT-07
    token = ISSUER.token(sub="kc-stranger", email="stranger@elsewhere.local", org_code="unknown-org")
    response = make_client(seeded).get("/api/v1/me", headers=bearer(token))
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "ORGANIZATION_UNKNOWN"
    assert_matches_response("getMe", 403, response.json())
    assert scalar(seeded, "SELECT count(*) FROM identity.users WHERE keycloak_sub = 'kc-stranger'") == 0


@pytest.mark.parametrize("kind", ["expired", "forged", "audience", "missing"])
def test_invalid_tokens_are_unauthenticated(seeded: PgUrls, kind: str) -> None:  # M01-AT-08
    tokens = {
        "expired": token_for(RESEARCHER, expires_in=-120),
        "forged": FakeIssuer().token(sub=USERS_BY_EMAIL[RESEARCHER].keycloak_sub, org_code="inst-a"),
        "audience": token_for(RESEARCHER, aud="some-other-api"),
        "missing": None,
    }
    token = tokens[kind]
    headers = bearer(token) if token else {}
    client = make_client(seeded, probe_module())
    for path in ("/api/v1/me", "/api/v1/projects"):
        response = client.get(path, headers=headers)
        assert response.status_code == 401, path
        assert response.json()["error"]["code"] == "UNAUTHENTICATED"
    assert_matches_response("getMe", 401, client.get("/api/v1/me", headers=headers).json())


def test_email_of_another_account_is_409(seeded: PgUrls) -> None:
    token = ISSUER.token(sub="kc-imposter", email="A.Researcher@inst-a.local", org_code="inst-a")
    response = make_client(seeded).get("/api/v1/me", headers=bearer(token))
    assert response.status_code == 409
    assert response.json()["error"]["code"] == "CONFLICT"
    assert_matches_response("getMe", 409, response.json())
```

- [ ] **Step 2: Run to verify it fails**

Run: `uv run pytest apps/api/modules/identity/tests/test_api_me.py -v`
Expected: FAIL — `ImportError: cannot import name 'wire_ports' from 'api.modules.identity'`.

- [ ] **Step 3: Implement DTOs, schemas, `get_me`, router and wiring**

`apps/api/modules/identity/public.py`:

```python
"""M01 public surface for other modules: read DTOs (+ IdentityQueryPort, added with the query adapter).

Field-identical to openapi components IdentityPublicProfile / OrganizationSummary. Other modules use only these,
CurrentUser, and IdentityQueryPort; they never read identity.* tables.
"""

from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict

OrganizationType = Literal["RESEARCH_INSTITUTE", "UNIVERSITY", "COMPANY", "PLATFORM_OPERATOR"]
ActiveStatus = Literal["ACTIVE", "DISABLED"]


class OrganizationSummary(BaseModel):
    model_config = ConfigDict(frozen=True)

    organization_id: UUID
    code: str
    name: str
    type: OrganizationType


class IdentityPublicProfile(BaseModel):
    model_config = ConfigDict(frozen=True)

    user_id: UUID
    display_name: str
    organization_id: UUID
    organization_name: str | None = None
    status: ActiveStatus
```

`apps/api/modules/identity/schemas.py`:

```python
"""HTTP models of the identity API (shapes of openapi.yaml components Me, Organization, OrganizationMembership)."""

from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, ConfigDict

from api.modules.identity.public import ActiveStatus, OrganizationSummary


class MeOut(BaseModel):
    user_id: UUID
    display_name: str
    email: str
    status: ActiveStatus
    organization: OrganizationSummary
    org_roles: list[str]
    platform_roles: list[str]


class OrganizationOut(OrganizationSummary):
    ror_id: str | None = None
    homepage_url: str | None = None
    member_count: int
    created_at: datetime


class MembershipOut(BaseModel):
    user_id: UUID
    organization_id: UUID
    display_name: str
    email: str
    roles: list[str]
    status: ActiveStatus
    updated_at: datetime


class MemberUpdateIn(BaseModel):
    """PATCH body. roles are plain strings on purpose: a non-org role is 422 ROLE_NOT_ASSIGNABLE, not a schema error."""

    model_config = ConfigDict(extra="forbid")

    roles: list[str] | None = None
    status: ActiveStatus | None = None
```

`apps/api/modules/identity/directory.py`:

```python
"""Read side of the identity API: the caller, organizations, and the user directory."""

from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from api.modules.identity.public import OrganizationSummary
from api.modules.identity.schemas import MeOut
from api.modules.identity.tables import memberships, organizations, users


def get_me(session: Session, user_id: UUID) -> MeOut:
    row = session.execute(
        select(
            users.c.user_id,
            users.c.display_name,
            users.c.email,
            users.c.status,
            users.c.platform_roles,
            memberships.c.roles,
            organizations.c.organization_id,
            organizations.c.code,
            organizations.c.name,
            organizations.c.type,
        )
        .select_from(
            users.join(memberships, memberships.c.user_id == users.c.user_id).join(
                organizations, organizations.c.organization_id == memberships.c.organization_id
            )
        )
        .where(users.c.user_id == user_id)
    ).one()
    return MeOut(
        user_id=row.user_id,
        display_name=row.display_name,
        email=row.email,
        status=row.status,
        organization=OrganizationSummary(
            organization_id=row.organization_id, code=row.code, name=row.name, type=row.type
        ),
        org_roles=sorted(row.roles),
        platform_roles=sorted(row.platform_roles),
    )
```

`apps/api/modules/identity/router.py`:

```python
"""Identity HTTP routes (openapi tag identity). Thin: rules live in directory.py / members.py."""

from fastapi import APIRouter

from api.modules.identity import directory
from api.modules.identity.schemas import MeOut
from api.platform.auth import CurrentUserDep
from api.platform.db import SessionDep

router = APIRouter(tags=["identity"])


@router.get("/me", operation_id="getMe")
def get_me(user: CurrentUserDep, session: SessionDep) -> MeOut:
    return directory.get_me(session, user.user_id)
```

Replace `apps/api/modules/identity/__init__.py` with:

```python
"""M01 Identity & Organization: NAIS users, organizations and memberships (Keycloak authenticates, D-019)."""

from pathlib import Path

from api.modules.identity.resolver import IdentityPrincipalResolver, SessionFactory
from api.modules.identity.router import router
from api.modules.identity.seed import seed
from api.platform import ports
from api.platform.auth import PrincipalResolver
from api.platform.db import session_scope
from api.platform.modules import ModuleSpec


def wire_ports(sessions: SessionFactory = session_scope) -> None:
    """Provide M01's ports. Production uses DATABASE_URL; tests pass a factory bound to their database."""
    ports.provide(PrincipalResolver, IdentityPrincipalResolver(sessions))


def wire() -> None:
    wire_ports()


MODULE = ModuleSpec(
    name="identity",
    db_schema="identity",
    router=router,
    migrations_dir=Path(__file__).parent / "migrations",
    wire=wire,
    seed=seed,
)
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `uv run pytest apps/api/modules/identity/tests -v`
Expected: all PASS (schema, seed, resolver, api_me).

- [ ] **Step 5: Lint and commit**

```bash
uv run ruff check --fix apps/api/modules/identity && uv run ruff format apps/api/modules/identity
git add apps/api/modules/identity
git commit -m "feat(identity): wire PrincipalResolver and serve GET /me

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Organizations and user directory (`listOrganizations`, `getOrganization`, `listUsers`)

**Files:**
- Modify: `apps/api/modules/identity/directory.py` (append cursor helpers + three queries)
- Modify: `apps/api/modules/identity/router.py` (replace whole file)
- Test: `apps/api/modules/identity/tests/test_api_directory.py`

**Interfaces:**
- Consumes: `api.platform.pagination.Page`, `PageParams`, `page_params`, `build_page`, `encode_cursor`; `public.OrganizationSummary`, `public.IdentityPublicProfile`; `schemas.OrganizationOut`.
- Produces (in `directory.py`):
  - `invalid_cursor() -> ApiError`, `cursor_key(params: PageParams) -> tuple[str, UUID] | None`, `after(sort_col, id_col, key: tuple[str, UUID]) -> ColumnElement[bool]`, `escape_like(value: str) -> str` — reused by Task 7.
  - `list_organizations(session, params) -> Page[OrganizationSummary]` (name asc, id tiebreak).
  - `get_organization(session, organization_id) -> OrganizationOut` (404 `NOT_FOUND`; `member_count` = ACTIVE memberships; no `dataset_count`).
  - `search_users(session, *, q: str | None, organization_id: UUID | None, params) -> Page[IdentityPublicProfile]` (ACTIVE user + ACTIVE membership only; `q` trimmed, ≥2 chars, display_name ILIKE `%q%` or email prefix; display_name asc; no email in output).

- [ ] **Step 1: Write the failing tests**

`apps/api/modules/identity/tests/test_api_directory.py`:

```python
from typing import Any

import pytest
from fastapi.testclient import TestClient

from api.modules.identity.seed_data import ORGS_BY_CODE
from api.modules.identity.tests.support import bearer, make_client, token_for
from api.platform.pagination import encode_cursor
from api.platform.testing.contracts import assert_matches_response
from api.platform.testing.fixtures import PgUrls

ACTIVE_NAMES = ["A Admin", "A Researcher", "A Steward", "B Admin", "B Researcher", "B Steward", "NAIS Admin"]


@pytest.fixture
def client(seeded: PgUrls) -> TestClient:
    return make_client(seeded)


def get(client: TestClient, path: str, **params: Any) -> Any:
    return client.get(path, params=params, headers=bearer(token_for("a.researcher@inst-a.local")))


def names(body: dict[str, Any]) -> list[str]:
    return [item["display_name"] for item in body["items"]]


def test_list_organizations_by_name(client: TestClient) -> None:
    response = get(client, "/api/v1/organizations")
    assert response.status_code == 200
    body = response.json()
    assert_matches_response("listOrganizations", 200, body)
    assert [org["code"] for org in body["items"]] == ["inst-a", "inst-b", "nais"]
    assert body["page"] == {"next_cursor": None, "has_more": False}


def test_list_organizations_pages(client: TestClient) -> None:
    first = get(client, "/api/v1/organizations", limit=2).json()
    assert [org["name"] for org in first["items"]] == ["Institute A", "Institute B"]
    assert first["page"]["has_more"] is True
    second = get(client, "/api/v1/organizations", limit=2, cursor=first["page"]["next_cursor"]).json()
    assert [org["name"] for org in second["items"]] == ["NAIS"]
    assert second["page"]["has_more"] is False


def test_organizations_require_authentication(client: TestClient) -> None:
    response = client.get("/api/v1/organizations")
    assert response.status_code == 401
    assert_matches_response("listOrganizations", 401, response.json())


def test_get_organization_counts_active_members(client: TestClient) -> None:
    inst_b = ORGS_BY_CODE["inst-b"].organization_id
    response = get(client, f"/api/v1/organizations/{inst_b}")
    assert response.status_code == 200
    body = response.json()
    assert_matches_response("getOrganization", 200, body)
    assert body["code"] == "inst-b" and body["type"] == "RESEARCH_INSTITUTE"
    assert body["member_count"] == 3  # b.disabled excluded
    assert "dataset_count" not in body
    assert body["ror_id"] is None and body["homepage_url"] is None


def test_get_unknown_organization_is_404(client: TestClient) -> None:
    response = get(client, "/api/v1/organizations/00000000-0000-7000-8000-00000000ffff")
    assert response.status_code == 404
    assert_matches_response("getOrganization", 404, response.json())


def test_user_search_by_email_prefix(client: TestClient) -> None:  # M01-AT-14
    response = get(client, "/api/v1/users", q="b.")
    assert response.status_code == 200
    body = response.json()
    assert_matches_response("listUsers", 200, body)
    assert names(body) == ["B Admin", "B Researcher", "B Steward"]  # b.disabled excluded
    for item in body["items"]:
        assert "email" not in item
        assert item["status"] == "ACTIVE"
        assert item["organization_name"] == "Institute B"


def test_user_search_by_display_name_fragment(client: TestClient) -> None:
    assert names(get(client, "/api/v1/users", q="esearch").json()) == ["A Researcher", "B Researcher"]


def test_user_search_by_organization(client: TestClient) -> None:
    inst_a = ORGS_BY_CODE["inst-a"].organization_id
    assert names(get(client, "/api/v1/users", organization_id=str(inst_a)).json()) == [
        "A Admin",
        "A Researcher",
        "A Steward",
    ]


def test_one_character_query_is_rejected(client: TestClient) -> None:
    response = get(client, "/api/v1/users", q="b")
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "VALIDATION_FAILED"
    assert_matches_response("listUsers", 422, response.json())


def test_padded_short_query_is_rejected(client: TestClient) -> None:
    response = get(client, "/api/v1/users", q="  a ")
    assert response.status_code == 422
    assert response.json()["error"]["details"]["fields"][0]["field"] == "q"


@pytest.mark.parametrize("q", ["%%", "__", "a%", "%@"])
def test_like_wildcards_are_literal(client: TestClient, q: str) -> None:
    response = get(client, "/api/v1/users", q=q)
    assert response.status_code == 200
    assert response.json()["items"] == []


def test_user_directory_pages_without_gaps(client: TestClient) -> None:
    seen: list[str] = []
    cursor = None
    while True:
        params: dict[str, Any] = {"limit": 3}
        if cursor:
            params["cursor"] = cursor
        body = get(client, "/api/v1/users", **params).json()
        seen += names(body)
        cursor = body["page"]["next_cursor"]
        if not body["page"]["has_more"]:
            break
    assert seen == ACTIVE_NAMES


@pytest.mark.parametrize("cursor", ["!!!not-base64", encode_cursor([1]), encode_cursor(["A", "not-a-uuid"])])
def test_bad_cursor_is_422(client: TestClient, cursor: str) -> None:
    for path in ("/api/v1/users", "/api/v1/organizations"):
        response = get(client, path, cursor=cursor)
        assert response.status_code == 422, path
        error = response.json()["error"]
        assert error["code"] == "VALIDATION_FAILED"
        assert error["details"]["fields"][0]["field"] == "cursor"
```

- [ ] **Step 2: Run to verify it fails**

Run: `uv run pytest apps/api/modules/identity/tests/test_api_directory.py -v`
Expected: FAIL — requests to `/api/v1/organizations` and `/api/v1/users` return 404.

- [ ] **Step 3: Implement queries and routes**

Replace the imports at the top of `apps/api/modules/identity/directory.py` with:

```python
"""Read side of the identity API: the caller, organizations, and the user directory."""

from typing import Any
from uuid import UUID

from sqlalchemy import ColumnElement, and_, func, or_, select
from sqlalchemy.orm import Session

from api.modules.identity.public import IdentityPublicProfile, OrganizationSummary
from api.modules.identity.schemas import MeOut, OrganizationOut
from api.modules.identity.tables import memberships, organizations, users
from api.platform.errors import ApiError
from api.platform.generated.error_codes import ErrorCode
from api.platform.pagination import Page, PageParams, build_page

MIN_QUERY_LENGTH = 2
```

Append to `apps/api/modules/identity/directory.py`:

```python
def invalid_cursor() -> ApiError:
    return ApiError(
        ErrorCode.VALIDATION_FAILED,
        "Invalid pagination cursor.",
        {"fields": [{"field": "cursor", "reason": "INVALID_CURSOR"}]},
    )


def cursor_key(params: PageParams) -> tuple[str, UUID] | None:
    """Decode our (sort text, id) cursor; anything else is a 422, never a 500."""
    if params.cursor is None:
        return None
    values = params.cursor
    if len(values) != 2 or not isinstance(values[0], str) or not isinstance(values[1], str):
        raise invalid_cursor()
    try:
        return values[0], UUID(values[1])
    except ValueError as exc:
        raise invalid_cursor() from exc


def after(sort_col: Any, id_col: Any, key: tuple[str, UUID]) -> ColumnElement[bool]:
    """Keyset predicate for ORDER BY sort_col, id_col."""
    text_value, id_value = key
    return or_(sort_col > text_value, and_(sort_col == text_value, id_col > id_value))


def escape_like(value: str) -> str:
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def list_organizations(session: Session, params: PageParams) -> Page[OrganizationSummary]:
    stmt = select(organizations.c.organization_id, organizations.c.code, organizations.c.name, organizations.c.type)
    key = cursor_key(params)
    if key is not None:
        stmt = stmt.where(after(organizations.c.name, organizations.c.organization_id, key))
    rows = session.execute(
        stmt.order_by(organizations.c.name, organizations.c.organization_id).limit(params.limit + 1)
    ).all()
    items = [
        OrganizationSummary(organization_id=r.organization_id, code=r.code, name=r.name, type=r.type) for r in rows
    ]
    return build_page(items, params.limit, key=lambda org: (org.name, str(org.organization_id)))


def get_organization(session: Session, organization_id: UUID) -> OrganizationOut:
    member_count = (
        select(func.count())
        .select_from(memberships)
        .where(
            memberships.c.organization_id == organizations.c.organization_id,
            memberships.c.status == "ACTIVE",
        )
        .scalar_subquery()
    )
    row = session.execute(
        select(
            organizations.c.organization_id,
            organizations.c.code,
            organizations.c.name,
            organizations.c.type,
            organizations.c.ror_id,
            organizations.c.homepage_url,
            organizations.c.created_at,
            member_count.label("member_count"),
        ).where(organizations.c.organization_id == organization_id)
    ).first()
    if row is None:
        raise ApiError(ErrorCode.NOT_FOUND)
    return OrganizationOut(
        organization_id=row.organization_id,
        code=row.code,
        name=row.name,
        type=row.type,
        ror_id=row.ror_id,
        homepage_url=row.homepage_url,
        member_count=row.member_count,
        created_at=row.created_at,
    )


def search_users(
    session: Session, *, q: str | None, organization_id: UUID | None, params: PageParams
) -> Page[IdentityPublicProfile]:
    stmt = (
        select(
            users.c.user_id,
            users.c.display_name,
            memberships.c.organization_id,
            organizations.c.name.label("organization_name"),
        )
        .select_from(
            users.join(memberships, memberships.c.user_id == users.c.user_id).join(
                organizations, organizations.c.organization_id == memberships.c.organization_id
            )
        )
        .where(users.c.status == "ACTIVE", memberships.c.status == "ACTIVE")
    )
    if q is not None:
        term = q.strip()
        if len(term) < MIN_QUERY_LENGTH:
            raise ApiError(
                ErrorCode.VALIDATION_FAILED,
                "q needs at least 2 non-space characters.",
                {"fields": [{"field": "q", "reason": "TOO_SHORT"}]},
            )
        pattern = escape_like(term)
        stmt = stmt.where(
            or_(
                users.c.display_name.ilike(f"%{pattern}%", escape="\\"),
                users.c.email.like(f"{pattern.lower()}%", escape="\\"),
            )
        )
    if organization_id is not None:
        stmt = stmt.where(memberships.c.organization_id == organization_id)
    key = cursor_key(params)
    if key is not None:
        stmt = stmt.where(after(users.c.display_name, users.c.user_id, key))
    rows = session.execute(stmt.order_by(users.c.display_name, users.c.user_id).limit(params.limit + 1)).all()
    items = [
        IdentityPublicProfile(
            user_id=r.user_id,
            display_name=r.display_name,
            organization_id=r.organization_id,
            organization_name=r.organization_name,
            status="ACTIVE",
        )
        for r in rows
    ]
    return build_page(items, params.limit, key=lambda p: (p.display_name, str(p.user_id)))
```

Replace `apps/api/modules/identity/router.py` with:

```python
"""Identity HTTP routes (openapi tag identity). Thin: rules live in directory.py / members.py."""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Query

from api.modules.identity import directory
from api.modules.identity.public import IdentityPublicProfile, OrganizationSummary
from api.modules.identity.schemas import MeOut, OrganizationOut
from api.platform.auth import CurrentUserDep
from api.platform.db import SessionDep
from api.platform.pagination import Page, PageParams, page_params

router = APIRouter(tags=["identity"])
Paging = Annotated[PageParams, Depends(page_params)]


@router.get("/me", operation_id="getMe")
def get_me(user: CurrentUserDep, session: SessionDep) -> MeOut:
    return directory.get_me(session, user.user_id)


@router.get("/users", operation_id="listUsers")
def list_users(
    user: CurrentUserDep,
    session: SessionDep,
    paging: Paging,
    q: Annotated[str | None, Query(min_length=2, max_length=200)] = None,
    organization_id: UUID | None = None,
) -> Page[IdentityPublicProfile]:
    return directory.search_users(session, q=q, organization_id=organization_id, params=paging)


@router.get("/organizations", operation_id="listOrganizations")
def list_organizations(user: CurrentUserDep, session: SessionDep, paging: Paging) -> Page[OrganizationSummary]:
    return directory.list_organizations(session, paging)


@router.get("/organizations/{organization_id}", operation_id="getOrganization")
def get_organization(organization_id: UUID, user: CurrentUserDep, session: SessionDep) -> OrganizationOut:
    return directory.get_organization(session, organization_id)
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `uv run pytest apps/api/modules/identity/tests/test_api_directory.py apps/api/modules/identity/tests/test_api_me.py -v`
Expected: all PASS.

- [ ] **Step 5: Lint and commit**

```bash
uv run ruff check --fix apps/api/modules/identity && uv run ruff format apps/api/modules/identity
git add apps/api/modules/identity
git commit -m "feat(identity): organizations and user directory endpoints

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Organization members (`listOrganizationMembers`, `updateOrganizationMember`)

**Files:**
- Create: `apps/api/modules/identity/members.py`
- Modify: `apps/api/modules/identity/router.py` (replace whole file)
- Test: `apps/api/modules/identity/tests/test_api_members.py`

**Interfaces:**
- Consumes: `directory.cursor_key`, `directory.after` (Task 6); `schemas.MembershipOut`, `schemas.MemberUpdateIn` (Task 5); `CurrentUser` (`is_platform_admin`, `has_org_role`); `outbox.write`; `EventActor.for_user`.
- Produces (in `members.py`):
  - `ORG_ROLES: frozenset[str]`, `ensure_organization(session, organization_id) -> None` (404), `ensure_org_admin(user: CurrentUser, organization_id: UUID) -> None` (403).
  - `list_members(session, organization_id, params) -> Page[MembershipOut]` (all statuses, emails included, display_name asc).
  - `update_member(session, actor: CurrentUser, organization_id: UUID, user_id: UUID, change: MemberUpdateIn) -> MembershipOut`.

Rules (spec §6, §9): order is empty body → 422 `VALIDATION_FAILED`; unknown org → 404; not ORG_ADMIN of that org and not PLATFORM_ADMIN → 403 `FORBIDDEN`; user not a member of that org → 404; duplicate roles → 422 `VALIDATION_FAILED`; any non-org role (incl. `PLATFORM_ADMIN`) → 422 `ROLE_NOT_ASSIGNABLE`; no actual change → 200 without event; non-platform-admin removing own `ORG_ADMIN` or disabling self → 422 `ROLE_NOT_ASSIGNABLE`; non-platform-admin removing the org's last ACTIVE `ORG_ADMIN` → 422 `ROLE_NOT_ASSIGNABLE`; otherwise update + `identity.membership.changed.v1` in the request transaction (actor = the admin, correlation = request id).

- [ ] **Step 1: Write the failing tests**

`apps/api/modules/identity/tests/test_api_members.py`:

```python
from typing import Any
from uuid import UUID

import pytest
from fastapi.testclient import TestClient

from api.modules.identity.members import update_member
from api.modules.identity.schemas import MemberUpdateIn
from api.modules.identity.seed_data import ORGS_BY_CODE, USERS_BY_EMAIL
from api.modules.identity.tests.support import bearer, events, make_client, token_for
from api.platform.auth import CurrentUser
from api.platform.db import session_scope
from api.platform.errors import ApiError
from api.platform.testing.contracts import assert_matches_response, assert_valid_event
from api.platform.testing.fixtures import PgUrls

CHANGED = "identity.membership.changed.v1"
INST_A = ORGS_BY_CODE["inst-a"].organization_id
INST_B = ORGS_BY_CODE["inst-b"].organization_id


def uid(email: str) -> UUID:
    return USERS_BY_EMAIL[email].user_id


@pytest.fixture
def client(seeded: PgUrls) -> TestClient:
    return make_client(seeded)


def members(client: TestClient, as_email: str, org: UUID) -> Any:
    return client.get(f"/api/v1/organizations/{org}/members", headers=bearer(token_for(as_email)))


def patch(client: TestClient, as_email: str, org: UUID, target: str, body: dict[str, Any]) -> Any:
    return client.patch(
        f"/api/v1/organizations/{org}/members/{uid(target)}", json=body, headers=bearer(token_for(as_email))
    )


def error_code(response: Any) -> str:
    return str(response.json()["error"]["code"])


def test_member_without_admin_role_cannot_list(client: TestClient) -> None:  # M01-AT-10
    response = members(client, "a.researcher@inst-a.local", INST_A)
    assert response.status_code == 403 and error_code(response) == "FORBIDDEN"
    assert_matches_response("listOrganizationMembers", 403, response.json())


def test_org_admin_lists_own_members_with_email(client: TestClient) -> None:
    response = members(client, "a.admin@inst-a.local", INST_A)
    assert response.status_code == 200
    body = response.json()
    assert_matches_response("listOrganizationMembers", 200, body)
    assert [m["email"] for m in body["items"]] == [
        "a.admin@inst-a.local",
        "a.researcher@inst-a.local",
        "a.steward@inst-a.local",
    ]


def test_other_org_admin_cannot_list(client: TestClient) -> None:
    assert members(client, "b.admin@inst-b.local", INST_A).status_code == 403


def test_platform_admin_lists_disabled_members_too(client: TestClient) -> None:
    body = members(client, "admin@nais.local", INST_B).json()
    statuses = {m["email"]: m["status"] for m in body["items"]}
    assert statuses["b.disabled@inst-b.local"] == "DISABLED"
    assert len(statuses) == 4


def test_unknown_org_members_is_404(client: TestClient) -> None:
    response = members(client, "admin@nais.local", UUID("00000000-0000-7000-8000-00000000ffff"))
    assert response.status_code == 404 and error_code(response) == "NOT_FOUND"
    assert_matches_response("listOrganizationMembers", 404, response.json())


def test_admin_of_other_org_cannot_patch(client: TestClient) -> None:  # M01-AT-09
    response = patch(client, "a.admin@inst-a.local", INST_B, "b.researcher@inst-b.local", {"roles": []})
    assert response.status_code == 403 and error_code(response) == "FORBIDDEN"
    assert_matches_response("updateOrganizationMember", 403, response.json())


def test_org_admin_cannot_drop_own_admin_role(client: TestClient) -> None:  # M01-AT-11
    response = patch(client, "a.admin@inst-a.local", INST_A, "a.admin@inst-a.local", {"roles": []})
    assert response.status_code == 422 and error_code(response) == "ROLE_NOT_ASSIGNABLE"
    assert_matches_response("updateOrganizationMember", 422, response.json())


def test_org_admin_cannot_disable_self(client: TestClient) -> None:
    response = patch(client, "a.admin@inst-a.local", INST_A, "a.admin@inst-a.local", {"status": "DISABLED"})
    assert response.status_code == 422 and error_code(response) == "ROLE_NOT_ASSIGNABLE"


def test_platform_role_is_not_assignable(client: TestClient) -> None:  # M01-AT-12
    body = {"roles": ["PLATFORM_ADMIN"]}
    response = patch(client, "a.admin@inst-a.local", INST_A, "a.researcher@inst-a.local", body)
    assert response.status_code == 422 and error_code(response) == "ROLE_NOT_ASSIGNABLE"


@pytest.mark.parametrize(
    "body",
    [{}, {"roles": ["DATA_STEWARD", "DATA_STEWARD"]}, {"status": "GONE"}, {"roles": [], "extra": 1}],
)
def test_malformed_bodies_are_validation_failed(client: TestClient, body: dict[str, Any]) -> None:
    response = patch(client, "a.admin@inst-a.local", INST_A, "a.researcher@inst-a.local", body)
    assert response.status_code == 422 and error_code(response) == "VALIDATION_FAILED"


def test_member_of_another_org_is_404(client: TestClient) -> None:
    response = patch(client, "a.admin@inst-a.local", INST_A, "b.researcher@inst-b.local", {"roles": []})
    assert response.status_code == 404 and error_code(response) == "NOT_FOUND"
    assert_matches_response("updateOrganizationMember", 404, response.json())


def test_granting_a_role_is_visible_on_the_same_token(client: TestClient, seeded: PgUrls) -> None:
    # M01-AT-13, M01-AT-15
    researcher = bearer(token_for("a.researcher@inst-a.local", sid="researcher-session"))
    assert client.get("/api/v1/me", headers=researcher).json()["org_roles"] == []

    body = {"roles": ["DATA_STEWARD"]}
    response = patch(client, "a.admin@inst-a.local", INST_A, "a.researcher@inst-a.local", body)
    assert response.status_code == 200, response.text
    assert_matches_response("updateOrganizationMember", 200, response.json())
    assert response.json()["roles"] == ["DATA_STEWARD"]

    changed = events(seeded, CHANGED, user_id=str(uid("a.researcher@inst-a.local")))
    assert len(changed) == 1
    assert_valid_event(changed[0])
    assert changed[0]["payload"] == {
        "user_id": str(uid("a.researcher@inst-a.local")),
        "organization_id": str(INST_A),
        "previous_roles": [],
        "roles": ["DATA_STEWARD"],
        "previous_status": "ACTIVE",
        "status": "ACTIVE",
    }
    assert changed[0]["actor"] == {
        "type": "USER",
        "user_id": str(uid("a.admin@inst-a.local")),
        "organization_id": str(INST_A),
    }
    assert changed[0]["correlation_id"] == response.headers["x-request-id"]
    assert client.get("/api/v1/me", headers=researcher).json()["org_roles"] == ["DATA_STEWARD"]


def test_disabling_blocks_the_next_request(client: TestClient, seeded: PgUrls) -> None:  # M01-AT-06
    researcher = bearer(token_for("a.researcher@inst-a.local", sid="researcher-session"))
    assert client.get("/api/v1/me", headers=researcher).status_code == 200
    body = {"status": "DISABLED"}
    assert patch(client, "a.admin@inst-a.local", INST_A, "a.researcher@inst-a.local", body).status_code == 200
    blocked = client.get("/api/v1/me", headers=researcher)
    assert blocked.status_code == 403 and error_code(blocked) == "MEMBERSHIP_DISABLED"
    assert len(events(seeded, CHANGED, user_id=str(uid("a.researcher@inst-a.local")))) == 1

    body = {"status": "ACTIVE"}
    assert patch(client, "a.admin@inst-a.local", INST_A, "a.researcher@inst-a.local", body).status_code == 200
    assert client.get("/api/v1/me", headers=researcher).status_code == 200


def test_no_op_update_emits_nothing(client: TestClient, seeded: PgUrls) -> None:
    body = {"roles": ["DATA_STEWARD"], "status": "ACTIVE"}
    response = patch(client, "a.admin@inst-a.local", INST_A, "a.steward@inst-a.local", body)
    assert response.status_code == 200
    assert events(seeded, CHANGED) == []


def test_admin_may_remove_another_admin_when_not_last(client: TestClient) -> None:
    both = {"roles": ["DATA_STEWARD", "ORG_ADMIN"]}
    assert patch(client, "admin@nais.local", INST_A, "a.steward@inst-a.local", both).status_code == 200
    response = patch(
        client, "a.admin@inst-a.local", INST_A, "a.steward@inst-a.local", {"roles": ["DATA_STEWARD"]}
    )
    assert response.status_code == 200 and response.json()["roles"] == ["DATA_STEWARD"]


def test_platform_admin_may_remove_last_org_admin(client: TestClient) -> None:
    response = patch(client, "admin@nais.local", INST_A, "a.admin@inst-a.local", {"roles": []})
    assert response.status_code == 200 and response.json()["roles"] == []


def test_non_platform_admin_cannot_remove_last_org_admin(seeded: PgUrls) -> None:
    # A caller whose token still says ORG_ADMIN (e.g. resolved a moment before losing the role) removes the
    # organization's only ACTIVE ORG_ADMIN: the last-admin guard must hold even though self-rules do not apply.
    actor = CurrentUser(
        user_id=uid("a.steward@inst-a.local"),
        organization_id=INST_A,
        org_roles=frozenset({"ORG_ADMIN"}),
        session_id="s",
        display_name="A Steward",
    )
    with pytest.raises(ApiError) as caught, session_scope(seeded.app) as session:
        update_member(session, actor, INST_A, uid("a.admin@inst-a.local"), MemberUpdateIn(roles=[]))
    assert caught.value.code.value == "ROLE_NOT_ASSIGNABLE"
```

- [ ] **Step 2: Run to verify it fails**

Run: `uv run pytest apps/api/modules/identity/tests/test_api_members.py -v`
Expected: collection error `ModuleNotFoundError: No module named 'api.modules.identity.members'`.

- [ ] **Step 3: Implement members and routes**

`apps/api/modules/identity/members.py`:

```python
"""Organization member administration (spec §6 updateOrganizationMember, §9 authorization matrix)."""

from typing import Any
from uuid import UUID

from sqlalchemy import Row, Select, any_, literal, select, update
from sqlalchemy.orm import Session

from api.modules.identity.directory import after, cursor_key
from api.modules.identity.schemas import MembershipOut, MemberUpdateIn
from api.modules.identity.tables import memberships, organizations, users
from api.platform import clock
from api.platform.auth import CurrentUser
from api.platform.errors import ApiError
from api.platform.events import EventActor
from api.platform.generated.error_codes import ErrorCode
from api.platform.generated.event_types import EventType
from api.platform.outbox import outbox
from api.platform.pagination import Page, PageParams, build_page

ORG_ADMIN = "ORG_ADMIN"
ORG_ROLES = frozenset({"ORG_ADMIN", "DATA_STEWARD", "RESOURCE_MANAGER"})


def ensure_organization(session: Session, organization_id: UUID) -> None:
    found = session.execute(
        select(organizations.c.organization_id).where(organizations.c.organization_id == organization_id)
    ).first()
    if found is None:
        raise ApiError(ErrorCode.NOT_FOUND)


def ensure_org_admin(user: CurrentUser, organization_id: UUID) -> None:
    if not (user.is_platform_admin or user.has_org_role(organization_id, ORG_ADMIN)):
        raise ApiError(ErrorCode.FORBIDDEN)


def _membership_select() -> Select[Any]:
    return select(
        memberships.c.user_id,
        memberships.c.organization_id,
        memberships.c.roles,
        memberships.c.status,
        memberships.c.updated_at,
        users.c.display_name,
        users.c.email,
    ).select_from(memberships.join(users, users.c.user_id == memberships.c.user_id))


def _to_out(row: Row[Any]) -> MembershipOut:
    return MembershipOut(
        user_id=row.user_id,
        organization_id=row.organization_id,
        display_name=row.display_name,
        email=row.email,
        roles=sorted(row.roles),
        status=row.status,
        updated_at=row.updated_at,
    )


def list_members(session: Session, organization_id: UUID, params: PageParams) -> Page[MembershipOut]:
    stmt = _membership_select().where(memberships.c.organization_id == organization_id)
    key = cursor_key(params)
    if key is not None:
        stmt = stmt.where(after(users.c.display_name, users.c.user_id, key))
    rows = session.execute(stmt.order_by(users.c.display_name, users.c.user_id).limit(params.limit + 1)).all()
    return build_page(
        [_to_out(row) for row in rows], params.limit, key=lambda m: (m.display_name, str(m.user_id))
    )


def _validated_roles(roles: list[str]) -> list[str]:
    if len(set(roles)) != len(roles):
        raise ApiError(
            ErrorCode.VALIDATION_FAILED,
            "roles must not contain duplicates.",
            {"fields": [{"field": "roles", "reason": "DUPLICATE"}]},
        )
    invalid = sorted(set(roles) - ORG_ROLES)
    if invalid:
        raise ApiError(ErrorCode.ROLE_NOT_ASSIGNABLE, f"Not an organization role: {', '.join(invalid)}.")
    return sorted(roles)


def _active_admin_count(session: Session, organization_id: UUID) -> int:
    rows = session.execute(
        select(memberships.c.user_id)
        .where(
            memberships.c.organization_id == organization_id,
            memberships.c.status == "ACTIVE",
            literal(ORG_ADMIN) == any_(memberships.c.roles),
        )
        .with_for_update()
    ).all()
    return len(rows)


def update_member(
    session: Session, actor: CurrentUser, organization_id: UUID, user_id: UUID, change: MemberUpdateIn
) -> MembershipOut:
    if change.roles is None and change.status is None:
        raise ApiError(
            ErrorCode.VALIDATION_FAILED,
            "Provide roles and/or status.",
            {"fields": [{"field": "body", "reason": "EMPTY"}]},
        )
    ensure_organization(session, organization_id)
    ensure_org_admin(actor, organization_id)
    row = session.execute(
        _membership_select()
        .where(memberships.c.organization_id == organization_id, memberships.c.user_id == user_id)
        .with_for_update(of=memberships)
    ).first()
    if row is None:
        raise ApiError(ErrorCode.NOT_FOUND)

    previous_roles = sorted(row.roles)
    roles = _validated_roles(change.roles) if change.roles is not None else previous_roles
    status = change.status or row.status
    if roles == previous_roles and status == row.status:
        return _to_out(row)

    loses_admin = (
        ORG_ADMIN in previous_roles and row.status == "ACTIVE" and (ORG_ADMIN not in roles or status != "ACTIVE")
    )
    if not actor.is_platform_admin:
        if user_id == actor.user_id and status != "ACTIVE":
            raise ApiError(ErrorCode.ROLE_NOT_ASSIGNABLE, "You cannot disable your own membership.")
        if user_id == actor.user_id and loses_admin:
            raise ApiError(ErrorCode.ROLE_NOT_ASSIGNABLE, "You cannot remove your own ORG_ADMIN role.")
        if loses_admin and _active_admin_count(session, organization_id) <= 1:
            raise ApiError(
                ErrorCode.ROLE_NOT_ASSIGNABLE, "Only a PLATFORM_ADMIN can remove the last ORG_ADMIN."
            )

    now = clock.now()
    session.execute(
        update(memberships)
        .where(memberships.c.user_id == user_id)
        .values(roles=roles, status=status, updated_at=now, updated_by=actor.user_id)
    )
    outbox.write(
        session,
        EventType.IDENTITY_MEMBERSHIP_CHANGED_V1,
        {
            "user_id": str(user_id),
            "organization_id": str(organization_id),
            "previous_roles": previous_roles,
            "roles": roles,
            "previous_status": row.status,
            "status": status,
        },
        EventActor.for_user(actor),
    )
    return MembershipOut(
        user_id=user_id,
        organization_id=organization_id,
        display_name=row.display_name,
        email=row.email,
        roles=roles,
        status=status,
        updated_at=now,
    )
```

Replace `apps/api/modules/identity/router.py` with:

```python
"""Identity HTTP routes (openapi tag identity). Thin: rules live in directory.py / members.py."""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Query

from api.modules.identity import directory, members
from api.modules.identity.public import IdentityPublicProfile, OrganizationSummary
from api.modules.identity.schemas import MembershipOut, MemberUpdateIn, MeOut, OrganizationOut
from api.platform.auth import CurrentUserDep
from api.platform.db import SessionDep
from api.platform.pagination import Page, PageParams, page_params

router = APIRouter(tags=["identity"])
Paging = Annotated[PageParams, Depends(page_params)]


@router.get("/me", operation_id="getMe")
def get_me(user: CurrentUserDep, session: SessionDep) -> MeOut:
    return directory.get_me(session, user.user_id)


@router.get("/users", operation_id="listUsers")
def list_users(
    user: CurrentUserDep,
    session: SessionDep,
    paging: Paging,
    q: Annotated[str | None, Query(min_length=2, max_length=200)] = None,
    organization_id: UUID | None = None,
) -> Page[IdentityPublicProfile]:
    return directory.search_users(session, q=q, organization_id=organization_id, params=paging)


@router.get("/organizations", operation_id="listOrganizations")
def list_organizations(user: CurrentUserDep, session: SessionDep, paging: Paging) -> Page[OrganizationSummary]:
    return directory.list_organizations(session, paging)


@router.get("/organizations/{organization_id}", operation_id="getOrganization")
def get_organization(organization_id: UUID, user: CurrentUserDep, session: SessionDep) -> OrganizationOut:
    return directory.get_organization(session, organization_id)


@router.get("/organizations/{organization_id}/members", operation_id="listOrganizationMembers")
def list_organization_members(
    organization_id: UUID, user: CurrentUserDep, session: SessionDep, paging: Paging
) -> Page[MembershipOut]:
    members.ensure_organization(session, organization_id)
    members.ensure_org_admin(user, organization_id)
    return members.list_members(session, organization_id, paging)


@router.patch("/organizations/{organization_id}/members/{user_id}", operation_id="updateOrganizationMember")
def update_organization_member(
    organization_id: UUID, user_id: UUID, body: MemberUpdateIn, user: CurrentUserDep, session: SessionDep
) -> MembershipOut:
    return members.update_member(session, user, organization_id, user_id, body)
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `uv run pytest apps/api/modules/identity/tests -v`
Expected: all PASS.

- [ ] **Step 5: Lint and commit**

```bash
uv run ruff check --fix apps/api/modules/identity && uv run ruff format apps/api/modules/identity
git add apps/api/modules/identity
git commit -m "feat(identity): organization member listing and role/status administration

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: `IdentityQueryPort` for other modules

**Files:**
- Modify: `apps/api/modules/identity/public.py` (append the Protocol)
- Create: `apps/api/modules/identity/query.py`
- Modify: `apps/api/modules/identity/__init__.py` (provide the port in `wire_ports`)
- Test: `apps/api/modules/identity/tests/test_query_port.py`

**Interfaces:**
- Consumes: `SessionFactory` (Task 4), `public.IdentityPublicProfile`/`OrganizationSummary` (Task 5), tables.
- Produces:
  - `public.IdentityQueryPort` (Protocol, spec §8): `get_public_profile(user_id: UUID) -> IdentityPublicProfile | None`, `get_public_profiles(user_ids: list[UUID]) -> dict[UUID, IdentityPublicProfile]`, `get_organization_summary(organization_id: UUID) -> OrganizationSummary | None`, `is_active_user(user_id: UUID) -> bool`, `has_org_role(user_id: UUID, organization_id: UUID, role: str) -> bool`, `list_users_with_org_role(organization_id: UUID, role: str) -> list[UUID]`, `get_email(user_id: UUID) -> str | None` (M09 only).
  - `query.SqlIdentityQuery(sessions: SessionFactory = session_scope)` implementing it. Profile `status` is `ACTIVE` only when both user and membership are ACTIVE.
  - `wire_ports` now also does `ports.provide(IdentityQueryPort, SqlIdentityQuery(sessions))`. Consumers: `ports.get(IdentityQueryPort)` with `from api.modules.identity.public import IdentityQueryPort`.

- [ ] **Step 1: Write the failing tests**

`apps/api/modules/identity/tests/test_query_port.py`:

```python
import uuid

import pytest
from sqlalchemy import text

from api.modules.identity import wire_ports
from api.modules.identity.public import IdentityQueryPort
from api.modules.identity.query import SqlIdentityQuery
from api.modules.identity.seed_data import ORGS_BY_CODE, USERS_BY_EMAIL
from api.platform import ports
from api.platform.db import session_scope
from api.platform.testing.fixtures import PgUrls

INST_A = ORGS_BY_CODE["inst-a"].organization_id
INST_B = ORGS_BY_CODE["inst-b"].organization_id
UNKNOWN = uuid.UUID("00000000-0000-7000-8000-00000000ffff")


def uid(email: str) -> uuid.UUID:
    return USERS_BY_EMAIL[email].user_id


@pytest.fixture
def port(seeded: PgUrls) -> SqlIdentityQuery:
    return SqlIdentityQuery(lambda: session_scope(seeded.app))


def test_port_is_provided_by_wire(seeded: PgUrls) -> None:
    wire_ports(lambda: session_scope(seeded.app))
    assert isinstance(ports.get(IdentityQueryPort), SqlIdentityQuery)


def test_public_profile(port: SqlIdentityQuery) -> None:
    profile = port.get_public_profile(uid("a.researcher@inst-a.local"))
    assert profile is not None
    assert profile.display_name == "A Researcher"
    assert profile.organization_id == INST_A and profile.organization_name == "Institute A"
    assert profile.status == "ACTIVE"
    disabled = port.get_public_profile(uid("b.disabled@inst-b.local"))
    assert disabled is not None and disabled.status == "DISABLED"
    assert port.get_public_profile(UNKNOWN) is None


def test_public_profiles_batch(port: SqlIdentityQuery) -> None:
    a, b = uid("a.researcher@inst-a.local"), uid("b.researcher@inst-b.local")
    profiles = port.get_public_profiles([a, b, UNKNOWN])
    assert set(profiles) == {a, b}
    assert profiles[b].organization_id == INST_B
    assert port.get_public_profiles([]) == {}


def test_organization_summary(port: SqlIdentityQuery) -> None:
    summary = port.get_organization_summary(INST_B)
    assert summary is not None and summary.code == "inst-b" and summary.type == "RESEARCH_INSTITUTE"
    assert port.get_organization_summary(UNKNOWN) is None


def test_is_active_user(port: SqlIdentityQuery, seeded: PgUrls) -> None:
    assert port.is_active_user(uid("a.researcher@inst-a.local")) is True
    assert port.is_active_user(uid("b.disabled@inst-b.local")) is False
    assert port.is_active_user(UNKNOWN) is False
    with session_scope(seeded.app) as session:
        session.execute(
            text("UPDATE identity.users SET status = 'DISABLED' WHERE user_id = :u"),
            {"u": uid("a.researcher@inst-a.local")},
        )
    assert port.is_active_user(uid("a.researcher@inst-a.local")) is False


def test_has_org_role(port: SqlIdentityQuery) -> None:
    assert port.has_org_role(uid("a.admin@inst-a.local"), INST_A, "ORG_ADMIN") is True
    assert port.has_org_role(uid("a.admin@inst-a.local"), INST_B, "ORG_ADMIN") is False
    assert port.has_org_role(uid("a.researcher@inst-a.local"), INST_A, "DATA_STEWARD") is False
    assert port.has_org_role(uid("b.steward@inst-b.local"), INST_B, "DATA_STEWARD") is True


def test_list_users_with_org_role_only_active(port: SqlIdentityQuery, seeded: PgUrls) -> None:
    assert port.list_users_with_org_role(INST_A, "ORG_ADMIN") == [uid("a.admin@inst-a.local")]
    assert port.list_users_with_org_role(INST_B, "DATA_STEWARD") == [uid("b.steward@inst-b.local")]
    with session_scope(seeded.app) as session:
        session.execute(
            text("UPDATE identity.organization_memberships SET status = 'DISABLED' WHERE user_id = :u"),
            {"u": uid("b.steward@inst-b.local")},
        )
    assert port.list_users_with_org_role(INST_B, "DATA_STEWARD") == []


def test_get_email(port: SqlIdentityQuery) -> None:
    assert port.get_email(uid("a.researcher@inst-a.local")) == "a.researcher@inst-a.local"
    assert port.get_email(UNKNOWN) is None
```

- [ ] **Step 2: Run to verify it fails**

Run: `uv run pytest apps/api/modules/identity/tests/test_query_port.py -v`
Expected: collection error `ImportError: cannot import name 'IdentityQueryPort' from 'api.modules.identity.public'`.

- [ ] **Step 3: Implement the port**

Append to `apps/api/modules/identity/public.py` (and add `from typing import Literal, Protocol` in place of the existing `from typing import Literal`):

```python
class IdentityQueryPort(Protocol):
    """Read port for other modules (spec §8). Look it up with api.platform.ports.get(IdentityQueryPort)."""

    def get_public_profile(self, user_id: UUID) -> IdentityPublicProfile | None: ...

    def get_public_profiles(self, user_ids: list[UUID]) -> dict[UUID, IdentityPublicProfile]: ...

    def get_organization_summary(self, organization_id: UUID) -> OrganizationSummary | None: ...

    def is_active_user(self, user_id: UUID) -> bool:
        """User ACTIVE and membership ACTIVE."""
        ...

    def has_org_role(self, user_id: UUID, organization_id: UUID, role: str) -> bool: ...

    def list_users_with_org_role(self, organization_id: UUID, role: str) -> list[UUID]:
        """ACTIVE users with an ACTIVE membership holding role (M09 notification recipients)."""
        ...

    def get_email(self, user_id: UUID) -> str | None:
        """M09 mail delivery only. Other modules must not use it."""
        ...
```

`apps/api/modules/identity/query.py`:

```python
"""SQL adapter for IdentityQueryPort. Each call is one short read transaction."""

from typing import Any
from uuid import UUID

from sqlalchemy import Select, and_, any_, literal, select
from sqlalchemy.orm import Session

from api.modules.identity.public import IdentityPublicProfile, OrganizationSummary
from api.modules.identity.resolver import SessionFactory
from api.modules.identity.tables import memberships, organizations, users
from api.platform.db import session_scope

_BOTH_ACTIVE = and_(users.c.status == "ACTIVE", memberships.c.status == "ACTIVE")


def _profiles_select() -> Select[Any]:
    return select(
        users.c.user_id,
        users.c.display_name,
        users.c.status.label("user_status"),
        memberships.c.status.label("membership_status"),
        memberships.c.organization_id,
        organizations.c.name.label("organization_name"),
    ).select_from(
        users.join(memberships, memberships.c.user_id == users.c.user_id).join(
            organizations, organizations.c.organization_id == memberships.c.organization_id
        )
    )


def _profile(row: Any) -> IdentityPublicProfile:
    active = row.user_status == "ACTIVE" and row.membership_status == "ACTIVE"
    return IdentityPublicProfile(
        user_id=row.user_id,
        display_name=row.display_name,
        organization_id=row.organization_id,
        organization_name=row.organization_name,
        status="ACTIVE" if active else "DISABLED",
    )


class SqlIdentityQuery:
    def __init__(self, sessions: SessionFactory = session_scope) -> None:
        self._sessions = sessions

    def _read(self) -> Any:
        return self._sessions()

    def get_public_profile(self, user_id: UUID) -> IdentityPublicProfile | None:
        return self.get_public_profiles([user_id]).get(user_id)

    def get_public_profiles(self, user_ids: list[UUID]) -> dict[UUID, IdentityPublicProfile]:
        if not user_ids:
            return {}
        with self._read() as session:
            rows = session.execute(_profiles_select().where(users.c.user_id.in_(user_ids))).all()
        return {row.user_id: _profile(row) for row in rows}

    def get_organization_summary(self, organization_id: UUID) -> OrganizationSummary | None:
        with self._read() as session:
            row = session.execute(
                select(
                    organizations.c.organization_id, organizations.c.code, organizations.c.name, organizations.c.type
                ).where(organizations.c.organization_id == organization_id)
            ).first()
        if row is None:
            return None
        return OrganizationSummary(organization_id=row.organization_id, code=row.code, name=row.name, type=row.type)

    def is_active_user(self, user_id: UUID) -> bool:
        with self._read() as session:
            return self._exists(session, users.c.user_id == user_id, _BOTH_ACTIVE)

    def has_org_role(self, user_id: UUID, organization_id: UUID, role: str) -> bool:
        with self._read() as session:
            return self._exists(
                session,
                users.c.user_id == user_id,
                memberships.c.organization_id == organization_id,
                literal(role) == any_(memberships.c.roles),
                _BOTH_ACTIVE,
            )

    def list_users_with_org_role(self, organization_id: UUID, role: str) -> list[UUID]:
        with self._read() as session:
            rows = session.execute(
                select(users.c.user_id)
                .select_from(users.join(memberships, memberships.c.user_id == users.c.user_id))
                .where(
                    memberships.c.organization_id == organization_id,
                    literal(role) == any_(memberships.c.roles),
                    _BOTH_ACTIVE,
                )
                .order_by(users.c.user_id)
            ).all()
        return [row.user_id for row in rows]

    def get_email(self, user_id: UUID) -> str | None:
        with self._read() as session:
            email = session.execute(select(users.c.email).where(users.c.user_id == user_id)).scalar_one_or_none()
        return str(email) if email is not None else None

    @staticmethod
    def _exists(session: Session, *conditions: Any) -> bool:
        found = session.execute(
            select(users.c.user_id)
            .select_from(users.join(memberships, memberships.c.user_id == users.c.user_id))
            .where(*conditions)
            .limit(1)
        ).first()
        return found is not None
```

In `apps/api/modules/identity/__init__.py`, add these imports next to the existing ones:

```python
from api.modules.identity.public import IdentityQueryPort
from api.modules.identity.query import SqlIdentityQuery
```

and replace `wire_ports` with:

```python
def wire_ports(sessions: SessionFactory = session_scope) -> None:
    """Provide M01's ports. Production uses DATABASE_URL; tests pass a factory bound to their database."""
    ports.provide(PrincipalResolver, IdentityPrincipalResolver(sessions))
    ports.provide(IdentityQueryPort, SqlIdentityQuery(sessions))
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `uv run pytest apps/api/modules/identity/tests -v`
Expected: all PASS.

- [ ] **Step 5: Lint and commit**

```bash
uv run ruff check --fix apps/api/modules/identity && uv run ruff format apps/api/modules/identity
git add apps/api/modules/identity
git commit -m "feat(identity): IdentityQueryPort for other modules

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Daily `identity.prune_sessions` job

**Files:**
- Create: `apps/api/modules/identity/jobs.py`
- Modify: `apps/api/modules/identity/__init__.py` (add `register_worker=register_worker`)
- Test: `apps/api/modules/identity/tests/test_jobs.py`

**Interfaces:**
- Consumes: `SessionFactory` (Task 4), `api.platform.scheduler.Scheduler.every(interval_s, name, fn)`, `api.platform.clock.now`.
- Produces: `jobs.RETENTION = timedelta(days=90)`, `jobs.PRUNE_INTERVAL_S = 86400.0`, `jobs.prune_sessions(session: Session, *, now: datetime) -> int`, `jobs.run_prune_sessions(sessions: SessionFactory = session_scope) -> None`, `jobs.register_worker(broker: dramatiq.Broker, scheduler: Scheduler) -> None` registering job `"identity.prune_sessions"`.

- [ ] **Step 1: Write the failing tests**

`apps/api/modules/identity/tests/test_jobs.py`:

```python
from datetime import UTC, datetime, timedelta

from dramatiq.brokers.stub import StubBroker
from sqlalchemy import text

from api.modules.identity import MODULE
from api.modules.identity.jobs import prune_sessions, register_worker, run_prune_sessions
from api.modules.identity.seed_data import USERS_BY_EMAIL
from api.modules.identity.tests.support import scalar
from api.platform import clock
from api.platform.db import session_scope
from api.platform.scheduler import Scheduler
from api.platform.testing.fixtures import PgUrls

NOW = datetime(2026, 10, 1, tzinfo=UTC)


def add_session(urls: PgUrls, session_id: str, age: timedelta) -> None:
    with session_scope(urls.app) as session:
        session.execute(
            text("INSERT INTO identity.user_sessions (session_id, user_id, first_seen_at) VALUES (:s, :u, :t)"),
            {"s": session_id, "u": USERS_BY_EMAIL["a.researcher@inst-a.local"].user_id, "t": NOW - age},
        )


def test_prune_deletes_sessions_older_than_90_days(seeded: PgUrls) -> None:
    add_session(seeded, "old", timedelta(days=91))
    add_session(seeded, "recent", timedelta(days=89))
    with session_scope(seeded.app) as session:
        assert prune_sessions(session, now=NOW) == 1
    assert scalar(seeded, "SELECT array_agg(session_id) FROM identity.user_sessions") == ["recent"]


def test_scheduled_run_uses_the_clock(seeded: PgUrls) -> None:
    add_session(seeded, "old", timedelta(days=91))
    with clock.frozen(NOW):
        run_prune_sessions(lambda: session_scope(seeded.app))
    assert scalar(seeded, "SELECT count(*) FROM identity.user_sessions") == 0


def test_job_is_registered_daily() -> None:
    scheduler = Scheduler(clock=lambda: 0.0)
    register_worker(StubBroker(), scheduler)
    assert scheduler.job_names == ["identity.prune_sessions"]
    assert MODULE.register_worker is register_worker
```

- [ ] **Step 2: Run to verify it fails**

Run: `uv run pytest apps/api/modules/identity/tests/test_jobs.py -v`
Expected: collection error `ModuleNotFoundError: No module named 'api.modules.identity.jobs'`.

- [ ] **Step 3: Implement the job and register it**

`apps/api/modules/identity/jobs.py`:

```python
"""Background jobs (spec §10): identity.prune_sessions, daily, deletes user_sessions older than 90 days."""

import logging
from datetime import datetime, timedelta
from typing import Any, cast

import dramatiq
from sqlalchemy import CursorResult, delete
from sqlalchemy.orm import Session

from api.modules.identity.resolver import SessionFactory
from api.modules.identity.tables import user_sessions
from api.platform import clock
from api.platform.db import session_scope
from api.platform.scheduler import Scheduler

logger = logging.getLogger("nais.identity.jobs")

RETENTION = timedelta(days=90)
PRUNE_INTERVAL_S = 86400.0


def prune_sessions(session: Session, *, now: datetime) -> int:
    result = cast(
        CursorResult[Any],
        session.execute(delete(user_sessions).where(user_sessions.c.first_seen_at < now - RETENTION)),
    )
    return result.rowcount


def run_prune_sessions(sessions: SessionFactory = session_scope) -> None:
    with sessions() as session:
        deleted = prune_sessions(session, now=clock.now())
    logger.info("pruned identity sessions", extra={"deleted": deleted})


def register_worker(broker: dramatiq.Broker, scheduler: Scheduler) -> None:
    scheduler.every(PRUNE_INTERVAL_S, "identity.prune_sessions", run_prune_sessions)
```

In `apps/api/modules/identity/__init__.py` add `from api.modules.identity.jobs import register_worker` to the imports and add `register_worker=register_worker,` to the `ModuleSpec(...)` call (after `wire=wire,`).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `uv run pytest apps/api/modules/identity/tests -v`
Expected: all PASS.

- [ ] **Step 5: Lint and commit**

```bash
uv run ruff check --fix apps/api/modules/identity && uv run ruff format apps/api/modules/identity
git add apps/api/modules/identity
git commit -m "feat(identity): daily prune of 90-day-old login sessions

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Keycloak realm `nais` import file

**Files:**
- Create: `infra/keycloak/import/realm-nais.json`
- Test: `apps/api/modules/identity/tests/test_realm.py`

**Interfaces:**
- Consumes: `seed_data.USERS`, `ORGS_BY_CODE` (Task 3) — the realm's user ids/emails/org codes must equal the seed.
- Produces: realm `nais` with clients `nais-web` (public, Standard Flow, PKCE S256 required, direct grants off, redirect `…/web-auth/callback/keycloak` on `localhost:21051` and `<NAIS_EXTERNAL_HOST>:21051`), `nais-api` (bearer-only; audience), `nais-e2e` (confidential, secret `nais`, direct grants on — dev/test only); on both token clients an `org_code` user-attribute mapper and an `oidc-audience-mapper` adding `nais-api`; declarative user profile with required, admin-edit-only `org_code`; 8 users (id = seed `user_id`, username = email, password `nais`, all enabled — b.disabled is blocked by NAIS, not Keycloak); no custom realm roles; `sslRequired: none` (dev over plain HTTP on the external IP, D-037); lifespans 300/1800/36000.

This file was validated before planning against `quay.io/keycloak/keycloak:26.0` (26.0.8): it imports cleanly, a `nais-e2e` password-grant token for a.researcher carries `aud: "nais-api"`, `org_code: "inst-a"`, `sub: 00000000-0000-7000-8000-000000000a02`, `sid`, `name`, `email`; an authorization request to `nais-web` without `code_challenge` is redirected with `error=invalid_request`; `nais-web` direct grant returns `unauthorized_client`.

- [ ] **Step 1: Write the failing test**

`apps/api/modules/identity/tests/test_realm.py`:

```python
import json
from typing import Any

from api.modules.identity.seed_data import ORGS_BY_CODE, USERS
from api.platform.settings import REPO_ROOT

REALM_FILE = REPO_ROOT / "infra" / "keycloak" / "import" / "realm-nais.json"


def realm() -> dict[str, Any]:
    data: dict[str, Any] = json.loads(REALM_FILE.read_text(encoding="utf-8"))
    return data


def client(client_id: str) -> dict[str, Any]:
    return next(c for c in realm()["clients"] if c["clientId"] == client_id)


def test_realm_basics() -> None:
    data = realm()
    assert data["realm"] == "nais" and data["enabled"] is True
    assert data["registrationAllowed"] is False
    assert (data["accessTokenLifespan"], data["ssoSessionIdleTimeout"], data["ssoSessionMaxLifespan"]) == (
        300,
        1800,
        36000,
    )
    assert "roles" not in data  # D-019: roles live in NAIS, not Keycloak


def test_nais_web_is_public_pkce_without_direct_grants() -> None:
    web = client("nais-web")
    assert web["publicClient"] is True
    assert web["standardFlowEnabled"] is True
    assert web["implicitFlowEnabled"] is False
    assert web["directAccessGrantsEnabled"] is False
    assert web["attributes"]["pkce.code.challenge.method"] == "S256"
    assert "http://localhost:21051/web-auth/callback/keycloak" in web["redirectUris"]
    assert "http://<NAIS_EXTERNAL_HOST>:21051/web-auth/callback/keycloak" in web["redirectUris"]
    # M10 (W1-D6): post-logout redirect to "/" on both hosts
    assert web["attributes"]["post.logout.redirect.uris"] == "http://localhost:21051/*##http://<NAIS_EXTERNAL_HOST>:21051/*"
    assert all(uri.endswith("/web-auth/callback/keycloak") for uri in web["redirectUris"])
    assert "http://localhost:21051" in web["webOrigins"]
    assert "basic" in web["defaultClientScopes"]  # KC 25+: the sub claim comes from the basic scope


def test_nais_api_is_audience_only() -> None:
    api = client("nais-api")
    assert api["bearerOnly"] is True
    assert api["standardFlowEnabled"] is False and api["directAccessGrantsEnabled"] is False


def test_e2e_client_is_confidential_with_direct_grants() -> None:
    e2e = client("nais-e2e")
    assert e2e["publicClient"] is False
    assert e2e["directAccessGrantsEnabled"] is True
    assert e2e["standardFlowEnabled"] is False
    assert e2e["secret"] == "nais"


def test_token_clients_emit_org_code_and_api_audience() -> None:
    for client_id in ("nais-web", "nais-e2e"):
        mappers = {m["name"]: m for m in client(client_id)["protocolMappers"]}
        org_code = mappers["org_code"]
        assert org_code["protocolMapper"] == "oidc-usermodel-attribute-mapper"
        assert org_code["config"]["user.attribute"] == "org_code"
        assert org_code["config"]["claim.name"] == "org_code"
        assert org_code["config"]["access.token.claim"] == "true"
        assert org_code["config"]["id.token.claim"] == "true"
        audience = mappers["audience-nais-api"]
        assert audience["protocolMapper"] == "oidc-audience-mapper"
        assert audience["config"]["included.client.audience"] == "nais-api"
        assert audience["config"]["access.token.claim"] == "true"


def test_org_code_is_required_and_admin_editable_only() -> None:
    component = realm()["components"]["org.keycloak.userprofile.UserProfileProvider"][0]
    profile = json.loads(component["config"]["kc.user.profile.config"][0])
    attribute = next(a for a in profile["attributes"] if a["name"] == "org_code")
    assert attribute["permissions"]["edit"] == ["admin"]
    assert "user" in attribute["required"]["roles"]
    assert {a["name"] for a in profile["attributes"]} >= {"username", "email", "firstName", "lastName"}


def test_realm_users_match_the_seed() -> None:
    by_id = {u["id"]: u for u in realm()["users"]}
    assert set(by_id) == {str(user.user_id) for user in USERS}
    for user in USERS:
        kc = by_id[str(user.user_id)]
        assert kc["username"] == kc["email"] == user.email
        assert kc["emailVerified"] is True and kc["enabled"] is True
        assert kc["attributes"]["org_code"] == [user.org_code]
        assert user.org_code in ORGS_BY_CODE
        assert f"{kc['firstName']} {kc['lastName']}" == user.display_name
        assert kc["credentials"] == [{"type": "password", "value": "nais", "temporary": False}]
        assert kc["requiredActions"] == []
```

- [ ] **Step 2: Run to verify it fails**

Run: `uv run pytest apps/api/modules/identity/tests/test_realm.py -v`
Expected: FAIL — `FileNotFoundError: ... infra/keycloak/import/realm-nais.json`.

- [ ] **Step 3: Write the realm file**

`infra/keycloak/import/realm-nais.json` (exact content; the user-profile config is a JSON string inside JSON, keep the escaping):

```json
{
  "realm": "nais",
  "displayName": "NAIS AI-OS",
  "enabled": true,
  "sslRequired": "none",
  "registrationAllowed": false,
  "registrationEmailAsUsername": false,
  "loginWithEmailAllowed": true,
  "duplicateEmailsAllowed": false,
  "resetPasswordAllowed": false,
  "editUsernameAllowed": false,
  "bruteForceProtected": true,
  "accessTokenLifespan": 300,
  "ssoSessionIdleTimeout": 1800,
  "ssoSessionMaxLifespan": 36000,
  "components": {
    "org.keycloak.userprofile.UserProfileProvider": [
      {
        "providerId": "declarative-user-profile",
        "subComponents": {},
        "config": {
          "kc.user.profile.config": [
            "{\"attributes\":[{\"name\":\"username\",\"displayName\":\"${username}\",\"validations\":{\"length\":{\"min\":3,\"max\":255},\"username-prohibited-characters\":{},\"up-username-not-idn-homograph\":{}},\"permissions\":{\"view\":[\"admin\",\"user\"],\"edit\":[\"admin\",\"user\"]},\"multivalued\":false},{\"name\":\"email\",\"displayName\":\"${email}\",\"validations\":{\"email\":{},\"length\":{\"max\":255}},\"required\":{\"roles\":[\"user\"]},\"permissions\":{\"view\":[\"admin\",\"user\"],\"edit\":[\"admin\",\"user\"]},\"multivalued\":false},{\"name\":\"firstName\",\"displayName\":\"${firstName}\",\"validations\":{\"length\":{\"max\":255},\"person-name-prohibited-characters\":{}},\"required\":{\"roles\":[\"user\"]},\"permissions\":{\"view\":[\"admin\",\"user\"],\"edit\":[\"admin\",\"user\"]},\"multivalued\":false},{\"name\":\"lastName\",\"displayName\":\"${lastName}\",\"validations\":{\"length\":{\"max\":255},\"person-name-prohibited-characters\":{}},\"required\":{\"roles\":[\"user\"]},\"permissions\":{\"view\":[\"admin\",\"user\"],\"edit\":[\"admin\",\"user\"]},\"multivalued\":false},{\"name\":\"org_code\",\"displayName\":\"Organization code\",\"validations\":{\"pattern\":{\"pattern\":\"^[a-z0-9-]{2,32}$\",\"error-message\":\"org_code must match ^[a-z0-9-]{2,32}$\"}},\"required\":{\"roles\":[\"admin\",\"user\"]},\"permissions\":{\"view\":[\"admin\",\"user\"],\"edit\":[\"admin\"]},\"multivalued\":false}],\"groups\":[{\"name\":\"user-metadata\",\"displayHeader\":\"User metadata\",\"displayDescription\":\"Attributes, which refer to user metadata\"}]}"
          ]
        }
      }
    ]
  },
  "clients": [
    {
      "clientId": "nais-web",
      "name": "NAIS web portal",
      "enabled": true,
      "protocol": "openid-connect",
      "publicClient": true,
      "standardFlowEnabled": true,
      "implicitFlowEnabled": false,
      "directAccessGrantsEnabled": false,
      "serviceAccountsEnabled": false,
      "redirectUris": [
        "http://localhost:21051/web-auth/callback/keycloak",
        "http://<NAIS_EXTERNAL_HOST>:21051/web-auth/callback/keycloak"
      ],
      "webOrigins": [
        "http://localhost:21051",
        "http://<NAIS_EXTERNAL_HOST>:21051"
      ],
      "attributes": {
        "pkce.code.challenge.method": "S256",
        "post.logout.redirect.uris": "http://localhost:21051/*##http://<NAIS_EXTERNAL_HOST>:21051/*"
      },
      "defaultClientScopes": [
        "web-origins",
        "acr",
        "profile",
        "roles",
        "basic",
        "email"
      ],
      "optionalClientScopes": [
        "offline_access"
      ],
      "protocolMappers": [
        {
          "name": "org_code",
          "protocol": "openid-connect",
          "protocolMapper": "oidc-usermodel-attribute-mapper",
          "consentRequired": false,
          "config": {
            "user.attribute": "org_code",
            "claim.name": "org_code",
            "jsonType.label": "String",
            "access.token.claim": "true",
            "id.token.claim": "true",
            "userinfo.token.claim": "true",
            "introspection.token.claim": "true",
            "multivalued": "false"
          }
        },
        {
          "name": "audience-nais-api",
          "protocol": "openid-connect",
          "protocolMapper": "oidc-audience-mapper",
          "consentRequired": false,
          "config": {
            "included.client.audience": "nais-api",
            "access.token.claim": "true",
            "id.token.claim": "false",
            "introspection.token.claim": "true"
          }
        }
      ]
    },
    {
      "clientId": "nais-api",
      "name": "NAIS API (audience only)",
      "enabled": true,
      "protocol": "openid-connect",
      "bearerOnly": true,
      "publicClient": false,
      "standardFlowEnabled": false,
      "implicitFlowEnabled": false,
      "directAccessGrantsEnabled": false,
      "serviceAccountsEnabled": false
    },
    {
      "clientId": "nais-e2e",
      "name": "NAIS E2E tests (dev/test realm only)",
      "enabled": true,
      "protocol": "openid-connect",
      "publicClient": false,
      "clientAuthenticatorType": "client-secret",
      "secret": "nais",
      "standardFlowEnabled": false,
      "implicitFlowEnabled": false,
      "directAccessGrantsEnabled": true,
      "serviceAccountsEnabled": false,
      "defaultClientScopes": [
        "web-origins",
        "acr",
        "profile",
        "roles",
        "basic",
        "email"
      ],
      "protocolMappers": [
        {
          "name": "org_code",
          "protocol": "openid-connect",
          "protocolMapper": "oidc-usermodel-attribute-mapper",
          "consentRequired": false,
          "config": {
            "user.attribute": "org_code",
            "claim.name": "org_code",
            "jsonType.label": "String",
            "access.token.claim": "true",
            "id.token.claim": "true",
            "userinfo.token.claim": "true",
            "introspection.token.claim": "true",
            "multivalued": "false"
          }
        },
        {
          "name": "audience-nais-api",
          "protocol": "openid-connect",
          "protocolMapper": "oidc-audience-mapper",
          "consentRequired": false,
          "config": {
            "included.client.audience": "nais-api",
            "access.token.claim": "true",
            "id.token.claim": "false",
            "introspection.token.claim": "true"
          }
        }
      ]
    }
  ],
  "users": [
    {
      "id": "00000000-0000-7000-8000-000000000101",
      "username": "admin@nais.local",
      "email": "admin@nais.local",
      "emailVerified": true,
      "enabled": true,
      "firstName": "NAIS",
      "lastName": "Admin",
      "attributes": {
        "org_code": [
          "nais"
        ]
      },
      "credentials": [
        {
          "type": "password",
          "value": "nais",
          "temporary": false
        }
      ],
      "requiredActions": []
    },
    {
      "id": "00000000-0000-7000-8000-000000000a01",
      "username": "a.admin@inst-a.local",
      "email": "a.admin@inst-a.local",
      "emailVerified": true,
      "enabled": true,
      "firstName": "A",
      "lastName": "Admin",
      "attributes": {
        "org_code": [
          "inst-a"
        ]
      },
      "credentials": [
        {
          "type": "password",
          "value": "nais",
          "temporary": false
        }
      ],
      "requiredActions": []
    },
    {
      "id": "00000000-0000-7000-8000-000000000a02",
      "username": "a.researcher@inst-a.local",
      "email": "a.researcher@inst-a.local",
      "emailVerified": true,
      "enabled": true,
      "firstName": "A",
      "lastName": "Researcher",
      "attributes": {
        "org_code": [
          "inst-a"
        ]
      },
      "credentials": [
        {
          "type": "password",
          "value": "nais",
          "temporary": false
        }
      ],
      "requiredActions": []
    },
    {
      "id": "00000000-0000-7000-8000-000000000a03",
      "username": "a.steward@inst-a.local",
      "email": "a.steward@inst-a.local",
      "emailVerified": true,
      "enabled": true,
      "firstName": "A",
      "lastName": "Steward",
      "attributes": {
        "org_code": [
          "inst-a"
        ]
      },
      "credentials": [
        {
          "type": "password",
          "value": "nais",
          "temporary": false
        }
      ],
      "requiredActions": []
    },
    {
      "id": "00000000-0000-7000-8000-000000000b01",
      "username": "b.admin@inst-b.local",
      "email": "b.admin@inst-b.local",
      "emailVerified": true,
      "enabled": true,
      "firstName": "B",
      "lastName": "Admin",
      "attributes": {
        "org_code": [
          "inst-b"
        ]
      },
      "credentials": [
        {
          "type": "password",
          "value": "nais",
          "temporary": false
        }
      ],
      "requiredActions": []
    },
    {
      "id": "00000000-0000-7000-8000-000000000b02",
      "username": "b.researcher@inst-b.local",
      "email": "b.researcher@inst-b.local",
      "emailVerified": true,
      "enabled": true,
      "firstName": "B",
      "lastName": "Researcher",
      "attributes": {
        "org_code": [
          "inst-b"
        ]
      },
      "credentials": [
        {
          "type": "password",
          "value": "nais",
          "temporary": false
        }
      ],
      "requiredActions": []
    },
    {
      "id": "00000000-0000-7000-8000-000000000b03",
      "username": "b.steward@inst-b.local",
      "email": "b.steward@inst-b.local",
      "emailVerified": true,
      "enabled": true,
      "firstName": "B",
      "lastName": "Steward",
      "attributes": {
        "org_code": [
          "inst-b"
        ]
      },
      "credentials": [
        {
          "type": "password",
          "value": "nais",
          "temporary": false
        }
      ],
      "requiredActions": []
    },
    {
      "id": "00000000-0000-7000-8000-000000000b04",
      "username": "b.disabled@inst-b.local",
      "email": "b.disabled@inst-b.local",
      "emailVerified": true,
      "enabled": true,
      "firstName": "B",
      "lastName": "Disabled",
      "attributes": {
        "org_code": [
          "inst-b"
        ]
      },
      "credentials": [
        {
          "type": "password",
          "value": "nais",
          "temporary": false
        }
      ],
      "requiredActions": []
    }
  ]
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `uv run pytest apps/api/modules/identity/tests/test_realm.py -v && python3 -m json.tool infra/keycloak/import/realm-nais.json > /dev/null`
Expected: all PASS; `json.tool` prints nothing.

- [ ] **Step 5: Lint and commit**

```bash
uv run ruff check --fix apps/api/modules/identity && uv run ruff format apps/api/modules/identity
git add infra/keycloak/import/realm-nais.json apps/api/modules/identity/tests/test_realm.py
git commit -m "feat(keycloak): realm nais with PKCE web client, e2e client, org_code claim and seed users

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 11: Import the realm into the running Keycloak and verify OIDC (M01-AT-16)

**Files:**
- Create: `apps/api/modules/identity/tests/test_live_stack.py` (opt-in, skipped unless `NAIS_LIVE=1`)

**Interfaces:**
- Consumes: `infra/keycloak/import/realm-nais.json` (Task 10) — the compose `keycloak` service mounts `./infra/keycloak/import` read-only at `/opt/keycloak/data/import` and runs `start-dev --import-realm`; `seed_data.USERS` (Task 3).
- Produces: realm `nais` live at `http://localhost:21051/auth/realms/nais`; helpers in `test_live_stack.py` reused by Task 12: `BASE`, `REALM`, `EXPECTED_ISSUER`, `password_token(username, *, password="nais", client_id="nais-e2e", secret="nais") -> httpx.Response`, `access_token(username) -> str`, `claims_of(token) -> dict[str, Any]`.

Keycloak facts (checked on 26.0.8): `--import-realm` imports a realm only if it does not exist yet ("Realm 'nais' already exists. Import skipped" otherwise); the H2 dev database lives in the container, so `docker compose restart` keeps an imported realm. The token issuer is always `${NAIS_PUBLIC_BASE_URL}/auth/realms/nais` (from `KC_HOSTNAME`), whatever host you call — read it from `.env`.

- [ ] **Step 1: Write the live checks**

`apps/api/modules/identity/tests/test_live_stack.py`:

```python
"""Live checks against the running compose stack through the 21051 gateway.

Opt-in: NAIS_LIVE=1 uv run pytest apps/api/modules/identity/tests/test_live_stack.py -v
"""

import base64
import json
import os
from typing import Any

import httpx
import pytest

from api.modules.identity.seed_data import USERS
from api.platform.settings import REPO_ROOT

pytestmark = pytest.mark.skipif(os.environ.get("NAIS_LIVE") != "1", reason="set NAIS_LIVE=1 to hit the stack")

BASE = os.environ.get("NAIS_LIVE_BASE_URL", "http://localhost:21051")
REALM = f"{BASE}/auth/realms/nais"
CALLBACK = "http://localhost:21051/web-auth/callback/keycloak"
PKCE_CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"


def env_value(key: str, default: str) -> str:
    if key in os.environ:
        return os.environ[key]
    env_file = REPO_ROOT / ".env"
    if env_file.exists():
        for line in env_file.read_text(encoding="utf-8").splitlines():
            if line.startswith(f"{key}="):
                return line.split("=", 1)[1].strip()
    return default


EXPECTED_ISSUER = env_value("OIDC_ISSUER", "http://localhost:21051/auth/realms/nais")


def password_token(
    username: str, *, password: str = "nais", client_id: str = "nais-e2e", secret: str | None = "nais"
) -> httpx.Response:
    data = {
        "grant_type": "password",
        "client_id": client_id,
        "username": username,
        "password": password,
        "scope": "openid",
    }
    if secret is not None:
        data["client_secret"] = secret
    return httpx.post(f"{REALM}/protocol/openid-connect/token", data=data, timeout=10)


def access_token(username: str) -> str:
    response = password_token(username)
    assert response.status_code == 200, response.text
    return str(response.json()["access_token"])


def claims_of(token: str) -> dict[str, Any]:
    payload = token.split(".")[1]
    payload += "=" * (-len(payload) % 4)
    claims: dict[str, Any] = json.loads(base64.urlsafe_b64decode(payload))
    return claims


def authorize(**extra: str) -> httpx.Response:
    params = {"client_id": "nais-web", "response_type": "code", "scope": "openid", "redirect_uri": CALLBACK}
    params.update(extra)
    return httpx.get(f"{REALM}/protocol/openid-connect/auth", params=params, timeout=10, follow_redirects=False)


def test_discovery_document() -> None:
    response = httpx.get(f"{REALM}/.well-known/openid-configuration", timeout=10)
    assert response.status_code == 200
    document = response.json()
    assert document["issuer"] == EXPECTED_ISSUER
    assert "S256" in document["code_challenge_methods_supported"]


def test_password_grant_token_carries_nais_claims() -> None:
    claims = claims_of(access_token("a.researcher@inst-a.local"))
    assert claims["iss"] == EXPECTED_ISSUER
    audience = claims["aud"] if isinstance(claims["aud"], list) else [claims["aud"]]
    assert "nais-api" in audience
    assert claims["sub"] == "00000000-0000-7000-8000-000000000a02"
    assert claims["org_code"] == "inst-a"
    assert claims["email"] == "a.researcher@inst-a.local"
    assert claims["name"] == "A Researcher"
    assert claims["sid"]
    assert claims["exp"] - claims["iat"] == 300


def test_every_seed_user_can_log_in() -> None:
    for user in USERS:
        assert password_token(user.email).status_code == 200, user.email


def test_wrong_password_is_rejected() -> None:
    assert password_token("a.researcher@inst-a.local", password="wrong").status_code == 401


def test_web_client_has_no_direct_grant() -> None:
    response = password_token("a.researcher@inst-a.local", client_id="nais-web", secret=None)
    assert response.status_code in (400, 401)
    assert response.json()["error"] == "unauthorized_client"


def test_authorization_code_without_pkce_is_rejected() -> None:  # M01-AT-16
    rejected = authorize()
    assert rejected.status_code == 302
    location = rejected.headers["location"]
    assert location.startswith(CALLBACK)
    assert "error=invalid_request" in location and "code_challenge_method" in location
    accepted = authorize(code_challenge=PKCE_CHALLENGE, code_challenge_method="S256")
    assert accepted.status_code == 200  # the login page
```

- [ ] **Step 2: Confirm the checks fail before the realm exists**

Run: `NAIS_LIVE=1 uv run pytest apps/api/modules/identity/tests/test_live_stack.py -v`
Expected: FAIL (discovery returns 404 `Realm does not exist`). Without `NAIS_LIVE=1` the file is skipped: `uv run pytest apps/api/modules/identity/tests/test_live_stack.py` → `6 skipped`.

- [ ] **Step 3: Restart Keycloak so it imports the realm**

```bash
cd /data/project/nst-nexus
docker compose restart keycloak
for i in $(seq 1 90); do curl -sf http://localhost:21051/auth/realms/nais/.well-known/openid-configuration >/dev/null && break; sleep 2; done
docker compose logs keycloak --since 5m | grep -E "Realm 'nais' (imported|already exists)"
curl -s http://localhost:21051/auth/realms/nais/.well-known/openid-configuration | python3 -c 'import json,sys; print(json.load(sys.stdin)["issuer"])'
```

Expected: the log line `Realm 'nais' imported`; the issuer printed equals `OIDC_ISSUER` in `.env` (currently `http://<NAIS_EXTERNAL_HOST>:21051/auth/realms/nais`).

Only if the log says `Realm 'nais' already exists. Import skipped` (a realm from an earlier attempt is stale), delete it and restart again — this is a realm delete, not a volume delete:

```bash
docker compose exec keycloak /opt/keycloak/bin/kcadm.sh config credentials --server http://localhost:8080/auth --realm master --user nais --password nais
docker compose exec keycloak /opt/keycloak/bin/kcadm.sh delete realms/nais
docker compose restart keycloak
```

- [ ] **Step 4: Verify a real password-grant token**

```bash
TOKEN=$(curl -s -d grant_type=password -d client_id=nais-e2e -d client_secret=nais \
  -d username=a.researcher@inst-a.local -d password=nais -d scope=openid \
  http://localhost:21051/auth/realms/nais/protocol/openid-connect/token \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["access_token"])')
echo "$TOKEN" | cut -d. -f2 | python3 -c 'import base64,json,sys; s=sys.stdin.read().strip(); s+="="*(-len(s)%4); c=json.loads(base64.urlsafe_b64decode(s)); print({k: c.get(k) for k in ("iss","aud","sub","org_code","sid","email","name")})'
```

Expected: `aud` `nais-api`, `sub` `00000000-0000-7000-8000-000000000a02`, `org_code` `inst-a`, a non-empty `sid`, `iss` = `.env` `OIDC_ISSUER`.

Then run: `NAIS_LIVE=1 uv run pytest apps/api/modules/identity/tests/test_live_stack.py -v`
Expected: 6 PASS.

- [ ] **Step 5: Lint and commit**

```bash
uv run ruff check --fix apps/api/modules/identity && uv run ruff format apps/api/modules/identity
git add apps/api/modules/identity/tests/test_live_stack.py
git commit -m "test(identity): live Keycloak checks for realm nais (discovery, e2e token, PKCE)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Deploy, migrate, seed, and verify `/me` through the gateway; module README

**Files:**
- Modify: `apps/api/modules/identity/tests/test_live_stack.py` (append API checks)
- Create: `apps/api/modules/identity/README.md`

**Interfaces:**
- Consumes: everything above; platform CLI `python -m api.platform.cli migrate|seed` (runs every discovered module; `seed` uses `DATABASE_URL`, i.e. `nais_app`); gateway routes `/api/` → `api:8000`.
- Produces: the running stack serving identity with the 10_SEED_DATA §2–3 rows; a README for module users.

The api/worker image copies `apps/api` at build time (no source mount), so the image must be rebuilt.

- [ ] **Step 1: Append the API live checks**

Append to `apps/api/modules/identity/tests/test_live_stack.py`:

```python
API = f"{BASE}/api/v1"


def api_get(path: str, token: str | None, **params: Any) -> httpx.Response:
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    return httpx.get(f"{API}{path}", params=params, headers=headers, timeout=10)


def test_me_through_gateway_for_each_institute() -> None:  # M01-AT-01
    from api.platform.testing.contracts import assert_matches_response

    for email, code in (("a.researcher@inst-a.local", "inst-a"), ("b.researcher@inst-b.local", "inst-b")):
        response = api_get("/me", access_token(email))
        assert response.status_code == 200, response.text
        assert_matches_response("getMe", 200, response.json())
        assert response.json()["organization"]["code"] == code


def test_platform_admin_through_gateway() -> None:
    body = api_get("/me", access_token("admin@nais.local")).json()
    assert body["platform_roles"] == ["PLATFORM_ADMIN"] and body["organization"]["code"] == "nais"


def test_disabled_member_logs_in_but_is_blocked() -> None:  # M01-AT-05 (/projects, /datasets arrive with M02/M03)
    response = api_get("/me", access_token("b.disabled@inst-b.local"))
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "MEMBERSHIP_DISABLED"


def test_bad_tokens_are_401_through_gateway() -> None:  # M01-AT-08
    token = access_token("a.researcher@inst-a.local")
    header, payload, signature = token.split(".")
    tampered = f"{header}.{payload}.{signature[:-4]}AAAA"
    for candidate in (tampered, None):
        response = api_get("/me", candidate)
        assert response.status_code == 401
        assert response.json()["error"]["code"] == "UNAUTHENTICATED"


def test_directory_through_gateway() -> None:  # M01-AT-14
    body = api_get("/users", access_token("a.researcher@inst-a.local"), q="b.").json()
    assert [item["display_name"] for item in body["items"]] == ["B Admin", "B Researcher", "B Steward"]
    assert all("email" not in item for item in body["items"])
```

- [ ] **Step 2: Confirm the API checks fail before deploy**

Run: `NAIS_LIVE=1 uv run pytest apps/api/modules/identity/tests/test_live_stack.py -v -k "gateway or disabled"`
Expected: FAIL — `/api/v1/me` returns 404 (the running image has no identity module).

- [ ] **Step 3: Rebuild, migrate, seed, restart api/worker**

```bash
cd /data/project/nst-nexus
docker compose build api
docker compose run --rm --no-deps api python -m api.platform.cli migrate
docker compose run --rm --no-deps api python -m api.platform.cli seed
docker compose run --rm --no-deps api python -m api.platform.cli seed   # idempotency: must succeed again
docker compose up -d api worker
for i in $(seq 1 30); do curl -sf http://localhost:21051/api/v1/health/live >/dev/null && break; sleep 2; done
```

Expected: `migrated platform` and `migrated identity`; `seeded identity` twice (plus any other modules present on the branch); api healthy.

- [ ] **Step 4: Verify through the gateway**

```bash
TOKEN=$(curl -s -d grant_type=password -d client_id=nais-e2e -d client_secret=nais \
  -d username=a.researcher@inst-a.local -d password=nais -d scope=openid \
  http://localhost:21051/auth/realms/nais/protocol/openid-connect/token \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["access_token"])')
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:21051/api/v1/me; echo
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:21051/api/v1/organizations; echo
docker compose exec -T postgres psql -U nais -d nais -c \
  "SELECT event_type, count(*) FROM platform.outbox_events WHERE event_type LIKE 'identity.%' GROUP BY 1 ORDER BY 1"
docker compose logs worker --since 5m | grep -i "event subscriptions"
```

Expected: `/me` → `{"user_id":"00000000-0000-7000-8000-000000000a02",...,"organization":{...,"code":"inst-a",...},"org_roles":[],"platform_roles":[]}`; three organizations; outbox counts `identity.organization.created.v1` 3, `identity.user.created.v1` 8, `identity.user.logged_in.v1` ≥ 1 (dispatched by the relay; identity has no handlers, so none are listed for it in the subscription table).

Then run: `NAIS_LIVE=1 uv run pytest apps/api/modules/identity/tests/test_live_stack.py -v`
Expected: 11 PASS.

- [ ] **Step 5: Write the module README**

`apps/api/modules/identity/README.md`:

````markdown
# identity (M01 Identity & Organization)

Keycloak authenticates; NAIS owns users, institutes, memberships and roles (D-019).
Spec: `NAIS_PRD/modules/M01_identity_org.md`.

## What it provides
- `PrincipalResolver` (wired in `wire()`): every authenticated request of every module goes
  JWT (platform) -> `IdentityPrincipalResolver.resolve` -> `CurrentUser`. It JIT-provisions unknown users from the
  `org_code` claim, blocks DISABLED users/memberships (403 `USER_DISABLED` / `MEMBERSHIP_DISABLED`), rejects unknown
  or mismatched institutes (403 `ORGANIZATION_UNKNOWN`), and emits `identity.user.logged_in.v1` once per `sid`.
  Roles/status are read on every request (no cache).
- `IdentityQueryPort` (`api.modules.identity.public`): `ports.get(IdentityQueryPort)` for profiles, org summaries,
  role checks, role holders, and (M09 only) email.
- API: `GET /me`, `GET /users`, `GET /organizations[/{id}]`, `GET/PATCH /organizations/{id}/members[/{user_id}]`.
- Events: `identity.organization.created.v1`, `identity.user.created.v1`, `identity.user.logged_in.v1`,
  `identity.membership.changed.v1`.
- Job: `identity.prune_sessions` (daily, deletes `user_sessions` older than 90 days).

## Integration rules for other modules
Use only `CurrentUser` (`api.platform.auth.CurrentUserDep`) and `IdentityQueryPort`. Never read `identity.*` tables.
Seed UUIDs for your own seed: `infra/keycloak/seed_ids.json` (Keycloak user id == `user_id` == token `sub`).

## Local login (dev only, D-037)
Realm `nais` is imported from `infra/keycloak/import/realm-nais.json` on Keycloak start (only when the realm does
not exist yet). Every seed user's password is `nais`.

| user | institute | org roles | platform roles |
|---|---|---|---|
| admin@nais.local | nais | ORG_ADMIN | PLATFORM_ADMIN |
| a.admin@inst-a.local | inst-a | ORG_ADMIN | |
| a.researcher@inst-a.local | inst-a | | |
| a.steward@inst-a.local | inst-a | DATA_STEWARD | |
| b.admin@inst-b.local | inst-b | ORG_ADMIN | |
| b.researcher@inst-b.local | inst-b | | |
| b.steward@inst-b.local | inst-b | DATA_STEWARD | |
| b.disabled@inst-b.local | inst-b | (membership DISABLED) | |

Token for curl / E2E (client `nais-e2e`, dev/test realm only):

```bash
TOKEN=$(curl -s -d grant_type=password -d client_id=nais-e2e -d client_secret=nais \
  -d username=a.researcher@inst-a.local -d password=nais -d scope=openid \
  http://localhost:21051/auth/realms/nais/protocol/openid-connect/token | python3 -c 'import json,sys;print(json.load(sys.stdin)["access_token"])')
curl -H "Authorization: Bearer $TOKEN" http://localhost:21051/api/v1/me
```

The web portal uses `nais-web` (public, Authorization Code + PKCE S256, callback `/web-auth/callback/keycloak`).
Changing the realm file needs a re-import: `kcadm.sh delete realms/nais` inside the keycloak container, then
`docker compose restart keycloak`.

## Tests
- `uv run pytest apps/api/modules/identity` (Postgres via testcontainers).
- Live stack: `NAIS_LIVE=1 uv run pytest apps/api/modules/identity/tests/test_live_stack.py`.

## Known limitations (P0)
- One institute per user; no institute moves. Changing a user's `org_code` in Keycloak yields 403
  `ORGANIZATION_UNKNOWN` until an operator fixes the membership.
- No API to disable a user account (`users.status`); operators use SQL.
- Access tokens stay valid until expiry (5 min); DISABLED checks on every request compensate.
- Re-running the seed resets seed memberships to their seed roles/status without a `membership.changed` event.
- The seed refuses to run if a seed user's Keycloak `sub`/email was already JIT-provisioned under another id.
````

- [ ] **Step 6: Full module test run, lint, commit**

Run: `uv run pytest apps/api/modules/identity apps/api/platform tests/contract -q && uv run ruff check . && uv run ruff format --check .`
Expected: all pass (live tests skipped), no lint findings.

```bash
git add apps/api/modules/identity
git commit -m "docs(identity): module README; live /me checks through the gateway

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Acceptance test map (spec §12)

| AT | Where |
|---|---|
| M01-AT-01 | `test_resolver.py::test_seed_users_resolve_to_their_institute`, `test_api_me.py::test_me_for_each_institute`, live `test_me_through_gateway_for_each_institute` |
| M01-AT-02 | `test_resolver.py::test_first_request_provisions_user_and_membership`, `test_api_me.py::test_first_call_provisions_new_user` |
| M01-AT-03 / 04 | `test_resolver.py::test_login_event_once_per_session`, `test_api_me.py::test_login_event_once_per_session` |
| M01-AT-05 | `test_api_me.py::test_disabled_membership_blocks_every_request` (`/me`, `/projects`, `/datasets` probes), live `test_disabled_member_logs_in_but_is_blocked` |
| M01-AT-06 | `test_api_members.py::test_disabling_blocks_the_next_request` |
| M01-AT-07 | `test_api_me.py::test_unknown_org_is_rejected_without_provisioning`, `test_resolver.py::test_unknown_org_provisions_nothing` |
| M01-AT-08 | `test_api_me.py::test_invalid_tokens_are_unauthenticated`, live `test_bad_tokens_are_401_through_gateway` |
| M01-AT-09 … 13 | `test_api_members.py` (`test_admin_of_other_org_cannot_patch`, `test_member_without_admin_role_cannot_list`, `test_org_admin_cannot_drop_own_admin_role`, `test_platform_role_is_not_assignable`, `test_granting_a_role_is_visible_on_the_same_token`) |
| M01-AT-14 | `test_api_directory.py::test_user_search_by_email_prefix`, live `test_directory_through_gateway` |
| M01-AT-15 | `test_api_members.py::test_granting_a_role_is_visible_on_the_same_token`, `test_resolver.py::test_role_changes_apply_on_the_next_request` |
| M01-AT-16 | live `test_authorization_code_without_pkce_is_rejected` |

## Contract/shared changes needed (not planned here; Agent 0)

1. Resolved by W1-D3 (M00 kickoff): `getOrganization`/`updateOrganizationMember` 401, `listOrganizationMembers` 401/404, `listUsers` 422 are declared in openapi 1.2.0; tests contract-assert them.
2. `packages/contracts` generator: `format: email` → `EmailStr` rejects the seed `.local` addresses, and `Id` is a `RootModel`; M01 therefore uses field-identical local DTOs (`api.modules.identity.public`). Mapping email to `str` and `Id` to `UUID` would let modules share generated types.
3. Resolved by W1-D2 (M00 kickoff): `pg_trgm` lives in schema public (init.sql); the migration only references `public.gin_trgm_ops`.
4. Prod realm: `docker-compose.prod.yml` reuses the dev import mount, so the prod stack would import `nais-e2e` (direct grants) and the dev users. Needs a prod realm file/mount without them (spec §11: "prod realm import에서 제외").
5. Resolved by W1-D1 (D-038): `IdentityQueryPort` lives in `api.modules.identity.public` and is the registry key for every consumer.
6. Spec text alignment: M01 §11 seed table gives `admin@nais.local` no org roles; `10_SEED_DATA.md` §3 gives `ORG_ADMIN` — this plan follows 10_SEED_DATA. M01 §11 names `infra/keycloak/realm-nais.json`; the compose mount requires `infra/keycloak/import/realm-nais.json`.
