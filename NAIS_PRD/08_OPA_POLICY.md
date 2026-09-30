# OPA Policy — `nais.data_access`

> Owner: **Agent 4 — Governance** (`infra/opa`, D-003) · Release: P0
> 관련: `modules/M04_access_governance.md` §6.12, `11_DECISION_LOG.md` D-009/D-010/D-011/D-022

## 1. 역할: Defense-in-depth 2차 판정

데이터 파일 접근은 두 번 판정한다.

```text
download-session 요청
   │
   ├─ 1차: Governance precheck (Python, DB 기반)   → 구체적 error code 결정 (M04 §6.12 step 1~7)
   │
   ├─ 2차: OPA decision (Rego, 입력만으로 판정)     → allow / reasons / policy_version
   │        · precheck와 같은 규칙(D-011)을 독립 구현
   │        · 둘 중 하나라도 deny면 deny
   │        · OPA 오류/timeout = deny (D-022)
   │
   └─ presigned URL 발급
```

- OPA는 DB에 접근하지 않는다. Governance가 판정에 필요한 사실(subject, resource, grant, project membership, 현재 시각)을 **input으로 모두 전달**한다.
- precheck 통과 후 OPA가 거부하면 규칙 구현이 어긋난 것이므로 `ACCESS_DENIED_BY_POLICY` + divergence metric(M04 §6.12 step 8a).
- 판정 시각은 OPA 내부 시계(`time.now_ns()`)가 아니라 **input의 `context.now`**를 쓴다. 테스트 결정성 확보와 Governance·OPA 간 시계 차이 제거를 위해서다.

## 2. API

```http
POST http://opa:8181/v1/data/nais/data_access/decision
Content-Type: application/json

{ "input": { ...DataAccessInput... } }
```

응답:
```json
{
  "result": {
    "allow": true,
    "basis": "GRANT",
    "reasons": [],
    "policy_version": "data_access@1.0.0"
  }
}
```

- `result`가 없거나(정책 미로딩) 스키마가 다르면 Governance는 **deny + `POLICY_ENGINE_UNAVAILABLE`**로 처리한다.
- `basis`는 계약 필수 출력 `{allow, reasons[], policy_version}`에 더한 확장 필드다. Governance는 precheck basis와 비교한다.
- 정책 버전 조회: `GET /v1/data/nais/data_access/policy_version` → `{"result": "data_access@1.0.0"}` (grant 생성 시 기록, M04 §11)

## 3. Input Schema (`DataAccessInput`)

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "DataAccessInput",
  "type": "object",
  "additionalProperties": false,
  "required": ["subject", "action", "resource", "context"],
  "properties": {
    "subject": {
      "type": "object",
      "additionalProperties": false,
      "required": ["user_id", "organization_id", "org_roles", "platform_roles", "user_status", "membership_status"],
      "properties": {
        "user_id": { "type": "string", "format": "uuid" },
        "organization_id": { "type": "string", "format": "uuid" },
        "org_roles": { "type": "array", "items": { "enum": ["ORG_ADMIN", "DATA_STEWARD", "RESOURCE_MANAGER"] } },
        "platform_roles": { "type": "array", "items": { "enum": ["PLATFORM_ADMIN"] } },
        "user_status": { "enum": ["ACTIVE", "DISABLED"] },
        "membership_status": { "enum": ["ACTIVE", "DISABLED"] }
      }
    },
    "action": { "enum": ["dataset.download", "dataset.compute", "dataset.write"], "description": "P0 지원: dataset.download만" },
    "resource": {
      "type": "object",
      "additionalProperties": false,
      "required": ["type", "dataset_id", "dataset_version_id", "owner_organization_id", "access_level", "dataset_status", "version_status"],
      "properties": {
        "type": { "const": "DATASET_VERSION" },
        "dataset_id": { "type": "string", "format": "uuid" },
        "dataset_version_id": { "type": "string", "format": "uuid" },
        "owner_organization_id": { "type": "string", "format": "uuid" },
        "access_level": { "enum": ["PUBLIC", "INTERNAL", "CONTROLLED", "SENSITIVE"] },
        "dataset_status": { "enum": ["ACTIVE", "WITHDRAWN"] },
        "version_status": { "enum": ["DRAFT", "PUBLISHED", "WITHDRAWN"] }
      }
    },
    "context": {
      "type": "object",
      "additionalProperties": false,
      "required": ["now", "project", "grant"],
      "properties": {
        "now": { "type": "string", "format": "date-time", "description": "Governance의 platform.clock.now(), RFC3339 UTC" },
        "project": {
          "description": "요청에 project_id가 있으면 객체, 없으면 null",
          "oneOf": [
            { "type": "null" },
            {
              "type": "object",
              "additionalProperties": false,
              "required": ["project_id", "status", "subject_is_active_member"],
              "properties": {
                "project_id": { "type": "string", "format": "uuid" },
                "status": { "enum": ["ACTIVE", "ARCHIVED"] },
                "subject_is_active_member": { "type": "boolean" }
              }
            }
          ]
        },
        "grant": {
          "description": "precheck가 찾은 (subject, project, dataset)의 최신 grant. 없으면 null",
          "oneOf": [
            { "type": "null" },
            {
              "type": "object",
              "additionalProperties": false,
              "required": ["access_grant_id", "subject_user_id", "project_id", "dataset_id", "operations", "valid_from", "expires_at", "status"],
              "properties": {
                "access_grant_id": { "type": "string", "format": "uuid" },
                "subject_user_id": { "type": "string", "format": "uuid" },
                "project_id": { "type": "string", "format": "uuid" },
                "dataset_id": { "type": "string", "format": "uuid" },
                "operations": { "type": "array", "items": { "enum": ["READ", "COMPUTE", "WRITE"] } },
                "valid_from": { "type": "string", "format": "date-time" },
                "expires_at": { "type": "string", "format": "date-time" },
                "status": { "enum": ["ACTIVE", "EXPIRED", "REVOKED"] }
              }
            }
          ]
        }
      }
    }
  }
}
```

Governance는 이 스키마를 `apps/api/modules/governance/adapters/opa_input.schema.json`으로 두고, 전송 전 validate한다(개발 모드 assert, 운영 모드 로그).

## 4. Reason Codes

거부 시 `reasons`는 아래 코드의 **정렬된 배열**이다. 허용 시 `[]`.

| Code | 의미 |
|---|---|
| `SUBJECT_INACTIVE` | user 또는 기관 멤버십이 ACTIVE 아님 |
| `UNSUPPORTED_ACTION` | P0에서 지원하지 않는 action (`dataset.compute`, `dataset.write`) |
| `DATASET_NOT_ACTIVE` | dataset WITHDRAWN |
| `VERSION_NOT_PUBLISHED` | version이 PUBLISHED 아님 |
| `INTERNAL_OTHER_ORGANIZATION` | INTERNAL 데이터에 타기관 접근 |
| `PROJECT_REQUIRED` | grant 필요 판정인데 project 없음 |
| `PROJECT_NOT_ACTIVE` | project ARCHIVED |
| `NOT_PROJECT_MEMBER` | subject가 project ACTIVE 멤버 아님 |
| `GRANT_MISSING` | grant 필요 판정인데 grant 없음 |
| `GRANT_REVOKED` | grant status REVOKED |
| `GRANT_EXPIRED` | status EXPIRED 또는 `now >= expires_at` (D-010) |
| `GRANT_NOT_YET_VALID` | `now < valid_from` |
| `GRANT_SUBJECT_MISMATCH` | grant subject ≠ subject.user_id |
| `GRANT_PROJECT_MISMATCH` | grant project ≠ context.project (cross-project 재사용 차단) |
| `GRANT_DATASET_MISMATCH` | grant dataset ≠ resource.dataset_id |
| `GRANT_OPERATION_MISSING` | action이 요구하는 operation이 grant에 없음 |
| `SENSITIVE_GRANT_TOO_LONG` | SENSITIVE인데 grant 기간 > 30일 |

## 5. Rego (`infra/opa/policies/data_access/policy.rego`)

```rego
# METADATA
# title: NAIS data access decision
# description: Defense-in-depth second check for dataset file access (D-011).
package nais.data_access

import rego.v1

policy_version := "data_access@1.0.0"

# 30일 (D-011)
sensitive_max_grant_ns := 2592000000000000

# action -> 요구 operation. P0 지원 action은 dataset.download 하나.
required_operation := {"dataset.download": "READ"}

supported_actions := {a | some a, _ in required_operation}

privileged_owner_roles := {"DATA_STEWARD", "ORG_ADMIN"}

grant_levels := {"CONTROLLED", "SENSITIVE"}

now_ns := time.parse_rfc3339_ns(input.context.now)

subject := input.subject

resource := input.resource

project := input.context.project

grant := input.context.grant

# ---------------------------------------------------------------- facts

subject_active if {
	subject.user_status == "ACTIVE"
	subject.membership_status == "ACTIVE"
}

same_org if subject.organization_id == resource.owner_organization_id

owner_privileged if {
	same_org
	some r in subject.org_roles
	r in privileged_owner_roles
}

base_ok if {
	subject_active
	input.action in supported_actions
	resource.dataset_status == "ACTIVE"
	resource.version_status == "PUBLISHED"
}

needs_grant if {
	resource.access_level in grant_levels
	not owner_privileged
}

project_ok if {
	project != null
	project.status == "ACTIVE"
	project.subject_is_active_member == true
}

grant_ok if {
	grant != null
	grant.status == "ACTIVE"
	grant.subject_user_id == subject.user_id
	grant.project_id == project.project_id
	grant.dataset_id == resource.dataset_id
	required_operation[input.action] in grant.operations
	time.parse_rfc3339_ns(grant.valid_from) <= now_ns
	now_ns < time.parse_rfc3339_ns(grant.expires_at)
	sensitive_duration_ok
}

sensitive_duration_ok if resource.access_level != "SENSITIVE"

sensitive_duration_ok if {
	resource.access_level == "SENSITIVE"
	time.parse_rfc3339_ns(grant.expires_at) - time.parse_rfc3339_ns(grant.valid_from) <= sensitive_max_grant_ns
}

# ---------------------------------------------------------------- basis (우선순위 순)

basis := "PUBLIC" if {
	base_ok
	resource.access_level == "PUBLIC"
} else := "OWNER_ORGANIZATION" if {
	base_ok
	owner_privileged
} else := "OWNER_ORGANIZATION" if {
	base_ok
	resource.access_level == "INTERNAL"
	same_org
} else := "GRANT" if {
	base_ok
	needs_grant
	project_ok
	grant_ok
} else := null

default allow := false

allow if basis != null

# ---------------------------------------------------------------- reasons (거부 설명)

deny_reasons contains "SUBJECT_INACTIVE" if not subject_active

deny_reasons contains "UNSUPPORTED_ACTION" if not input.action in supported_actions

deny_reasons contains "DATASET_NOT_ACTIVE" if resource.dataset_status != "ACTIVE"

deny_reasons contains "VERSION_NOT_PUBLISHED" if resource.version_status != "PUBLISHED"

deny_reasons contains "INTERNAL_OTHER_ORGANIZATION" if {
	resource.access_level == "INTERNAL"
	not same_org
}

deny_reasons contains "PROJECT_REQUIRED" if {
	needs_grant
	project == null
}

deny_reasons contains "PROJECT_NOT_ACTIVE" if {
	needs_grant
	project != null
	project.status != "ACTIVE"
}

deny_reasons contains "NOT_PROJECT_MEMBER" if {
	needs_grant
	project != null
	project.subject_is_active_member != true
}

deny_reasons contains "GRANT_MISSING" if {
	needs_grant
	grant == null
}

deny_reasons contains "GRANT_REVOKED" if {
	needs_grant
	grant != null
	grant.status == "REVOKED"
}

deny_reasons contains "GRANT_EXPIRED" if {
	needs_grant
	grant != null
	grant.status == "EXPIRED"
}

deny_reasons contains "GRANT_EXPIRED" if {
	needs_grant
	grant != null
	now_ns >= time.parse_rfc3339_ns(grant.expires_at)
}

deny_reasons contains "GRANT_NOT_YET_VALID" if {
	needs_grant
	grant != null
	now_ns < time.parse_rfc3339_ns(grant.valid_from)
}

deny_reasons contains "GRANT_SUBJECT_MISMATCH" if {
	needs_grant
	grant != null
	grant.subject_user_id != subject.user_id
}

deny_reasons contains "GRANT_PROJECT_MISMATCH" if {
	needs_grant
	grant != null
	project != null
	grant.project_id != project.project_id
}

deny_reasons contains "GRANT_DATASET_MISMATCH" if {
	needs_grant
	grant != null
	grant.dataset_id != resource.dataset_id
}

deny_reasons contains "GRANT_OPERATION_MISSING" if {
	needs_grant
	grant != null
	input.action in supported_actions
	not required_operation[input.action] in grant.operations
}

deny_reasons contains "SENSITIVE_GRANT_TOO_LONG" if {
	needs_grant
	grant != null
	not sensitive_duration_ok
}

reasons := [] if allow

else := sort([r | some r in deny_reasons])

# ---------------------------------------------------------------- output

decision := {
	"allow": allow,
	"basis": basis,
	"reasons": reasons,
	"policy_version": policy_version,
}
```

구현 메모
- `else` 체인이 basis 우선순위를 고정한다: PUBLIC → 소유기관 특권 → INTERNAL 소유기관 → GRANT.
- 모든 grant 조건은 `grant_ok` 한 규칙에 AND로 묶는다. `deny_reasons`는 설명용일 뿐이며 **허용 여부는 `basis`만으로 결정**된다. reasons 규칙에 빈틈이 있어도 권한이 새지 않는다.
- 정의되지 않은 input 필드는 규칙을 undefined로 만들어 거부 쪽으로 떨어진다(fail-closed).

## 6. Policy Tests (`infra/opa/policies/data_access/policy_test.rego`)

```rego
package nais.data_access_test

import rego.v1

import data.nais.data_access

org_a := "00000000-0000-7000-8000-00000000000a"

org_b := "00000000-0000-7000-8000-00000000000b"

user_a := "00000000-0000-7000-8000-000000000a02"

project_1 := "00000000-0000-7000-8000-000000001001"

project_2 := "00000000-0000-7000-8000-000000001002"

dataset_1 := "00000000-0000-7000-8000-000000002001"

valid_grant := {
	"access_grant_id": "00000000-0000-7000-8000-000000004001",
	"subject_user_id": user_a,
	"project_id": project_1,
	"dataset_id": dataset_1,
	"operations": ["READ"],
	"valid_from": "2026-09-01T00:00:00Z",
	"expires_at": "2026-10-01T00:00:00Z",
	"status": "ACTIVE",
}

# a.researcher가 inst-b CONTROLLED dataset을 project_1 grant로 다운로드
base := {
	"subject": {
		"user_id": user_a,
		"organization_id": org_a,
		"org_roles": [],
		"platform_roles": [],
		"user_status": "ACTIVE",
		"membership_status": "ACTIVE",
	},
	"action": "dataset.download",
	"resource": {
		"type": "DATASET_VERSION",
		"dataset_id": dataset_1,
		"dataset_version_id": "00000000-0000-7000-8000-000000002101",
		"owner_organization_id": org_b,
		"access_level": "CONTROLLED",
		"dataset_status": "ACTIVE",
		"version_status": "PUBLISHED",
	},
	"context": {
		"now": "2026-09-30T12:00:00Z",
		"project": {"project_id": project_1, "status": "ACTIVE", "subject_is_active_member": true},
		"grant": valid_grant,
	},
}

decide(patch) := d if {
	d := data_access.decision with input as object.union(base, patch)
}

denied_with(patch, reason) if {
	d := decide(patch)
	d.allow == false
	reason in d.reasons
}

# ---- 허용

test_controlled_with_valid_grant_allowed if {
	d := decide({})
	d.allow
	d.basis == "GRANT"
	d.reasons == []
	d.policy_version == "data_access@1.0.0"
}

test_public_allowed_without_grant if {
	d := decide({"resource": {"access_level": "PUBLIC"}, "context": {"project": null, "grant": null}})
	d.allow
	d.basis == "PUBLIC"
}

test_owner_steward_allowed_without_grant if {
	d := decide({
		"subject": {"organization_id": org_b, "org_roles": ["DATA_STEWARD"]},
		"context": {"project": null, "grant": null},
	})
	d.allow
	d.basis == "OWNER_ORGANIZATION"
}

test_internal_same_org_member_allowed if {
	d := decide({
		"subject": {"organization_id": org_b},
		"resource": {"access_level": "INTERNAL"},
		"context": {"project": null, "grant": null},
	})
	d.basis == "OWNER_ORGANIZATION"
}

# ---- 거부: 주체/리소스

test_disabled_membership_denied if {
	denied_with({"subject": {"membership_status": "DISABLED"}}, "SUBJECT_INACTIVE")
}

test_write_action_denied if {
	denied_with({"action": "dataset.write"}, "UNSUPPORTED_ACTION")
}

test_compute_action_denied_in_p0 if {
	denied_with({"action": "dataset.compute"}, "UNSUPPORTED_ACTION")
}

test_draft_version_denied if {
	denied_with({"resource": {"version_status": "DRAFT"}}, "VERSION_NOT_PUBLISHED")
}

test_withdrawn_dataset_denied_even_public if {
	denied_with({"resource": {"access_level": "PUBLIC", "dataset_status": "WITHDRAWN"}}, "DATASET_NOT_ACTIVE")
}

test_internal_other_org_denied_even_with_grant if {
	denied_with({"resource": {"access_level": "INTERNAL"}}, "INTERNAL_OTHER_ORGANIZATION")
}

test_owner_org_plain_member_needs_grant_for_controlled if {
	denied_with(
		{"subject": {"organization_id": org_b}, "context": {"grant": null}},
		"GRANT_MISSING",
	)
}

# ---- 거부: project

test_missing_project_denied if {
	denied_with({"context": {"project": null}}, "PROJECT_REQUIRED")
}

test_archived_project_denied if {
	denied_with({"context": {"project": {"status": "ARCHIVED"}}}, "PROJECT_NOT_ACTIVE")
}

test_removed_member_denied if {
	denied_with({"context": {"project": {"subject_is_active_member": false}}}, "NOT_PROJECT_MEMBER")
}

# ---- 거부: grant

test_no_grant_denied if {
	denied_with({"context": {"grant": null}}, "GRANT_MISSING")
}

test_revoked_grant_denied if {
	denied_with({"context": {"grant": {"status": "REVOKED"}}}, "GRANT_REVOKED")
}

test_expired_by_time_even_if_status_active if {
	denied_with({"context": {"now": "2026-10-01T00:00:00Z"}}, "GRANT_EXPIRED")
}

test_expired_status_denied if {
	denied_with({"context": {"grant": {"status": "EXPIRED"}}}, "GRANT_EXPIRED")
}

test_not_yet_valid_denied if {
	denied_with({"context": {"now": "2026-08-31T23:59:59Z"}}, "GRANT_NOT_YET_VALID")
}

test_other_users_grant_denied if {
	denied_with(
		{"context": {"grant": {"subject_user_id": "00000000-0000-7000-8000-000000000b02"}}},
		"GRANT_SUBJECT_MISMATCH",
	)
}

test_cross_project_grant_reuse_denied if {
	denied_with({"context": {"project": {"project_id": project_2}}}, "GRANT_PROJECT_MISMATCH")
}

test_other_dataset_grant_denied if {
	denied_with(
		{"context": {"grant": {"dataset_id": "00000000-0000-7000-8000-000000002004"}}},
		"GRANT_DATASET_MISMATCH",
	)
}

test_grant_without_read_denied if {
	denied_with({"context": {"grant": {"operations": ["COMPUTE"]}}}, "GRANT_OPERATION_MISSING")
}

test_sensitive_grant_over_30_days_denied if {
	denied_with(
		{
			"resource": {"access_level": "SENSITIVE"},
			"context": {"grant": {"valid_from": "2026-09-01T00:00:00Z", "expires_at": "2026-10-02T00:00:00Z"}},
		},
		"SENSITIVE_GRANT_TOO_LONG",
	)
}

test_sensitive_grant_30_days_allowed if {
	d := decide({
		"resource": {"access_level": "SENSITIVE"},
		"context": {"grant": {"valid_from": "2026-09-15T00:00:00Z", "expires_at": "2026-10-15T00:00:00Z"}},
	})
	d.allow
}

# ---- 결정성: 같은 input은 같은 output

test_reasons_sorted_and_deterministic if {
	d := decide({"context": {"project": null, "grant": null}})
	d.reasons == ["GRANT_MISSING", "PROJECT_REQUIRED"]
}

test_malformed_now_is_not_allowed if {
	not decide({"context": {"now": "not-a-time"}}).allow == true
}
```

`object.union`은 재귀 병합이므로 patch는 바꿀 필드만 적는다. 값이 `null`인 patch는 해당 객체를 통째로 교체한다.

> `test_malformed_now_is_not_allowed`: `time.parse_rfc3339_ns` 실패는 OPA 기본 설정(non-strict)에서 undefined로 처리되어 `allow`가 true가 되지 않아야 한다. `opa eval --strict-builtin-errors`를 켜면 오류가 되며, Governance는 오류 응답을 `POLICY_ENGINE_UNAVAILABLE`로 처리하므로 어느 쪽이든 fail-closed다.

검증 기록: §5·§6 초안은 OPA v1.4.2에서 `opa fmt --fail`, `opa check --strict`, `opa test`(27/27 PASS, coverage 100%)를 통과했다.

CI (`.github/workflows`, Agent 0가 job 추가):
```bash
opa fmt --fail infra/opa/policies
opa check --strict infra/opa/policies
opa test infra/opa/policies -v --coverage --threshold 95
```

## 7. Bundle Layout

```text
infra/opa/
├── README.md
├── config.yaml                       # OPA 서버 설정 (decision log 등)
└── policies/
    └── data_access/
        ├── policy.rego               # §5
        ├── policy_test.rego          # §6
        └── input.schema.json         # §3 (Governance adapter와 동일 파일을 복사, CI에서 diff 검사)
```

- P0 compose: `opa run --server --addr=0.0.0.0:8181 --config-file=/config/config.yaml /policies` (파일 마운트, 번들 서버 없음).
- 로컬 디버깅: `127.0.0.1:21057` (07_RUNTIME_ENVIRONMENT.md §2).
- OPA decision log는 P0에서 stdout(console)으로만 켠다. 정본 감사는 Governance가 발행하는 `governance.download.*` 이벤트다.
- `/v1/data` 전체 쓰기 API는 compose 네트워크 내부에서만 접근 가능하다. P1에서 `--authentication=token` 적용.

## 8. Governance 측 오류 처리 (D-022)

| 상황 | Governance 처리 | HTTP / code |
|---|---|---|
| 연결 실패, DNS 실패 | deny | 503 `POLICY_ENGINE_UNAVAILABLE` |
| 응답 지연 > `OPA_TIMEOUT_MS`(500) | 요청 취소, deny | 503 `POLICY_ENGINE_UNAVAILABLE` |
| HTTP 4xx/5xx | deny | 503 `POLICY_ENGINE_UNAVAILABLE` |
| `result` 없음(정책 미로딩), 필드 누락, 타입 불일치 | deny | 503 `POLICY_ENGINE_UNAVAILABLE` |
| `allow=false` | deny | 403 `ACCESS_DENIED_BY_POLICY` (`details.reasons`) |
| `allow=true`, basis ≠ precheck basis | deny | 403 `ACCESS_DENIED_BY_POLICY` + divergence metric |

- 재시도하지 않는다(사용자 재시도에 맡김). circuit breaker는 P1.
- 모든 경우 `governance.download.denied.v1`을 기록한다.
- `GET /api/v1/health/ready`는 OPA의 `GET /health?bundles`를 포함한다.

## 9. 정책 변경과 감사

- 정책 변경은 `infra/opa/policies` PR로만 한다. PR에 `policy_version` 상수 증가(semver)와 테스트 추가가 필수다(CI가 `policy.rego` 변경 시 버전 문자열 변경 여부를 검사).
- 발급되는 grant와 download 이벤트에 `policy_version`이 기록되므로, 어떤 판정이 어느 정책으로 내려졌는지 추적할 수 있다.
- **P0**: 플랫폼 정책 배포 자체는 Audit `POLICY_CHANGED` 이벤트를 만들지 않는다(git 이력이 근거). Dataset 단위 정책 변경은 catalog 이벤트로 `POLICY_CHANGED`가 기록된다.
- **P1**: 정책 번들 배포 파이프라인이 `platform.policy.deployed.v1`(가칭)을 발행하여 Audit `POLICY_CHANGED`로 기록한다(contract change request 필요).
