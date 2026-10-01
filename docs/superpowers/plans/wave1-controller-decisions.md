# Wave 1 controller decisions (bind all Wave 1 plans; supersede plan text where they differ)

Source: docs/superpowers/plans/wave1-integration-notes.md (planner reports).

## W1-D1 = D-038 — where cross-module Port interfaces live
Provider-owned public module: `apps/api/modules/<provider>/public.py` holds the provider's public Port Protocols and DTOs
(transcribed from its spec §8). It imports nothing from the provider's internals (only stdlib, pydantic/dataclasses,
typing, api.platform). The Protocol class object in `public.py` is THE registry key: providers
`ports.provide(IdentityQueryPort, impl)` in `wire()`; consumers `ports.get(IdentityQueryPort)` importing it from
`api.modules.identity.public`. A provider may re-export from `ports.py` for spec compatibility.
Consumers built after their provider (execution order M01→M02→M03→M05→M09→M10) import the real `public.py`.
Only ports whose provider is not in Wave 1 (M04 GrantQueryPort, consumed by M09) are defined consumer-side for now, in
`api/modules/<consumer>/ports.py` with a `# TODO(Wave 2): replace with api.modules.governance.public` marker.
Missing provider at runtime (not wired) → behavior per each consumer spec (seed-backed fake with a warning in Wave 1,
or 503 where the plan chose fail-closed); keep what each plan chose, but the key type must be the public.py class.

## W1-D2 — pg_trgm
Installed once by the platform, not by modules: `CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;` added to
`infra/docker/postgres/init.sql` (runs as superuser) and applied once to the RUNNING stack by the kickoff task
(`docker compose exec -T postgres psql -U nais -d nais -c "CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public"`).
The testcontainers fixture already executes init.sql. Module migrations must NOT create extensions; they use
`public.gin_trgm_ops` / `public.similarity` where needed.

## W1-D3 — contract (openapi) updates done once, up front, by the kickoff
Add to `NAIS_PRD/contracts/openapi.yaml` (version 1.2.0), each `$ref: "#/components/responses/Error"`:
- `401` on every operation that has `security` (i.e. all except health).
- M01: getOrganization 401 (covered above), listOrganizationMembers 404, listUsers 422.
- M02: updateProject 404/422, archiveProject 404, addProjectMember 404, updateProjectMemberRole 404/422, listProjects 422.
- M03: searchDatasets 422/503; updateDataset 404/409; listDatasetVersions 404; createDatasetVersion 404;
  createUploadSession 404/503; completeUploadSession 403/404/503; deleteDraftFile 503; publishDatasetVersion 404;
  make `UploadSession.files[].upload` NOT required (URLs omitted after close).
- M05: startReadinessValidation 404; (503 optional — add to start/get readiness).
- M10 optional fields: add optional `AccessGrant.subject_display_name`, `AccessGrant.project_name`,
  `ProjectSummary.lead_organization_name` (string, not required).
Regenerate with `uv run python packages/contracts/generate.py`; all tests must still pass.

## W1-D4 — shared config
- `pyproject.toml` mypy `files` += `"apps/api/modules"`.
- `.env.example`: add every module env key the plans introduce, with the plans' defaults (SMTP_FROM,
  NOTIFICATION_EMAIL_ENABLED, NOTIFICATION_RETENTION_DAYS, PROJECT_MAX_MEMBERS, READINESS_RUN_TIMEOUT_SECONDS,
  READINESS_FILE_TIMEOUT_SECONDS, READINESS_WORKER_CONCURRENCY, catalog keys from the M03 plan, WEB_API_MOCKING,
  AUTH_TRUST_HOST). Module plans then do not touch `.env.example`.
- Approved shared changes stay with the module plans: M03 adds compose `opensearch: build: infra/opensearch` (nori)
  in its own task; M05 adds `pyarrow` to pyproject/uv.lock; M10 adds compose `web` service and root `pnpm-lock.yaml`;
  M01 raises `fastapi>=0.121`.
- CI web job: added after M10 in the Wave 1 integration step (Agent 0), not in module plans.

## W1-D5 — cross-module coupling
M05's fixture generator and M03's `catalog/seed_files.py` must produce byte-identical files (M03 plan). Rule: M03 is
the source (built first); the M05 plan must generate its fixtures by importing/reusing M03's generator functions or
assert byte-equality against them in a test.

## W1-D6 — Keycloak nais-web client
Owned by M01 (its realm file). M01 must include: public client `nais-web`, PKCE S256 required, redirect URIs
`http://localhost:21051/web-auth/callback/keycloak` and `http://<NAIS_EXTERNAL_HOST>:21051/web-auth/callback/keycloak`,
post-logout redirect `/`, `org_code` mapper, audience `nais-api` mapper — as needed by the M10 plan.
