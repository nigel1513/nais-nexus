# NAIS Web Portal (M10)

Next.js 15 (App Router) · TypeScript · Tailwind v4 · shadcn-style `@nais/ui` · TanStack Query · RHF + Zod · next-intl (ko default) · Auth.js v5.

## Run

```bash
corepack pnpm install                       # repo root (pnpm workspace)
cd apps/web
corepack pnpm dev                           # http://localhost:3000, mock mode via .env.development
corepack pnpm test                          # Vitest (unit, component, mock-API contract check)
corepack pnpm e2e                           # Playwright smoke (builds + starts on :3100)
corepack pnpm typecheck && corepack pnpm lint
corepack pnpm contracts:check               # generated error/enum lists match NAIS_PRD/contracts
```

In compose the portal is the `web` service behind the gateway: `http://localhost:21051/` (Auth.js under `/web-auth`).
In **mock mode** (the default) any origin works: `http://localhost:21051/` or `http://<NAIS_EXTERNAL_HOST>:21051/` (value from the local,
untracked `.env`; never commit it). Redirects inside the app are relative, so they follow whatever origin the browser used.
In **real (Keycloak) mode** the portal works from ONE origin only, see "Real mode" below.

## Environment

| Variable | Meaning |
|---|---|
| `NEXT_PUBLIC_API_MOCKING` | `enabled` -> in-app mock API at `/mock-api/v1` + mock login; build-time (compose sets it from `WEB_API_MOCKING`, default `enabled` until Wave 2) |
| `NEXT_PUBLIC_API_BASE` | Real API base as seen by the browser (`/api/v1`); `NEXT_PUBLIC_*` are inlined at build time, changing them needs a rebuild |
| `API_INTERNAL_BASE` | Server-side API base (`http://api:8000/api/v1`), reserved for Wave 2 server components |
| `AUTH_URL`, `AUTH_SECRET`, `AUTH_TRUST_HOST` | Auth.js (`AUTH_URL` ends in `/web-auth`, D-026) |
| `NAIS_EXTERNAL_HOST` | Public host/IP of the dev server; only adds it to the host allow-list used for the absolute logout return URL. It does NOT make real mode work from a second origin. With no allow-list configured the forwarded host is never trusted (fails closed) |
| `AUTH_ALLOWED_HOSTS` | Optional comma-separated extra `host[:port]` entries to allow (e.g. a test hostname) |
| `NAIS_PUBLIC_BASE_URL` | Base URL that presigned storage URLs are signed against (API/storage side). For browsers on the external host the local `.env` must set `NAIS_PUBLIC_BASE_URL=http://<NAIS_EXTERNAL_HOST>:21051`, otherwise uploads/downloads from external browsers point at `localhost` |
| `AUTH_KEYCLOAK_ISSUER` | Public issuer, must equal token `iss`: `http://localhost:21051/auth/realms/nais` |
| `AUTH_KEYCLOAK_INTERNAL_URL` | Token/userinfo/JWKS from inside the container: `http://keycloak:8080/auth/realms/nais` |
| `AUTH_KEYCLOAK_ID` | `nais-web` (public client + PKCE) |
| `PLAYWRIGHT_BASE_URL` | e2e only: run the suite against an already running portal (e.g. the gateway) |
| `PLAYWRIGHT_EXTERNAL_PORT` | e2e only: port for the non-localhost origin project (defaults to the port of `PLAYWRIGHT_BASE_URL`, else 3100) |

## Mock mode

- `/mock-login` lists the seed users (10_SEED_DATA.md); the choice is a cookie `nais_mock_user`. Pick **B Disabled** to see `/blocked`.
- The mock API is the MSW handler set in `src/mocks/handlers`, served by the Next server (`/mock-api/v1/*`, `/mock-storage/*`) and by
  `msw/node` in Vitest. No Service Worker: the dev portal is opened over plain HTTP on `<NAIS_EXTERNAL_HOST>:21051`, where browsers disallow them.
- State is in memory per web process (restart = reseed). Flows: project create/member add, search/facets,
  request SUBMITTED -> UNDER_REVIEW -> APPROVED/REJECTED/CHANGE_REQUESTED, revoke/expiry -> `ACCESS_GRANT_REVOKED|EXPIRED`,
  upload (PUT/multipart) -> publish -> readiness QUEUED -> RUNNING -> COMPLETED after two polls.
- Error injection: append `?mock_error=POLICY_ENGINE_UNAVAILABLE` (any contract code) to a page URL.
- `src/mocks/contract.test.ts` calls all 49 operations and validates every response against `NAIS_PRD/contracts/openapi.yaml`.

## Real mode (Keycloak)

Build with `NEXT_PUBLIC_API_MOCKING=disabled`. Auth.js (`basePath: /web-auth`, Next defines no `/api/*` routes) signs users in through the
Keycloak public client `nais-web` with Authorization Code + PKCE (S256); discovery is not used, endpoints are configured explicitly.
The issuer must equal the token `iss` (public host), while token/userinfo/JWKS go through `AUTH_KEYCLOAK_INTERNAL_URL`.
Tokens live only in the encrypted httpOnly session cookie; the session exposes `accessToken` only and refreshes it 60 s before expiry.
`USER_DISABLED`, `MEMBERSHIP_DISABLED`, `ORGANIZATION_UNKNOWN` lead to `/blocked?code=...`. Logout redirects to the Keycloak `end_session` endpoint.

**Single-origin rule.** Keycloak real mode works from exactly one browser origin: `NAIS_PUBLIC_BASE_URL` (e.g. `http://localhost:21051`, or
`http://<NAIS_EXTERNAL_HOST>:21051` for remote browsers). `AUTH_URL` (`<base>/web-auth`), `AUTH_KEYCLOAK_ISSUER` (`<base>/auth/realms/nais`) and the
API's `OIDC_ISSUER` must all derive from that same base: the issuer has to equal the token `iss`, the OIDC callback and the session cookie are bound to
the `AUTH_URL` origin, and presigned storage URLs are signed against it. Opening the portal from any other origin breaks sign-in. Mock mode has no
such restriction.

## Rule: no secure-context-only browser APIs

The portal is opened over plain HTTP on non-localhost origins (`http://<NAIS_EXTERNAL_HOST>:21051`), which are not secure contexts.
There `crypto.randomUUID`, `crypto.subtle`, Service Workers and `navigator.clipboard` are undefined. Client code must not depend on them
(use `shared/lib/random-id.ts`, hash-wasm for SHA-256, `copyText` from `@nais/ui` for the clipboard: `navigator.clipboard`, else a hidden textarea + `execCommand("copy")`, else the value is shown to select by hand). This once broke every API call (fixed in f0de935), so the e2e
suite runs a second Playwright project, `chromium-insecure-origin`, against `http://nais.test:<port>` (Chromium arg
`--host-resolver-rules=MAP nais.test 127.0.0.1`; a placeholder host, never the real address) and asserts the dashboard renders without a
"service unavailable" error and that `window.isSecureContext` is false.

## Scripts

| Script | Purpose |
|---|---|
| `dev` / `build` / `start` | Next.js dev server (3000), production build, start |
| `lint` / `typecheck` | ESLint, `tsc --noEmit` |
| `test` / `test:watch` | Vitest |
| `e2e` | Playwright smoke + axe, both projects (localhost and non-localhost http origin) |
| `contracts:sync` / `contracts:check` | Regenerate / verify `src/generated` against `NAIS_PRD/contracts` |

## E2E (Playwright)

Default: `corepack pnpm e2e` builds the app in mock mode, starts it on :3100 and runs both projects.

Browser install: `corepack pnpm exec playwright install chromium`. If the download or system libraries are unavailable, run in the
official image instead (use the same version as `corepack pnpm exec playwright --version`; 1.63.0 at the time of writing):

```bash
# portal already running, e.g. behind the gateway on :21051 (or `next start --port 3100` with PLAYWRIGHT_BASE_URL=http://localhost:3100)
docker run --rm --network host -v "$PWD/../..:/repo" -w /repo/apps/web \
  -e PLAYWRIGHT_BASE_URL=http://localhost:21051 mcr.microsoft.com/playwright:v1.63.0-noble \
  npx --yes playwright@1.63.0 test
```

`--network host` makes `nais.test` (mapped to 127.0.0.1 inside Chromium) reach the same portal. When pointing at a portal that enforces
host checks, add the test host to `AUTH_ALLOWED_HOSTS` (e.g. `nais.test:21051`).

## Wave 1.5 Stage 1

- **Data Card** (`/commons/data/[id]`): header with AI-ready score (0-10, expandable checks), About, metadata block with a JSON-LD download, people/steward side card with the affiliation at publish time vs. now, and a column description table.
- **Data Explorer**: file tree plus Detail / Compact / Column views with up to 100 preview rows. Previews follow the access rule: owner organization and active grant holders see data, everyone else sees the notice "접근 승인 후 미리보기 가능". `PENDING` previews are polled; failures fall back to a generic message.
- **Markdown safety**: dataset descriptions render through a restricted markdown subset (no raw HTML, no images, links only to http(s)/mailto with `rel="noopener noreferrer"`); nothing is injected with `dangerouslySetInnerHTML`.
- **Mock profiler**: in mock mode only, `src/mocks` computes previews/column profiles from fixture CSVs; it is never imported by feature code, so the real-mode client bundle contains none of it (`NEXT_PUBLIC_API_MOCKING=disabled next build`, then `grep -rl profileCsv .next/static` finds nothing).
- **Settings**: the NTIS researcher number (8 digits; clearing sends `null`; a duplicate is reported as a field error). PLATFORM_ADMINs also get an institute-transfer card on `/settings/organization` (confirmation required; the user must sign in again).

## Known limitations (Wave 1)

- Real API integration, Keycloak login end-to-end and the 12-step golden E2E are Wave 2 (needs the `nais-web` Keycloak client from M01).
- Notifications poll every 30 s. Downloads are per-file links; uploads resume only within the same tab.
- Content-Security-Policy is `frame-ancestors 'none'` only; the nonce-based script CSP of spec section 16 lands with Wave 2.
- Role-based hiding uses the cached `/me` (up to 60 s); the server always decides.

## Integration notes

- Task 18 (Agent 0 approved): `docker-compose.yml` `web` service, root `pnpm-lock.yaml`; compose passes `NAIS_EXTERNAL_HOST` to `web`. `.env.example` already has `WEB_API_MOCKING`, `AUTH_TRUST_HOST`; Agent 0 adds the CI web job (contracts:check, lint, typecheck, test).
- Keycloak client `nais-web` is provided by the M01 realm (W1-D6): public, PKCE S256, redirect URIs `http://localhost:21051/web-auth/callback/keycloak`
  and `http://<NAIS_EXTERNAL_HOST>:21051/web-auth/callback/keycloak`, web origins for both hosts, post-logout redirects `http://localhost:21051/*`, `http://<NAIS_EXTERNAL_HOST>:21051/*`,
  `org_code` mapper, audience `nais-api` on the access token.
