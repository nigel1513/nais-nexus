# M04 Access Governance

> Owner: **Agent 4 — Governance** · Release: **P0** · DB schema: `governance`
> Source of truth: `contracts/openapi.yaml` (tag `governance`), `contracts/events/p0_events.schema.json`, `contracts/error_codes.json`, `11_DECISION_LOG.md`, `08_OPA_POLICY.md`

---

## 1. Goal / Scope

### Goal
Dataset(향후 Resource) 접근 요청 → 검토 → **기간제 Grant** → 만료/회수를 통합 관리하고, 파일 다운로드 URL 발급의 **유일한 관문**이 된다.

### P0
- Access Request 생성(= SUBMITTED), 조회, 재제출, 철회
- Review: approve / reject / request-changes
- Grant 생성(ACTIVE), 조회, revoke
- 만료 enforcement(검사 시점 비교, D-010) + expiry sweeper + 만료 임박 알림 이벤트
- Download session: 권한 판정 → OPA 2차 판정 → presigned GET URL 발급(TTL 300s)
- 모든 결정(허용·거부)의 이벤트 발행 → Audit

### Hard rules (v1.0 유지)
- **default deny**
- **permanent grant 금지** — `expires_at NOT NULL`, `expires_at > valid_from`
- **purpose 필수**
- **CONTROLLED/SENSITIVE download는 active grant 필수** (소유기관 DATA_STEWARD/ORG_ADMIN 예외, D-011)
- **OPA fail = deny** (D-022)

### Out of scope (P0)
- Project 단위/Group 단위 grant (D-008, P1 검토)
- `COMPUTE`, `WRITE` operation 부여 (D-009) — 요청 시 `ACCESS_OPERATION_NOT_ALLOWED`
- 다단계 승인(기관 IRB, 2인 승인), 조건부 승인(마스킹 등)
- 스토리지 access log 기반 실제 다운로드 감사 (D-017, P1)
- Grant 연장(extend) — P0는 새 요청으로 대체

### 후속 단계
- P1: Resource(GPU/Model) grant 재사용(`GrantQueryPort`), grant 연장, 플랫폼 정책 배포의 POLICY_CHANGED 감사
- P2: Data Node의 grant validation(`services/data-node`가 `GrantQueryPort` 대응 API 호출), `COMPUTE` operation(compute-to-data)

---

## 2. Ownership

| 구분 | 경로 |
|---|---|
| 모듈 코드 | `apps/api/modules/governance/` |
| OPA 정책·테스트·번들 | `infra/opa/` (Rego는 `infra/opa/policies/data_access/`, D-003) |
| DB schema | `governance.*` (migration: `apps/api/modules/governance/migrations`, version table `governance.alembic_version`, D-021) |

권장 내부 구조:
```text
apps/api/modules/governance/
  api/            # FastAPI router (operationId 1:1)
  domain/         # AccessRequest, AccessGrant aggregate, state machine, rules
  app/            # use cases (create_request, approve, create_download_session ...)
  ports/          # Protocol 정의 (consumed ports) + public GrantQueryPort
  adapters/       # catalog/project/identity/storage/opa 어댑터 + fakes/
  jobs/           # expire_grants, notify_expiring
  handlers/       # event consumers
  migrations/
  tests/
```

---

## 3. Dependencies

### 3.1 Ports consumed

다른 모듈 테이블을 import/조회하지 않는다. Wave 1에서는 `adapters/fakes/`의 fake를 사용하고 통합 시 adapter만 교체한다.

```python
from datetime import datetime
from typing import Literal, Protocol, Sequence
from uuid import UUID
from dataclasses import dataclass

AccessLevel = Literal["PUBLIC", "INTERNAL", "CONTROLLED", "SENSITIVE"]
Purpose = Literal["ACADEMIC_RESEARCH", "AI_TRAINING", "COMMERCIAL_RESEARCH", "EDUCATION", "PUBLIC_INTEREST"]

# Catalog 타입(DatasetPolicyView, FileRef, VersionView, PresignedGet)과
# CatalogQueryPort / StoragePort의 정본은 modules/M03_data_catalog.md §8 이다 (D-024).
# Governance는 storage_bucket/storage_key를 읽거나 로그에 남기지 않는다.
from api.modules.catalog.ports import DatasetPolicyView, VersionView, PresignedGet  # 계약 타입만 import

class CatalogQueryPort(Protocol):   # 구현: M03
    def get_policy_view(self, dataset_id: UUID) -> DatasetPolicyView | None: ...
    def get_version(self, dataset_version_id: UUID) -> VersionView | None: ...

class StoragePort(Protocol):        # 구현: M03 (catalog가 key를 알고, governance가 권한을 결정)
    def presign_get(self, dataset_version_id: UUID, file_ids: Sequence[UUID] | None,
                    ttl_seconds: int) -> list[PresignedGet]: ...   # 알 수 없는 file_id → ValueError(NOT_FOUND)

@dataclass(frozen=True)
class ProjectSummary:
    project_id: UUID
    name: str
    status: Literal["ACTIVE", "ARCHIVED"]
    lead_organization_id: UUID

class ProjectQueryPort(Protocol):
    def get_summary(self, project_id: UUID) -> ProjectSummary | None: ...
    def is_active_member(self, project_id: UUID, user_id: UUID) -> bool: ...
    def get_member_role(self, project_id: UUID, user_id: UUID) -> str | None: ...  # ProjectRole

@dataclass(frozen=True)
class Principal:                    # platform auth dependency가 요청마다 구성
    user_id: UUID
    organization_id: UUID
    organization_code: str
    org_roles: frozenset[str]        # ORG_ADMIN / DATA_STEWARD / RESOURCE_MANAGER
    platform_roles: frozenset[str]   # PLATFORM_ADMIN
    user_status: Literal["ACTIVE", "DISABLED"]
    membership_status: Literal["ACTIVE", "DISABLED"]

class IdentityPort(Protocol):
    def get_principal(self, user_id: UUID) -> Principal | None: ...     # 이벤트 핸들러/잡용
    def get_public_profile(self, user_id: UUID) -> dict | None: ...     # IdentityPublicProfile

@dataclass(frozen=True)
class OpaDecision:
    allow: bool
    basis: Literal["PUBLIC", "OWNER_ORGANIZATION", "GRANT"] | None
    reasons: tuple[str, ...]
    policy_version: str

class PolicyDecisionPort(Protocol):  # adapters/opa_http.py, 08_OPA_POLICY.md
    def decide_data_access(self, opa_input: dict) -> OpaDecision: ...   # timeout/오류 시 PolicyEngineUnavailable raise
```

### 3.2 Platform 제공 (Agent 0)
- `platform.db.session` (트랜잭션), `platform.outbox.OutboxWriter` (D-005), `platform.errors.ApiError(code)`, `platform.auth.current_principal`, `platform.events.subscribe` (D-006), `platform.clock.now()` (테스트에서 고정 가능해야 함)

### 3.3 Events consumed
| Event | 처리 |
|---|---|
| `project.member.removed.v1` | 해당 user×project의 ACTIVE grant 전부 revoke(`PROJECT_MEMBER_REMOVED`), 열린 request는 SYSTEM withdraw |
| `project.archived.v1` | 해당 project의 ACTIVE grant 전부 revoke(`PROJECT_ARCHIVED`), 열린 request SYSTEM withdraw |
| `identity.membership.changed.v1` | `status: ACTIVE → DISABLED`일 때 해당 user의 ACTIVE grant 전부 revoke(`MEMBERSHIP_DISABLED`), 열린 request SYSTEM withdraw. 역할 변경만 있으면 처리 없음(권한은 호출 시점 판정) |
| `catalog.dataset.access_level_changed.v1` | **기존 grant 상태 변경 없음.** 로그만 남김. 단, 판정은 항상 *현재* access level 기준이므로 CONTROLLED → INTERNAL 변경 시 타기관 grant 보유자는 grant가 ACTIVE여도 다운로드 불가(D-011, §6.12 step 2) |
| `catalog.dataset.policy_changed.v1` | 기존 grant 변경 없음. 이후 approve는 **승인 시점의 현재 정책**으로 재검증 |

---

## 4. Data Model (`governance` schema)

공통: 모든 timestamp는 `timestamptz`(UTC). enum은 `text + CHECK`로 구현(Alembic diff 단순화). FK는 governance schema 내부만.

### 4.1 `governance.access_requests`
| column | type | null | default | constraint / 비고 |
|---|---|---|---|---|
| access_request_id | uuid | N | uuid7 (app) | **PK** |
| dataset_id | uuid | N | | 외부 ID (FK 없음) |
| dataset_title_snapshot | text | N | | 요청 시점 제목 (목록 표시용) |
| owner_organization_id | uuid | N | | 요청 시점 dataset 소유기관 |
| project_id | uuid | N | | |
| project_name_snapshot | text | N | | |
| requester_user_id | uuid | N | | |
| requester_organization_id | uuid | N | | |
| purpose | text | N | | CHECK IN (Purpose enum) |
| purpose_detail | text | N | | CHECK `char_length BETWEEN 20 AND 4000` |
| operations | text[] | N | | CHECK `cardinality(operations) >= 1 AND operations <@ ARRAY['READ','COMPUTE','WRITE']` |
| requested_days | integer | N | | CHECK `BETWEEN 1 AND 365` |
| status | text | N | `'SUBMITTED'` | CHECK IN (`DRAFT`,`SUBMITTED`,`UNDER_REVIEW`,`CHANGE_REQUESTED`,`APPROVED`,`REJECTED`,`WITHDRAWN`) |
| policy_snapshot | jsonb | N | | 제출 시점 DatasetPolicyView (감사/분쟁 대비) |
| submitted_at | timestamptz | N | now() | 재제출 시 갱신 |
| decided_at | timestamptz | Y | | APPROVED/REJECTED 시각 |
| decided_by | uuid | Y | | |
| created_at | timestamptz | N | now() | |
| updated_at | timestamptz | N | now() | |
| row_version | integer | N | 1 | optimistic lock (UPDATE 시 +1) |

Index
- **`uq_access_requests_open`** UNIQUE `(requester_user_id, project_id, dataset_id)` **WHERE** `status IN ('DRAFT','SUBMITTED','UNDER_REVIEW','CHANGE_REQUESTED')` — 열린 요청 1건 제한
- `ix_access_requests_owner_status` `(owner_organization_id, status, submitted_at DESC)` — review queue
- `ix_access_requests_requester` `(requester_user_id, created_at DESC)`
- `ix_access_requests_project` `(project_id)`

### 4.2 `governance.access_request_history`
| column | type | null | default | constraint |
|---|---|---|---|---|
| history_id | bigint | N | identity | **PK** |
| access_request_id | uuid | N | | **FK** → access_requests ON DELETE RESTRICT |
| from_status | text | Y | | 최초 생성 시 NULL |
| to_status | text | N | | |
| actor_type | text | N | `'USER'` | CHECK IN (`USER`,`SYSTEM`) |
| actor_user_id | uuid | Y | | SYSTEM이면 NULL |
| comment | text | Y | | reject reason / change comment / approve note |
| payload_diff | jsonb | Y | | resubmit 시 변경 필드 |
| at | timestamptz | N | now() | |

Index: `(access_request_id, at)`. API의 `AccessRequest.history[]`는 이 테이블에서 구성.

### 4.3 `governance.access_grants`
| column | type | null | default | constraint |
|---|---|---|---|---|
| access_grant_id | uuid | N | uuid7 | **PK** |
| access_request_id | uuid | N | | **FK** → access_requests, **UNIQUE** |
| subject_type | text | N | `'USER'` | CHECK = `'USER'` (P0) |
| subject_user_id | uuid | N | | |
| subject_organization_id | uuid | N | | |
| project_id | uuid | N | | |
| dataset_id | uuid | N | | |
| owner_organization_id | uuid | N | | |
| purpose | text | N | | |
| operations | text[] | N | | CHECK `cardinality >= 1` AND `operations <@ ARRAY['READ']` (P0) |
| valid_from | timestamptz | N | | |
| expires_at | timestamptz | N | | CHECK `expires_at > valid_from` — **영구 grant 불가** |
| granted_by | uuid | N | | reviewer |
| policy_version | text | N | | 예: `data_access@1.0.0` |
| status | text | N | `'ACTIVE'` | CHECK IN (`ACTIVE`,`EXPIRED`,`REVOKED`) |
| revoked_at | timestamptz | Y | | |
| revoked_by | uuid | Y | | SYSTEM revoke면 NULL |
| revocation_reason | text | Y | | |
| revocation_cause | text | Y | | CHECK IN (`MANUAL`,`PROJECT_MEMBER_REMOVED`,`PROJECT_ARCHIVED`,`MEMBERSHIP_DISABLED`) |
| expired_at | timestamptz | Y | | sweeper가 기록 |
| created_at | timestamptz | N | now() | |
| updated_at | timestamptz | N | now() | |

CHECK: `(status = 'REVOKED') = (revoked_at IS NOT NULL AND revocation_cause IS NOT NULL)`

Index
- **`uq_access_grants_active`** UNIQUE `(subject_user_id, project_id, dataset_id)` **WHERE** `status = 'ACTIVE'` — ACTIVE grant 1건 제한
- `ix_access_grants_lookup` `(subject_user_id, project_id, dataset_id, created_at DESC)` — download 판정
- `ix_access_grants_expiry` `(expires_at)` WHERE `status = 'ACTIVE'` — sweeper
- `ix_access_grants_owner` `(owner_organization_id, status)`
- `ix_access_grants_project` `(project_id)` WHERE `status = 'ACTIVE'`

> 주의: `status='ACTIVE'`이지만 `expires_at <= now()`인 행은 sweeper 지연 구간이다. **판정 로직은 status만 믿지 않고 항상 expires_at을 비교**한다(D-010). API 응답의 `status`도 계산값(`ACTIVE && expires_at <= now` → `EXPIRED`)으로 반환한다.

### 4.4 `governance.grant_notices`
만료 임박 알림 1회 보장.
| column | type | null | default | constraint |
|---|---|---|---|---|
| access_grant_id | uuid | N | | **PK(1)**, FK → access_grants |
| notice_type | text | N | | **PK(2)**, CHECK IN (`EXPIRING_SOON`) |
| sent_at | timestamptz | N | now() | |

### 4.5 `governance.download_sessions`
다운로드 판정 로컬 기록(포렌식·rate 모니터링). 감사의 정본은 Audit(M09).
| column | type | null | default | constraint |
|---|---|---|---|---|
| download_session_id | uuid | N | uuid7 | **PK** |
| user_id | uuid | N | | |
| organization_id | uuid | N | | |
| dataset_version_id | uuid | N | | |
| dataset_id | uuid | Y | | version 미존재 시 NULL |
| project_id | uuid | Y | | |
| access_grant_id | uuid | Y | | FK → access_grants |
| basis | text | Y | | CHECK IN (`PUBLIC`,`OWNER_ORGANIZATION`,`GRANT`) |
| result | text | N | | CHECK IN (`AUTHORIZED`,`DENIED`) |
| error_code | text | Y | | DENIED일 때 필수 |
| reasons | text[] | N | `'{}'` | OPA reasons 등 |
| file_ids | uuid[] | N | `'{}'` | |
| policy_version | text | Y | | |
| url_expires_at | timestamptz | Y | | |
| created_at | timestamptz | N | now() | |

Index: `(user_id, created_at DESC)`, `(dataset_version_id, created_at DESC)`, `(result, created_at)`.

### 4.6 `governance.processed_events`
| column | type | null | default | constraint |
|---|---|---|---|---|
| event_id | uuid | N | | **PK** |
| event_type | text | N | | |
| processed_at | timestamptz | N | now() | |

핸들러는 비즈니스 변경과 `processed_events` insert를 **같은 트랜잭션**에서 수행한다(D-006). PK 충돌 = 이미 처리됨 → skip.

---

## 5. State Machine

### 5.1 Access Request
```text
            (P0 미사용) DRAFT
                         │
 create ────────────────▶ SUBMITTED ──start-review (reviewer)──▶ UNDER_REVIEW
                         │  │  │                         │  │  │
                         │  │  └──── request-changes ───┼──┼──┴─▶ CHANGE_REQUESTED ──resubmit──▶ SUBMITTED
                         │  └─────── reject ────────────┼──┴────▶ REJECTED   (terminal)
                         └────────── approve ───────────┴───────▶ APPROVED   (terminal, grant 생성)
 SUBMITTED / UNDER_REVIEW / CHANGE_REQUESTED ──withdraw (requester | SYSTEM)──▶ WITHDRAWN (terminal)
```

| From | To | Actor | Trigger | Event |
|---|---|---|---|---|
| (none) | SUBMITTED | requester | `createAccessRequest` | `governance.access.requested.v1` (`resubmission=false`) |
| SUBMITTED | UNDER_REVIEW | owner-org DATA_STEWARD (≠ requester) | `startAccessReview` (D-025) | `governance.access.review_started.v1` |
| SUBMITTED, UNDER_REVIEW | APPROVED | owner-org DATA_STEWARD (≠ requester) | `approveAccessRequest` | `governance.access.approved.v1` |
| SUBMITTED, UNDER_REVIEW | REJECTED | owner-org DATA_STEWARD (≠ requester) | `rejectAccessRequest` | `governance.access.rejected.v1` |
| SUBMITTED, UNDER_REVIEW | CHANGE_REQUESTED | owner-org DATA_STEWARD (≠ requester) | `requestAccessChanges` | `governance.access.changes_requested.v1` |
| CHANGE_REQUESTED | SUBMITTED | requester | `resubmitAccessRequest` | `governance.access.requested.v1` (`resubmission=true`) |
| SUBMITTED, UNDER_REVIEW, CHANGE_REQUESTED | WITHDRAWN | requester | `withdrawAccessRequest` | `governance.access.withdrawn.v1` (actor USER) |
| SUBMITTED, UNDER_REVIEW, CHANGE_REQUESTED | WITHDRAWN | SYSTEM | member removed / project archived / membership disabled | `governance.access.withdrawn.v1` (actor SYSTEM) |

위 표에 없는 전이는 `ACCESS_REQUEST_INVALID_STATE`(409).

### 5.2 Access Grant
```text
approve ──▶ ACTIVE ──(expires_at <= now, sweeper)──▶ EXPIRED   (terminal)
               └────(revoke: MANUAL | SYSTEM cause)──▶ REVOKED   (terminal)
```

| From | To | Actor | Trigger | Event |
|---|---|---|---|---|
| (none) | ACTIVE | owner-org DATA_STEWARD | approve | `governance.access.approved.v1` |
| ACTIVE | ACTIVE (notice) | SYSTEM | expiring sweeper (72h 전, 1회) | `governance.access.expiring_soon.v1` |
| ACTIVE | EXPIRED | SYSTEM | expiry sweeper / approve 시 선정리 | `governance.access.expired.v1` |
| ACTIVE (not expired) | REVOKED | owner-org DATA_STEWARD / ORG_ADMIN | `revokeAccessGrant` | `governance.access.revoked.v1` (`MANUAL`) |
| ACTIVE | REVOKED | SYSTEM | §3.3 이벤트 | `governance.access.revoked.v1` (`revoked_by=null`, cause별) |

- EXPIRED/REVOKED grant는 재활성화하지 않는다. 다시 쓰려면 새 request.
- **Enforcement는 상태 전이와 무관**: `expires_at <= now`이면 status가 ACTIVE여도 즉시 거부(D-010).

---

## 6. API

모든 endpoint는 `platform.auth.current_principal`을 거친다. 인증 실패 `UNAUTHENTICATED`(401), 사용자/기관 멤버십 비활성은 platform이 `USER_DISABLED`/`MEMBERSHIP_DISABLED`(403)로 차단한다.
"Reviewer" = 해당 request/grant의 `owner_organization_id`에 **ACTIVE 멤버십 + `DATA_STEWARD` 역할**을 가진 사용자.

### 6.1 `createAccessRequest` — `POST /access-requests`
- 호출자: 인증 사용자
- 규칙(순서대로):
  1. `catalog.get_policy_view(dataset_id)`; 없음 / `status=WITHDRAWN` / (`access_level=INTERNAL` ∧ 호출자 org ≠ owner) → `NOT_FOUND`(D-012)
  2. `project.get_summary(project_id)` 없음 또는 호출자가 비멤버 → `ACCESS_NOT_PROJECT_MEMBER`(403). `status=ARCHIVED` → `PROJECT_ARCHIVED`(409)
  3. 호출자 project role이 `VIEWER` → `FORBIDDEN` (요청은 RESEARCHER 이상)
  4. grant 불필요 대상 → `ACCESS_NOT_REQUIRED`(422): `PUBLIC`, 또는 호출자가 owner org의 DATA_STEWARD/ORG_ADMIN, 또는 `INTERNAL` ∧ 호출자 org = owner
  5. `purpose ∉ allowed_purposes` → `ACCESS_PURPOSE_NOT_ALLOWED`
  6. `operations ⊄ {READ}` → `ACCESS_OPERATION_NOT_ALLOWED` (D-009)
  7. `requested_days > max_grant_days` 또는 (`SENSITIVE` ∧ `requested_days > 30`) → `ACCESS_DURATION_EXCEEDED`
  8. 같은 (user, project, dataset)의 열린 request 또는 `status=ACTIVE ∧ expires_at > now` grant 존재 → `ACCESS_REQUEST_DUPLICATE`(409). (unique index 위반도 동일 코드로 매핑)
- 부수효과: request(SUBMITTED, `policy_snapshot`), history 1행, outbox `governance.access.requested.v1` — 한 트랜잭션
- 응답: 201 `AccessRequest`

### 6.2 `listAccessRequests` — `GET /access-requests`
- `role=requester`(기본): `requester_user_id = 호출자`
- `role=reviewer`: 호출자가 DATA_STEWARD인 기관(= 호출자 org)이 owner인 요청. DATA_STEWARD가 아니면 빈 목록이 아니라 `FORBIDDEN`
- 필터: `status[]`, `project_id`, `dataset_id`. 정렬 `submitted_at DESC`. cursor pagination.

### 6.3 `getAccessRequest` — `GET /access-requests/{id}`
- 조회 가능: requester, owner org의 DATA_STEWARD/ORG_ADMIN. 그 외 → `NOT_FOUND`
- 부수효과 없음 (GET은 상태를 바꾸지 않는다, D-025).

#### `startAccessReview` — `POST /access-requests/{id}/start-review`
- 호출자: owner-org DATA_STEWARD (≠ requester)
- request `SELECT ... FOR UPDATE`; status = SUBMITTED → UNDER_REVIEW + history + outbox `governance.access.review_started.v1`
- status = UNDER_REVIEW이고 같은 reviewer면 멱등 200 (이벤트 없음). 그 외 상태 → `ACCESS_REQUEST_INVALID_STATE`(409)
- approve/reject/request-changes는 SUBMITTED에서도 바로 가능하다 (start-review는 선택)
- 응답에 `history[]`, `access_grant_id`(APPROVED일 때) 포함

### 6.4 `approveAccessRequest` — `POST /access-requests/{id}/approve`
- 호출자: Reviewer. requester 본인이면 → `ACCESS_NOT_REVIEWER` (자기 승인 금지)
- 규칙:
  1. request `SELECT ... FOR UPDATE`; 상태 ∉ {SUBMITTED, UNDER_REVIEW} → `ACCESS_REQUEST_INVALID_STATE`
  2. **현재** policy view 재조회: dataset 없음/WITHDRAWN → `ACCESS_REQUEST_INVALID_STATE`; `purpose ∉ allowed_purposes` → `ACCESS_PURPOSE_NOT_ALLOWED`
  3. `grant_days > requested_days` 또는 `> max_grant_days` 또는 (SENSITIVE ∧ `> 30`) → `ACCESS_DURATION_EXCEEDED`
  4. `operations`(생략 시 requested) ⊄ requested 또는 ⊄ {READ} → `ACCESS_OPERATION_NOT_ALLOWED`
  5. requester가 여전히 ACTIVE project member가 아님 → `ACCESS_NOT_PROJECT_MEMBER`; project ARCHIVED → `PROJECT_ARCHIVED`
  6. 같은 키의 기존 `status=ACTIVE ∧ expires_at <= now` grant가 있으면 먼저 EXPIRED 처리(+`expired` 이벤트) — unique index 충돌 방지
- 부수효과: request → APPROVED(`decided_at/by`), grant 생성(`valid_from=now`, `expires_at=now + grant_days*24h`, `policy_version`=현재 OPA 정책 버전), history(note), outbox `approved` — 한 트랜잭션
- 응답: 200 `AccessDecisionResult{access_request, access_grant}`

### 6.5 `rejectAccessRequest` / 6.6 `requestAccessChanges`
- 호출자: Reviewer (본인 요청 불가 → `ACCESS_NOT_REVIEWER`)
- 상태 ∉ {SUBMITTED, UNDER_REVIEW} → `ACCESS_REQUEST_INVALID_STATE`
- reject: `reason` 필수 → REJECTED, `rejected` 이벤트. request-changes: `comment` 필수 → CHANGE_REQUESTED, `changes_requested` 이벤트
- 응답: `AccessDecisionResult{access_grant: null}`

### 6.7 `resubmitAccessRequest`
- 호출자: requester만(아니면 `NOT_FOUND`/`FORBIDDEN`: 조회 권한 없으면 404, 있으면 403)
- 상태 ≠ CHANGE_REQUESTED → `ACCESS_REQUEST_INVALID_STATE`
- 변경 필드에 6.1의 규칙 5~7 재적용 + project 멤버십 재확인
- → SUBMITTED, `submitted_at` 갱신, history(`payload_diff`), `requested.v1(resubmission=true)`

### 6.8 `withdrawAccessRequest`
- 호출자: requester. 상태 ∉ {SUBMITTED, UNDER_REVIEW, CHANGE_REQUESTED} → `ACCESS_REQUEST_INVALID_STATE`
- → WITHDRAWN, `withdrawn.v1`

### 6.9 `listAccessGrants` — `GET /access-grants`
- `role=subject`(기본): 호출자가 subject인 grant
- `role=owner`: 호출자 org가 owner이고 호출자가 DATA_STEWARD 또는 ORG_ADMIN. 아니면 `FORBIDDEN`
- `status` 필터는 **계산 status** 기준(`ACTIVE` 필터는 `status='ACTIVE' AND expires_at > now`)

### 6.10 `revokeAccessGrant` — `POST /access-grants/{id}/revoke`
- 호출자: owner org의 DATA_STEWARD 또는 ORG_ADMIN. grant를 볼 권한도 없으면 `NOT_FOUND`, 보이지만 역할 없음 → `FORBIDDEN`
- grant `SELECT ... FOR UPDATE`; `status ≠ ACTIVE` 또는 `expires_at <= now` → `ACCESS_GRANT_NOT_ACTIVE`
- → REVOKED(`revoked_at=now`, `revoked_by`, `reason`, cause `MANUAL`), outbox `revoked.v1`, commit
- **효과는 commit 즉시**: 이후 모든 download-session은 §6.12 step 7에서 거부

### 6.11 권한 판정 공통 헬퍼
`domain/access_basis.py`의 순수 함수 `determine_basis(principal, policy_view) -> "PUBLIC" | "OWNER_ORGANIZATION" | "GRANT" | "HIDDEN"`를 6.1/6.12/`GrantQueryPort`가 공유한다(D-011).

| access_level | 호출자 = owner org ∧ (DATA_STEWARD ∨ ORG_ADMIN) | 호출자 = owner org (일반 멤버) | 타기관 |
|---|---|---|---|
| PUBLIC | PUBLIC | PUBLIC | PUBLIC |
| INTERNAL | OWNER_ORGANIZATION | OWNER_ORGANIZATION | HIDDEN (→ NOT_FOUND) |
| CONTROLLED | OWNER_ORGANIZATION | GRANT | GRANT |
| SENSITIVE | OWNER_ORGANIZATION | GRANT | GRANT |

### 6.12 `createDownloadSession` — `POST /dataset-versions/{version_id}/download-session`

**판정 알고리즘** (01_ARCHITECTURE §7 순서: active grant → operation → expiration → policy decision → signed URL)

| Step | 검사 | 실패 시 error code (HTTP) |
|---:|---|---|
| 0 | 인증, user/membership ACTIVE (platform) | `UNAUTHENTICATED`(401) / `USER_DISABLED` / `MEMBERSHIP_DISABLED`(403) — **감사 대상 아님**(platform 로그) |
| 1 | `catalog.get_version(version_id)` 존재, `get_policy_view(dataset_id)` 존재, dataset ACTIVE | `NOT_FOUND`(404) |
| 2 | `determine_basis` ≠ HIDDEN (INTERNAL 타기관) | `NOT_FOUND`(404) |
| 3 | version `status = PUBLISHED` | `DATASET_VERSION_NOT_PUBLISHED`(409) |
| 4 | `file_ids`(생략 시 전체) 모두 이 version의 VERIFIED 파일 | `NOT_FOUND`(404), `details.file_ids` |
| 5 | basis = GRANT이면 `project_id` 필수 | `VALIDATION_FAILED`(422), `details.fields=["project_id"]` |
| 6 | (GRANT) project 존재 ∧ 호출자 ACTIVE member; project ACTIVE | `ACCESS_NOT_PROJECT_MEMBER`(403) / `PROJECT_ARCHIVED`(409) |
| 7 | (GRANT) `(호출자, project_id, dataset_id)`의 **최신 grant** `SELECT ... FOR SHARE`: 없음 | `ACCESS_GRANT_REQUIRED`(403) |
| 7a | status = REVOKED | `ACCESS_GRANT_REVOKED`(403) |
| 7b | status = EXPIRED **또는 `expires_at <= now`** (D-010) | `ACCESS_GRANT_EXPIRED`(403) |
| 7c | `valid_from > now` | `ACCESS_GRANT_REQUIRED`(403), `details.reason="NOT_YET_VALID"` |
| 7d | `'READ' ∈ operations` | `ACCESS_GRANT_REQUIRED`(403), `details.reason="OPERATION_MISSING"` |
| 8 | OPA `decide_data_access(input)` (08_OPA_POLICY.md §2) — timeout 500ms, 연결 오류, 5xx, 응답 스키마 불일치 | `POLICY_ENGINE_UNAVAILABLE`(503) (D-022, fail-closed) |
| 8a | `allow = false` | `ACCESS_DENIED_BY_POLICY`(403), `details.reasons` = OPA reasons. precheck 통과 후 OPA 거부는 **정책 불일치**이므로 metric `governance_policy_divergence_total` 증가 + WARN 로그 |
| 8b | OPA `basis` ≠ precheck basis | `ACCESS_DENIED_BY_POLICY`(403), divergence metric |
| 9 | `storage.presign_get(version_id, file_ids, ttl_seconds=300)` 1회 호출 (M03이 `attachment` disposition 적용) | `ValueError` → `NOT_FOUND`(404), 그 외 예외 → `DEPENDENCY_UNAVAILABLE`(503) |
| 10 | `download_sessions`(AUTHORIZED) insert + outbox `governance.download.authorized.v1` → commit | |

- 응답: 201 `DownloadSession{basis, access_grant_id, expires_at=now+300s, files[]}`
- **Cross-project 재사용 방지**: step 7의 조회 키에 요청 `project_id`가 포함되므로 다른 project의 grant는 절대 매칭되지 않는다.
- **PUBLIC / OWNER_ORGANIZATION basis**도 step 8(OPA)을 거친다(defense-in-depth). `project_id`가 주어지면 기록만 한다.
- **거부 감사(D-017)**: step 1~9 중 어느 단계든 실패하면 본 트랜잭션은 rollback하고, **별도 트랜잭션**으로 `download_sessions`(DENIED, `error_code`, `reasons`) + outbox `governance.download.denied.v1`을 기록한 뒤 에러를 반환한다. 거부 기록 트랜잭션 자체가 실패해도 응답은 원래 에러 코드(fail-closed), ERROR 로그 남김.
- **동시성(revoke vs download)**: step 7은 `FOR SHARE`, revoke는 `FOR UPDATE`로 같은 grant 행을 잠근다. 따라서 (a) download 트랜잭션이 먼저 commit되면 URL은 revoke 이전에 적법하게 발급된 것이고, (b) revoke가 먼저 commit되면 download는 REVOKED를 읽고 거부된다. OPA 호출(≤500ms)과 presign(로컬 서명 계산)은 락 보유 구간 안에 있으며 허용 가능한 지연이다.

---

## 7. Events

### 7.1 Produced (모두 outbox 경유, 비즈니스 변경과 같은 트랜잭션)
| Event | 발생 시점 | Audit action |
|---|---|---|
| `governance.access.requested.v1` | create / resubmit | ACCESS_REQUESTED |
| `governance.access.approved.v1` | approve | ACCESS_APPROVED |
| `governance.access.rejected.v1` | reject | ACCESS_REJECTED |
| `governance.access.changes_requested.v1` | request-changes | ACCESS_CHANGES_REQUESTED |
| `governance.access.withdrawn.v1` | withdraw (USER/SYSTEM) | ACCESS_WITHDRAWN |
| `governance.access.revoked.v1` | revoke (MANUAL/SYSTEM) | ACCESS_REVOKED |
| `governance.access.expiring_soon.v1` | sweeper, 72h 전 1회 | (알림 전용) |
| `governance.access.expired.v1` | sweeper / approve 선정리 | ACCESS_EXPIRED |
| `governance.download.authorized.v1` | download 허용 | FILE_DOWNLOADED |
| `governance.download.denied.v1` | download 거부 | DOWNLOAD_DENIED |

envelope `actor`: 사용자 행위는 `{type: USER, user_id, organization_id}`, sweeper/이벤트 핸들러는 `{type: SYSTEM, user_id: null, organization_id: null}`. `correlation_id`는 요청 trace id, 이벤트 핸들러에서는 원인 이벤트의 `correlation_id`를 승계.

### 7.2 Consumed
§3.3 참조. 핸들러 규칙:
- 대상 grant를 `FOR UPDATE SKIP LOCKED` 없이 `FOR UPDATE`로 잠그고 ACTIVE인 것만 revoke (이미 REVOKED/EXPIRED면 skip)
- 이벤트 1건 → 여러 grant revoke 시 grant별 `revoked.v1` 1건씩 발행
- `processed_events` insert와 같은 트랜잭션

---

## 8. Public Service Interface (exposed)

`apps/api/modules/governance/ports/public.py` — 다른 모듈은 이 Protocol만 사용한다.

```python
class GrantQueryPort(Protocol):
    def has_active_grant(self, *, user_id: UUID, project_id: UUID, dataset_id: UUID,
                         operation: Literal["READ", "COMPUTE"], at: datetime | None = None) -> bool:
        """status=ACTIVE ∧ valid_from <= at < expires_at ∧ operation ∈ operations. at 기본값 now."""

    def list_active_grant_subjects(self, dataset_id: UUID) -> list[UUID]:
        """M09 DATASET_PUBLISHED 알림 수신자. ACTIVE ∧ expires_at > now 인 grant의 subject_user_id (중복 제거)."""

    def list_active_grants_for_project(self, project_id: UUID) -> list["GrantSummary"]:
        """P1: 프로젝트 화면/Compute가 연결 가능한 dataset 목록 조회."""

    def authorize_dataset_access(self, *, principal: Principal, dataset_id: UUID,
                                 dataset_version_id: UUID, project_id: UUID | None,
                                 operation: Literal["READ", "COMPUTE"]) -> "AccessDecision":
        """§6.12 step 1~8과 동일 판정(presign 제외). P1 Compute, P2 Data Node가 재사용. 감사 이벤트 발행 포함."""

@dataclass(frozen=True)
class GrantSummary:
    access_grant_id: UUID
    subject_user_id: UUID
    dataset_id: UUID
    operations: tuple[str, ...]
    expires_at: datetime

@dataclass(frozen=True)
class AccessDecision:
    allow: bool
    basis: str | None
    access_grant_id: UUID | None
    error_code: str | None
    reasons: tuple[str, ...]
    policy_version: str | None
```

---

## 9. Authorization Matrix

| Operation | Requester (project RESEARCHER+) | Project VIEWER | Owner-org DATA_STEWARD | Owner-org ORG_ADMIN | 타 사용자 | PLATFORM_ADMIN |
|---|---|---|---|---|---|---|
| createAccessRequest | ✅ | ❌ FORBIDDEN | (자기 기관 데이터면 ACCESS_NOT_REQUIRED) | 동일 | ✅ (project 멤버면) | 일반 사용자와 동일 |
| listAccessRequests role=requester | ✅ 본인 것 | ✅ 본인 것 | ✅ 본인 것 | ✅ 본인 것 | ✅ 본인 것 | ✅ 본인 것 |
| listAccessRequests role=reviewer | ❌ | ❌ | ✅ | ❌ FORBIDDEN | ❌ | ❌ (P0) |
| getAccessRequest | ✅ 본인 것 | — | ✅ (+UNDER_REVIEW 전이) | ✅ 읽기만 | ❌ NOT_FOUND | ❌ NOT_FOUND (P0) |
| approve / reject / request-changes | ❌ | ❌ | ✅ (본인 요청 제외) | ❌ | ❌ | ❌ |
| resubmit / withdraw | ✅ 본인 것 | — | ❌ | ❌ | ❌ | ❌ |
| listAccessGrants role=subject | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| listAccessGrants role=owner | ❌ | ❌ | ✅ | ✅ | ❌ | ❌ (P0) |
| revokeAccessGrant | ❌ | ❌ | ✅ | ✅ | ❌ | ❌ (P0) |
| createDownloadSession | §6.11 basis 규칙 | 동일 | OWNER_ORGANIZATION | OWNER_ORGANIZATION | basis 규칙 | 일반 사용자와 동일 (특권 없음) |

> PLATFORM_ADMIN은 데이터 접근 특권이 없다(최소권한). 운영상 강제 revoke가 필요하면 P1에서 별도 break-glass 절차로 정의.

---

## 10. Background Jobs

Worker 진입점(`apps/api/worker.py`, Agent 0)이 주기 실행을 등록하고, 로직은 `governance/jobs/`에 둔다.

| Job | 주기 | 동작 | 멱등성 |
|---|---|---|---|
| `expire_grants` | 60s (`GOVERNANCE_EXPIRY_SWEEP_INTERVAL_SECONDS`) | `status='ACTIVE' AND expires_at <= now()` 행을 `FOR UPDATE SKIP LOCKED LIMIT 500` 배치로 → `EXPIRED`, `expired_at=now`, `expired.v1` 발행. 배치가 가득 차면 즉시 반복 | 상태 조건부 UPDATE이므로 중복 실행 안전. 여러 worker 동시 실행 가능(SKIP LOCKED) |
| `notify_expiring` | 60s | `status='ACTIVE' AND expires_at > now AND expires_at <= now + 72h` 이면서 `grant_notices`에 `EXPIRING_SOON` 없는 grant → notice insert + `expiring_soon.v1` | `grant_notices` PK로 1회 보장 (insert 충돌 시 skip) |

- sweeper 지연/중단은 **보안에 영향 없음**(D-010). 지연은 metric `governance_expiry_lag_seconds`(가장 오래된 미처리 만료 grant의 경과 시간)로 모니터링, 300s 초과 시 alert.
- 전체 기간이 72h 이하인 grant는 승인 직후 첫 sweeper 실행에서 만료 임박 알림이 1회 발송된다(seed grant `...4001`의 2일 grant가 이 경우, 10_SEED_DATA.md §6).

---

## 11. Config / Env

| 변수 | 기본값 | 설명 |
|---|---|---|
| `OPA_URL` | `http://opa:8181` | |
| `OPA_TIMEOUT_MS` | `500` | D-022 |
| `OPA_DECISION_PATH` | `/v1/data/nais/data_access/decision` | 08_OPA_POLICY.md |
| `STORAGE_PRESIGN_TTL_SECONDS` | `300` | 다운로드 URL TTL. 상한 900 (초과 설정 시 기동 실패) |
| `GOVERNANCE_EXPIRY_SWEEP_INTERVAL_SECONDS` | `60` | |
| `GOVERNANCE_EXPIRING_SOON_HOURS` | `72` | |
| `GOVERNANCE_SENSITIVE_MAX_GRANT_DAYS` | `30` | D-011, 변경 시 OPA 정책 상수와 함께 변경 |
| `GOVERNANCE_DOWNLOAD_MAX_FILES` | `500` | contract `maxItems`와 동일 |

`policy_version`은 설정값이 아니라 OPA의 `data.nais.data_access.policy_version`을 조회해 60초 캐시한다. OPA 조회 실패 시 approve도 `POLICY_ENGINE_UNAVAILABLE`로 실패한다(grant에 버전 없는 기록 금지).

---

## 12. Acceptance Tests

Fixture: `10_SEED_DATA.md`의 기관·사용자(`a.researcher`, `b.researcher`, `b.steward`(DATA_STEWARD@inst-b), `b.admin`(ORG_ADMIN@inst-b))와 dataset `...2001`(= 아래 `DS-B1`, inst-b CONTROLLED, v1 PUBLISHED, allowed_purposes=[ACADEMIC_RESEARCH, AI_TRAINING], max_grant_days=180)을 사용하되, **seed의 request `...3001`/grant `...4001`은 로드하지 않은** 테스트 DB에서 실행한다. `P1` = project `...1001`(a.researcher OWNER, b.researcher RESEARCHER), `P2` = 테스트에서 새로 만든 a.researcher 소유 project. 시계는 `platform.clock` fake로 고정.

| ID | Given | When | Then |
|---|---|---|---|
| M04-AT-01 | a.researcher가 Project P1의 PROJECT_OWNER | DS-B1에 READ, ACADEMIC_RESEARCH, 30일 요청 | 201 SUBMITTED, `requested.v1` 1건, history 1행 |
| M04-AT-02 | AT-01 요청 존재 | 같은 user/project/dataset로 재요청 | 409 `ACCESS_REQUEST_DUPLICATE` |
| M04-AT-03 | — | purpose=COMMERCIAL_RESEARCH로 요청 (DS-B1 허용 목적 아님) | 422 `ACCESS_PURPOSE_NOT_ALLOWED` |
| M04-AT-04 | — | operations=[WRITE] 또는 [COMPUTE]로 요청 | 422 `ACCESS_OPERATION_NOT_ALLOWED` (**READ만 가진 사용자의 WRITE 불가**의 요청 측) |
| M04-AT-05 | — | requested_days=200 | 422 `ACCESS_DURATION_EXCEEDED` |
| M04-AT-06 | a.researcher가 P1 비멤버 | 요청 | 403 `ACCESS_NOT_PROJECT_MEMBER` |
| M04-AT-07 | AT-01 요청 | b.steward가 GET | status UNDER_REVIEW, history 2행 |
| M04-AT-08 | AT-07 | b.steward approve grant_days=7 | 200, grant ACTIVE, `expires_at = now+7d`, `approved.v1`, grant.policy_version 존재 |
| M04-AT-09 | AT-07 | b.admin(ORG_ADMIN, steward 아님) approve | 403 `ACCESS_NOT_REVIEWER` |
| M04-AT-10 | AT-07 | approve grant_days=40 (requested 30) | 422 `ACCESS_DURATION_EXCEEDED` |
| M04-AT-11 | AT-08 grant | a.researcher download-session(project_id=P1) | 201 basis=GRANT, URL TTL ≤ 300s, `download.authorized.v1` |
| M04-AT-12 | grant 없음 | a.researcher download-session | 403 `ACCESS_GRANT_REQUIRED`, `download.denied.v1` 1건 (**grant 없는 다운로드 URL 발급 불가**) |
| M04-AT-13 | AT-08 grant, 시계 +7d+1s, sweeper **미실행** | download-session | 403 `ACCESS_GRANT_EXPIRED` (**만료 grant로 다운로드 불가**, D-010) |
| M04-AT-14 | AT-13 이후 sweeper 실행 | — | grant EXPIRED, `expired.v1` 정확히 1건; sweeper 재실행해도 추가 이벤트 없음 |
| M04-AT-15 | AT-08 grant | b.steward revoke → 즉시 download-session | revoke 200, download 403 `ACCESS_GRANT_REVOKED` (**revoke 즉시 차단**) |
| M04-AT-16 | AT-15 | 다시 revoke | 409 `ACCESS_GRANT_NOT_ACTIVE` |
| M04-AT-17 | a.researcher가 P1 grant 보유, P2에도 멤버 | download-session(project_id=P2) | 403 `ACCESS_GRANT_REQUIRED` (**다른 project의 grant 재사용 불가**) |
| M04-AT-18 | AT-11 URL | 쿼리의 object key/`X-Amz-Expires`/서명 한 글자 변조 후 GET, 또는 다른 file의 path로 교체 | S3 스토리지가 403 (`SignatureDoesNotMatch`/`AccessDenied`) (**URL tampering 불가**). 301초 후 원본 URL GET → 403 (만료) |
| M04-AT-19 | OPA 컨테이너 중지 또는 fake가 timeout | 유효 grant로 download-session | 503 `POLICY_ENGINE_UNAVAILABLE`, URL 미발급, `download.denied.v1` 기록 (**OPA unavailable 시 fail-closed**) |
| M04-AT-20 | OPA fake가 allow=false 반환 | 유효 grant로 download-session | 403 `ACCESS_DENIED_BY_POLICY`, divergence metric +1 |
| M04-AT-21 | P1이 PRIVATE, 기관 C 사용자 | P1 id로 access request | 403 `ACCESS_NOT_PROJECT_MEMBER` (프로젝트 존재 여부 외 정보 노출 없음). (**다른 기관 사용자가 private project 조회 불가**의 governance 측; 본 테스트는 M02 AT와 쌍) |
| M04-AT-22 | AT-08 grant | `project.member.removed.v1`(a.researcher, P1) 전달 2회 | grant REVOKED(cause PROJECT_MEMBER_REMOVED, revoked_by null), `revoked.v1` 1건(멱등) |
| M04-AT-23 | AT-08 grant | `project.archived.v1`(P1) | 모든 P1 grant REVOKED(PROJECT_ARCHIVED), 열린 request WITHDRAWN(SYSTEM) |
| M04-AT-24 | AT-08 grant | `identity.membership.changed.v1` a.researcher DISABLED | grant REVOKED(MEMBERSHIP_DISABLED) |
| M04-AT-25 | AT-08 grant | DS-B1 access level CONTROLLED → INTERNAL (`access_level_changed.v1`) | grant 상태 ACTIVE 유지, download-session → 404 `NOT_FOUND` + denied 기록 |
| M04-AT-26 | AT-08 grant | **race**: T1 download-session이 step 7 락 획득 후 OPA 대기(fake 지연 300ms) 중 T2 revoke | T2는 T1 commit까지 대기 후 성공. T1 URL 발급됨(revoke 이전 발급으로 기록). T1 commit 후 새 download-session은 `ACCESS_GRANT_REVOKED`. 역순(T2 먼저 commit)이면 T1은 `ACCESS_GRANT_REVOKED` |
| M04-AT-27 | DS-B1 v2 DRAFT | a.researcher download-session(v2) | 409 `DATASET_VERSION_NOT_PUBLISHED` |
| M04-AT-28 | B의 INTERNAL dataset | a.researcher download-session | 404 `NOT_FOUND` |
| M04-AT-29 | b.steward | DS-B1 download-session (project_id 없음) | 201 basis=OWNER_ORGANIZATION |
| M04-AT-30 | PUBLIC dataset | 인증 사용자 download-session | 201 basis=PUBLIC, OPA 호출 1회 |
| M04-AT-31 | 만료 72h 전 진입한 7일 grant | notify_expiring 2회 실행 | `expiring_soon.v1` 정확히 1건 |
| M04-AT-32 | a.researcher 본인이 b.steward 역할도 가진 가상 계정 | 자기 요청 approve | 403 `ACCESS_NOT_REVIEWER` |
| M04-AT-33 | DB | `INSERT access_grants ... expires_at = valid_from` 또는 NULL | CHECK/NOT NULL 위반 (영구 grant 불가) |
| M04-AT-34 | 전 endpoint | 권한 없는 호출 | 모든 거부 응답이 ErrorEnvelope + `trace_id` 포함 |

추가로 `infra/opa/policies/data_access/*_test.rego`(08_OPA_POLICY.md §6)가 CI `opa test`로 통과해야 한다.

---

## 13. Deliverables & Known Limitations

### Deliverables (02 §8 준수)
1. `apps/api/modules/governance/README.md`
2. Router (openapi operationId 11개 1:1) + contract test 통과
3. Migration (§4 테이블/인덱스/CHECK 전부)
4. 이벤트 10종 발행, 4종 소비 핸들러
5. Error code 매핑 (error_codes.json의 governance 코드 전부 사용처 존재)
6. Unit tests (state machine, determine_basis, duration 계산 경계값) + AT-01~34
7. `infra/opa/policies/data_access/` Rego + test + bundle 설정
8. Fakes: `FakeCatalogQuery`, `FakeProjectQuery`, `FakeIdentity`, `FakeStorage`, `FakeOpa(mode=allow|deny|timeout|error)`
9. Integration notes: M10(에러 코드/상태 표시), M09(이벤트 → audit action 매핑), M03(`CatalogQueryPort`, `StoragePort` — 타입 정본은 M03 §8)

### Known limitations
- **이미 발급된 presigned URL은 revoke/만료 후에도 최대 TTL(300s)까지 유효**하다. S3 presigned URL은 발급 후 서버에서 무효화할 수 없다. 완화: TTL 300s 상한, 발급 기록/감사. P2 Data Node의 direct transfer endpoint에서는 요청 시점 grant 재검증으로 해소.
- `FILE_DOWNLOADED` 감사는 **URL 발급 기준**이며 실제 전송 완료를 의미하지 않는다(D-017). P1에서 S3 스토리지 bucket notification/access log 연동.
- Grant subject는 사용자 1명(D-008). 같은 프로젝트 공동연구자도 각자 요청해야 한다.
- `COMPUTE`/`WRITE` operation은 enum만 존재, P0에서 부여 불가.
- Reviewer의 GET이 상태를 바꾸는(SUBMITTED → UNDER_REVIEW) 부수효과가 있다. 이 전이는 이벤트/감사가 없다.
- 단일 승인자 모델. 다단계 승인, 승인 위임, 부재 시 대리 승인 없음.
- Policy 변경(`allowed_purposes`, `max_grant_days` 축소)은 기존 grant에 소급 적용되지 않는다. 필요 시 steward가 수동 revoke.
