# M09 Audit & Notification

> 기준 계약: `contracts/openapi.yaml`(tags `audit`, `notifications`), `contracts/events/index.json`, `04_SECURITY_GOVERNANCE.md` §6, `11_DECISION_LOG.md`(D-006, D-017)

## 1. Goal / Scope

### Goal
중요 행위의 **불변 Audit 기록**과 사용자 **notification**을 제공한다.

### P0
- `contracts/events/index.json`의 **모든 이벤트 소비**
- 이벤트 → Audit record 변환 (불변, append-only)
- Audit fields: event_id, timestamp, actor, organization, action, resource, result, reason, trace_id, policy_version
- Audit 조회 API (역할별 가시성)
- Notification P0: project invitation, access submitted, access approved/rejected, changes requested, access expiring, grant revoked, dataset published
- Channel: In-app + 이메일 (dev: local Mailpit)

### Principle
- 일반 app log와 audit log를 분리한다.
  - app log는 stdout JSON이다.
  - audit는 `audit` schema에 저장한다.
  - audit 기록은 app log 레벨·샘플링의 영향을 받지 않는다.
- Audit는 **이벤트만으로** 생성한다. 다른 모듈이 audit 테이블에 직접 쓰지 않는다.

### Out of scope
- 외부 SIEM 전송 (P1)
- 알림 사용자별 설정 (P1)
- 스토리지 access log 기반 실제 다운로드 감사 (P1, D-017)
- Web push, Slack 등 추가 채널

### 후속 단계
- P1: 알림 설정, 요약 메일
- P2: Data Node audit forwarding 수신 (M08)
- 장기: 해시 체인 기반 변조 탐지

## 2. Ownership

| 항목 | 값 |
|---|---|
| Owner | Agent 6 — Audit/Notification |
| Paths | `apps/api/modules/audit` |
| DB schema | `audit` |
| Migration | `apps/api/modules/audit/migrations` (version_table `audit.alembic_version`) |
| Infra | `mailpit` 서비스 (07 §3, compose 정의는 Agent 0) |

## 3. Dependencies

### Ports consumed
```python
class IdentityQueryPort(Protocol):  # M01
    def get_public_profiles(self, user_ids: list[UUID]) -> dict[UUID, IdentityPublicProfile]: ...
    def list_users_with_org_role(self, organization_id: UUID, role: str) -> list[UUID]: ...
    def has_org_role(self, user_id: UUID, organization_id: UUID, role: str) -> bool: ...
    def get_email(self, user_id: UUID) -> str | None: ...  # 알림 메일 전용 (M01 §8에 정의)


class ProjectQueryPort(Protocol):  # M02
    def list_project_ids_for_member(self, user_id: UUID) -> list[UUID]: ...
    def is_active_member(self, project_id: UUID, user_id: UUID) -> bool: ...


class CatalogQueryPort(Protocol):  # M03 §8 (정본). title, owner_organization_id 사용
    def get_policy_view(self, dataset_id: UUID) -> DatasetPolicyView | None: ...


class GrantQueryPort(Protocol):  # M04 §8 (정본)
    def list_active_grant_subjects(self, dataset_id: UUID) -> list[UUID]: ...
```

Port 호출은 **이벤트를 기록할 때 한 번** 하고, 결과를 audit `details`와 `resource_owner_organization_id`로 비정규화해 저장한다. 조회 시에는 audit 테이블만 읽는다 (예외: 가시성 판단용 `list_project_ids_for_member`, `has_org_role`).

### Events consumed
`contracts/events/index.json`의 26종 전부 (v1.1.1에서 `governance.access.review_started.v1` 추가). 매핑은 §7 참고.

## 4. Data Model (`audit.*`)

### `audit.audit_events` (append-only)
| column | type | null | default | constraint |
|---|---|---|---|---|
| audit_event_id | uuid | N | uuidv7 | PK |
| occurred_at | timestamptz | N | | = envelope `occurred_at` |
| recorded_at | timestamptz | N | now() | |
| action | varchar(48) | N | | CHECK in openapi `AuditAction` enum |
| result | varchar(8) | N | | CHECK in (`SUCCESS`,`DENIED`) |
| reason | text | Y | | 거절/회수/거부 사유 |
| actor_type | varchar(8) | N | | CHECK in (`USER`,`SYSTEM`) |
| actor_user_id | uuid | Y | | |
| actor_display_name | varchar(200) | Y | | 기록 시점 이름 |
| actor_organization_id | uuid | Y | | |
| resource_type | varchar(32) | N | | CHECK in openapi `ResourceType` enum |
| resource_id | uuid | N | | |
| resource_owner_organization_id | uuid | Y | | 가시성 판단용 |
| project_id | uuid | Y | | |
| policy_version | varchar(64) | Y | | governance 이벤트에서 복사 |
| source_event_id | uuid | N | | **UNIQUE** (멱등 키) |
| source_event_type | varchar(96) | N | | |
| trace_id | varchar(64) | N | | = envelope `correlation_id` |
| details | jsonb | N | `'{}'` | payload에서 선택 필드 (아래 규칙) |

Index:
- `ix_audit_occurred (occurred_at desc, audit_event_id desc)` — cursor pagination
- `ix_audit_actor (actor_user_id, occurred_at desc)`
- `ix_audit_actor_org (actor_organization_id, occurred_at desc)`
- `ix_audit_owner_org (resource_owner_organization_id, occurred_at desc)`
- `ix_audit_project (project_id, occurred_at desc)`
- `ix_audit_resource (resource_type, resource_id)`
- `ix_audit_action (action, occurred_at desc)`

`details` 규칙: payload를 그대로 복사하되 **자유 텍스트 중 `purpose_detail`은 제외**한다. 원본은 governance가 보관한다. 데이터 값은 저장하지 않는다.

### 불변성 보장
1. **DB 권한**: 앱 런타임 DB role(`nais_app`)에는 `audit.audit_events`에 대해 `INSERT, SELECT`만 GRANT한다. `UPDATE, DELETE, TRUNCATE`는 REVOKE한다. migration은 별도 owner role(`nais_migrator`)로 실행한다 (Agent 0 compose/Makefile에 반영 요청).
2. **Trigger**: `BEFORE UPDATE OR DELETE ON audit.audit_events FOR EACH ROW EXECUTE FUNCTION audit.forbid_mutation()` → `RAISE EXCEPTION 'audit_events is append-only'`. `TRUNCATE`도 statement trigger로 차단한다.
3. 애플리케이션 코드에 audit update/delete 경로를 두지 않는다 (코드 리뷰 체크리스트).

### `audit.notifications`
| column | type | null | default | constraint |
|---|---|---|---|---|
| notification_id | uuid | N | uuidv7 | PK |
| recipient_user_id | uuid | N | | |
| type | varchar(32) | N | | CHECK in openapi `NotificationType` |
| title | varchar(300) | N | | |
| body | text | N | `''` | |
| link | varchar(500) | N | | web route |
| source_event_id | uuid | N | | |
| read_at | timestamptz | Y | | |
| created_at | timestamptz | N | now() | |

Unique: `(source_event_id, recipient_user_id)` — 같은 이벤트로 같은 사람에게 중복 알림 금지.
Index: `ix_notifications_recipient (recipient_user_id, created_at desc)`, partial `ix_notifications_unread (recipient_user_id) WHERE read_at IS NULL`.

### `audit.email_deliveries`
| column | type | null | default | constraint |
|---|---|---|---|---|
| email_delivery_id | uuid | N | uuidv7 | PK |
| notification_id | uuid | N | | FK → `audit.notifications`, UNIQUE |
| to_address | varchar(320) | N | | |
| status | varchar(16) | N | `'PENDING'` | CHECK in (`PENDING`,`SENT`,`FAILED`) |
| attempts | int | N | 0 | |
| last_error | text | Y | | |
| sent_at | timestamptz | Y | | |
| created_at | timestamptz | N | now() | |

### `audit.processed_events`
| column | type | null | default | constraint |
|---|---|---|---|---|
| event_id | uuid | N | | PK part |
| handler | varchar(64) | N | | PK part (`audit_writer`, `notifier`) |
| processed_at | timestamptz | N | now() | |

## 5. State machine

### Email delivery
| from | to | 조건 |
|---|---|---|
| PENDING | SENT | SMTP 성공 |
| PENDING | PENDING | 실패, attempts < 5 (backoff 1m, 5m, 15m, 1h) |
| PENDING | FAILED | attempts = 5 |

Notification은 `read_at`만 null → 값으로 한 번 바뀐다 (unread → read). 되돌리기는 없다.

## 6. API

| operationId | 호출 가능 | 규칙 | Side effect | Error |
|---|---|---|---|---|
| `listAuditEvents` | 인증 사용자 (범위는 역할별) | 아래 가시성 규칙을 필터로 **강제 결합**한다. 요청 필터는 그 안에서만 좁힌다. 정렬 `occurred_at desc`. cursor는 `(occurred_at, audit_event_id)` opaque base64 | 없음 (조회 자체는 감사하지 않음, P0) | 401, 403 `FORBIDDEN`(일반 사용자가 멤버가 아닌 `project_id` 지정, 또는 소속 외 `organization_id` 지정), 422 |
| `listNotifications` | 인증 사용자 | 본인 것만. `unread_only`. 응답에 `unread_count` | 없음 | 401 |
| `markNotificationRead` | 수신자 본인 | 이미 읽었으면 그대로 200 | 없음 | 404 `NOTIFICATION_NOT_FOUND`(타인 것 포함) |
| `markAllNotificationsRead` | 인증 사용자 | 본인 unread 전부 | 없음 | 401 |

### Audit 가시성 규칙 (openapi `listAuditEvents` description)
| 호출자 | 볼 수 있는 행 |
|---|---|
| PLATFORM_ADMIN | 전부 |
| ORG_ADMIN, DATA_STEWARD | `actor_organization_id = 내 기관` OR `resource_owner_organization_id = 내 기관` (+ 아래 일반 사용자 범위) |
| 일반 사용자 | `actor_user_id = 나`. 추가로 `project_id` 파라미터를 지정했고 내가 그 프로젝트 ACTIVE 멤버이면 해당 `project_id` 행 전부 |

- 일반 사용자가 `project_id` 없이 조회하면 본인 행위만 받는다.
- `project_id`를 지정했는데 멤버가 아니면 403 `FORBIDDEN`이다.
- `DOWNLOAD_DENIED` 행은 PLATFORM_ADMIN과 소유기관 ORG_ADMIN/DATA_STEWARD, 본인에게만 보인다. 프로젝트 멤버 범위에서는 제외한다.

## 7. Events consumed → Audit / Notification

### 7.1 Audit 매핑

| event_type | AuditAction | result | resource_type / id | owner org 출처 | project_id |
|---|---|---|---|---|---|
| `identity.organization.created.v1` | ORGANIZATION_CREATED | SUCCESS | ORGANIZATION / organization_id | payload.organization_id | - |
| `identity.user.created.v1` | USER_CREATED | SUCCESS | USER / user_id | payload.organization_id | - |
| `identity.user.logged_in.v1` | **LOGIN** | SUCCESS | USER / user_id | payload.organization_id | - |
| `identity.membership.changed.v1` | **ADMIN_ROLE_CHANGED** | SUCCESS | MEMBERSHIP / user_id | payload.organization_id | - |
| `project.created.v1` | PROJECT_CREATED | SUCCESS | PROJECT / project_id | lead_organization_id | project_id |
| `project.archived.v1` | PROJECT_ARCHIVED | SUCCESS | PROJECT / project_id | - | project_id |
| `project.member.added.v1` | **PROJECT_MEMBER_ADDED** | SUCCESS | PROJECT_MEMBER / user_id | payload.organization_id | project_id |
| `project.member.removed.v1` | PROJECT_MEMBER_REMOVED | SUCCESS | PROJECT_MEMBER / user_id | payload.organization_id | project_id |
| `project.member.role_changed.v1` | PROJECT_MEMBER_ROLE_CHANGED | SUCCESS | PROJECT_MEMBER / user_id | - | project_id |
| `catalog.dataset.created.v1` | **DATASET_CREATED** | SUCCESS | DATASET / dataset_id | owner_organization_id | - |
| `catalog.dataset.access_level_changed.v1` | **POLICY_CHANGED** | SUCCESS | DATASET / dataset_id | owner_organization_id | - |
| `catalog.dataset.policy_changed.v1` | **POLICY_CHANGED** | SUCCESS | DATASET / dataset_id | owner_organization_id | - |
| `catalog.dataset.version_published.v1` | **DATASET_VERSION_PUBLISHED** | SUCCESS | DATASET_VERSION / dataset_version_id | owner_organization_id | - |
| `governance.access.requested.v1` | **ACCESS_REQUESTED** | SUCCESS | ACCESS_REQUEST / access_request_id | owner_organization_id | project_id |
| `governance.access.approved.v1` | **ACCESS_APPROVED** | SUCCESS | ACCESS_GRANT / access_grant_id | owner_organization_id | project_id |
| `governance.access.review_started.v1` | ACCESS_REVIEW_STARTED | SUCCESS | ACCESS_REQUEST / access_request_id | owner_organization_id | project_id |
| `governance.access.rejected.v1` | **ACCESS_REJECTED** | SUCCESS | ACCESS_REQUEST / access_request_id | owner_organization_id | project_id |
| `governance.access.changes_requested.v1` | ACCESS_CHANGES_REQUESTED | SUCCESS | ACCESS_REQUEST / access_request_id | owner_organization_id | project_id |
| `governance.access.withdrawn.v1` | ACCESS_WITHDRAWN | SUCCESS | ACCESS_REQUEST / access_request_id | owner_organization_id | project_id |
| `governance.access.revoked.v1` | **ACCESS_REVOKED** | SUCCESS | ACCESS_GRANT / access_grant_id | owner_organization_id | project_id |
| `governance.access.expiring_soon.v1` | (audit 기록 안 함 — 알림 전용) | - | - | - | - |
| `governance.access.expired.v1` | **ACCESS_EXPIRED** | SUCCESS | ACCESS_GRANT / access_grant_id | owner_organization_id | project_id |
| `governance.download.authorized.v1` | **FILE_DOWNLOADED** | SUCCESS | DATASET_VERSION / dataset_version_id | owner_organization_id | project_id |
| `governance.download.denied.v1` | DOWNLOAD_DENIED | **DENIED** | DATASET_VERSION / dataset_version_id | owner_organization_id (null 가능) | project_id |
| `readiness.validation.started.v1` | (audit 기록 안 함 — 운영 이벤트) | - | - | - | - |
| `readiness.validation.completed.v1` | READINESS_VALIDATION_COMPLETED | SUCCESS | READINESS_VALIDATION / validation_id | owner_organization_id | - |

굵게 표시한 12개가 `04_SECURITY_GOVERNANCE.md` §6 필수 Audit 항목이다: LOGIN, PROJECT_MEMBER_ADDED, DATASET_CREATED, DATASET_VERSION_PUBLISHED, ACCESS_REQUESTED/APPROVED/REJECTED/REVOKED/EXPIRED, FILE_DOWNLOADED, POLICY_CHANGED, ADMIN_ROLE_CHANGED.

공통 규칙:
- `actor_*`는 envelope `actor`에서 가져온다. `actor_display_name`은 IdentityQueryPort로 조회하고, SYSTEM이면 null이다.
- `reason`: rejected.reason, revoked.reason, changes_requested.comment, denied.error_code(+reasons는 details).
- `policy_version`: approved/download.authorized payload에서 복사한다.
- `trace_id` = envelope `correlation_id`. 원래 요청의 OpenTelemetry trace id와 같다 (Gate E).
- 감사 대상이 아닌 이벤트(expiring_soon, validation.started)도 `processed_events`에 `audit_writer`로 기록해 재처리를 막는다.

### 7.2 멱등성
- `audit_writer` handler: `INSERT ... ON CONFLICT (source_event_id) DO NOTHING` + `processed_events` insert를 같은 트랜잭션에서 처리한다.
- `notifier` handler: `processed_events(event_id,'notifier')` 선점 insert 후 notification insert (`(source_event_id, recipient_user_id)` unique). 실패하면 트랜잭션 전체를 롤백하고, relay가 재전달한다 (D-006 at-least-once).
- 두 handler는 독립적이다. 한쪽 실패가 다른 쪽을 막지 않는다.

### 7.3 Notification 규칙

| event_type | 수신자 | NotificationType | title 템플릿 | link |
|---|---|---|---|---|
| `project.member.added.v1` | payload.user_id (단, `added_by == user_id`면 없음) | PROJECT_INVITATION | `"{project_name}" 프로젝트에 참여자로 추가되었습니다` | `/commons/projects/{project_id}` |
| `governance.access.requested.v1` | owner_organization_id의 ACTIVE DATA_STEWARD 전원 | ACCESS_SUBMITTED | `"{dataset_title}" 데이터 접근 요청이 도착했습니다` (재제출이면 `다시 제출되었습니다`) | `/commons/access/{access_request_id}` |
| `governance.access.approved.v1` | subject_user_id | ACCESS_APPROVED | `"{dataset_title}" 접근이 승인되었습니다 (만료 {expires_at:YYYY-MM-DD})` | `/commons/access/{access_request_id}` |
| `governance.access.rejected.v1` | requester_user_id | ACCESS_REJECTED | `"{dataset_title}" 접근 요청이 거절되었습니다` | `/commons/access/{access_request_id}` |
| `governance.access.changes_requested.v1` | requester_user_id | ACCESS_CHANGES_REQUESTED | `"{dataset_title}" 접근 요청에 수정이 요청되었습니다` | `/commons/access/{access_request_id}` |
| `governance.access.expiring_soon.v1` | subject_user_id | ACCESS_EXPIRING | `"{dataset_title}" 접근 권한이 {expires_at:YYYY-MM-DD HH:mm} UTC에 만료됩니다` | `/commons/access?tab=grants` |
| `governance.access.revoked.v1` | subject_user_id | ACCESS_REVOKED | `"{dataset_title}" 접근 권한이 회수되었습니다` | `/commons/access?tab=grants` |
| `catalog.dataset.version_published.v1` | 해당 dataset의 ACTIVE grant 보유자 전원 (`GrantQueryPort.list_active_grant_subjects`) | DATASET_PUBLISHED | `"{dataset_title}" 새 버전 {version_label}이(가) 게시되었습니다` | `/commons/data/{dataset_id}` |

- `dataset_title`은 CatalogQueryPort로 조회한다. 조회에 실패하면 `"데이터셋"`으로 대체한다.
- body에는 사유(reason/comment)를 포함할 수 있다. 데이터 값은 절대 넣지 않는다.
- 수신자가 `is_active_user=false`이면 생성하지 않는다.
- 모든 notification은 in-app 생성과 동시에 `email_deliveries` PENDING 행을 만든다 (P0 전 유형 메일 발송).

### Events produced
해당 없음. M09는 이벤트를 발행하지 않는다.

## 8. Public Service Interface

해당 없음. 다른 모듈은 audit에 쓰지 않고 이벤트만 발행한다. 조회는 REST API로만 한다.

테스트 지원용 read helper(`AuditTestReader.find_by_source_event(event_id)`)는 `tests/` 전용으로 제공한다.

## 9. Authorization matrix

| Action | 일반 사용자 | DATA_STEWARD | ORG_ADMIN | PLATFORM_ADMIN |
|---|---|---|---|---|
| 본인 행위 audit 조회 | O | O | O | O |
| 소속 프로젝트 audit 조회 (`project_id`) | O (ACTIVE 멤버) | O | O | O |
| 자기 기관 관련 audit 조회 | X | O | O | O |
| 전체 audit 조회 | X | X | X | O |
| 본인 notification 조회·읽음 처리 | O | O | O | O |
| 타인 notification | X | X | X | X |
| audit 수정·삭제 | X | X | X | X (DB 차단) |

## 10. Background jobs

| Job | 실행 | 내용 |
|---|---|---|
| `audit.send_emails` | Dramatiq actor, notification 생성 직후 enqueue + 5분 주기 재시도 스캔 | PENDING 메일을 SMTP(`SMTP_HOST:SMTP_PORT`)로 발송. From `NAIS AI-OS <no-reply@nais.local>`. 본문은 title + body + `{NAIS_PUBLIC_BASE_URL}{link}` |
| `audit.purge_notifications` | 1일 | `created_at < now() - NOTIFICATION_RETENTION_DAYS`인 **읽은** 알림과 연결 email 행 삭제 |
| (없음) | | audit_events는 삭제 job이 없다. 보존 **≥ 5년**, P0는 무기한 보존. 아카이빙(파티션 분리·콜드 스토리지)은 운영 단계 ADR로 결정 |

## 11. Config / env vars

| 변수 | 기본값 | 용도 |
|---|---|---|
| `SMTP_HOST` | `mailpit` | |
| `SMTP_PORT` | `1025` | |
| `SMTP_FROM` | `NAIS AI-OS <no-reply@nais.local>` | |
| `NOTIFICATION_EMAIL_ENABLED` | `true` | false면 in-app만 |
| `NOTIFICATION_RETENTION_DAYS` | `180` | 읽은 알림 보존 |
| `NAIS_PUBLIC_BASE_URL` | `http://localhost:21051` | 메일 링크 |

Mailpit UI는 `127.0.0.1:21052` (dev only, 07 §2).

## 12. Acceptance tests

| ID | Given | When | Then |
|---|---|---|---|
| M09-AT-01 | 12개 필수 액션을 발생시키는 golden E2E 실행 | 완료 후 `GET /audit-events` (PLATFORM_ADMIN) | 12개 AuditAction 모두 1건 이상, 각 행에 trace_id·actor·resource 존재 |
| M09-AT-02 | 같은 이벤트를 relay가 2번 전달 | handler 실행 | audit 행 1건, notification 1건 |
| M09-AT-03 | audit 행 존재 | 앱 DB role로 `UPDATE`/`DELETE`/`TRUNCATE` | 모두 실패 (권한 오류 또는 trigger 예외) |
| M09-AT-04 | a.researcher | `GET /audit-events` (필터 없음) | 본인 actor 행만 |
| M09-AT-05 | b.researcher, a.researcher 프로젝트 멤버 | `GET /audit-events?project_id={p}` | 해당 프로젝트 행 전부 (DOWNLOAD_DENIED 제외) |
| M09-AT-06 | a.researcher, 비멤버 프로젝트 | `GET /audit-events?project_id={other}` | 403 `FORBIDDEN` |
| M09-AT-07 | b.steward | `GET /audit-events?action=FILE_DOWNLOADED` | inst-b 소유 데이터셋 다운로드 행 포함 (actor는 inst-a) |
| M09-AT-08 | a.steward | 같은 조회 | inst-b 데이터 다운로드 행 미포함 |
| M09-AT-09 | a.researcher가 b.researcher 추가 | 이벤트 처리 후 | b.researcher 알림 PROJECT_INVITATION, Mailpit에 메일 1통 |
| M09-AT-10 | access 요청 제출 | 처리 후 | b.steward 알림 ACCESS_SUBMITTED, a.researcher에는 없음 |
| M09-AT-11 | grant 만료 72h 전 | expiring_soon 이벤트 | subject에게 ACCESS_EXPIRING 1건, audit 행 없음 |
| M09-AT-12 | 다운로드 거부 | `governance.download.denied.v1` | result=DENIED, action=DOWNLOAD_DENIED, reason=error_code |
| M09-AT-13 | b.researcher | a.researcher의 notification_id로 read 처리 | 404 `NOTIFICATION_NOT_FOUND` |
| M09-AT-14 | SMTP 다운 | 알림 생성 | in-app은 정상, email PENDING → 복구 후 SENT |
| M09-AT-15 | trace 추적 | 승인 요청의 응답 `X-Request-Id`/trace id | 해당 ACCESS_APPROVED audit 행 `trace_id`와 일치 (Gate E) |
| M09-AT-16 | audit `details` 검사 | access.requested 처리 후 | `purpose_detail` 미포함 |

## 13. Deliverables & Known limitations

### Deliverables
- README, router, event handler 등록(`audit_writer`, `notifier`)
- Alembic migration (append-only trigger 포함), DB role GRANT 스크립트(Agent 0와 협의)
- 메일 템플릿(ko)
- Unit/contract tests, 12개 필수 액션 커버리지 테스트
- Integration notes: 새 이벤트를 추가하는 모듈은 §7.1 매핑 추가를 Agent 6에게 요청한다. 매핑이 없는 이벤트는 `processed_events`만 기록하고 경고 로그를 남긴다.

### Known limitations
- FILE_DOWNLOADED는 URL 발급 시점 기준이다. 실제 다운로드 완료 여부는 모른다 (D-017).
- 비정규화된 이름·owner org는 기록 시점 값이다.
- 조회 행위 자체(audit 열람)는 P0에서 감사하지 않는다.
- 알림은 한국어 단일 로케일이다.
