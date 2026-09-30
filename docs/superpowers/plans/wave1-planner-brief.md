# Wave 1 planner brief (shared by all six module planners)

You write ONE implementation plan for ONE NAIS AI-OS module. Six planners work in parallel, one per module:
M01 identity, M02 project, M03 catalog, M05 readiness, M09 audit, M10 web.

## Read first
1. Load the `superpowers:writing-plans` skill with the Skill tool and follow it exactly (header, Global Constraints,
   Review Focus, File Structure, bite-sized TDD tasks with complete code, no placeholders, self-review).
   Do NOT do its "Execution Handoff" step — the controller handles that. Do not ask the user anything.
2. Your module spec (the binding design): `NAIS_PRD/modules/<your module>.md` — all 13 sections.
3. Cross-cutting: `NAIS_PRD/11_DECISION_LOG.md` (D-001…D-037), `NAIS_PRD/03_API_EVENT_CONTRACTS.md`,
   `NAIS_PRD/04_SECURITY_GOVERNANCE.md`, `NAIS_PRD/07_RUNTIME_ENVIRONMENT.md`, `NAIS_PRD/10_SEED_DATA.md`.
4. Machine contracts: `NAIS_PRD/contracts/openapi.yaml`, `events/p0_events.schema.json`, `events/index.json`,
   `error_codes.json`, `module_ownership.json`.
5. The platform you build on (Wave 0, already done — read the code, don't guess): `README.md` ("Adding a module" +
   "Module author checklist"), `apps/api/platform/*.py` (modules.py ModuleSpec, db.py SessionDep, outbox.py, event_bus.py
   subscribe/claim_event(handler=), auth.py CurrentUser/CurrentUserDep/PrincipalResolver, errors.py ApiError, pagination.py,
   storage.py, scheduler.py, ports.py, migrate.py, migration_helpers.py, testing/*), `apps/api/worker.py`.
   M10 only: the platform API surface is `contracts/openapi.yaml`; the web must not read backend code.

## Hard rules for every plan
- The module lives only in its owned paths from `module_ownership.json`. The ONLY exceptions allowed (Agent 0 grants them
  for Wave 1, list each one explicitly in the plan's File Structure as "shared file change (Agent 0 approved)"):
  - adding runtime/dev dependencies to root `pyproject.toml` + `uv lock` (M03, M05 likely);
  - M10: adding a `web` service to `docker-compose.yml` (built from `apps/web`, internal port 3000, no host port — the
    gateway already routes `/` and `/web-auth` to `web:3000`) and web env keys to `.env.example`;
  - M01: raise `fastapi>=0.121` floor in pyproject (SessionDep needs Depends(scope=)) as its first task.
  Anything else outside owned paths → do not plan it; list it under "Contract/shared changes needed" at the end.
- Module package: `apps/api/modules/<name>/__init__.py` exports `MODULE = ModuleSpec(...)`; migrations via
  `scripts/nais new-migration <name> -m ...` pattern (or write revision files directly with the platform template form);
  every table `schema="<name>"`; consumers use `create_processed_events(schema, per_handler=True)` +
  `claim_event(..., handler=...)`; write endpoints use `SessionDep`; events only through `outbox.write` in the same session.
- Other modules are NOT available yet: depend on them only through Ports (Protocol) with in-module fakes, as the spec's §3
  says (mock-first, 02_PARALLEL_DEVELOPMENT_PLAN §4). Provide your own module's public Port implementation via `wire()`.
- Every API response must satisfy `openapi.yaml`: tests call `api.platform.testing.contracts.assert_matches_response`.
  Every emitted event must pass `assert_valid_event`. Only error codes from `error_codes.json`.
- Tests: pytest, real Postgres via the `migrated_db` fixture (extend it by running your module's migrations in a module
  conftest fixture), `create_test_app(modules=[MODULE])`, `FakeIssuer` for auth where needed.
  M10: vitest + Playwright per its spec, MSW mock mode generated from openapi.
- Dev environment facts: server ports 21051–21058, every dev login `nais`/`nais` (D-037); seed user password `nais`;
  compose stack is running — plans must not include `docker compose down` or volume deletion; restarting `api`/`worker`
  (and `web` for M10) after changes is fine.
- Commit trailer on every commit step: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Size: split into tasks a reviewer can reject independently; typically 8–16 tasks. Include the module's acceptance tests
  (spec §12) as real tests. The last task wires seed data (10_SEED_DATA.md) and verifies against the running stack
  (migrate + seed via `docker compose run --rm --no-deps api python -m api.platform.cli ...`, then curl through
  http://localhost:21051).

## Output
Save the plan to `docs/superpowers/plans/2026-10-01-wave1-<mNN>-<name>.md` (e.g. `2026-10-01-wave1-m01-identity.md`).
Do not commit it (the controller commits all six together). Do not implement anything.
Final reply (under 12 lines): plan path, task count, the "Contract/shared changes needed" list (or "none"), and any
spec ambiguity you resolved (one line each: what you chose and why).
