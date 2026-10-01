# Cross-Module Contracts

> **v1.1:** 이 문서는 개요다. 기계가 읽는 최종 계약은 `contracts/`에 있다.
> - API: `contracts/openapi.yaml` (OpenAPI 3.1, v1.2.0: 41 paths / 49 operations)
> - Events: `contracts/events/p0_events.schema.json` (envelope + payload), 목록 `contracts/events/index.json`
> - Errors: `contracts/error_codes.json`
> 둘이 다르면 `contracts/`가 우선한다.

## 1. Canonical IDs
```text
UserId
OrganizationId
ProjectId
DatasetId
DatasetVersionId
AccessRequestId
AccessGrantId
ResourceId
AuditEventId
```

모두 opaque UUID.

---

## 2. Shared Event Envelope

```json
{
  "event_id": "uuid",
  "event_type": "catalog.dataset.version_published.v1",
  "occurred_at": "2026-09-30T12:00:00Z",
  "producer": "catalog",
  "correlation_id": "uuid",
  "actor": {
    "user_id": "uuid",
    "organization_id": "uuid"
  },
  "payload": {}
}
```

---

## 3. Required P0 Events

Identity:
```text
identity.user.created.v1
identity.organization.created.v1
```

Project:
```text
project.created.v1
project.member.added.v1
project.member.removed.v1
```

Catalog:
```text
catalog.dataset.created.v1
catalog.dataset.version_published.v1
catalog.dataset.access_level_changed.v1
```

Governance:
```text
governance.access.requested.v1
governance.access.approved.v1
governance.access.rejected.v1
governance.access.revoked.v1
governance.access.expired.v1
```

Readiness:
```text
readiness.validation.started.v1
readiness.validation.completed.v1
```

Audit:
Audit는 이벤트를 consume하여 immutable event record 생성.

---

## 4. Required Read Models

### IdentityPublicProfile
```json
{
  "user_id": "uuid",
  "display_name": "string",
  "organization_id": "uuid",
  "status": "ACTIVE"
}
```

### OrganizationSummary
```json
{
  "organization_id": "uuid",
  "name": "string",
  "type": "RESEARCH_INSTITUTE"
}
```

### ProjectSummary
```json
{
  "project_id": "uuid",
  "name": "string",
  "status": "ACTIVE",
  "lead_organization_id": "uuid"
}
```

### DatasetPolicyView
```json
{
  "dataset_id": "uuid",
  "owner_organization_id": "uuid",
  "access_level": "CONTROLLED",
  "allowed_purposes": ["ACADEMIC_RESEARCH", "AI_TRAINING"],
  "approval_required": true,
  "max_grant_days": 180
}
```

---

## 5. P0 API Surface

### Identity
```text
GET  /api/v1/me
GET  /api/v1/organizations
GET  /api/v1/organizations/{id}
```

### Projects
```text
POST /api/v1/projects
GET  /api/v1/projects
GET  /api/v1/projects/{id}
POST /api/v1/projects/{id}/members
DELETE /api/v1/projects/{id}/members/{user_id}
```

### Catalog
```text
POST /api/v1/datasets
GET  /api/v1/datasets
GET  /api/v1/datasets/{id}
POST /api/v1/datasets/{id}/versions
POST /api/v1/dataset-versions/{id}/upload-session
POST /api/v1/dataset-versions/{id}/publish
```

### Governance
```text
POST /api/v1/access-requests
GET  /api/v1/access-requests
GET  /api/v1/access-requests/{id}
POST /api/v1/access-requests/{id}/approve
POST /api/v1/access-requests/{id}/reject
POST /api/v1/access-requests/{id}/request-changes
POST /api/v1/access-grants/{id}/revoke
POST /api/v1/dataset-versions/{id}/download-session
```

### Readiness
```text
POST /api/v1/dataset-versions/{id}/readiness-validations
GET  /api/v1/dataset-versions/{id}/readiness
```

### Audit
```text
GET /api/v1/audit-events
```

---

## 6. v1.1 추가분 (11_DECISION_LOG D-014~D-017, D-020)

### 추가 Events
```text
identity.user.logged_in.v1              # Audit LOGIN
identity.membership.changed.v1          # Audit ADMIN_ROLE_CHANGED, DISABLED 시 grant 회수
project.archived.v1                     # grant 일괄 회수
project.member.role_changed.v1
catalog.dataset.policy_changed.v1       # Audit POLICY_CHANGED
governance.access.review_started.v1     # D-025
governance.access.changes_requested.v1
governance.access.withdrawn.v1
governance.access.expiring_soon.v1      # 만료 72h 전 알림
governance.download.authorized.v1       # Audit FILE_DOWNLOADED
governance.download.denied.v1           # Audit DOWNLOAD_DENIED
```

모든 governance 이벤트 payload에 `owner_organization_id`가 포함된다 (D-030).

Envelope의 `actor`에 `type: USER | SYSTEM`을 추가했다. sweeper 등 시스템 행위는 `type=SYSTEM`, `user_id=null`.

### 추가 API
```text
GET    /api/v1/health/live
GET    /api/v1/health/ready
GET    /api/v1/users
GET    /api/v1/organizations/{id}/members
PATCH  /api/v1/organizations/{id}/members/{user_id}
PATCH  /api/v1/projects/{id}
POST   /api/v1/projects/{id}/archive
GET    /api/v1/projects/{id}/members
PATCH  /api/v1/projects/{id}/members/{user_id}
PATCH  /api/v1/datasets/{id}
GET    /api/v1/datasets/{id}/policy             # DatasetPolicyView read model
GET    /api/v1/datasets/{id}/versions
GET    /api/v1/dataset-versions/{id}
GET    /api/v1/upload-sessions/{id}
POST   /api/v1/upload-sessions/{id}/complete
DELETE /api/v1/dataset-versions/{id}/files/{file_id}   # DRAFT only
POST   /api/v1/access-requests/{id}/start-review      # D-025
POST   /api/v1/access-requests/{id}/resubmit
POST   /api/v1/access-requests/{id}/withdraw
GET    /api/v1/access-grants
GET    /api/v1/readiness-profiles
GET    /api/v1/notifications
POST   /api/v1/notifications/{id}/read
POST   /api/v1/notifications/read-all
```

### Enum 확정
| 이름 | 값 |
|---|---|
| Purpose | ACADEMIC_RESEARCH, AI_TRAINING, COMMERCIAL_RESEARCH, EDUCATION, PUBLIC_INTEREST |
| Operation | READ, COMPUTE(P2), WRITE(예약) — P0 grant 가능: READ |
| AccessRequestStatus | DRAFT(예약), SUBMITTED, UNDER_REVIEW, CHANGE_REQUESTED, APPROVED, REJECTED, WITHDRAWN |
| AccessGrantStatus | ACTIVE, EXPIRED, REVOKED |
| DatasetVersionStatus | DRAFT, PUBLISHED, WITHDRAWN |
| ProjectVisibility | PRIVATE, PUBLIC |
| OrganizationType | RESEARCH_INSTITUTE, UNIVERSITY, COMPANY, PLATFORM_OPERATOR |
