# Security & Governance Specification

## 1. Authorization Decision
데이터 접근은 RBAC만으로 판단하지 않는다.

```text
Subject
+ Organization
+ Project
+ Resource
+ Purpose
+ Operation
+ Time
+ Classification
```

를 OPA에 전달한다.

---

## 2. Roles

Platform:
```text
PLATFORM_ADMIN
```

Organization:
```text
ORG_ADMIN
DATA_STEWARD
RESOURCE_MANAGER
```

Project:
```text
PROJECT_OWNER
PROJECT_ADMIN
RESEARCHER
VIEWER
```

---

## 3. Dataset Classification
```text
PUBLIC
INTERNAL
CONTROLLED
SENSITIVE
```

P0 demo에서는 실제 민감 개인정보 데이터 금지.

---

## 4. Grant
```text
subject
project_id
resource_id
purpose
operations[]
valid_from
expires_at
granted_by
policy_version
```

영구 Grant 금지. 명시적 expiration 필요.

---

## 5. File Security
- Presigned URL TTL 짧게
- MIME 검증
- size limit
- malware scan extension point
- archive bomb 방어
- checksum
- bucket private

---

## 6. Audit Required Actions
```text
LOGIN
PROJECT_MEMBER_ADDED
DATASET_CREATED
DATASET_VERSION_PUBLISHED
ACCESS_REQUESTED
ACCESS_APPROVED
ACCESS_REJECTED
ACCESS_REVOKED
ACCESS_EXPIRED
FILE_DOWNLOADED
POLICY_CHANGED
ADMIN_ROLE_CHANGED
```

v1.1 추가 action (contracts `AuditAction`): `USER_CREATED`, `ORGANIZATION_CREATED`, `PROJECT_CREATED`, `PROJECT_ARCHIVED`, `PROJECT_MEMBER_REMOVED`, `PROJECT_MEMBER_ROLE_CHANGED`, `ACCESS_CHANGES_REQUESTED`, `ACCESS_WITHDRAWN`, `DOWNLOAD_DENIED`, `READINESS_VALIDATION_COMPLETED`.
이벤트 → action 매핑은 `modules/M09_audit_notification.md`.

---

## 7. Security Tests
- 다른 기관 사용자가 private project 조회 불가
- grant 없는 다운로드 URL 발급 불가
- 만료 grant로 다운로드 불가
- revoke 즉시 차단
- operation READ만 가진 사용자의 WRITE 불가
- 다른 project의 grant 재사용 불가
- URL tampering 불가
- OPA unavailable 시 fail-closed

## 8. v1.1 보안 결정 요약
- 접근 등급별 규칙: D-011 / 메타데이터 공개 범위: D-012 (`11_DECISION_LOG.md`)
- 만료 enforcement는 검사 시점 비교 (D-010). sweeper 지연과 무관하게 차단.
- 이미 발급된 presigned URL은 revoke 후에도 최대 TTL(300s) 동안 유효하다. 이것이 P0의 "즉시 차단" 정의다: **revoke 이후 새 download session은 즉시 실패**.
- OPA 정책 상세: `08_OPA_POLICY.md`
- 프로젝트 탈퇴/아카이브, 기관 멤버십 비활성화 시 관련 grant 자동 회수.
