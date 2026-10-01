# NAIS AI-OS / Research Commons

Product and contracts: [`NAIS_PRD/README.md`](NAIS_PRD/README.md). Service port: **21051**.

## Prerequisites
Docker (Compose v2), [uv](https://docs.astral.sh/uv/) 0.11+, Node 22 (only for `scripts/nais contracts`).

## Run it
```bash
scripts/nais up            # creates .env from .env.example on first run
scripts/nais migrate
scripts/nais storage-init
scripts/nais credentials   # prints the login/URL table for every port
open http://localhost:21051/api/v1/docs
scripts/nais gate-a        # boot + readiness + storage smoke
```

### External access
Dev server <NAIS_EXTERNAL_HOST> (LAN 192.168.0.3). The router must forward TCP 21051-21058 to it.
All ports 21051-21058 are externally reachable and every login is `nais` / `nais` (D-037).

## Develop
```bash
uv sync
scripts/nais test          # pytest (postgres via testcontainers)
scripts/nais lint && scripts/nais typecheck
scripts/nais contracts     # regenerate code after NAIS_PRD/contracts changes
```

## Adding a module (Wave 1 agents)
Create `apps/api/modules/<name>/__init__.py` exporting `MODULE = ModuleSpec(...)` (see `api.platform.modules`):
`router` is mounted under `/api/v1`; `migrations_dir` + `db_schema` are migrated by `scripts/nais migrate`
(new revision, written into your source tree on the host: `scripts/nais new-migration <name> -m "..."`);
`wire()` provides your ports via `api.platform.ports.provide`; `register_worker(broker, scheduler)` adds periodic jobs;
**public interface (D-038):** put the Port Protocols + DTOs other modules use in `apps/api/modules/<name>/public.py`
(no imports from your module internals); that class is the `ports` key — consumers do
`from api.modules.<provider>.public import XPort` and `ports.get(XPort)`, never their own copy of the Protocol;
`seed(session)` inserts the `10_SEED_DATA.md` rows (as Python data in your module). Publish events with
`api.platform.outbox.outbox.write(...)` in the same session as your change; consume with
`@api.platform.event_bus.subscribe(...)` + `claim_event(session, "<schema>", event)`.
Test helpers: `api.platform.testing.app.create_test_app`, fixtures `migrated_db`, `api.platform.testing.tokens.FakeIssuer`,
`api.platform.testing.contracts.assert_matches_response` / `assert_valid_event`.

### Module author checklist
- **Sessions:** endpoints take `session: SessionDep` (`from api.platform.db import SessionDep`). It commits before the
  response is sent, so a failed commit is a 500 envelope, never a 2xx. Do not call `session.commit()` yourself and
  do not use `Depends(get_session)` directly.
- **Handlers are registered at import time:** import every handler module from your package `__init__.py`
  (e.g. `from api.modules.<name> import handlers  # noqa: F401`). An event with no registered handler is still marked
  dispatched by the relay. The worker logs the `event subscriptions` table (event_type -> handlers) at start: check it.
- **Idempotency (D-006, at-least-once):** every handler starts with `if not claim_event(session, "<schema>", event): return`.
  If several handlers in one module consume the same event, create the table with
  `create_processed_events("<schema>", per_handler=True)` and call `claim_event(session, "<schema>", event, handler="<name>")`.
- **Migrations:** create them with `scripts/nais new-migration <name> -m "..."`; always pass `schema="<db_schema>"` to
  every `op.*` call (tables, indexes, constraints). Never touch another module's schema.
- **Never modify `platform.outbox_events` inside a handler:** the relay holds row locks on the batch, so the handler
  would deadlock against itself. Publish follow-up events with `outbox.write(session, ...)` (an INSERT) only.
- **Seed data:** `seed()` must not read `NAIS_PRD/*.md` at runtime (the docs are not in the image); keep the rows in code.
- **Extensions:** `pg_trgm` is installed once in schema `public` by the platform (`init.sql`). Migrations never run
  `CREATE EXTENSION`; reference `public.gin_trgm_ops` / `public.similarity(...)`.
