# M01 Identity & Organization

> 기준 계약: `contracts/openapi.yaml`(tag `identity`), `contracts/events/p0_events.schema.json`, `contracts/error_codes.json`, `11_DECISION_LOG.md`(D-019, D-020)

## 1. Goal / Scope

### Goal
기관 연합형 인증을 위한 내부 Identity model과 Organization directory를 제공한다.
Keycloak은 **인증만** 담당하고, 사용자·기관 소속·역할의 source of truth는 NAIS `identity` DB다 (D-019).

### P0
- Keycloak OIDC login (realm `nais`, Authorization Code + PKCE)
- 토큰 claim 기반 JIT user provisioning (`org_code` → Organization 매핑)
- `GET /me`
- Organization list/detail
- User ↔ Organization membership (P0: 사용자 1명 = 기관 1개)
- 기관 역할: `ORG_ADMIN`, `DATA_STEWARD`, `RESOURCE_MANAGER` / 플랫폼 역할: `PLATFORM_ADMIN`
- 기관 멤버 역할·상태 관리 (`ORG_ADMIN`, `PLATFORM_ADMIN`)
- 사용자 directory 검색 (`GET /users`, 프로젝트 초대용)
- 비활성 사용자/멤버십 요청 차단 (모든 요청)
- 세션당 1회 로그인 감사 이벤트 (D-020)
- 다른 모듈이 쓰는 인증 dependency `CurrentUser` 계약
- Institute A/B seed

### Out of scope
- KAFE 실제 연동
- ORCID verification
- SAML IdP 실제 연동 (Keycloak 설정으로 SAML-ready 구조만 유지)
- 한 사용자의 복수 기관 소속

### 후속 단계
- P1: 복수 기관 소속, 기관 가입 신청/승인 플로우
- P2: ROR/ORCID PID 연계 (`organizations.ror_id` 컬럼은 P0에 미리 둠), KAFE/Federated IdP

## 2. Ownership

| 항목 | 값 |
|---|---|
| Owner | Agent 1 — Identity |
| Paths | `apps/api/modules/identity`, `infra/keycloak` |
| DB schema | `identity` |
| Migration | `apps/api/modules/identity/migrations` (version_table `identity.alembic_version`, D-021) |

`apps/api/platform/auth`(JWT 검증, `CurrentUser` dependency 골격)는 Agent 0 소유다. M01은 그 골격이 호출하는 `PrincipalResolver` 구현을 제공한다.

## 3. Dependencies

### Ports consumed
해당 없음. M01은 다른 비즈니스 모듈에 의존하지 않는다.

플랫폼 인프라만 사용한다.
```python
# apps/api/platform (Agent 0)
class OutboxWriter(Protocol):
    def write(self, session: Session, event_type: str, payload: dict, actor: EventActor,
              correlation_id: UUID) -> UUID: ...
```

### Events consumed
해당 없음.

## 4. Data Model (`identity.*`)

### `identity.organizations`
| column | type | null | default | constraint |
|---|---|---|---|---|
| organization_id | uuid | N | uuidv7 | PK |
| code | varchar(32) | N | | UNIQUE, CHECK `code ~ '^[a-z0-9-]{2,32}$'` |
| name | varchar(200) | N | | |
| type | varchar(32) | N | | CHECK in (`RESEARCH_INSTITUTE`,`UNIVERSITY`,`COMPANY`,`PLATFORM_OPERATOR`) |
| ror_id | varchar(64) | Y | | P2 확장 |
| homepage_url | text | Y | | |
| created_at | timestamptz | N | now() | |
| updated_at | timestamptz | N | now() | |

### `identity.users`
| column | type | null | default | constraint |
|---|---|---|---|---|
| user_id | uuid | N | uuidv7 | PK |
| keycloak_sub | varchar(64) | N | | UNIQUE (토큰 `sub`) |
| email | varchar(320) | N | | UNIQUE (lower 저장) |
| display_name | varchar(200) | N | | |
| status | varchar(16) | N | `'ACTIVE'` | CHECK in (`ACTIVE`,`DISABLED`) |
| platform_roles | text[] | N | `'{}'` | 원소 CHECK ⊆ {`PLATFORM_ADMIN`} |
| last_login_at | timestamptz | Y | | |
| created_at | timestamptz | N | now() | |
| updated_at | timestamptz | N | now() | |

Index: `ix_users_display_name_trgm` (pg_trgm GIN, `GET /users?q=` 용), `ix_users_email_prefix` (`email text_pattern_ops`).

### `identity.organization_memberships`
| column | type | null | default | constraint |
|---|---|---|---|---|
| membership_id | uuid | N | uuidv7 | PK |
| user_id | uuid | N | | FK → `identity.users`, **UNIQUE** (P0 1인 1기관) |
| organization_id | uuid | N | | FK → `identity.organizations` |
| roles | text[] | N | `'{}'` | 원소 CHECK ⊆ {`ORG_ADMIN`,`DATA_STEWARD`,`RESOURCE_MANAGER`} |
| status | varchar(16) | N | `'ACTIVE'` | CHECK in (`ACTIVE`,`DISABLED`) |
| created_at | timestamptz | N | now() | |
| updated_at | timestamptz | N | now() | |
| updated_by | uuid | Y | | 마지막 변경자 user_id |

Index: `ix_memberships_org_status (organization_id, status)`, GIN `roles`.

### `identity.user_sessions`
로그인 감사(D-020)를 세션당 1회로 제한하기 위한 테이블.

| column | type | null | default | constraint |
|---|---|---|---|---|
| session_id | varchar(64) | N | | PK (토큰 `sid` claim) |
| user_id | uuid | N | | FK → `identity.users` |
| first_seen_at | timestamptz | N | now() | |

Index: `ix_user_sessions_user (user_id, first_seen_at desc)`. 90일 지난 행은 정리 job이 삭제.

`identity.processed_events`: 해당 없음 (소비 이벤트 없음).

## 5. State machine

### User / Membership status
| from | to | 주체 | 비고 |
|---|---|---|---|
| (없음) | ACTIVE | JIT provisioning, seed | |
| ACTIVE | DISABLED | ORG_ADMIN(자기 기관 membership), PLATFORM_ADMIN(user, membership) | membership DISABLED → governance가 해당 사용자 grant 회수 (`MEMBERSHIP_DISABLED`) |
| DISABLED | ACTIVE | ORG_ADMIN, PLATFORM_ADMIN | 회수된 grant는 복구되지 않음 |

`users.status` 변경 API는 P0에 없다 (PLATFORM_ADMIN이 운영 스크립트로 변경). API로 바꾸는 것은 membership status다.

## 6. API

모든 endpoint는 platform의 `CurrentUser` dependency를 통과한다. 즉, 아래 규칙이 **모든 모듈의 모든 요청**에 적용된다.

### 인증 공통 처리 (`PrincipalResolver.resolve`)
1. Platform이 Bearer JWT를 JWKS(`OIDC_INTERNAL_JWKS_URL`)로 검증한다. `iss == OIDC_ISSUER`, `aud`에 `nais-api` 포함, `exp` 유효. 실패 시 401 `UNAUTHENTICATED`.
2. `org_code` claim으로 `organizations.code`를 조회한다. 없으면 403 `ORGANIZATION_UNKNOWN`.
3. `keycloak_sub`로 user를 조회한다. 없으면 **JIT provisioning**을 한 트랜잭션에서 처리한다.
   - `users` insert (email, `name` claim → display_name)
   - `organization_memberships` insert (roles `{}`, ACTIVE)
   - `identity.user.created.v1` outbox write
   - 같은 email이 이미 다른 `sub`로 존재하면 409 `CONFLICT`를 반환한다. 계정 병합은 하지 않는다.
4. `users.status = DISABLED`이면 403 `USER_DISABLED`.
5. membership이 DISABLED이면 403 `MEMBERSHIP_DISABLED`.
6. 토큰 `org_code`와 membership organization이 다르면 403 `ORGANIZATION_UNKNOWN`. 기관 이동은 P0 미지원이다.
7. `sid`를 `user_sessions`에 `INSERT ... ON CONFLICT DO NOTHING`한다. 실제로 insert되었으면 `identity.user.logged_in.v1` outbox write, `last_login_at` 갱신. (`sid`가 없으면 `sub + iat`의 sha256을 session_id로 사용)
8. `CurrentUser`를 반환한다.

역할과 status는 **캐시하지 않는다** (요청마다 PK 조회 1회). 그래서 DISABLED 처리는 다음 요청부터 즉시 적용된다.

### Endpoint별 규칙

| operationId | 호출 가능 | 규칙 | Side effect | Error |
|---|---|---|---|---|
| `getMe` | 인증 사용자 | 위 공통 처리 결과를 `Me`로 반환. 첫 호출이 곧 JIT provisioning 지점 | `identity.user.created.v1`(최초), `identity.user.logged_in.v1`(세션 최초) | 401 `UNAUTHENTICATED`, 403 `USER_DISABLED`/`MEMBERSHIP_DISABLED`/`ORGANIZATION_UNKNOWN`, 409 `CONFLICT` |
| `listUsers` | 인증 사용자 | ACTIVE user + ACTIVE membership만. `q`(2자 이상): display_name 부분일치(trgm) 또는 email prefix. `organization_id` 필터. 정렬 display_name asc. 반환 필드는 `IdentityPublicProfile`만 (email 미포함) | 없음 | 401, 422 `VALIDATION_FAILED`(q 1자) |
| `listOrganizations` | 인증 사용자 | 전체 기관, name asc | 없음 | 401 |
| `getOrganization` | 인증 사용자 | `member_count`(ACTIVE membership 수). `dataset_count`는 identity가 알 수 없으므로 P0에서는 필드를 생략한다 (optional 필드) | 없음 | 404 `NOT_FOUND` |
| `listOrganizationMembers` | 해당 기관 ORG_ADMIN, PLATFORM_ADMIN | DISABLED 포함 전체. email 포함 | 없음 | 403 `FORBIDDEN`, 404 |
| `updateOrganizationMember` | 해당 기관 ORG_ADMIN, PLATFORM_ADMIN | 아래 규칙 참고 | `identity.membership.changed.v1` | 403 `FORBIDDEN`, 404 `NOT_FOUND`, 422 `ROLE_NOT_ASSIGNABLE`/`VALIDATION_FAILED` |

`updateOrganizationMember` 규칙:
- `roles`는 전체 교체(set semantics)다. 중복은 422 `VALIDATION_FAILED`.
- ORG_ADMIN은 **자기 자신의 `ORG_ADMIN` 역할을 제거할 수 없고**, 자기 membership을 DISABLED로 바꿀 수 없다 (422 `ROLE_NOT_ASSIGNABLE`). 기관의 마지막 ACTIVE ORG_ADMIN 제거는 PLATFORM_ADMIN만 가능하다.
- `PLATFORM_ADMIN`은 기관 역할이 아니므로 roles에 넣으면 422 `ROLE_NOT_ASSIGNABLE`.
- 실제 변경이 없으면(같은 roles/status) 이벤트를 발행하지 않고 200을 반환한다.
- 변경과 outbox write는 같은 트랜잭션에서 처리한다.

## 7. Events

### Produced
| event_type | 시점 | 트랜잭션 |
|---|---|---|
| `identity.organization.created.v1` | seed 또는 관리 스크립트로 기관 생성 | organizations insert와 동일 |
| `identity.user.created.v1` | JIT provisioning, seed | users/memberships insert와 동일 |
| `identity.user.logged_in.v1` | 세션(`sid`) 최초 인증 요청 | user_sessions insert와 동일 |
| `identity.membership.changed.v1` | roles 또는 status 변경 | membership update와 동일 |

envelope `actor`:
- `logged_in`/`user.created`(JIT)는 actor = 해당 사용자다.
- seed는 `SYSTEM`이다.
- `membership.changed`는 변경한 관리자다.

`correlation_id`는 요청 trace id다.

### Consumed
해당 없음.

## 8. Public Service Interface

```python
from typing import Protocol
from uuid import UUID

class CurrentUser(BaseModel):          # apps/api/platform/auth 에 정의 (Agent 0), 전 모듈 공용
    user_id: UUID
    organization_id: UUID
    org_roles: frozenset[str]          # ORG_ADMIN | DATA_STEWARD | RESOURCE_MANAGER
    platform_roles: frozenset[str]     # PLATFORM_ADMIN
    session_id: str
    display_name: str
    def has_org_role(self, org_id: UUID, role: str) -> bool:   # org_id == organization_id and role in org_roles
        ...
    @property
    def is_platform_admin(self) -> bool: ...

class PrincipalResolver(Protocol):     # M01 구현, platform auth dependency가 호출
    def resolve(self, claims: dict, correlation_id: UUID) -> CurrentUser: ...   # 실패 시 DomainError(code)

class IdentityQueryPort(Protocol):     # 다른 모듈용 read port
    def get_public_profile(self, user_id: UUID) -> IdentityPublicProfile | None: ...
    def get_public_profiles(self, user_ids: list[UUID]) -> dict[UUID, IdentityPublicProfile]: ...
    def get_organization_summary(self, organization_id: UUID) -> OrganizationSummary | None: ...
    def is_active_user(self, user_id: UUID) -> bool: ...                # user ACTIVE and membership ACTIVE
    def has_org_role(self, user_id: UUID, organization_id: UUID, role: str) -> bool: ...
    def list_users_with_org_role(self, organization_id: UUID, role: str) -> list[UUID]: ...   # ACTIVE만, M09 알림 수신자용
    def get_email(self, user_id: UUID) -> str | None: ...   # M09 메일 발송 전용. 다른 모듈은 사용 금지
```

`IdentityPublicProfile`과 `OrganizationSummary`는 `openapi.yaml` components와 동일한 Pydantic 모델이다 (`packages/contracts`의 생성 타입).

## 9. Authorization matrix

| Action | 인증 사용자 | ORG_ADMIN (자기 기관) | ORG_ADMIN (타 기관) | PLATFORM_ADMIN |
|---|---|---|---|---|
| `GET /me` | O | O | O | O |
| `GET /users`, `GET /organizations[/{id}]` | O | O | O | O |
| `GET /organizations/{id}/members` | X | O | X | O |
| 멤버 roles 변경 | X | O (자기 ORG_ADMIN 제거 불가) | X | O |
| 멤버 status 변경 | X | O (자기 자신 불가) | X | O |
| 마지막 ORG_ADMIN 제거 | X | X | X | O |

DATA_STEWARD, RESOURCE_MANAGER는 M01 관리 권한이 없다.

## 10. Background jobs

| Job | 주기 | 내용 |
|---|---|---|
| `identity.prune_sessions` | 1일 | `first_seen_at < now() - 90d`인 `user_sessions` 삭제 |

## 11. Config / env vars

| 변수 | 기본값 | 용도 |
|---|---|---|
| `OIDC_ISSUER` | `http://localhost:21051/auth/realms/nais` | 토큰 `iss` 검증 |
| `OIDC_INTERNAL_JWKS_URL` | `http://keycloak:8080/auth/realms/nais/protocol/openid-connect/certs` | 서명키 조회 (컨테이너 내부) |
| `OIDC_AUDIENCE` | `nais-api` | `aud` 검증 |
| `OIDC_CLOCK_SKEW_SECONDS` | `30` | exp/nbf 허용 오차 |

### Keycloak realm `nais` (`infra/keycloak/realm-nais.json`, import on start)
- 컨테이너 설정: `KC_HTTP_RELATIVE_PATH=/auth`, `KC_HOSTNAME=http://localhost:21051/auth`, `KC_PROXY_HEADERS=xforwarded`, `start-dev --import-realm` (dev).
- Clients:
  - `nais-web`: public client, Standard Flow + **PKCE S256 필수**, redirect `http://localhost:21051/*`, web origin `http://localhost:21051`, direct access grants **off**.
  - `nais-api`: bearer-only(또는 audience 전용 client). `nais-web` 토큰에 audience mapper로 `nais-api` 추가.
  - `nais-e2e`: confidential, direct access grants on — **dev/test realm에만** 존재 (E2E/보안 테스트 토큰 발급용). prod realm import에서 제외.
- User attribute `org_code`: user profile에 필수 속성으로 선언. Protocol mapper `org_code`(User Attribute → token claim `org_code`, access/id token 포함).
- Token 수명: access 5분, SSO session idle 30분, max 10시간.
- Keycloak에는 **역할을 두지 않는다** (D-019). realm roles는 기본값만 사용한다.

### Seed (M01 seed, `make seed`)
dev password: `nais` (dev/test realm 한정)

| 기관 code | name | type |
|---|---|---|
| `nais` | NAIS | PLATFORM_OPERATOR |
| `inst-a` | Institute A | RESEARCH_INSTITUTE |
| `inst-b` | Institute B | RESEARCH_INSTITUTE |

기관 스토리지는 identity가 관리하지 않는다. catalog가 기관 `code`에서 env prefix를 유도한다 (`inst-a` → `STORAGE_INST_A_*`, D-024).

| email | 기관 | org roles | platform roles | membership |
|---|---|---|---|---|
| admin@nais.local | nais | - | PLATFORM_ADMIN | ACTIVE |
| a.admin@inst-a.local | inst-a | ORG_ADMIN | - | ACTIVE |
| a.researcher@inst-a.local | inst-a | - | - | ACTIVE |
| a.steward@inst-a.local | inst-a | DATA_STEWARD | - | ACTIVE |
| b.admin@inst-b.local | inst-b | ORG_ADMIN | - | ACTIVE |
| b.researcher@inst-b.local | inst-b | - | - | ACTIVE |
| b.steward@inst-b.local | inst-b | DATA_STEWARD | - | ACTIVE |
| b.disabled@inst-b.local | inst-b | - | - | **DISABLED** |

Seed 규칙:
- Keycloak 사용자와 NAIS DB 행을 **같은 `sub`로** 동시에 만든다. 고정 UUID를 사용하고, Keycloak import JSON에 `id`를 지정한다.
- seed는 멱등이다 (upsert).
- UUID 목록은 `infra/keycloak/seed_ids.json`에 두고 다른 모듈 seed가 참조한다.

## 12. Acceptance tests

| ID | Given | When | Then |
|---|---|---|---|
| M01-AT-01 | seed 완료 | a.researcher, b.researcher가 각각 로그인 후 `GET /me` | 각자 `organization.code`가 `inst-a`/`inst-b`, 200 |
| M01-AT-02 | Keycloak에만 있고 NAIS DB에 없는 신규 사용자(org_code=`inst-a`) | `GET /me` | users/membership 생성, roles `[]`, `identity.user.created.v1` 1건 |
| M01-AT-03 | 같은 `sid` 토큰 | `GET /me`를 3회 호출 | `identity.user.logged_in.v1` 정확히 1건 |
| M01-AT-04 | 새 로그인(다른 `sid`) | `GET /me` | `logged_in` 이벤트 추가 1건 |
| M01-AT-05 | b.disabled (membership DISABLED) | 로그인 후 `GET /me`, `GET /projects`, `GET /datasets` | 모두 403 `MEMBERSHIP_DISABLED` |
| M01-AT-06 | a.researcher 로그인 상태 | a.admin이 a.researcher membership을 DISABLED로 변경 후 a.researcher가 같은 토큰으로 요청 | 다음 요청부터 403 `MEMBERSHIP_DISABLED`, `identity.membership.changed.v1` 1건 |
| M01-AT-07 | `org_code=unknown-org` 토큰 | `GET /me` | 403 `ORGANIZATION_UNKNOWN`, 사용자 생성 안 됨 |
| M01-AT-08 | 만료/위조 서명/`aud` 불일치 토큰 | 임의 API 호출 | 401 `UNAUTHENTICATED` |
| M01-AT-09 | a.admin | `PATCH /organizations/{inst-b}/members/{b.researcher}` | 403 `FORBIDDEN` |
| M01-AT-10 | a.researcher (역할 없음) | `GET /organizations/{inst-a}/members` | 403 `FORBIDDEN` |
| M01-AT-11 | a.admin | 자기 roles에서 ORG_ADMIN 제거 | 422 `ROLE_NOT_ASSIGNABLE` |
| M01-AT-12 | a.admin | a.researcher roles를 `["PLATFORM_ADMIN"]`으로 | 422 `ROLE_NOT_ASSIGNABLE` |
| M01-AT-13 | a.admin | a.researcher에게 DATA_STEWARD 부여 | 200, 이벤트 `previous_roles=[]`, `roles=["DATA_STEWARD"]`; 이후 a.researcher `GET /me`의 org_roles에 반영 |
| M01-AT-14 | 인증 사용자 | `GET /users?q=b.` | ACTIVE 사용자만, b.disabled 미포함, 응답에 email 필드 없음 |
| M01-AT-15 | 요청마다 | 역할 변경 직후 | 캐시 없이 즉시 반영 (M01-AT-13과 동일 토큰으로 확인) |
| M01-AT-16 | `nais-web` client | Authorization Code 요청에 PKCE 없음 | Keycloak이 거부 |

## 13. Deliverables & Known limitations

### Deliverables (02 §8)
- README (모듈 개요, 로컬 로그인 방법)
- `PrincipalResolver`, `IdentityQueryPort` 구현 + FastAPI router
- Alembic migration (`identity` schema)
- `infra/keycloak/realm-nais.json`, `seed_ids.json`
- Seed 스크립트
- Unit/contract tests (위 AT)
- Integration notes: 다른 모듈은 `CurrentUser`와 `IdentityQueryPort`만 사용한다. identity 테이블 직접 조회는 금지다.

### Known limitations
- 1인 1기관. 기관 이동/겸직 불가.
- Keycloak에서 사용자의 `org_code` 속성을 바꾸면 403 `ORGANIZATION_UNKNOWN`이 되며 수동 조정이 필요하다.
- 사용자 계정(`users.status`) 비활성화 API는 없다 (운영 스크립트).
- 토큰 폐기(logout)는 Keycloak 세션 기준이다. NAIS는 access token 만료(5분)까지 유효하다고 보되, DISABLED 검사로 보완한다.
