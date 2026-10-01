# Wave 1 integration notes (controller)

## M09 (plan: 2026-10-01-wave1-m09-audit.md, 13 tasks)
Shared changes requested: .env.example SMTP_FROM / NOTIFICATION_EMAIL_ENABLED / NOTIFICATION_RETENTION_DAYS; mypy files += apps/api/modules; port Protocol location (consumers define Protocols in their own ports.py; providers must satisfy them or Agent 0 moves them to a shared package); IdentityQueryPort.is_active_user needed by M09.
Resolved ambiguities: trace_id stored as hex; staff visibility excludes FILE_DOWNLOADED/DOWNLOAD_DENIED of own-org actors (AT-08 binding); staff project filter narrows instead of 403; missing ports fall back to seed-backed fakes with a warning; email actor declared in register_worker; requester excluded from steward notification; email_deliveries.next_attempt_at added; no seed().

## M02 (plan: 2026-10-01-wave1-m02-project.md, 13 tasks)
Shared changes: port location (imports api.modules.identity.ports.IdentityQueryPort — CONFLICTS with M09's own-Protocol approach → needs one convention); openapi missing statuses (updateProject 404/422, archiveProject 404, addProjectMember 404, updateProjectMemberRole 404/422, listProjects 422, 401 on all ops); pg_trgm extension (M01 too) → platform; .env PROJECT_MAX_MEMBERS.
Resolved: identity absent → seed fake; installed-but-unwired → 503; ADMIN can't change any ADMIN role; 422 details use platform {"fields":[{field,reason}]}; check order 404/403→409→403; null edits 422; seed events only first run.

## Controller decisions pending (Wave 1 kickoff, Agent 0)
- D-038 candidate: cross-module port Protocols + DTOs live in Agent-0-owned `apps/api/platform/interfaces/<provider>.py` (identity, project, catalog, governance, readiness), transcribed from each provider spec §8; providers implement + ports.provide; consumers import only from there; missing provider → consumer's in-module fake (Wave 1) / 503 per spec.
- pg_trgm: platform migration `CREATE EXTENSION IF NOT EXISTS pg_trgm` (trusted ext; migrator has CREATE on db) + init.sql.
- openapi: add missing 401/404/422 responses; bump contract version; regenerate.
- mypy files += apps/api/modules; .env.example module keys.

## M01 (plan: 2026-10-01-wave1-m01-identity.md, 12 tasks; planner prototyped code: 105 identity tests passed in scratch; realm imported in throwaway KC 26.0.8)
Shared changes: openapi missing getOrganization 401, listOrganizationMembers 401/404, listUsers 422, updateOrganizationMember 401; codegen maps format:email→EmailStr (rejects .local seed emails) and Id→RootModel (modules use local models; consider str/UUID mapping); pg_trgm installed into identity schema (migrator can't create in public) → move to platform/init.sql; prod compose mounts dev realm (nais-e2e client + seed users) → prod needs separate realm mount; IdentityQueryPort at api.modules.identity.public (3rd location variant!).
Resolved: admin@nais.local = ORG_ADMIN+PLATFORM_ADMIN per 10_SEED_DATA; realm at infra/keycloak/import/realm-nais.json; local response models; redirect URIs for localhost + <NAIS_EXTERNAL_HOST>; sid fallback sha256; non-org roles in PATCH → 422 ROLE_NOT_ASSIGNABLE; sslRequired none (D-037).

## M05 (plan: 2026-10-01-wave1-m05-readiness.md, 16 tasks, 7108 lines; planner ran all code in scratch: 343 passed, golden outputs match 09 §5.6)
Shared changes: openapi startReadinessValidation 404; 401 on 3 readiness ops; .env READINESS_* keys; CatalogReadPort mirror class in readiness/catalog_port.py → re-export from D-038 interfaces; docs: 09 §4 fingerprint formula, M05 §4.1 requester_organization_id column, evidence limit 128 KiB. Adds pyarrow dep (approved).
Resolved: fingerprint includes metadata_snapshot_sha256 joined with "|" (D-029 > 09); storage 404 → run FAILED(FILE_NOT_FOUND); requester_organization_id column; evidence truncated at 64 KiB canonical JSON, DB check 128 KiB; schema.presence FAIL on missing path/dup headers; per-process concurrency semaphore; unknown profile GET → 404 READINESS_NOT_AVAILABLE; conftest rebinds actor to StubBroker.

## M03 (plan: 2026-10-01-wave1-m03-catalog.md, 18 tasks; planner ran all code in scratch: 375 passed incl. SeaweedFS e2e via 21051, 10k-doc load, nori image test)
Shared changes: openapi UploadSession.files[].upload must be optional (contract says omitted after close); many missing error statuses (401 all; searchDatasets 422/503; updateDataset 404/409; list/createDatasetVersion 404; createUploadSession 404/503; completeUploadSession 403/404/503; deleteDraftFile 503; publishDatasetVersion 404); compose opensearch should build infra/opensearch (nori) — fallback analyzer until then; .env catalog keys; ports at api.modules.catalog.public (+ ports.py re-export); M05 fixtures generate.py must be byte-identical to catalog/seed_files.py (cross-module coupling!); mypy files += modules.
Resolved: OpenSearch testcontainer for search tests; S3 tests use running SeaweedFS via 21053/21054/21051; WITHDRAWN visible to owner org; PLATFORM_ADMIN GET any; index_queue.next_attempt_at; readiness FAILED never overwrites COMPLETED; AT-21 emits policy_changed; getUploadSession 404 for non-stewards; identity fake until M01; seed files generated in code from 09 §5; dramatiq uses current broker; AT-18 via app.openapi(); path CHECK char_length.

## M10 (plan: 2026-10-01-wave1-m10-web.md, 18 tasks; paper-checked only, not executed)
Shared changes: root pnpm-lock.yaml (approve); CI web job (Agent 0, at integration); Keycloak nais-web client (M01 plan covers it); optional openapi: AccessGrant.subject_display_name/project_name, ProjectSummary.lead_organization_name; compose web service + .env WEB_API_MOCKING/AUTH_TRUST_HOST (pre-approved).
Resolved: MSW handlers run server-side at /mock-api/v1 (no service worker over plain HTTP); hand-written stateful handlers for all 49 ops + Ajv contract test; mock switch build-time via WEB_API_MOCKING build arg+env (default enabled); logout via back-channel; nonce CSP + real-API E2E deferred to Wave 2; download panel on version page.

## Carry-forward to M09 execution (from M02 Task 12 review)
Audit visibility for a given project_id: use `project_id in ProjectQueryPort.list_project_ids_for_member(user)` (includes ARCHIVED projects), never `is_active_member` (False for archived) — otherwise members lose the audit trail of archived projects.
