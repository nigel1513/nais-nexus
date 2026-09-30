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
(new revision: `docker compose run --rm api python -m api.platform.cli new-migration <name> -m "..."`);
`wire()` provides your ports via `api.platform.ports.provide`; `register_worker(broker, scheduler)` adds periodic jobs;
`seed(session)` loads `10_SEED_DATA.md` rows. Publish events with `api.platform.outbox.outbox.write(...)` in the same
session as your change; consume with `@api.platform.event_bus.subscribe(...)` + `claim_event(session, "<schema>", event)`.
Test helpers: `api.platform.testing.app.create_test_app`, fixtures `migrated_db`, `api.platform.testing.tokens.FakeIssuer`,
`api.platform.testing.contracts.assert_matches_response` / `assert_valid_event`.
