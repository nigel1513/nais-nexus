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
