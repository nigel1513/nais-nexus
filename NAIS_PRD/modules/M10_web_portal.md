# M10 Web Portal

> Owner: **Agent 7 — Web** · Release: **P0** · 소유 경로: `apps/web`, `packages/ui`
> Source of truth: `contracts/openapi.yaml`, `contracts/error_codes.json`, `07_RUNTIME_ENVIRONMENT.md`, `11_DECISION_LOG.md`

---

## 1. Goal

NAIS public site에서 AI-OS / Research Commons로 자연스럽게 들어오는 **실제 Application UI**. 연구자, Project Lead, Data Steward, Institution Admin이 P0 전 과정(프로젝트 → 검색 → 접근 요청 → 승인 → 다운로드 → 회수 → 감사)을 브라우저만으로 수행할 수 있어야 한다.

### Constraint (v1.0 유지 + 보강)
- backend ORM/model을 추측하지 않고 **`contracts/openapi.yaml`에서 생성한 타입/클라이언트만** 사용한다.
- 권한 판단은 서버가 한다. UI의 역할 기반 숨김은 **편의 기능일 뿐** 보안 경계가 아니다. 버튼이 보이더라도 서버 403/404를 항상 처리한다.
- 파일 bytes는 API를 거치지 않는다. 브라우저 ↔ 스토리지 presigned URL로 직접 전송한다(21051 동일 origin).

### Out of scope (P0)
- Marketplace / Compute / Ontology 화면 (P1, route만 예약: `/marketplace`, `/compute`)
- Public homepage 콘텐츠(About/Research/News)는 정적 placeholder만 둔다
- 실시간 push(WebSocket/SSE). 알림은 polling
- 모바일 전용 레이아웃(반응형은 지원, 최소 폭 360px)

---

## 2. Stack

| 영역 | 선택 | 비고 |
|---|---|---|
| Framework | **Next.js 15 (App Router)**, React 19, TypeScript strict | `output: "standalone"` |
| Style | Tailwind CSS, **shadcn/ui** (`packages/ui`에 재사용 컴포넌트) | Radix 기반, 접근성 기본 제공 |
| Data | **TanStack Query v5** | 서버 상태 전부 |
| Form | React Hook Form + Zod | Zod는 UX용 1차 검증, 최종 판정은 서버 |
| API client | **openapi-typescript + openapi-fetch** | §4 |
| Auth | **Auth.js v5 (next-auth@5)** Keycloak provider | §3 |
| i18n | **next-intl**, 기본 `ko`, 보조 `en` | §12 |
| Hash | **hash-wasm** (`createSHA256`, streaming) | §9 |
| Mock | **MSW v2** + `@mswjs/source` (`fromOpenApi`) | §13 |
| Test | Vitest + Testing Library, **Playwright** | §14 |
| Lint | ESLint(next, jsx-a11y), Prettier, `tsc --noEmit` | CI |

---

## 3. Auth Flow

### 3.1 경로 규칙 (중요)
Gateway가 `/api/` 전체를 FastAPI로 보내므로(07 §1) **Next.js는 `/api/*` route를 쓸 수 없다.** Auth.js는 `basePath: "/web-auth"`로 설정한다.

```text
/web-auth/signin, /web-auth/callback/keycloak, /web-auth/session, /web-auth/signout  → Next.js (web:3000)
/auth/realms/nais/...                                                                → Keycloak
/api/v1/...                                                                          → FastAPI
```

### 3.2 Login
```text
Browser ─(1) GET /commons (미인증) ─▶ web middleware → redirect /web-auth/signin?callbackUrl=/commons
        ─(2) Keycloak Authorization Code + PKCE ─▶ http://localhost:21051/auth/realms/nais/protocol/openid-connect/auth
        ─(3) 로그인 후 redirect ─▶ /web-auth/callback/keycloak
web(server) ─(4) token 교환 ─▶ http://keycloak:8080/auth/realms/nais/protocol/openid-connect/token  (내부 URL)
            ─(5) 암호화 JWT 세션 cookie 설정 (httpOnly, SameSite=Lax, Secure in prod)
Browser ─(6) /commons 렌더 → GET /api/v1/me (Bearer access_token) → identity가 JIT provisioning + LOGIN 감사
```

### 3.3 Keycloak provider 설정 (discovery 미사용)
web 컨테이너 안에서 `localhost:21051`은 gateway가 아니므로, discovery 대신 endpoint를 명시한다. `issuer`는 토큰의 `iss`(public URL)와 일치해야 한다.

```ts
// apps/web/src/auth.ts
Keycloak({
  issuer: process.env.AUTH_KEYCLOAK_ISSUER,                 // http://localhost:21051/auth/realms/nais
  clientId: process.env.AUTH_KEYCLOAK_ID,                    // nais-web (public client + PKCE)
  authorization: { url: `${process.env.AUTH_KEYCLOAK_ISSUER}/protocol/openid-connect/auth`, params: { scope: "openid profile email" } },
  token:    `${process.env.AUTH_KEYCLOAK_INTERNAL_URL}/protocol/openid-connect/token`,
  userinfo: `${process.env.AUTH_KEYCLOAK_INTERNAL_URL}/protocol/openid-connect/userinfo`,
  jwks_endpoint: `${process.env.AUTH_KEYCLOAK_INTERNAL_URL}/protocol/openid-connect/certs`,
  checks: ["pkce", "state"],
})
```

### 3.4 Token 처리
- Access token(Keycloak 기본 5분)과 refresh token은 **Auth.js 암호화 세션 cookie**에만 저장한다. `localStorage`/`sessionStorage` 저장 금지.
- `jwt` callback에서 만료 60초 전 refresh. refresh 실패 → `session.error = "RefreshFailed"` → 클라이언트가 `signIn()`으로 재로그인 유도.
- `session` callback은 `accessToken`만 노출한다(refresh token 비노출). 클라이언트 fetch middleware가 이를 `Authorization: Bearer`로 붙인다.
- Server Component/Route Handler에서 API 호출 시 `auth()`로 토큰을 얻고 **내부 URL**(`API_INTERNAL_BASE`)로 호출한다.
- Logout: Auth.js signOut → Keycloak `end_session_endpoint`(id_token_hint, post_logout_redirect_uri=`/`) → `/`.
- 인증 후 API가 `USER_DISABLED`/`MEMBERSHIP_DISABLED`/`ORGANIZATION_UNKNOWN`을 반환하면 전용 안내 화면 `/blocked?code=...`로 보낸다(재로그인 루프 방지).

### 3.5 Web 환경 변수
| 변수 | 값(dev) |
|---|---|
| `AUTH_URL` | `http://localhost:21051/web-auth` |
| `AUTH_SECRET` | 32바이트 랜덤 |
| `AUTH_KEYCLOAK_ISSUER` | `http://localhost:21051/auth/realms/nais` |
| `AUTH_KEYCLOAK_INTERNAL_URL` | `http://keycloak:8080/auth/realms/nais` |
| `AUTH_KEYCLOAK_ID` | `nais-web` |
| `NEXT_PUBLIC_API_BASE` | `/api/v1` |
| `API_INTERNAL_BASE` | `http://api:8000/api/v1` |
| `NEXT_PUBLIC_API_MOCKING` | `disabled` \| `enabled` |

---

## 4. API Client

- 생성: `openapi-typescript contracts/openapi.yaml -o packages/contracts/ts/schema.d.ts` — **생성물과 스크립트는 Agent 0 소유(`packages/contracts`)**. Web은 `@nais/contracts`로 import만 한다.
- 호출: `openapi-fetch`의 `createClient<paths>()` 단일 인스턴스(`src/shared/api/client.ts`).
  - middleware: Bearer 부착, `X-Request-Id`(crypto.randomUUID) 부착, 응답 에러를 `ApiError{status, code, message, traceId, details}`로 변환
- 도메인 훅: `features/<domain>/api.ts`에 operationId 이름으로 TanStack Query 훅을 둔다 (`useSearchDatasets`, `useApproveAccessRequest` …). **컴포넌트에서 client 직접 호출 금지.**
- Query key 규약: `[operationId, params]`. mutation 성공 시 invalidate 규칙은 §7 각 화면에 명시.
- 계약 drift 방지: CI에서 `pnpm contracts:check`(재생성 후 git diff 없음) + `tsc`.

---

## 5. Directory Structure

```text
apps/web/src/
  app/
    (public)/page.tsx                  # 랜딩 (NAIS 소개 + "Research Commons 시작하기")
    (platform)/layout.tsx              # 인증 필수, AppShell(header, nav, notification bell)
    (platform)/commons/...             # §6 route
    (platform)/settings/...
    blocked/page.tsx
    web-auth/[...nextauth]/route.ts
  features/
    auth/ organizations/ projects/ catalog/ upload/ governance/ readiness/ audit/ notifications/
      api.ts  components/  schemas.ts  messages.ts(key 목록)
  shared/
    api/ (client, errors, pagination)  ui/ (AppShell, DataTable, StatusBadge, EmptyState, ErrorState, ConfirmDialog)
    hooks/ (useMe, useCursorList, useCountdown)  lib/ (format, time)
  mocks/ (handlers.ts, scenarios/, browser.ts, node.ts)
  messages/ ko.json, en.json
  middleware.ts
```

---

## 6. Route Map

| Route | 화면 | 접근 |
|---|---|---|
| `/` | Public 랜딩 | 누구나 |
| `/commons` | 대시보드 | 인증 |
| `/commons/projects` | 프로젝트 목록 (탭: 내 프로젝트 / 공개 프로젝트) | 인증 |
| `/commons/projects/new` | 프로젝트 생성 | 인증 |
| `/commons/projects/{id}` | 프로젝트 상세 (탭: 개요 / 멤버 / 데이터 / 활동) | 멤버 (비멤버는 서버 404/403 처리) |
| `/commons/data` | 데이터 검색 | 인증 |
| `/commons/data/new` | Dataset 등록 | DATA_STEWARD |
| `/commons/data/{id}` | Dataset 상세 | 메타데이터 조회 권한자 |
| `/commons/data/{id}/versions/{vid}` | Version 상세 (파일, 업로드, publish, readiness, 다운로드) | 동일 |
| `/commons/access` | 접근 관리 (탭: 내 요청 / 검토 대기 / 내 권한 / 기관 권한) | 인증 (탭별 역할) |
| `/commons/access/{id}` | 요청 상세 · 검토 | requester, owner-org steward/admin |
| `/commons/activity` | 활동 · 감사 로그 | 인증 (서버가 범위 제한) |
| `/settings` | 내 정보 · 알림 · 언어 | 인증 |
| `/settings/organization` | 기관 멤버 · 역할 관리 | ORG_ADMIN |
| `/blocked` | 계정/기관 비활성 안내 | — |

Route 권한 가드는 `(platform)/layout.tsx`에서 `getMe` 결과로 수행하고, 역할 부족 시 403 안내(`ErrorState`)를 렌더한다(redirect 아님).

---

## 7. Screen Specs

공통 상태 규약
- **Loading**: 레이아웃을 유지하는 skeleton. 300ms 미만이면 표시하지 않음(깜빡임 방지).
- **Empty**: `EmptyState`(설명 + 다음 행동 버튼 1개).
- **Error**: `ErrorState`(§8 한국어 메시지 + `trace_id` 복사 버튼 + 재시도). 404는 "찾을 수 없거나 접근 권한이 없습니다" 한 문장으로 통일(존재 여부 노출 금지).
- 목록은 cursor 기반 "더 보기"(무한 스크롤 금지 — 키보드 접근성).
- 모든 시각은 `Asia/Seoul`로 표시하고, title 속성에 UTC ISO 원문을 둔다. 만료 시각은 상대 시간도 함께 표시("3일 후 만료").

### 7.1 `/commons` 대시보드
| 항목 | 내용 |
|---|---|
| 목적 | 오늘 할 일(검토 대기, 만료 임박, 최근 프로젝트)을 한눈에 |
| Data | `getMe`, `listProjects(scope=mine, limit=5)`, `listAccessRequests(role=requester, status=[SUBMITTED,UNDER_REVIEW,CHANGE_REQUESTED])`, `listAccessGrants(role=subject, status=[ACTIVE])`, (steward) `listAccessRequests(role=reviewer, status=[SUBMITTED,UNDER_REVIEW])` |
| Components | 카드 4개: 내 프로젝트, 진행 중 요청, 내 권한(만료 7일 이내 강조), **검토 대기(steward만)** |
| 역할 | 검토 대기 카드는 `org_roles ∋ DATA_STEWARD`일 때만 렌더 |
| Empty | 프로젝트 없음 → "첫 공동 프로젝트 만들기" |

### 7.2 `/commons/projects`, `/commons/projects/new`
| 항목 | 내용 |
|---|---|
| Data | `listProjects(scope, q, status)`; 생성 `createProject` |
| Components | DataTable(이름, 주관기관, 내 역할, 멤버 수, 상태, 수정일), 검색 input(q, 300ms debounce, URL sync) |
| Form | name(2~200), description(≤10000), visibility(PRIVATE 기본, 설명 문구 D-023), keywords(≤20), start/end date(end ≥ start) |
| 성공 | 201 → `/commons/projects/{id}`로 이동, `listProjects` invalidate |

### 7.3 `/commons/projects/{id}`
| 탭 | Data | 동작 · 역할 |
|---|---|---|
| 개요 | `getProject` | OWNER/ADMIN: 편집(`updateProject`). OWNER: 보관(`archiveProject`, ConfirmDialog에 "보관 시 이 프로젝트로 받은 모든 데이터 접근 권한이 즉시 회수됩니다" 경고) |
| 멤버 | `listProjectMembers`, `listUsers(q, organization_id)` | OWNER/ADMIN: **멤버 추가**(사용자 검색 combobox → 역할 선택 → `addProjectMember`), 역할 변경(`updateProjectMemberRole`), 제거(`removeProjectMember`). 본인: "프로젝트 나가기". 마지막 OWNER 제거/강등 시 `PROJECT_LAST_OWNER` 메시지 |
| 데이터 | `listAccessGrants(role=subject, project_id)`, `listAccessRequests(role=requester, project_id)` | 이 프로젝트로 내가 받은 grant와 진행 중 요청. 각 행 → dataset 상세 / 다운로드 |
| 활동 | `listAuditEvents(project_id)` | 시간순 타임라인 |

- ARCHIVED 프로젝트는 상단 배너 + 모든 변경 버튼 비활성.
- 서버 403(PUBLIC 프로젝트 비멤버) → "멤버만 상세를 볼 수 있습니다" + 프로젝트 요약만 표시.

### 7.4 `/commons/data` 검색
| 항목 | 내용 |
|---|---|
| Data | `searchDatasets(q, access_level[], owner_organization_id[], purpose[], keyword[], readiness_status[], sort, cursor)` |
| Components | 검색창, 왼쪽 facet 패널(체크박스 + count, `facets` 응답 사용), 결과 카드(제목, snippet, 소유기관, `AccessLevelBadge`, `ReadinessBadge`, 허용 목적, 최신 버전, 수정일), 정렬 select |
| URL | 모든 필터를 query string에 반영(공유·뒤로가기 가능) |
| 역할 | DATA_STEWARD에게 "Dataset 등록" 버튼 |
| Empty | "조건에 맞는 데이터가 없습니다" + 필터 초기화 버튼 |
| 성능 | 응답 1.5s 초과 시에도 이전 결과 유지(`placeholderData: keepPreviousData`) |

Badge 규약: PUBLIC=초록, INTERNAL=회색, CONTROLLED=주황, SENSITIVE=빨강. **색 + 텍스트 라벨 + 아이콘**을 함께 쓴다(색만으로 구분 금지).

### 7.5 `/commons/data/new` Dataset 등록 (DATA_STEWARD)
- `createDataset`. owner_organization_id는 `getMe.organization`으로 고정(선택 불가).
- access_level 선택 시 설명 표시. SENSITIVE 선택 시 `max_grant_days` 최대 30으로 입력 제한 + 안내(`INVALID_POLICY` 사전 차단).
- 성공 → 상세로 이동 후 "첫 버전 만들기" 안내.

### 7.6 `/commons/data/{id}` Dataset 상세
| 항목 | 내용 |
|---|---|
| Data | `getDataset`, `listDatasetVersions`, `getDatasetPolicy`, `listAccessGrants(role=subject, dataset_id, status=[ACTIVE])`, `listAccessRequests(role=requester, dataset_id)`, 최신 버전 `getReadiness` |
| Components | 메타데이터 패널(설명, 키워드, 도메인, 라이선스, 이용 정책, provenance, 연락처), 정책 카드(허용 목적, 최대 기간, 승인 필요), 버전 목록, readiness 요약 |
| **접근 CTA** | 아래 표 |
| 역할 | owner-org DATA_STEWARD: 편집(`updateDataset`), 새 버전(`createDatasetVersion`), 정책 변경(ConfirmDialog: "기존 권한에는 소급 적용되지 않습니다") |

접근 CTA 결정(UI 편의 — 서버가 최종 판정):
| 조건 | CTA |
|---|---|
| PUBLIC | [다운로드] |
| 내 기관 소유 ∧ (DATA_STEWARD ∨ ORG_ADMIN), 또는 INTERNAL ∧ 내 기관 | [다운로드] |
| CONTROLLED/SENSITIVE ∧ ACTIVE grant 있음 | [다운로드] (grant가 여러 project면 project 선택) + "N일 후 만료" |
| 열린 요청 있음 | [요청 상태 보기] → `/commons/access/{id}` |
| 그 외 | [접근 요청] → §7.9 다이얼로그 |

### 7.7 `/commons/data/{id}/versions/{vid}` Version 상세
| 영역 | Data | 동작 |
|---|---|---|
| 헤더 | `getDatasetVersion` | 상태 badge(DRAFT/PUBLISHED/WITHDRAWN), 파일 수, 총 용량, manifest_sha256 |
| 파일 목록 | `files[]` | 경로, 크기, sha256(축약 + 복사), 상태 |
| 업로드 (DRAFT ∧ steward) | `createUploadSession`, `completeUploadSession` | §9 |
| Publish (DRAFT ∧ steward) | `publishDatasetVersion` | ConfirmDialog "게시 후에는 수정할 수 없습니다". 성공 → readiness 영역이 QUEUED로 바뀌고 5초 polling |
| Readiness | `getReadiness`, `listReadinessProfiles`, `startReadinessValidation` | 프로파일별 결과 카드: overall badge, summary(pass/warn/fail/na), check 테이블(check_id, severity, status, message, evidence 펼치기). QUEUED/RUNNING이면 5초 polling, 완료 시 중단. steward는 [검증 실행](프로파일 선택) |
| 다운로드 | `createDownloadSession` | §10 |

### 7.8 `/commons/access`
| 탭 | Data | 표시 역할 | 행 동작 |
|---|---|---|---|
| 내 요청 | `listAccessRequests(role=requester, status[])` | 모두 | 상세 이동, 상태 필터 |
| 검토 대기 | `listAccessRequests(role=reviewer, status=[SUBMITTED,UNDER_REVIEW])` | DATA_STEWARD | 상세 이동(검토) |
| 내 권한 | `listAccessGrants(role=subject, status[])` | 모두 | 만료일, 상태, [다운로드] |
| 기관 권한 | `listAccessGrants(role=owner, status=[ACTIVE])` | DATA_STEWARD, ORG_ADMIN | [회수] → reason 입력 dialog → `revokeAccessGrant` |

탭은 `?tab=` query로 유지한다. 값: `requests`(내 요청, 기본) · `review`(검토 대기) · `grants`(내 권한) · `org-grants`(기관 권한). M09 알림 링크가 이 값을 사용한다. 검토 대기 건수는 탭 라벨에 숫자로 표시.

### 7.9 접근 요청 다이얼로그 (`createAccessRequest`)
| 필드 | 규칙 |
|---|---|
| 프로젝트 | `listProjects(scope=mine, status=ACTIVE)` 중 `my_role ≠ VIEWER`. 없으면 "먼저 프로젝트를 만들거나 참여하세요" + 링크 |
| 목적 | `allowed_purposes`만 선택지로 노출 |
| 목적 상세 | 20~4000자, 글자 수 카운터 |
| 권한 | P0: `READ` 고정 표시(체크 해제 불가), COMPUTE/WRITE는 "추후 지원" 비활성 |
| 기간(일) | 1 ~ `max_grant_days` (SENSITIVE ≤ 30) |

성공 → 토스트 "요청을 보냈습니다" + `/commons/access/{id}`로 이동. invalidate: `listAccessRequests`, dataset 상세.

### 7.10 `/commons/access/{id}` 요청 상세 · 검토
| 영역 | 내용 |
|---|---|
| Data | `getAccessRequest`. steward가 SUBMITTED 요청을 열면 화면이 `startAccessReview`를 1회 호출해 UNDER_REVIEW로 표시한다 (D-025, 실패해도 화면은 유지) |
| 요약 | dataset, project, 요청자(기관), 목적/상세, 권한, 요청 기간, 상태 badge |
| 타임라인 | `history[]` (상태, 시각, 사용자, 코멘트) |
| Reviewer 액션 (SUBMITTED/UNDER_REVIEW) | **승인** dialog: `grant_days`(기본 = min(requested_days, max_grant_days), 상한 표시), operations(요청된 것 중 선택), note → `approveAccessRequest`. **거절**: reason 필수 → `rejectAccessRequest`. **수정 요청**: comment 필수 → `requestAccessChanges` |
| Requester 액션 | CHANGE_REQUESTED: 수정 폼 → `resubmitAccessRequest`. SUBMITTED/UNDER_REVIEW/CHANGE_REQUESTED: [철회] → `withdrawAccessRequest` |
| APPROVED | 생성된 grant 요약(만료일) + [다운로드] 바로가기 |
| 동시성 | 액션 결과 `ACCESS_REQUEST_INVALID_STATE` → "다른 사용자가 먼저 처리했습니다" + 자동 refetch |

### 7.11 `/commons/activity`
| 항목 | 내용 |
|---|---|
| Data | `listAuditEvents(action[], project_id, resource_type, from, to, cursor)` |
| Components | 필터 바(행위 multi-select, 기간, 프로젝트), 테이블(시각, 행위자·기관, 행위(한국어 라벨), 대상, 결과 SUCCESS/DENIED, 사유). 행 펼치면 `trace_id`, `policy_version`, `details` |
| 역할 | 서버가 범위를 제한(PLATFORM_ADMIN 전체, ORG_ADMIN/STEWARD 기관, 그 외 본인). UI는 범위 안내 문구만 표시 |
| Export | P0 없음 (P1 CSV) |

### 7.12 `/settings`, `/settings/organization`
- `/settings`: `getMe`(이름, 이메일, 기관, 역할 — 읽기 전용, 변경은 기관 관리자에게 문의), 알림 목록(`listNotifications`, `markNotificationRead`, `markAllNotificationsRead`), 언어(ko/en, cookie 저장).
- `/settings/organization` (ORG_ADMIN): `getOrganization`, `listOrganizationMembers`. 역할 체크박스(ORG_ADMIN/DATA_STEWARD/RESOURCE_MANAGER), 상태 토글(ACTIVE/DISABLED) → ConfirmDialog → `updateOrganizationMember`. DISABLED 전환 경고: "이 사용자의 모든 데이터 접근 권한이 회수됩니다". 본인 ORG_ADMIN 해제 시 이중 확인.

### 7.13 AppShell 공통
- Header: 로고(→`/commons`), 전역 검색(→`/commons/data?q=`), **알림 bell**(`listNotifications(unread_only=true)` 30초 polling, 창이 hidden이면 중단, `unread_count` badge, 항목 클릭 → `link` 이동 + 읽음 처리), 기관 badge, 사용자 메뉴(설정, 로그아웃).
- Nav: 대시보드, 프로젝트, 데이터, 접근 관리, 활동, (ORG_ADMIN) 기관 관리. 예약 메뉴(Marketplace, Compute)는 P0에서 숨김.
- Skip link "본문으로 건너뛰기".

---

## 8. Error Code → 사용자 메시지 (ko)

`messages/ko.json`의 `errors.<CODE>` 키. 표에 없는 코드는 `errors.fallback`("요청을 처리하지 못했습니다. 문제가 계속되면 추적 ID와 함께 문의하세요.")을 쓰고 `trace_id`를 표시한다.

| Code | 메시지 | UI 동작 |
|---|---|---|
| `UNAUTHENTICATED` | 로그인이 필요합니다. | `signIn()` |
| `FORBIDDEN` | 이 작업을 수행할 권한이 없습니다. | |
| `NOT_FOUND` | 찾을 수 없거나 접근 권한이 없습니다. | |
| `VALIDATION_FAILED` | 입력값을 확인해 주세요. | `details.fields` → 폼 필드 에러 |
| `RATE_LIMITED` | 요청이 너무 많습니다. 잠시 후 다시 시도하세요. | |
| `DEPENDENCY_UNAVAILABLE` | 일시적으로 서비스를 이용할 수 없습니다. 잠시 후 다시 시도하세요. | 재시도 버튼 |
| `USER_DISABLED` | 비활성화된 계정입니다. 기관 관리자에게 문의하세요. | `/blocked` |
| `MEMBERSHIP_DISABLED` | 기관 멤버십이 비활성화되었습니다. 기관 관리자에게 문의하세요. | `/blocked` |
| `ORGANIZATION_UNKNOWN` | 등록되지 않은 기관 계정입니다. | `/blocked` |
| `PROJECT_ARCHIVED` | 보관된 프로젝트에서는 이 작업을 할 수 없습니다. | |
| `PROJECT_MEMBER_EXISTS` | 이미 프로젝트 멤버입니다. | |
| `PROJECT_LAST_OWNER` | 프로젝트에는 소유자가 최소 1명 있어야 합니다. | |
| `DATASET_VERSION_IMMUTABLE` | 게시된 버전은 수정할 수 없습니다. 새 버전을 만드세요. | |
| `DATASET_VERSION_NOT_PUBLISHED` | 아직 게시되지 않은 버전입니다. | |
| `DATASET_VERSION_INCOMPLETE` | 업로드가 끝나지 않았거나 검증에 실패한 파일이 있습니다. | 파일 목록 강조 |
| `DATASET_VERSION_LABEL_EXISTS` | 이미 사용 중인 버전 이름입니다. | |
| `UPLOAD_SESSION_EXPIRED` | 업로드 세션이 만료되었습니다. 남은 파일을 다시 업로드합니다. | 자동 재시작 제안 |
| `UPLOAD_CHECKSUM_MISMATCH` | 업로드된 파일이 원본과 다릅니다. 다시 업로드하세요. | |
| `FILE_TYPE_NOT_ALLOWED` | 허용되지 않는 파일 형식입니다. | |
| `FILE_TOO_LARGE` | 파일이 최대 크기(50 GiB)를 초과합니다. | |
| `INVALID_POLICY` | 데이터 정책 설정이 올바르지 않습니다. (민감 데이터는 최대 30일) | |
| `ACCESS_REQUEST_INVALID_STATE` | 요청 상태가 바뀌었습니다. 새로고침 후 다시 확인하세요. | refetch |
| `ACCESS_REQUEST_DUPLICATE` | 이미 진행 중인 요청이나 유효한 권한이 있습니다. | 기존 요청 링크 |
| `ACCESS_PURPOSE_NOT_ALLOWED` | 이 데이터에 허용되지 않은 이용 목적입니다. | |
| `ACCESS_OPERATION_NOT_ALLOWED` | 요청할 수 없는 권한 종류입니다. | |
| `ACCESS_DURATION_EXCEEDED` | 허용된 최대 이용 기간을 초과했습니다. | |
| `ACCESS_NOT_PROJECT_MEMBER` | 해당 프로젝트의 활성 멤버가 아닙니다. | |
| `ACCESS_NOT_REVIEWER` | 이 요청을 검토할 권한이 없습니다. | |
| `ACCESS_NOT_REQUIRED` | 이 데이터는 별도 승인 없이 이용할 수 있습니다. | 다운로드 CTA로 전환 |
| `ACCESS_GRANT_REQUIRED` | 이 프로젝트로 승인된 접근 권한이 없습니다. | [접근 요청] 버튼 |
| `ACCESS_GRANT_EXPIRED` | 접근 권한이 만료되었습니다. 다시 요청하세요. | [다시 요청] |
| `ACCESS_GRANT_REVOKED` | 접근 권한이 회수되었습니다. | |
| `ACCESS_GRANT_NOT_ACTIVE` | 이미 만료되었거나 회수된 권한입니다. | refetch |
| `ACCESS_DENIED_BY_POLICY` | 보안 정책에 의해 접근이 거부되었습니다. | trace_id 표시 |
| `POLICY_ENGINE_UNAVAILABLE` | 권한 확인 시스템에 일시적인 문제가 있어 접근이 차단되었습니다. 잠시 후 다시 시도하세요. | 재시도 |
| `READINESS_PROFILE_UNKNOWN` | 알 수 없는 검증 프로파일입니다. | |
| `READINESS_VALIDATION_IN_PROGRESS` | 이미 검증이 진행 중입니다. | polling 시작 |
| `READINESS_NOT_AVAILABLE` | 아직 검증 결과가 없습니다. | EmptyState |
| `NOTIFICATION_NOT_FOUND` | 알림을 찾을 수 없습니다. | 목록 refetch |

---

## 9. Upload (브라우저 → 스토리지 직접)

1. **파일 선택**: drag & drop 또는 파일/폴더 선택(`webkitdirectory`). 경로는 폴더 기준 상대 경로.
2. **사전 검증 (클라이언트)**
   - path가 `^[A-Za-z0-9._/-]{1,512}$`에 맞지 않으면(한글·공백 등) 행 단위 에러 + [자동 변환](공백 → `_`, 비ASCII 제거 후 충돌 시 `-1` suffix) 제안. 사용자가 확인해야 진행.
   - `..`, 선행 `/` 금지. 크기 0 금지, 50 GiB 초과 금지. 중복 path 금지. 최대 500개.
   - media_type: `File.type`, 비어 있으면 확장자 매핑(`.csv → text/csv`, `.parquet → application/vnd.apache.parquet`, 기타 `application/octet-stream`).
3. **SHA-256 계산**: **hash-wasm `createSHA256()`로 `file.stream()`을 8 MiB 단위 streaming** 처리한다(메모리 일정, 대용량 대응). Web Worker에서 실행해 UI 스레드를 막지 않는다. 진행률 표시. (Web Crypto `subtle.digest`는 스트리밍이 안 되므로 사용하지 않는다.)
4. **세션 생성**: `createUploadSession({files:[{path,size_bytes,sha256,media_type}]})`.
5. **전송**
   - `upload.method = PUT`: `XMLHttpRequest`로 `url`에 PUT(진행률 이벤트), `headers` 그대로 설정.
   - `upload.method = MULTIPART`: `file.slice()`로 `part_size_bytes` 단위 분할, part URL에 PUT. **동시 4개**, part별 재시도 3회(1s/2s/4s backoff). 응답 `ETag` 헤더 수집(21051 동일 origin이라 CORS 설정 불필요).
   - 전체 동시 파일 수 3개. 전송 중 `beforeunload` 경고.
6. **완료**: `completeUploadSession({parts:[{file_id, etags:[{part_number, etag}]}]})`. 응답의 파일별 `status`(VERIFIED/FAILED, `failure_code`)를 표에 반영. FAILED는 [다시 업로드].
7. **만료**: 세션 TTL 1h. `UPLOAD_SESSION_EXPIRED` 시 VERIFIED 아닌 파일만으로 새 세션을 만든다(해시 재계산 불필요, 메모리에 보관).
8. **Publish**: 모든 파일 VERIFIED이고 1개 이상일 때만 [게시] 활성.

## 10. Download

1. [다운로드] → (grant basis면) project 선택 → `createDownloadSession({project_id?, file_ids?})`.
2. 응답 `files[]`를 목록으로 표시하고 파일별 `<a href={url} download>` 제공. 1개 파일이면 바로 시작.
3. `expires_at`까지 카운트다운(최대 5분). 만료되면 링크 비활성 + [링크 다시 받기](새 session 요청 — 권한 재판정).
4. URL은 화면 밖으로 보관하지 않는다(로그, 분석 도구, localStorage 전송 금지).
5. 에러는 §8 매핑(`ACCESS_GRANT_EXPIRED`, `ACCESS_GRANT_REVOKED`, `POLICY_ENGINE_UNAVAILABLE` 등).
6. 다운로드 후 sha256 검증 안내 문구와 sha256 값 복사 버튼 제공(자동 검증은 P1).

---

## 11. Required Flows → UI 단계 ↔ operationId

| # | Flow | 단계 (화면 → operationId) |
|---:|---|---|
| 1 | **login** | `/commons` → `/web-auth/signin` → Keycloak 로그인 → callback → `getMe` (JIT provisioning, LOGIN 감사) → 대시보드 렌더 |
| 2 | **create project** | `/commons/projects/new` → 폼 제출 `createProject` → `/commons/projects/{id}` (`getProject`) |
| 3 | **invite member** | 프로젝트 > 멤버 탭 → [멤버 추가] → 사용자 검색 `listUsers(q)` → 역할 선택 → `addProjectMember` → `listProjectMembers` refetch (상대방에게 PROJECT_INVITATION 알림) |
| 4 | **search data** | `/commons/data` → 검색어/facet → `searchDatasets` → 결과 클릭 → `getDataset` + `getDatasetPolicy` + `listDatasetVersions` |
| 5 | **request access** | Dataset 상세 [접근 요청] → `listProjects(scope=mine)` → 다이얼로그 제출 `createAccessRequest` → `/commons/access/{id}` (`getAccessRequest`) |
| 6 | **steward review** | 알림 ACCESS_SUBMITTED 또는 `/commons/access?tab=review` (`listAccessRequests(role=reviewer)`) → 상세 `getAccessRequest` + `startAccessReview`(→UNDER_REVIEW) → 승인 `approveAccessRequest` / 거절 `rejectAccessRequest` / 수정요청 `requestAccessChanges`. 회수: `?tab=org-grants` → `revokeAccessGrant` |
| 7 | **readiness result** | Version 상세 → `getReadiness` (QUEUED/RUNNING이면 polling) → check 테이블. steward: `listReadinessProfiles` → `startReadinessValidation` |
| 8 | **audit/activity** | `/commons/activity` → `listAuditEvents(filters)`; 프로젝트 활동 탭 → `listAuditEvents(project_id)` |
| + | download | Dataset/Version/내 권한 → `createDownloadSession` → presigned GET |
| + | upload/publish | Version 상세 → `createUploadSession` → PUT → `completeUploadSession` → `publishDatasetVersion` |

---

## 12. i18n

- next-intl, locale `ko`(기본), `en`. 결정: cookie `NEXT_LOCALE` → `Accept-Language` → `ko`. URL prefix 없음.
- **키는 영어 dot notation**: `projects.create.title`, `access.request.submit`, `errors.ACCESS_GRANT_EXPIRED`, `enums.AccessLevel.CONTROLLED`, `audit.action.FILE_DOWNLOADED`.
- 모든 enum(AccessLevel, Purpose, ProjectRole, OrgRole, AccessRequestStatus, AccessGrantStatus, ReadinessOverall, ReadinessCheckStatus, AuditAction, NotificationType)의 라벨을 `enums.*`에 정의. CI 스크립트가 openapi enum 값과 `ko.json` 키의 누락을 검사한다.
- `ko.json` 누락 키는 빌드 실패, `en.json` 누락은 경고(ko로 fallback).
- 날짜/숫자: `Intl.DateTimeFormat('ko-KR', {timeZone:'Asia/Seoul'})`, 용량은 이진 단위(KiB, MiB, GiB).

---

## 13. Mock Mode (Wave 1 독립 개발)

- `NEXT_PUBLIC_API_MOCKING=enabled`이면 MSW 활성: 브라우저 `setupWorker`, 서버(`instrumentation.ts`) `setupServer`.
- **기본 handler**: `@mswjs/source`의 `fromOpenApi(contracts/openapi.yaml)`로 전 operation 자동 생성(스키마 예시 기반).
- **시나리오 handler**(`mocks/scenarios/`): 메모리 상태 머신으로 golden flow 재현 — project 생성·멤버 추가, dataset 검색, request SUBMITTED → UNDER_REVIEW → APPROVED, grant 만료/회수 후 download-session이 `ACCESS_GRANT_EXPIRED`/`ACCESS_GRANT_REVOKED` 반환, readiness QUEUED → COMPLETED(2회 polling 후).
- 오류 주입: `?mock_error=POLICY_ENGINE_UNAVAILABLE` query로 특정 코드 강제(개발 전용).
- Mock 모드에서는 Auth.js 대신 **mock session**(seed 사용자 선택 드롭다운)을 쓴다. 운영 빌드에서는 mock 코드가 번들되지 않도록 dynamic import + 환경 변수 가드.

---

## 14. Test

### 14.1 Unit / Component (Vitest)
- 접근 CTA 결정 함수(§7.6 표), 에러 매핑, 업로드 path 검증/자동 변환, multipart 분할 계산, 카운트다운, enum 라벨 누락 검사.

### 14.2 Playwright — Golden E2E (05 §2와 1:1)
실제 스택(`make up && make seed`, `http://localhost:21051`)에서 실행. 사용자별 `storageState`를 분리한다.

```text
1  a.researcher 로그인 (Keycloak 폼)                         → 대시보드 표시
2  프로젝트 생성 "E2E Joint Study {timestamp}"               → 상세 이동
3  멤버 탭에서 b.researcher 검색·추가 (RESEARCHER)            → 멤버 2명
4  b.steward 로그인 → Dataset 등록 (CONTROLLED, ACADEMIC_RESEARCH, 180일)
   → v1 생성 → fixture clean_tabular 업로드(sha256 브라우저 계산) → complete → 게시
5  a.researcher: 데이터 검색에서 해당 dataset 발견 (메타데이터만, CTA=[접근 요청])
6  접근 요청 (프로젝트=2의 프로젝트, 목적 ACADEMIC_RESEARCH, 30일)   → 상태 SUBMITTED
7  b.steward: 알림 bell에 ACCESS_SUBMITTED → 상세(UNDER_REVIEW) → 승인 7일
8  a.researcher: 알림 ACCESS_APPROVED → [다운로드] → 파일 저장 → sha256이 업로드 원본과 일치
9  a.researcher: /commons/activity 에 FILE_DOWNLOADED(SUCCESS) 존재
10 b.steward: 접근 관리 > 기관 권한 > [회수] (사유 입력)
11 a.researcher: [다운로드] → "접근 권한이 회수되었습니다." 표시, URL 미발급
12 /commons/activity 에 ACCESS_REVOKED, DOWNLOAD_DENIED 존재
```

### 14.3 추가 E2E
- b.disabled 로그인 → `/blocked` (MEMBERSHIP_DISABLED)
- PRIVATE 프로젝트 URL을 비멤버가 직접 열기 → "찾을 수 없거나 접근 권한이 없습니다"
- 권한 없는 사용자에게 검토/회수 버튼 미노출 + 직접 API 호출 시 403 메시지 처리
- 키보드만으로 flow 5·6 완주 (Tab/Enter/Esc)
- `@axe-core/playwright`로 주요 화면 13개 serious/critical 위반 0

---

## 15. Accessibility (WCAG 2.2 AA) Checklist

- [ ] 모든 페이지 `<main>`, `<nav>`, `<header>` landmark, 페이지당 `<h1>` 1개, heading 순서 유지
- [ ] Skip link 제공, 첫 Tab에서 노출
- [ ] 모든 인터랙티브 요소 키보드 조작 가능, 포커스 순서 = 시각 순서
- [ ] **포커스 표시**: 2px 이상, 대비 3:1 이상, sticky header에 가려지지 않음 (2.4.11 Focus Not Obscured)
- [ ] Dialog: focus trap, Esc 닫기, 닫은 뒤 트리거로 포커스 복귀 (Radix 기본 동작 유지)
- [ ] 텍스트 대비 4.5:1, 큰 텍스트/아이콘 3:1. 다크 모드 동일 기준
- [ ] 상태(access level, readiness, request status)를 **색 + 텍스트 + 아이콘**으로 표현
- [ ] 폼: 모든 입력에 `<label>`, 에러는 `aria-describedby` 연결 + 에러 요약에 포커스 이동, 필수 표시는 텍스트로
- [ ] 터치/클릭 대상 최소 24×24 CSS px (2.5.8 Target Size)
- [ ] Drag & drop 업로드에는 동등한 버튼 대안 (2.5.7 Dragging Movements)
- [ ] 비동기 결과(토스트, 업로드 진행률, polling 완료)를 `aria-live="polite"`로 알림, 에러는 `assertive`
- [ ] 카운트다운(다운로드 URL 만료)에 연장 수단 제공([링크 다시 받기]) (2.2.1 Timing Adjustable)
- [ ] 세션 만료로 인한 재로그인 시 작성 중 폼 데이터 유지 (2.2.5 / 3.3.7 Redundant Entry 취지)
- [ ] 인증 과정에서 인지 테스트 없음, 비밀번호 붙여넣기 허용 (3.3.8 Accessible Authentication — Keycloak 테마 확인)
- [ ] 200% 확대 · 320px 폭에서 가로 스크롤 없음 (DataTable은 카드 레이아웃으로 전환)
- [ ] `lang="ko"` / `lang="en"` 지정, 아이콘 버튼 `aria-label`
- [ ] 표에는 `<th scope>`와 caption

---

## 16. Security (Web)

- CSP: `default-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'` (+ Next.js nonce 기반 script). 스토리지·API·Keycloak 모두 21051 동일 origin이므로 외부 origin 허용이 필요 없다.
- 토큰은 httpOnly 세션 cookie에만 저장한다. 클라이언트 노출은 메모리의 access token뿐이다.
- presigned URL, access token, 파일 경로를 에러 리포팅(Sentry)으로 보내지 않는다(`beforeSend`에서 query string 제거).
- 사용자 입력 텍스트(목적 상세, 코멘트)는 plain text로만 렌더한다(Markdown/HTML 렌더 금지).

---

## 17. Acceptance

| ID | 기준 |
|---|---|
| M10-AT-01 | §14.2 Golden E2E 12단계 통과 |
| M10-AT-02 | Mock 모드(`NEXT_PUBLIC_API_MOCKING=enabled`)에서 backend 없이 §11의 8개 flow 수동 시연 가능 |
| M10-AT-03 | `pnpm contracts:check`, `tsc --noEmit`, lint, unit test 통과. 컴포넌트 내 `fetch(` 직접 호출 0건(lint rule) |
| M10-AT-04 | error_codes.json의 모든 code에 `errors.*` ko 메시지 존재(CI 검사) |
| M10-AT-05 | 1 GiB 파일 multipart 업로드 → VERIFIED, 브라우저 메모리 사용이 파일 크기에 비례해 증가하지 않음 |
| M10-AT-06 | axe serious/critical 0, 키보드 전용 flow 통과 |
| M10-AT-07 | revoke/만료 후 다운로드 시 URL이 화면에 나타나지 않고 §8 메시지 표시 |
| M10-AT-08 | 모든 화면이 `http://localhost:21051` 단일 origin으로 동작(개발자 도구 네트워크 탭에 다른 origin 요청 0) |

## 18. Deliverables

1. `apps/web` (standalone Docker 이미지, compose `web` 서비스)
2. `packages/ui` 공통 컴포넌트 (AppShell, DataTable, StatusBadge, EmptyState, ErrorState, ConfirmDialog, FileDropzone)
3. MSW 시나리오와 mock session
4. Playwright golden E2E + a11y 테스트
5. `apps/web/README.md`: 실행법, 환경 변수, mock 모드, 알려진 제한
6. Integration notes: Agent 0(`AUTH_KEYCLOAK_INTERNAL_URL`, `API_INTERNAL_BASE`, Auth.js basePath `/web-auth` → `.env.example`, gateway), Agent 1(Keycloak client `nais-web` redirect URI `http://localhost:21051/web-auth/callback/keycloak`, post-logout URI, `org_code` mapper)

## 19. Known Limitations

- 알림은 30초 polling이며 실시간이 아니다.
- 다운로드는 파일별 링크 방식이다(zip 묶음, 재개 가능한 다운로드 없음).
- 업로드 재개는 같은 탭 세션 안에서만 가능하다(탭을 닫으면 처음부터).
- 역할 기반 UI 숨김은 `/me` 캐시(최대 60초) 기준이므로 역할 변경 직후 잠시 버튼이 보일 수 있다(서버가 차단).
