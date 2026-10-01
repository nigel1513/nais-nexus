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
