# NAIS AI-OS / Research Commons — Consolidated PRD (v1.1)

> 생성물: `NAIS_PRD/`의 마크다운을 합친 파일. 직접 수정하지 말 것. 기계 계약(`contracts/*.yaml|json`)은 포함하지 않는다.


---

# FILE: README.md

# NAIS AI-OS PRD Package (v1.1)

서비스 포트: **`21051`** (단일 진입점 — `07_RUNTIME_ENVIRONMENT.md`)

## 읽는 순서
1. `00_MASTER_PRD.md` — 제품 정의, 범위, 성공 기준
2. `01_ARCHITECTURE.md` — 스택, 구조, 보안 경계
3. `02_PARALLEL_DEVELOPMENT_PLAN.md` — ownership, mock-first, 통합 gate
4. `03_API_EVENT_CONTRACTS.md` — 계약 개요 (최종 계약은 `contracts/`)
5. `04_SECURITY_GOVERNANCE.md` — 권한 판단, grant, 감사, 보안 테스트
6. `05_TEST_ACCEPTANCE.md` — 테스트 전략, golden E2E
7. `06_AGENT_ASSIGNMENTS.md` — 에이전트에게 그대로 전달할 지시문
8. `07_RUNTIME_ENVIRONMENT.md` — 포트, gateway 라우팅, compose, env
9. `08_OPA_POLICY.md` — 데이터 접근 정책(Rego) 초안
10. `09_AI_READY_RULES.md` — AI-ready 검증 규칙, fixture golden output
11. `10_SEED_DATA.md` — 개발 seed 데이터
12. `11_DECISION_LOG.md` — v1.1에서 확정한 결정 (D-001~)
13. `modules/Mxx_*.md` — 모듈별 상세 명세 (각 에이전트에게 전달)

## contracts/
| 파일 | 내용 |
|---|---|
| `openapi.yaml` | P0 REST API 계약 (OpenAPI 3.1) |
| `events/p0_events.schema.json` | Event envelope + 이벤트별 payload JSON Schema |
| `events/index.json` | 이벤트 목록 (producer, 설명) |
| `error_codes.json` | 에러 코드 레지스트리 (code → HTTP) |
| `module_ownership.json` | 모듈별 소유 경로, DB schema, 담당 에이전트 |

## 가장 중요한 규칙
- contract-first (`contracts/` 우선, 변경은 change request)
- 각 agent는 owned folder만 수정
- 다른 모듈 DB 직접 접근 금지
- P0는 modular monolith, Data Node만 P2 별도 service
- AI-ready 판정은 deterministic rule 기반
- Access는 deny-by-default + time-bound grant

`../NAIS_PRD_COMBINED.md`는 이 폴더의 모든 문서를 합친 파일이다 (생성물, 직접 수정 금지).


---

# FILE: 00_MASTER_PRD.md

# NAIS AI-OS / Research Commons — Master PRD
**Version:** 1.1  
**Status:** Implementation Ready  
**Service Port:** `21051` (단일 진입점, `07_RUNTIME_ENVIRONMENT.md`)  
**Primary Goal:** 여러 개발 에이전트가 모듈 단위로 병렬 개발해도 통합 시 충돌이 최소화되도록 제품·도메인·기술·계약 경계를 고정한다.

---

## 1. 제품 정의

### 1.1 제품명
**NAIS AI-OS**  
하위 핵심 서비스: **Research Commons**

### 1.2 한 줄 정의
> 출연연·대학·기업 연구자가 기관 경계를 넘어 공동 프로젝트를 만들고, 연구데이터·모델·도구·컴퓨팅·지식자산을 발견하고, 권한을 요청·승인받아 안전하게 재사용하며, AI-ready 데이터와 자율형 연구로 확장할 수 있는 연구 협업 플랫폼.

### 1.3 NAIS 미션과의 대응
본 PRD는 다음 센터 미션을 제품 기능으로 해석한다.

**Science AI Platform**
- AI-OS 설계 및 구축
- 연구자 대상 AI 플랫폼
- AI Marketplace
- GPU 자원 관리
- AI-ready 데이터 파이프라인
- AI-ready Data Governance / 보안

**Science AI Convergence**
- 출연연 AX 협력
- 자율실험실 확산
- AI-ready Dataset 품질관리
- 대형연구시설 Agent / 특화모델
- AX 교육
- Ontology 기반 지식구조 데이터 평가

### 1.4 핵심 제품 철학
1. **Project First** — 데이터 저장소가 아니라 공동연구 Project가 중심이다.
2. **Federated by Design** — 데이터 소유권은 기관에 남는다.
3. **Deny by Default** — 권한 없는 데이터 접근은 기본 차단한다.
4. **Evidence over Score** — AI-ready는 단일 점수보다 검증 근거를 보여준다.
5. **Reusable Research Asset** — Dataset, Model, Tool, Workflow, Ontology를 재사용 가능한 자산으로 관리한다.
6. **Audit Everything Important** — 권한·데이터·관리자 행위는 추적 가능해야 한다.
7. **AI Later, Platform First** — P0는 LLM 없이도 완전히 동작해야 한다.

---

## 2. 제품 구조

```text
NAIS AI-OS
│
├── Research Commons
│   ├── Organizations / People
│   ├── Joint Projects
│   └── Collaboration Workspace
│
├── Data Commons
│   ├── Dataset Catalog
│   ├── Dataset Version
│   ├── AI-Ready Validation
│   ├── Data Governance
│   └── Federation / Data Node
│
├── AI Marketplace
│   ├── Dataset
│   ├── Model
│   ├── Tool
│   ├── Workflow
│   ├── Agent
│   └── Ontology
│
├── Compute
│   ├── GPU
│   ├── HPC
│   └── Workspace
│
└── Autonomous Science
    ├── Experiment Workflow
    ├── Instrument / Facility
    ├── Sandbox
    └── Closed-loop Research
```

---

## 3. 사용자

### Researcher
- 공동 프로젝트 생성/참여
- Dataset/Model/Tool 검색
- 데이터 권한 요청
- 승인된 연구자산 Project에 연결

### Project Lead
- 참여기관/연구자 관리
- Project Resource 관리
- 산출물 관리

### Data Steward
- Dataset 등록·정책 설정
- Access Request 검토
- 승인/거절/회수

### Institution Admin
- 기관 구성원·Data Node·기관 정책 관리

### NAIS Platform Admin
- Federation / 공통 정책 / Catalog / 운영 상태 관리

### Resource Manager
- GPU/HPC 자원 등록
- Resource Request 검토
- Allocation 관리

---

## 4. 대표 End-to-End 시나리오

```text
기관 A 연구자 로그인
      ↓
공동 Project 생성
      ↓
기관 B 연구자 초대
      ↓
기관 B Dataset 검색
      ↓
Dataset 정책 확인
      ↓
Access Request 제출
      ↓
기관 B Data Steward 검토
      ↓
Approve + 만료일 지정
      ↓
Project에 Dataset 연결
      ↓
AI-Ready Validation 확인
      ↓
Marketplace에서 Model 추가
      ↓
GPU Resource 요청
      ↓
연구 수행
      ↓
새 Dataset Version / Output 등록
      ↓
Audit / Reuse
```

---

## 5. Release 범위

### P0 — 반드시 완성
- 기관/사용자 인증
- Organization
- Joint Project
- Cross-organization Member
- Dataset Catalog
- Dataset Version
- Object Storage Upload/Download
- Access Request / Approval / Expiration / Revoke
- AI-Ready Rule Validation
- Audit
- Notification
- Search
- Web Portal

### P1 — NAIS AI-OS 고도화
- AI Marketplace
- Model / Tool / Workflow / Ontology
- Resource abstraction
- GPU Resource Request / Allocation
- Project에 Research Asset 추가
- Dataset → Ontology Mapping
- AI-ready Transformation Job

### P2 — Federation
- Institution Data Node
- Metadata Federation
- Remote Storage Adapter
- Direct Transfer
- Compute-to-Data 기본 구조
- ORCID/ROR/PID 확장

### P3 — Autonomous Science
- Experiment Workflow
- Instrument Registry
- Facility Sandbox
- Simulation → Human Approval → Limited Execution
- Closed-loop Dataset Versioning

---

## 6. Success Criteria

### P0 Definition of Done
아래 시나리오가 실제로 동작하면 P0 완료다.

1. 기관 A 사용자가 로그인한다.
2. 기관 B 사용자를 초대해 공동 Project를 만든다.
3. 기관 B의 Controlled Dataset을 검색한다.
4. Project와 연구목적을 지정해 Access Request를 보낸다.
5. 기관 B Data Steward가 승인한다.
6. 승인 기간 동안만 데이터 접근이 가능하다.
7. 만료/회수 시 즉시 접근이 차단된다.
8. Dataset Version별 AI-readiness validation 결과가 표시된다.
9. 주요 행위가 Audit Log에 남는다.
10. 권한 없는 사용자는 API 우회로도 데이터를 받을 수 없다.

### 운영 KPI
- Unauthorized data access: **0**
- 권한 관련 Audit coverage: **100%**
- Access Grant 만료 enforcement: **100%**
- Search p95: **< 1.5s**
- 일반 API p95: **< 500ms** (파일 전송 제외)
- 주요 P0 flow E2E pass: **100%**

---

## 7. 비기능 요구사항

### Security
- OIDC/SAML-ready
- RBAC + ABAC
- Least privilege
- TLS
- Signed URL
- Access expiry
- 모든 권한 변경 Audit

### Performance
- 대용량 파일을 API 서버가 relay하지 않는다.
- Multipart upload / Presigned URL 사용
- Search는 OpenSearch
- Background validation은 async worker

### Accessibility
- WCAG 2.2 AA 목표
- Keyboard navigation
- Semantic HTML
- Focus states

### Operability
- OpenTelemetry
- Structured logging
- Metrics
- Health endpoints
- Migration reproducibility

---

## 8. 개발 원칙

### 8.1 모듈 간 직접 DB 접근 금지
다른 모듈의 테이블을 ORM으로 직접 읽지 않는다.

허용:
- 해당 모듈의 Public Service Interface
- REST API
- 정의된 Domain Event
- Read model / Search index

### 8.2 각 모듈은 자신의 DB schema를 소유
P0는 하나의 PostgreSQL instance를 사용하지만 schema를 분리한다.

```text
identity.*
project.*
catalog.*
governance.*
readiness.*
marketplace.*
compute.*
audit.*
knowledge.*    # P1
autonomy.*     # P3
platform.*     # M00: outbox 등 공통 인프라 (D-005)
```

### 8.3 API contract 먼저
각 개발 에이전트는 구현 전에 다음을 확정한다.
- OpenAPI endpoint
- Request/Response schema
- Error code
- Domain event
- Ownership

### 8.4 Shared package 최소화
공유 허용:
- ID type
- Time
- Error envelope
- Pagination
- Event envelope

공유 금지:
- 모듈 비즈니스 로직
- 모듈별 ORM entity

---

## 9. 모듈 목록

| ID | 모듈 | P0 | 개발 독립성 | 주요 의존 |
|---|---|---:|---|---|
| M00 | Platform Contracts / Foundation | O | 선행 | 없음 |
| M01 | Identity & Organization | O | 높음 | M00 |
| M02 | Project Collaboration | O | 높음 | M00, M01 contract |
| M03 | Data Catalog & Version | O | 높음 | M00, M01 |
| M04 | Access Governance | O | 높음 | M00, M01, M02, M03 contracts |
| M05 | AI-Ready Pipeline | O | 높음 | M00, M03 |
| M06 | Marketplace | P1 | 높음 | M00, M03 concept |
| M07 | Compute / GPU | P1 | 높음 | M00, M01, M02 |
| M08 | Federation / Data Node | P2 | 별도 서비스 | M00, M03, M04 |
| M09 | Audit / Notification | O | 높음 | M00 events |
| M10 | Web Portal | O | API contract 기반 | M00~M09 |
| M11 | Knowledge / Ontology | P1 | 높음 | M03, M06 |
| M12 | Autonomous Science | P3 | 높음 | M02, M06, M07, M08 |

---

## 10. 병렬 개발 추천 Wave

### Wave 0 — Contract freeze
**1 agent**
- M00
- API envelope
- ID conventions
- Event envelope
- Repository skeleton
- Docker Compose skeleton

### Wave 1 — P0 Core
**동시에 6 agents**
- Agent A: M01 Identity/Organization
- Agent B: M02 Project
- Agent C: M03 Catalog/Version
- Agent D: M05 AI-Ready
- Agent E: M09 Audit/Notification
- Agent F: M10 Web shell + mock APIs

### Wave 2 — Governance integration
**동시에 3 agents**
- Agent G: M04 Access Governance
- Agent H: M10 P0 screens integration
- Agent I: E2E / Security test

### Wave 3 — P1
**동시에 3 agents**
- M06 Marketplace
- M07 Compute
- M11 Ontology

### Wave 4 — P2/P3
- M08 Federation
- M12 Autonomous Science

---

## 11. 참고: NAIS 홈페이지 연결

Public homepage:
```text
/
├── About
├── Research
├── Programs
├── AI Platform
├── Research Commons
└── News
```

Application:
```text
/platform
/commons
```

홈페이지는 “NAIS가 무엇을 하는지” 설명하고,
AI-OS는 “그 미션을 실제로 어떻게 수행하는지” 보여준다.

---

## 12. Source of Truth

개발 중 충돌 시 우선순위:
1. `contracts/`의 API/Event contract (`openapi.yaml`, `events/p0_events.schema.json`, `error_codes.json`, `module_ownership.json`)
2. `11_DECISION_LOG.md`
3. `00_MASTER_PRD.md`
4. 해당 `modules/Mxx_*.md`
5. 개별 구현

계약 변경은 구현 중 임의 수정하지 않고 ADR 또는 contract PR로 먼저 합의한다.


---

# FILE: 01_ARCHITECTURE.md

# Architecture & Technology Specification

## 1. Recommended Stack

### Frontend
- **Next.js**
- **TypeScript**
- Tailwind CSS
- shadcn/ui
- TanStack Query
- React Hook Form
- Zod

### Backend
- **Python + FastAPI**
- Pydantic
- SQLAlchemy
- Alembic

### Identity
- **Keycloak**
- OIDC first
- SAML-ready
- 장기적으로 KAFE/Federated IdP 연계 가능한 구조

### Authorization
- **Open Policy Agent (OPA)**
- RBAC + ABAC

### System of Record
- **PostgreSQL**
- 단일 instance, 모듈별 schema

### Search
- **OpenSearch**
- P0: keyword + faceted search
- P1+: vector/hybrid 가능

### Object Storage
- **MinIO** for local/dev
- Production: S3-compatible / institutional storage

### Async
- Redis
- Dramatiq 권장 (Celery도 허용)
- P0에서는 event bus를 별도 도입하지 않고 Transactional Outbox 사용

### Observability
- OpenTelemetry
- Prometheus
- Grafana
- Sentry

### Infra
- Docker
- Docker Compose
- Nginx
- GitHub Actions
- P0에서 Kubernetes 사용하지 않음

---

## 2. Architecture Style

### P0: Modular Monolith + Separate Data Node
빠른 개발과 병렬성을 동시에 확보하기 위해 backend는 **Modular Monolith**로 시작한다.

```text
apps/api
  modules/
    identity
    project
    catalog
    governance
    readiness
    marketplace
    compute
    audit
```

단, M08 Data Node는 별도 서비스로 분리한다.

이점:
- 배포 복잡도 최소화
- DB transaction 단순
- 모듈 ownership 명확
- 향후 필요 모듈만 service 분리 가능

---

## 3. Repository Structure

```text
nais-ai-os/
│
├── apps/
│   ├── web/                     # Next.js
│   └── api/                     # FastAPI modular monolith
│
├── services/
│   └── data-node/               # P2 separate service
│
├── packages/
│   ├── contracts/               # OpenAPI generated types / JSON schema
│   ├── ui/
│   └── config/
│
├── infra/
│   ├── docker/
│   ├── keycloak/
│   ├── opa/
│   ├── opensearch/
│   └── nginx/
│
├── docs/
│   ├── adr/
│   ├── api/
│   └── runbooks/
│
└── tests/
    ├── contract/
    ├── e2e/
    └── security/
```

---

## 4. PostgreSQL Schema Ownership

```text
identity
project
catalog
governance
readiness
marketplace
compute
audit
knowledge   # P1 (M11)
autonomy    # P3 (M12)
platform    # M00 (outbox_events 등)
```

각 모듈은 자신의 schema migration만 소유한다.

### 금지
`governance` 코드에서 `catalog.datasets` ORM entity import.

### 허용
`CatalogQueryPort.get_dataset_summary(dataset_id)`

또는 API/contract read model.

---

## 5. Transactional Outbox

모듈 간 이벤트는 P0에서 별도 Kafka를 두지 않는다.

```text
Business Transaction
    ↓
Domain row update
+
outbox_event insert
    ↓
Worker
    ↓
Event Handler
```

P1/P2에서 필요해질 경우 NATS/Kafka로 교체 가능하도록 Event Envelope을 고정한다.

---

## 6. File Transfer

대용량 파일은 API 서버를 경유하지 않는다.

```text
Browser
  │ request upload
  ▼
API
  │ permission check
  │ presigned URL
  ▼
Browser ───── direct ─────> MinIO/S3
```

Download도 동일.

---

## 7. Security Boundary

```text
Authentication
   ↓
Identity claims
   ↓
Application permission pre-check
   ↓
OPA decision
   ↓
Resource access
   ↓
Audit
```

Dataset file access는 반드시:
1. active grant 확인
2. operation 확인
3. expiration 확인
4. policy decision
5. signed URL 발급

순으로 처리한다.

---

## 8. API Conventions

Base:
```text
/api/v1
```

ID:
- UUIDv7 권장

Time:
- UTC ISO 8601

Error:
```json
{
  "error": {
    "code": "ACCESS_GRANT_EXPIRED",
    "message": "The access grant has expired.",
    "trace_id": "..."
  }
}
```

Pagination:
```json
{
  "items": [],
  "page": {
    "next_cursor": "...",
    "has_more": true
  }
}
```

---

## 9. Frontend Architecture

```text
app/
  (public)/
  (platform)/
    commons/
    marketplace/
    compute/

features/
  auth/
  organizations/
  projects/
  catalog/
  governance/
  readiness/
  marketplace/
  compute/
  audit/

shared/
  api/
  ui/
  hooks/
```

Frontend agent는 backend internal model을 직접 추측하지 않고 generated client 또는 contract type만 사용한다.

---

## 10. Environment

Local:
```text
web
api
postgres
redis
opensearch
keycloak
opa
minio-a
minio-b
worker
mailpit
```

P0 integration demo는 `Institute A`, `Institute B` 두 조직과 두 bucket을 seed한다 (`10_SEED_DATA.md`).

**서비스 포트는 `21051` 하나다.** Nginx gateway가 `/`(web), `/api/`(api), `/auth/`(keycloak), `/nais-inst-a/`·`/nais-inst-b/`(presigned 스토리지)를 path로 라우팅한다. 상세는 `07_RUNTIME_ENVIRONMENT.md`.


---

# FILE: 02_PARALLEL_DEVELOPMENT_PLAN.md

# Parallel Development Plan

## 1. 목적
여러 LLM 개발 에이전트가 동시에 작업할 때 가장 큰 위험은:
- 동일 파일 수정
- 서로 다른 데이터 모델 발명
- API 이름 불일치
- 권한 로직 중복
- shared code 비대화

따라서 **폴더 ownership + contract-first + mock-first**를 강제한다.

---

## 2. Agent Ownership

### Agent 0 — Platform Architect
**Own**
- `/packages/contracts`
- `/infra/docker`
- `/docs/adr`
- root config

**Do not**
- 비즈니스 모듈 구현

### Agent 1 — Identity
**Own**
- `/apps/api/modules/identity`
- `/infra/keycloak`

### Agent 2 — Project
**Own**
- `/apps/api/modules/project`

### Agent 3 — Catalog
**Own**
- `/apps/api/modules/catalog`

### Agent 4 — Governance
**Own**
- `/apps/api/modules/governance`
- `/infra/opa` (Rego는 `infra/opa/policies/data_access/`, D-003)

### Agent 5 — AI Readiness
**Own**
- `/apps/api/modules/readiness`
- worker validator code

### Agent 6 — Audit/Notification
**Own**
- `/apps/api/modules/audit`

### Agent 7 — Web
**Own**
- `/apps/web`

### Agent 8 — Marketplace (P1)
**Own**
- `/apps/api/modules/marketplace`

### Agent 9 — Compute (P1)
**Own**
- `/apps/api/modules/compute`

### Agent 10 — Knowledge/Ontology (P1)
**Own**
- `/apps/api/modules/knowledge`

### Agent 11 — Federation (P2)
**Own**
- `/services/data-node`

### Agent 12 — Autonomous Science (P3)
**Own**
- `/apps/api/modules/autonomy`

### Agent I — E2E / Security QA (Wave 2)
**Own**
- `/tests/e2e`, `/tests/security`, `/tests/load`

> 전체 경로 목록의 기준은 `contracts/module_ownership.json`이다.

---

## 3. Shared File Rule

아래는 Agent 0만 수정:
```text
packages/contracts/*
docker-compose.yml
root pyproject/package workspace config
shared error code registry
```

다른 agent가 contract 변경이 필요하면:
1. `CONTRACT_CHANGE_REQUEST.md` 작성
2. 요청 endpoint/schema/event 명시
3. Agent 0가 contract 반영
4. 그 후 구현

---

## 4. Mock-first Rule

Wave 1에서는 서로의 구현을 기다리지 않는다.

예:
- Project agent는 Identity 실서버가 없어도 `IdentityPort` fake 사용
- Governance agent는 Dataset 조회에 `CatalogPort` fake 사용
- Web agent는 OpenAPI mock 사용

통합 시 fake → adapter만 교체한다.

---

## 5. Dependency Direction

```text
contracts
   ↑
identity      catalog
   ↑            ↑
project        readiness
   \            /
    \          /
     governance
         ↑
       web
```

도메인 핵심이 Web에 의존하면 안 된다.

---

## 6. Branch / PR Strategy

권장 branch:
```text
feat/m01-identity
feat/m02-project
feat/m03-catalog
...
```

PR checklist:
- owned folder 외 변경 없음
- contract 변경 여부
- migration 포함 여부
- unit tests
- contract tests
- audit event 필요 여부
- security implications

---

## 7. Integration Gates

### Gate A — Compile/Boot
모든 container 기동.

### Gate B — Contract
OpenAPI/JSON Schema contract test 통과.

### Gate C — Authorization
권한 우회 테스트 통과.

### Gate D — E2E
기관 A → 기관 B 접근 승인 시나리오 통과.

### Gate E — Observability
trace_id로 요청 추적 가능.

---

## 8. Agent별 완료 정의

각 agent는 완료 시 반드시 제출:
1. README
2. Public API
3. DB schema
4. Domain events
5. Error codes
6. Unit tests
7. Seed data
8. Known limitations
9. 다음 모듈이 알아야 할 integration notes


---

# FILE: 03_API_EVENT_CONTRACTS.md

# Cross-Module Contracts

> **v1.1:** 이 문서는 개요다. 기계가 읽는 최종 계약은 `contracts/`에 있다.
> - API: `contracts/openapi.yaml` (OpenAPI 3.1, v1.1.1: 41 paths / 49 operations)
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


---

# FILE: 04_SECURITY_GOVERNANCE.md

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


---

# FILE: 05_TEST_ACCEPTANCE.md

# Test & Acceptance Plan

## 1. Test Pyramid
- Unit
- Module integration
- Contract
- Security
- E2E
- Load

## 2. P0 Golden E2E
```text
seed Institute A / Institute B
→ A researcher login
→ create Project
→ invite B researcher
→ B creates Controlled Dataset
→ A discovers metadata
→ A requests access
→ B steward approves 7 days
→ A obtains signed download
→ audit event exists
→ grant revoked
→ next download denied
```

## 3. Contract Tests
각 module의 OpenAPI response가 `contracts`와 일치해야 한다.

## 4. AI-Ready Validation Test Dataset
최소 4 fixtures:
- clean tabular
- missing metadata
- invalid units
- missing provenance

## 5. Performance
- catalog search 10k metadata docs
- API 50 concurrent users
- signed URL generation p95
- readiness 1GB sample async 처리

## 6. CI Gate
- lint
- typecheck
- unit
- contract
- migration dry-run
- security critical tests
- build

## 7. v1.1 참조
- 모듈별 인수 테스트 ID(`Mxx-AT-nn`)는 각 `modules/Mxx_*.md` §12에 있다.
- Seed와 seed 검증: `10_SEED_DATA.md`
- AI-ready fixture 4종의 golden output: `09_AI_READY_RULES.md`
- OPA 정책 단위 테스트: `08_OPA_POLICY.md`
- 모든 E2E/보안 테스트는 gateway `http://localhost:21051`을 통해서만 호출한다.


---

# FILE: 06_AGENT_ASSIGNMENTS.md

# Ready-to-Use Agent Assignments

아래 블록을 각 개발 에이전트에게 그대로 전달한다.
**모든 에이전트에게 먼저 "공통 지시"를 붙이고, 그 뒤에 해당 Agent 블록을 붙인다.**

---

## 공통 지시 (모든 Agent 앞에 붙임)

```text
당신은 NAIS AI-OS 모노레포의 개발 에이전트다.

반드시 먼저 읽을 것:
- NAIS_PRD/00_MASTER_PRD.md, 01_ARCHITECTURE.md, 02_PARALLEL_DEVELOPMENT_PLAN.md
- NAIS_PRD/03_API_EVENT_CONTRACTS.md, 04_SECURITY_GOVERNANCE.md, 07_RUNTIME_ENVIRONMENT.md
- NAIS_PRD/11_DECISION_LOG.md
- NAIS_PRD/contracts/ (openapi.yaml, events/, error_codes.json, module_ownership.json)
- 아래 "Read" 항목의 모듈 명세

규칙:
1. module_ownership.json에서 당신 모듈의 path만 수정한다. 그 밖의 파일은 읽기만 한다.
2. contracts/는 수정하지 않는다. 변경이 필요하면 repo 루트에 CONTRACT_CHANGE_REQUEST.md를 작성하고 멈춘다.
3. 다른 모듈의 DB schema/ORM/내부 코드를 import하지 않는다. Port(Protocol) + fake 구현으로 개발한다.
4. 에러는 error_codes.json의 code만 사용한다. 새 코드가 필요하면 change request.
5. 이벤트는 platform OutboxWriter로 자기 트랜잭션 안에서 발행한다. 소비는 processed_events로 멱등 처리.
6. 서비스 포트는 21051 하나다(gateway). 컨테이너 내부 포트를 하드코딩해 외부에 노출하지 않는다.
7. LLM을 판정 로직에 쓰지 않는다 (P0).
8. 완료 시 02_PARALLEL_DEVELOPMENT_PLAN.md §8의 9개 항목을 모듈 README에 제출한다.

PR 체크리스트: owned path 외 변경 없음 / contract 변경 없음 / migration 포함 / unit + contract test / audit event 확인 / 보안 영향 기술.
```

---

## Agent 0 — Platform / Contracts (Wave 0)

**Goal:** 다른 agent들이 동시에 개발할 수 있는 repo skeleton과 공통 런타임을 만든다.

**Read:** 공통 지시 문서 전체, `10_SEED_DATA.md`

**Own:** `module_ownership.json`의 M00 path 전체

**Deliver:**
- monorepo skeleton (01_ARCHITECTURE §3 구조, pnpm workspace + uv/pyproject)
- `docker-compose.yml` / `docker-compose.prod.yml` (07 §3 서비스 목록, 21051만 공개, dev 도구 127.0.0.1:21052~21059)
- `infra/nginx/nais.conf` (07 §1)
- `infra/docker/postgres/init.sql`: schema 생성 + DB role `nais_migrator`/`nais_app` 분리 (07 §5, D-027)
- `apps/api/platform/storage`: 기관 code → `STORAGE_<CODE>_*` 설정 로더 (S3 client 생성만. presign/key 규칙은 M03)
- `apps/api/platform/`:
  - FastAPI app factory, `/api/v1/health/live`, `/api/v1/health/ready`
  - error envelope + exception handler (error_codes.json 기반 enum 자동 생성)
  - cursor pagination helper
  - `CurrentUser` 인증 dependency 인터페이스 (구현은 M01이 제공하는 provider를 주입)
  - DB session / unit of work, `platform.outbox_events` + `OutboxWriter`
  - outbox relay + in-process event handler registry (`@subscribe(event_type)`)
  - OpenTelemetry, structured logging (trace_id), `X-Request-Id`
  - seed orchestrator (`platform/seed.py`, 10 §1 순서)
- `apps/api/worker.py` (Dramatiq: outbox relay, 모듈이 등록한 job/scheduler 실행)
- Alembic 멀티 version location 설정 (D-021)
- `packages/contracts`: openapi.yaml → TS 타입/클라이언트 생성, Python pydantic 모델 생성, JSON Schema 이벤트 검증기
- `tests/contract/`: 각 모듈 응답을 openapi.yaml로 검증하는 harness, 이벤트를 p0_events.schema.json으로 검증하는 harness
- `Makefile`: up, down, migrate, seed, seed-check, test, lint, typecheck, contract-test, e2e
- GitHub Actions CI (05 §6 CI Gate)

**Done when:** Gate A 통과(07 §5), 빈 모듈 폴더에 fake 구현만 있어도 `make test` 녹색.

**Do not implement:** business module logic.

---

## Agent 1 — Identity & Organization (Wave 1)

**Read:** `modules/M01_identity_org.md`, `10_SEED_DATA.md` §2~3

**Own:** `apps/api/modules/identity`, `infra/keycloak`

**Deliver:** Keycloak realm `nais` export(clients, `org_code` mapper, seed users), JWT 검증 + JIT provisioning, `CurrentUser` provider, `/me`, `/users`, `/organizations*`, 기관 멤버 역할/상태 변경, `IdentityPort` 공개 인터페이스, identity 이벤트 4종, seed.

**Key rules:** 역할의 source of truth는 identity DB(D-019). DISABLED user/membership은 모든 API에서 403. 세션당 1회 `identity.user.logged_in.v1`(D-020).

---

## Agent 2 — Project Collaboration (Wave 1)

**Read:** `modules/M02_project_collaboration.md`

**Own:** `apps/api/modules/project`

**Deliver:** project CRUD/archive, 멤버 추가·역할 변경·삭제(D-007 직접 추가), visibility(D-023), `ProjectQueryPort`, project 이벤트 5종, seed project.

**Key rules:** PROJECT_OWNER ≥ 1. 외부 기관 멤버 허용. project membership과 dataset 권한은 별개. IdentityPort는 fake로 시작.

---

## Agent 3 — Data Catalog & Version (Wave 1)

**Read:** `modules/M03_data_catalog.md`, `07_RUNTIME_ENVIRONMENT.md` §1 (presigned URL 규칙)

**Own:** `apps/api/modules/catalog`, `infra/opensearch`

**Deliver:** dataset CRUD/policy, version, upload session(+multipart)/complete(checksum 검증), publish(immutable), OpenSearch index + faceted search, `CatalogQueryPort`/`StoragePort`/`CatalogReadPort`, catalog 이벤트 4종, seed datasets.

**Key rules:** API는 파일 bytes를 relay하지 않는다. catalog는 controlled 다운로드 권한을 결정하지 않는다(M04 책임). 메타데이터 공개 범위 D-012.

---

## Agent 4 — Access Governance (Wave 2)

**Read:** `modules/M04_access_governance.md`, `08_OPA_POLICY.md`, `04_SECURITY_GOVERNANCE.md`

**Own:** `apps/api/modules/governance`, `infra/opa`

**Deliver:** access request 상태기계, approve/reject/request-changes/resubmit/withdraw, grant/revoke, 만료 sweeper + expiring_soon, download-session 판정 알고리즘, OPA Rego + opa test, governance 이벤트 10종, seed grant.

**Key rules:** default deny, 영구 grant 금지, purpose 필수, 만료는 검사 시점 비교(D-010), OPA 실패 시 deny(D-022), 모든 다운로드 허용/거부 감사(D-017).

---

## Agent 5 — AI-Ready Pipeline (Wave 1)

**Read:** `modules/M05_ai_ready.md`, `09_AI_READY_RULES.md`

**Own:** `apps/api/modules/readiness`, `tests/fixtures/readiness`

**Deliver:** profile 2종, validator 9종, Dramatiq job, publish 이벤트 자동 실행, 결과 재사용(input_fingerprint), readiness API, readiness 이벤트 2종, fixture 4종 + golden output 테스트.

**Key rules:** LLM 판정 금지. 같은 input/version/profile → 같은 결과. evidence에 원본 값 금지(D-018). CatalogReadPort는 fake로 시작.

---

## Agent 6 — Audit & Notification (Wave 1)

**Read:** `modules/M09_audit_notification.md`

**Own:** `apps/api/modules/audit`

**Deliver:** 전체 이벤트 consumer → immutable audit record, audit 조회 API(권한별 scope), 알림 규칙 → in-app notification + Mailpit 이메일, notification API.

**Key rules:** audit 테이블 UPDATE/DELETE 금지(DB 권한 + trigger). 일반 app log와 audit 분리. trace_id = correlation_id.

---

## Agent 7 — Web Portal (Wave 1 shell → Wave 2 통합)

**Read:** `modules/M10_web_portal.md`, `contracts/openapi.yaml`

**Own:** `apps/web`, `packages/ui`

**Deliver:**
- Wave 1: 레이아웃, Auth.js + Keycloak 로그인(21051/auth), 생성된 API client, MSW mock mode, 전체 P0 route 화면(mock 데이터)
- Wave 2: 실제 API 연결, 8개 필수 flow, Playwright golden E2E

**Key rules:** backend ORM/model을 추측하지 않고 생성된 contract client만 사용. WCAG 2.2 AA. 브라우저가 MinIO로 직접 업로드/다운로드(presigned URL).

---

## Agent I — E2E / Security QA (Wave 2)

**Read:** `05_TEST_ACCEPTANCE.md`, `04_SECURITY_GOVERNANCE.md` §7, 각 모듈 명세의 Acceptance tests

**Own:** `tests/e2e`, `tests/security`, `tests/load`

**Deliver:** Golden E2E(API 레벨, pytest + httpx), 보안 테스트 8종, 성능 테스트(05 §5), Gate C/D 판정 리포트.

**Key rules:** 테스트는 21051 gateway를 통해서만 호출한다. 실패 시 모듈 코드를 고치지 말고 해당 Agent에게 이슈를 남긴다.

---

## Agent 8 — AI Marketplace (Wave 3, P1)

**Read:** `modules/M06_marketplace.md`

**Own:** `apps/api/modules/marketplace`

**Deliver (착수 전):** 모듈 명세를 13개 섹션 템플릿으로 상세화하고 필요한 API/이벤트를 CONTRACT_CHANGE_REQUEST.md로 제출 → Agent 0 반영 후 구현.

**Key rules:** download marketplace가 아니라 project reuse 중심. DATASET 자산은 catalog dataset을 참조(복제 금지). 접근 통제는 GrantQueryPort 재사용.

---

## Agent 9 — Compute / GPU (Wave 3, P1)

**Read:** `modules/M07_compute.md`

**Own:** `apps/api/modules/compute`

**Deliver (착수 전):** 명세 상세화 + contract change request. Resource Request는 governance의 요청·승인 패턴(기간제, 만료, 감사)을 따른다.

---

## Agent 10 — Knowledge / Ontology (Wave 3, P1)

**Read:** `modules/M11_knowledge_ontology.md`, `09_AI_READY_RULES.md` (`semantic_mapping` check)

**Own:** `apps/api/modules/knowledge`

**Deliver (착수 전):** 명세 상세화 + contract change request. Dataset semantic mapping 결과는 readiness `semantic_mapping` check가 읽을 수 있는 Port로 제공.

---

## Agent 11 — Federation / Data Node (Wave 4, P2)

**Read:** `modules/M08_federation_data_node.md`, `08_OPA_POLICY.md`

**Own:** `services/data-node`

**Deliver (착수 전):** node ↔ control plane 프로토콜(인증, manifest sync, grant validation, audit forwarding) 명세 작성 후 ADR로 합의.

**Key rules:** bytes remain at owner. Node는 control plane grant를 검증 없이 신뢰하지 않는다(서명된 grant token).

---

## Agent 12 — Autonomous Science (Wave 4, P3)

**Read:** `modules/M12_autonomous_science.md`

**Own:** `apps/api/modules/autonomy`

**Deliver (착수 전):** 명세 상세화 + contract change request.

**Key rules:** SIMULATION → SHADOW → HUMAN_APPROVED_LIMITED_CONTROL. 실제 장비 제어는 prototype 범위 밖.


---

# FILE: 07_RUNTIME_ENVIRONMENT.md

# Runtime Environment & Ports

## 1. 단일 진입점: `:21051`

NAIS AI-OS는 호스트에 **21051 포트 하나만** 서비스 포트로 노출한다.
모든 트래픽은 Nginx(`gateway`)가 path 기준으로 내부 컨테이너에 전달한다.

```text
http://localhost:21051
│
├── /                     → web:3000        (Next.js, Auth.js는 /web-auth/*)
├── /api/                 → api:8000        (FastAPI, /api/v1/*)
├── /auth/                → keycloak:8080   (KC_HTTP_RELATIVE_PATH=/auth)
├── /nais-inst-a/         → minio-a:9000    (Institute A bucket, presigned URL 전용)
├── /nais-inst-b/         → minio-b:9000    (Institute B bucket, presigned URL 전용)
└── /healthz              → gateway 자체 health (200 "ok")
```

### Presigned URL 규칙
- API는 presigned URL을 **public endpoint `NAIS_PUBLIC_BASE_URL`(기본 `http://localhost:21051`)** 기준, **path-style**로 서명한다.
  - 예: `http://localhost:21051/nais-inst-b/datasets/{dataset_id}/{version_id}/data.csv?X-Amz-...`
- Nginx는 bucket 경로를 해당 MinIO로 그대로 전달하며, 서명 검증을 위해 `Host` 헤더를 보존한다 (`proxy_set_header Host $http_host;`).
- bucket 이름은 전역 유일해야 한다: `nais-inst-a`, `nais-inst-b`, (readiness 산출물) `nais-platform`.
- 업로드 본문 크기 제한은 bucket 경로에서만 해제한다 (`client_max_body_size 0;`). `/api/`는 `10m`.

### Nginx 참고 설정 (infra/nginx/nais.conf)
```nginx
server {
  listen 21051;

  location = /healthz { return 200 "ok"; }

  location /api/ {
    client_max_body_size 10m;
    proxy_pass http://api:8000;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-Host  $http_host;
    proxy_set_header X-Request-Id      $request_id;
  }

  location /auth/ {
    proxy_pass http://keycloak:8080;
    proxy_set_header Host              $http_host;
    proxy_set_header X-Forwarded-Proto $scheme;
  }

  location /nais-inst-a/ {
    client_max_body_size 0;
    proxy_request_buffering off;
    proxy_pass http://minio-a:9000;
    proxy_set_header Host $http_host;
  }

  location /nais-inst-b/ {
    client_max_body_size 0;
    proxy_request_buffering off;
    proxy_pass http://minio-b:9000;
    proxy_set_header Host $http_host;
  }

  location / {
    proxy_pass http://web:3000;
    proxy_set_header Host $http_host;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
  }
}
```

## 2. 개발 도구 포트 (dev only, `127.0.0.1` bind)

| 포트 | 서비스 | 용도 |
|---:|---|---|
| 21051 | gateway (nginx) | **서비스 포트 (유일한 공개 포트)** |
| 21052 | mailpit UI | 개발용 메일 확인 |
| 21053 | minio-a console | Institute A 스토리지 콘솔 |
| 21054 | minio-b console | Institute B 스토리지 콘솔 |
| 21055 | postgres | 로컬 디버깅 (psql) |
| 21056 | opensearch | 로컬 디버깅 |
| 21057 | opa | 정책 디버깅 (`/v1/data`) |
| 21058~21059 | 예약 | P1 이후 (예: grafana) |

운영 배포(`docker-compose.prod.yml`)에서는 21052~21059를 publish하지 않는다.

## 3. Compose 서비스 목록

| 서비스 | 이미지/빌드 | 내부 포트 | 소유 Agent | 비고 |
|---|---|---:|---|---|
| gateway | nginx:1.27 | 21051 | Agent 0 | 호스트 21051:21051 |
| web | apps/web | 3000 | Agent 7 | |
| api | apps/api | 8000 | Agent 0 (entry) | 모듈 코드는 각 Agent |
| worker | apps/api (`python -m worker`) | - | Agent 0 (entry) | outbox relay, readiness job, grant expiry sweeper |
| postgres | postgres:16 | 5432 | Agent 0 | DB `nais`, schema 모듈별 |
| redis | redis:7 | 6379 | Agent 0 | Dramatiq broker |
| opensearch | opensearch:2 | 9200 | Agent 3 | single-node, security plugin off (dev) |
| keycloak | keycloak:26 | 8080 | Agent 1 | realm `nais`, relative path `/auth` |
| opa | openpolicyagent/opa | 8181 | Agent 4 | bundle: `infra/opa/policies` |
| minio-a | minio/minio | 9000/9001 | Agent 0 | Institute A storage |
| minio-b | minio/minio | 9000/9001 | Agent 0 | Institute B storage |
| mailpit | axllent/mailpit | 1025/8025 | Agent 6 | SMTP 1025 |

## 4. 환경 변수 (공통 `.env.example`, Agent 0 소유)

모듈 전용 변수(예: `GOVERNANCE_*`, `READINESS_*`, `NOTIFICATION_*`)는 각 `modules/Mxx_*.md` §11에 정의하고, Agent 0가 `.env.example`에 모은다.

```dotenv
NAIS_PUBLIC_BASE_URL=http://localhost:21051
NAIS_GATEWAY_PORT=21051

# API
DATABASE_URL=postgresql+psycopg://nais_app:nais_app@postgres:5432/nais          # 런타임 role (D-027)
MIGRATION_DATABASE_URL=postgresql+psycopg://nais_migrator:nais_migrator@postgres:5432/nais  # schema owner, migrate 전용
REDIS_URL=redis://redis:6379/0
OPENSEARCH_URL=http://opensearch:9200
OPA_URL=http://opa:8181
OPA_TIMEOUT_MS=500
OIDC_ISSUER=http://localhost:21051/auth/realms/nais
OIDC_INTERNAL_JWKS_URL=http://keycloak:8080/auth/realms/nais/protocol/openid-connect/certs
OIDC_AUDIENCE=nais-api
SMTP_HOST=mailpit
SMTP_PORT=1025

# Storage (기관별 스토리지를 organization code로 매핑)
# 기관 code → prefix: 대문자화, '-'→'_' (inst-a → STORAGE_INST_A_*, D-024)
STORAGE_INST_A_ENDPOINT=http://minio-a:9000
STORAGE_INST_A_BUCKET=nais-inst-a
STORAGE_INST_A_ACCESS_KEY=nais-inst-a
STORAGE_INST_A_SECRET_KEY=change-me-a
STORAGE_INST_B_ENDPOINT=http://minio-b:9000
STORAGE_INST_B_BUCKET=nais-inst-b
STORAGE_INST_B_ACCESS_KEY=nais-inst-b
STORAGE_INST_B_SECRET_KEY=change-me-b
STORAGE_PRESIGN_TTL_SECONDS=300
STORAGE_MULTIPART_THRESHOLD_BYTES=67108864

# Web
# Auth.js basePath는 /web-auth (/api/는 FastAPI 전용, D-026)
AUTH_URL=http://localhost:21051/web-auth
AUTH_SECRET=change-me-32-bytes
AUTH_KEYCLOAK_ISSUER=http://localhost:21051/auth/realms/nais
AUTH_KEYCLOAK_INTERNAL_URL=http://keycloak:8080/auth/realms/nais
AUTH_KEYCLOAK_ID=nais-web
NEXT_PUBLIC_API_BASE=/api/v1
API_INTERNAL_BASE=http://api:8000/api/v1
NEXT_PUBLIC_API_MOCKING=disabled
```

## 5. Database roles (D-027)

| role | 권한 | 사용처 |
|---|---|---|
| `nais_migrator` | 모든 모듈 schema owner | `make migrate`, `make seed`의 DDL |
| `nais_app` | 각 schema 테이블 DML. 단 `audit.audit_events`는 `INSERT, SELECT`만 | api, worker 런타임 |

Postgres init 스크립트(`infra/docker/postgres/init.sql`, Agent 0)가 두 role과 schema를 만든다. M09 migration이 audit 테이블 권한을 REVOKE한다.

## 6. Health / Readiness

| 경로 | 설명 |
|---|---|
| `GET /healthz` | gateway liveness |
| `GET /api/v1/health/live` | api process liveness |
| `GET /api/v1/health/ready` | postgres, redis, opensearch, opa 연결 확인. 하나라도 실패 시 503 |

Gate A(Compile/Boot) 판정: `docker compose up -d` 후 120초 이내 위 3개가 모두 200.

## 7. 로컬 실행 규약

```bash
cp .env.example .env
make up          # docker compose up -d --build
make migrate     # 모든 모듈 alembic upgrade head
make seed        # 10_SEED_DATA.md 기준 데이터 적재
open http://localhost:21051
```


---

# FILE: 08_OPA_POLICY.md

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


---

# FILE: 09_AI_READY_RULES.md

# AI-Ready Validation Rules (M05 규칙표)

> 소유: Agent 5 — Readiness. 구현 명세는 `modules/M05_ai_ready.md`.
> **판정은 결정론적 규칙으로만 한다. LLM은 PASS/FAIL 판정에 관여하지 않는다.**
> 규칙·임계값·사전(단위, 라이선스 목록)이 바뀌면 `profile version` 또는 `validator_version`을 올린다.

---

## 1. 입력

검증기는 **PUBLISHED version**만 평가한다. 입력은 세 가지이며 모두 version에 대해 불변이다.

| 입력 | 출처 | 비고 |
|---|---|---|
| Metadata snapshot | `VersionView.metadata_snapshot` (M03이 publish 시 동결) | live dataset 수정은 기존 version 판정에 영향 없음 |
| File manifest | `VersionView.files` (path, size, sha256, media_type) | path 오름차순 |
| File bytes | `CatalogReadPort.open_stream` (서비스 자격증명, D-018) | |

### 1.1 Metadata snapshot 필드

`title, description, keywords, domain, access_level, license, usage_policy, allowed_purposes, max_grant_days, contact_email, provenance`

### 1.2 Convention files (version 루트에 업로드)

| 파일 | 형식 | 용도 |
|---|---|---|
| `_schema.json` | Frictionless Data Package **subset** (아래) | 표 형식 파일의 필드, 타입, 단위, 의미 매핑 |
| `_codebook.csv` | CSV, 헤더 `path,field,code,label,unit,description` | 범주형 코드 정의, 필드 단위 보조 |
| `README.md` | Markdown | 설명, provenance 섹션 |

`_`로 시작하는 파일과 `README.md`는 **표 형식 데이터 파일 집합(T)에서 제외**한다.

#### `_schema.json` subset

```json
{
  "resources": [
    {
      "path": "data/measurements.csv",
      "schema": {
        "fields": [
          {
            "name": "temperature_c",
            "type": "number",
            "unit": "Cel",
            "description": "시편 온도",
            "constraints": { "required": true },
            "x-nais-concept": "http://qudt.org/vocab/quantitykind/Temperature"
          }
        ],
        "primaryKey": "sample_id",
        "missingValues": ["", "NA"]
      }
    }
  ]
}
```

| 키 | 필수 | 규칙 |
|---|---|---|
| `resources[].path` | O | version 내 파일 path와 정확히 일치 |
| `schema.fields[].name` | O | 헤더 컬럼명과 정확히 일치 (대소문자 구분) |
| `schema.fields[].type` | O | `string`, `integer`, `number`, `boolean`, `date`, `datetime` |
| `schema.fields[].unit` | 숫자형 권장 | UCUM case-sensitive 표기 (`Cel`, `kPa`, `mg/L`, 무차원은 `1`) |
| `schema.fields[].constraints.required` | 선택 | true면 결측 불허 |
| `schema.fields[].constraints.enum` | 선택 | 범주형 코드 목록 |
| `schema.fields[].x-nais-concept` | 선택 | 절대 IRI (`http(s)://...`) |
| `schema.primaryKey` | 선택 | 문자열 또는 문자열 배열. 결측 불허 |
| `schema.missingValues` | 선택 | 기본 `["", "NA", "N/A", "null", "NULL", "NaN"]` |

Readiness는 subset을 검사하는 JSON Schema(`modules/readiness/schemas/table_schema_subset_v1.json`)를 코드로 번들한다.

### 1.3 표 형식 파일 집합 T

- 확장자 `.csv`, `.tsv`, `.parquet` 이며 `_` 접두어가 아닌 파일
- path 오름차순, 최대 `max_tabular_files`(50)개 평가. 초과분은 evidence `skipped_files`에 path만 기록

### 1.4 파싱 규칙 (결정론)

| 항목 | 규칙 |
|---|---|
| 인코딩 | UTF-8, BOM 허용. 디코딩 실패 → 해당 파일 `encoding_error` |
| 구분자 | `.csv` → `,`, `.tsv` → `\t`. 추론하지 않음 |
| 헤더 | 첫 줄 필수 |
| quote | RFC 4180 (`"`) |
| sample | 파일별 **앞에서부터** 최대 `sample_max_rows`(100,000) 행, 그리고 최대 `sample_max_bytes`(256 MiB) 이내. 먼저 닿는 한도에서 중단. evidence에 `truncated` |
| parquet | row group 순서대로 `sample_max_rows`까지. 헤더 = parquet schema 컬럼명 |
| 컬럼 수 불일치 행 | `malformed_rows`로 계수, 타입·결측 계산에서 제외 |
| 값 읽기 | 모든 CSV 값을 **문자열**로 읽은 뒤 타입 규칙(§3.3) 적용. locale·pandas 추론 사용 금지 |
| 병렬성 | 파일은 path 순으로 처리, 결과 병합 순서 고정 |

위 한도 값은 **profile parameter**다 (env로 바꿀 수 없음). 바꾸면 profile version을 올린다.

---

## 2. Profiles

### 2.1 `GENERIC_BASIC@1.0.0` — 모든 PUBLISHED version에 자동 실행

| # | check_id | severity |
|---|---|---|
| 1 | `metadata.completeness` | REQUIRED |
| 2 | `provenance.presence` | REQUIRED |
| 3 | `policy.license_usage` | REQUIRED |
| 4 | `integrity.file_checksum` | REQUIRED |
| 5 | `schema.presence` | RECOMMENDED |
| 6 | `semantics.units_codebook` | RECOMMENDED |
| 7 | `semantics.mapping_status` | RECOMMENDED |

### 2.2 `TABULAR_ML_BASIC@1.0.0` — T가 비어있지 않으면 자동 실행

| # | check_id | severity |
|---|---|---|
| 1 | `metadata.completeness` | REQUIRED |
| 2 | `provenance.presence` | REQUIRED |
| 3 | `policy.license_usage` | REQUIRED |
| 4 | `integrity.file_checksum` | REQUIRED |
| 5 | `schema.presence` | REQUIRED |
| 6 | `schema.datatype_validity` | REQUIRED |
| 7 | `data.missing_values` | RECOMMENDED |
| 8 | `semantics.units_codebook` | REQUIRED |
| 9 | `semantics.mapping_status` | RECOMMENDED |

### 2.3 Profile parameters (두 profile 공통, v1.0.0)

```yaml
sample_max_rows: 100000
sample_max_bytes: 268435456        # 256 MiB
max_tabular_files: 50
checksum_max_total_bytes: 10737418240   # 10 GiB, §3.8
description_min_length: 50
provenance_min_length: 50
usage_policy_min_length: 20
datatype_warn_ratio: 0.0           # invalid_ratio > 0 이면 최소 WARNING
datatype_fail_ratio: 0.01
malformed_rows_fail_ratio: 0.001
missing_warn_ratio: 0.05
missing_fail_ratio: 0.5
missing_overall_warn_ratio: 0.05
unit_missing_fail_ratio: 0.2
mapping_pass_ratio: 0.8
```

### 2.4 Overall 집계

```text
applicable = status != NOT_APPLICABLE 인 checks
if any(c.status == FAIL and c.severity == REQUIRED)            -> FAIL
elif any(c.status == FAIL) or any(c.status == WARNING)          -> WARNING   # RECOMMENDED FAIL 포함
else                                                            -> PASS
```
정의된 두 profile은 항상 적용 가능한 REQUIRED check(1~4)를 포함하므로 applicable이 비는 경우는 없다.

---

## 3. Validators

공통 evidence 규칙 (D-018):
- **허용**: 개수, 비율(소수 6자리 반올림), 파일 path, 필드명, 스키마에 선언된 단위 문자열, 행 번호(1-based, 헤더 제외), 길이
- **금지**: 셀 값, 셀 값 일부, 샘플 행, 통계 중 원값을 드러내는 min/max/mean
- 배열은 정렬(path → field → row), 행 번호 목록은 최대 10개

### 3.1 `metadata.completeness`

| 항목 | 규칙 |
|---|---|
| 적용 | 항상 |
| REQUIRED 필드 | `title`(≥3자), `description`(trim 후 ≥ `description_min_length`), `license`(비어있지 않음), `contact_email`(존재), `keywords`(≥1개) |
| RECOMMENDED 필드 | `keywords` ≥ 3개, `domain` 존재, version 파일에 `README.md` 존재 |
| PASS | REQUIRED, RECOMMENDED 모두 충족 |
| WARNING | REQUIRED 충족, RECOMMENDED 중 하나 이상 미충족 |
| FAIL | REQUIRED 중 하나 이상 미충족 |

evidence
```json
{
  "required_missing": ["contact_email", "description", "keywords"],
  "recommended_missing": ["domain", "keywords_min_3"],
  "description_length": 6,
  "keyword_count": 0,
  "readme_present": true
}
```
message 예: `필수 메타데이터 3개가 누락되었습니다: contact_email, description(50자 미만), keywords.`

### 3.2 `schema.presence`

| 항목 | 규칙 |
|---|---|
| 적용 | T ≠ ∅. 아니면 `NOT_APPLICABLE` |
| FAIL | ① `_schema.json` 없음(단, T 전부 parquet이면 WARNING) ② JSON 파싱 실패 또는 subset JSON Schema 위반 ③ csv/tsv 파일 중 `resources[]`에 기술되지 않은 파일 존재 ④ 선언된 field가 헤더에 없음 |
| WARNING | ① parquet 파일이 `resources[]`에 없음(내장 schema로 대체) ② 헤더에 선언되지 않은 컬럼 존재 |
| PASS | T의 모든 파일이 기술되고 헤더와 field 집합이 정확히 일치 |

evidence
```json
{
  "tabular_files": 1,
  "described": 1,
  "undescribed": [],
  "schema_errors": [{"pointer": "/resources/0/schema/fields/2/type", "error": "enum"}],
  "header_mismatch": [{"path": "data/a.csv", "missing_in_header": ["ph"], "undeclared_columns": ["note"]}]
}
```

### 3.3 `schema.datatype_validity`

| 항목 | 규칙 |
|---|---|
| 적용 | T ≠ ∅ 이고, 평가 가능한 파일(`_schema.json`에 기술된 csv/tsv, 또는 parquet)이 1개 이상. 아니면 `NOT_APPLICABLE` |
| 타입 규칙 | `integer`: `^[+-]?\d+$` · `number`: `^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$` (NaN/Inf 불허) · `boolean`: `true,false,True,False,TRUE,FALSE,1,0` · `date`: `YYYY-MM-DD` 실존 날짜 · `datetime`: RFC 3339 (`Z` 또는 offset 필수) · `string`: 항상 유효. 결측 토큰은 검사 제외 |
| parquet | 선언 타입과 physical/logical 타입 호환 여부 (예: `integer` ↔ INT32/INT64). 기술되지 않은 parquet은 컬럼 타입이 존재하므로 유효로 간주 |
| invalid_ratio | 필드별 invalid / (sample 행 − 결측) |
| PASS | 모든 필드 invalid 0, malformed_rows 0, encoding_error 없음 |
| WARNING | 최대 invalid_ratio ≤ `datatype_fail_ratio`(1%), 또는 malformed_rows 비율 ≤ 0.1% |
| FAIL | 어떤 필드든 invalid_ratio > 1%, malformed_rows 비율 > 0.1%, 또는 encoding_error |

evidence
```json
{
  "files": [{"path": "data/a.csv", "sampled_rows": 1000, "truncated": false, "malformed_rows": 0, "encoding_error": false}],
  "fields": [{"path": "data/a.csv", "field": "pressure_kpa", "declared_type": "number", "checked": 990, "invalid": 3, "invalid_ratio": 0.00303, "first_invalid_rows": [17, 204, 811]}]
}
```
(`fields`는 invalid > 0인 필드만)

### 3.4 `data.missing_values`

| 항목 | 규칙 |
|---|---|
| 적용 | T ≠ ∅. 아니면 `NOT_APPLICABLE` |
| 결측 판정 | 셀 문자열이 해당 resource `missingValues`(없으면 기본 토큰)에 속함. parquet은 null |
| PASS | 모든 필드 missing_ratio ≤ 5% 이고 전체 셀 결측률 ≤ 5% |
| WARNING | 어떤 필드가 5% 초과 50% 이하, 또는 전체 셀 결측률 > 5% |
| FAIL | 어떤 필드가 50% 초과, 또는 `primaryKey` / `constraints.required` 필드에 결측 1건 이상 |

evidence
```json
{
  "overall_missing_ratio": 0.002,
  "fields": [{"path": "data/measurements.csv", "field": "pressure_kpa", "missing": 10, "ratio": 0.01}],
  "required_field_violations": []
}
```

### 3.5 `semantics.units_codebook`

| 항목 | 규칙 |
|---|---|
| 적용 | T ≠ ∅ 이고 숫자형 필드(`integer`/`number`, 또는 parquet 숫자 컬럼)가 1개 이상. 아니면 `NOT_APPLICABLE` |
| 단위 출처 | ① `_schema.json` field `unit` ② `_codebook.csv`에서 `code`가 빈 행의 `unit` (path+field 일치). 둘 다 있고 다르면 conflict |
| 단위 유효성 | 번들 사전 `ucum_atoms_v1.txt` + UCUM prefix + 문법(`.` 곱, `/` 나눗셈, 정수 지수, 괄호, `{annotation}`), 대소문자 구분. `1` = 무차원 |
| 범주형 | codebook에 코드가 정의된 필드에서, sample 값 중 codebook에 없는 코드 수 |
| FAIL | 단위 출처가 전혀 없음(`_schema.json`·`_codebook.csv` 모두 없음), 문법상 invalid 단위 ≥ 1, 또는 단위 누락 숫자 필드 비율 > 20% |
| WARNING | 단위 누락 비율 0% 초과 20% 이하, schema/codebook 단위 conflict ≥ 1, codebook 미정의 코드 ≥ 1 |
| PASS | 모든 숫자 필드가 유효 단위 보유, conflict 없음, 미정의 코드 없음 |

evidence
```json
{
  "numeric_fields": 2,
  "with_valid_unit": 0,
  "missing_unit": [],
  "invalid_unit": [
    {"path": "data/measurements.csv", "field": "pressure_kpa", "unit": "kilopascal", "error": "UNKNOWN_ATOM"},
    {"path": "data/measurements.csv", "field": "temperature_c", "unit": "degC", "error": "UNKNOWN_ATOM"}
  ],
  "conflicts": [],
  "undefined_code_counts": []
}
```
message 예: `UCUM 단위로 해석할 수 없는 값이 2개 있습니다 (예: temperature_c: degC → Cel).`
(`unit` 문자열은 스키마 메타데이터이므로 evidence 허용. 교정 제안은 번들 사전의 alias 표 `unit_aliases_v1.csv`에서만 결정론적으로 가져온다.)

### 3.6 `provenance.presence`

| 항목 | 규칙 |
|---|---|
| 적용 | 항상 |
| 출처 | ① snapshot `provenance` ② `README.md`의 heading(`#`~`###`)이 정규식 `^(provenance|출처|데이터 출처|생성 방법)$`(대소문자 무시, 앞뒤 공백 제거)인 섹션 본문(다음 heading 전까지, trim) |
| PASS | 어느 한 출처의 길이 ≥ `provenance_min_length`(50자) |
| WARNING | 출처는 있으나 모두 50자 미만 |
| FAIL | 두 출처 모두 없음(빈 문자열 포함) |

evidence
```json
{"metadata_provenance_length": 0, "readme_present": true, "readme_section_found": false, "readme_section_length": 0}
```

### 3.7 `policy.license_usage`

| 항목 | 규칙 |
|---|---|
| 적용 | 항상 |
| license 인식 | 번들 `spdx_license_ids_v1.txt`에 있음, 또는 `^NAIS-[A-Z0-9-]+-\d+\.\d+$` |
| PASS | license 인식됨, 그리고 (`access_level` ∈ {PUBLIC, INTERNAL} 또는 `usage_policy` 길이 ≥ 20) |
| WARNING | license가 비어있지 않지만 인식되지 않음 (usage 조건은 충족) |
| FAIL | license 비어있음, 또는 `access_level` ∈ {CONTROLLED, SENSITIVE}인데 `usage_policy` 없음/20자 미만 |

evidence
```json
{"license": "CC-BY-4.0", "license_recognized": true, "access_level": "CONTROLLED", "usage_policy_length": 142, "allowed_purposes_count": 2}
```

### 3.8 `integrity.file_checksum`

| 항목 | 규칙 |
|---|---|
| 적용 | 항상 |
| 방법 | path 순으로 누적 크기가 `checksum_max_total_bytes`(10 GiB) 이내인 파일은 스트리밍 sha256 **재계산**(`method=recomputed`). 초과분은 M03의 `VERIFIED` 상태를 근거로 채택(`method=catalog_verified`). 별도로 manifest로부터 `manifest_sha256`을 재계산해 snapshot 값과 비교 |
| PASS | 재계산 파일 전부 일치, catalog_verified 파일 전부 `VERIFIED`, manifest 일치 |
| FAIL | 불일치 1건 이상, object 없음, 또는 manifest 불일치 |
| WARNING | 없음 |

evidence
```json
{"files_total": 4, "recomputed": 4, "catalog_verified": 0, "mismatched": [], "missing": [], "manifest_match": true}
```

### 3.9 `semantics.mapping_status`

| 항목 | 규칙 |
|---|---|
| 적용 | T ≠ ∅ 이고 `_schema.json`이 유효. 아니면 `NOT_APPLICABLE` |
| mapped | field에 절대 IRI 형식(`^https?://\S+$`)의 `x-nais-concept`가 있음. 형식 불량은 unmapped |
| PASS | mapped / 선언 field 수 ≥ 80% |
| WARNING | 80% 미만 (0% 포함) |
| FAIL | P0에서는 없음 |

evidence
```json
{"declared_fields": 5, "mapped_fields": 5, "ratio": 1.0, "unmapped": [], "malformed_iri": []}
```
P1: M11 Knowledge 모듈의 dataset semantic mapping 결과를 출처로 추가한다 (profile version 증가).

---

## 4. 결정론 보장

| 항목 | 규칙 |
|---|---|
| `validator_version` | 코드 상수 `VALIDATOR_VERSION = "1.0.0"`. 규칙 코드, 번들 사전(UCUM, SPDX, alias), 파서 라이브러리 major 버전이 바뀌면 올린다 |
| `input_fingerprint` | `sha256(manifest_sha256 + "\|" + profile_id + "\|" + profile_version + "\|" + validator_version)` (openapi 정의) |
| 재사용 범위 | `(dataset_version_id, profile_id, input_fingerprint)`가 같은 COMPLETED 결과가 있으면 재실행하지 않고 반환. metadata_snapshot은 version에 대해 불변이므로 version 범위 안에서 결정론이 성립 |
| 금지 | 현재 시간, 난수, locale, 환경 변수 임계값, 스레드 완료 순서, 네트워크 조회(LLM 포함)에 결과가 의존하는 코드 |
| 정규화 | float는 소수 6자리 반올림, dict key 정렬, 배열 정렬 후 canonical JSON(`separators=(",", ":")`, `ensure_ascii=False`) |
| `result_sha256` | canonical JSON(`checks` + `overall_status` + `summary`)의 sha256. 결정론 테스트의 비교 기준 |

---

## 5. Test Fixtures (`tests/fixtures/readiness/`)

각 fixture 디렉터리 구조:
```text
<fixture>/
  dataset.json            # metadata snapshot (M03 seed/테스트에서 dataset 생성에 사용)
  files/                  # version에 업로드할 파일 (루트 = version 루트)
  expected/
    GENERIC_BASIC.json    # golden: check별 status, overall, result_sha256
    TABULAR_ML_BASIC.json
```
파일은 `tests/fixtures/readiness/generate.py`(난수 미사용, 아래 공식)로 한 번 생성해 **커밋**한다. 테스트는 fixture 파일의 sha256 목록(`fixtures.lock`)으로 변조를 감지한다.

### 5.1 공통 데이터 파일 `files/data/measurements.csv`

1,000행 + 헤더. i = 1..1000.

| 컬럼 | 타입 | 값 공식 |
|---|---|---|
| `sample_id` | string (primaryKey) | `S` + 4자리 zero-pad i (`S0001`) |
| `material` | string (codebook) | `["AL","CU","FE"][i % 3]` |
| `temperature_c` | number | `20.0 + (i % 50) * 0.5` (소수 1자리) |
| `pressure_kpa` | number | `i % 100 == 0`이면 빈 값(결측 10건 = 1%), 아니면 `101.325 + (i % 10)` (소수 3자리) |
| `measured_at` | datetime | `2026-01-01T00:00:00Z` + i 분 (RFC 3339, `Z`) |

### 5.2 `clean_tabular`

- `dataset.json`
  ```json
  {
    "title": "고분자 전해질 막 온도-압력 측정",
    "description": "연료전지용 고분자 전해질 막 시편 1,000개에 대해 온도와 압력을 측정한 표 형식 데이터셋이다. 재료 코드는 codebook에 정의되어 있다.",
    "keywords": ["fuel-cell", "membrane", "temperature", "pressure"],
    "domain": "materials",
    "access_level": "CONTROLLED",
    "license": "CC-BY-4.0",
    "usage_policy": "학술 연구 및 AI 학습 목적에 한해 사용한다. 재배포 금지. 결과 공개 시 출처를 표기한다.",
    "allowed_purposes": ["ACADEMIC_RESEARCH", "AI_TRAINING"],
    "max_grant_days": 180,
    "contact_email": "steward@inst-b.example",
    "provenance": "Institute B 연료전지 실험실의 환경 챔버(모델 EC-200)에서 2026년 1월 1일 1분 간격으로 자동 수집한 측정값."
  }
  ```
- `files/data/measurements.csv` (§5.1)
- `files/_schema.json`: 5개 field 모두 기술. `temperature_c.unit="Cel"`, `pressure_kpa.unit="kPa"`, `sample_id`는 `primaryKey`, `material.constraints.enum=["AL","CU","FE"]`, 모든 field에 `x-nais-concept` (예: `http://qudt.org/vocab/quantitykind/Temperature`, `http://qudt.org/vocab/quantitykind/Pressure`, `https://schema.org/identifier`, `https://w3id.org/emmo#Material`, `http://www.w3.org/2006/time#Instant`)
- `files/_codebook.csv`: `data/measurements.csv,material,AL,Aluminium,,` 외 CU, FE 3행 (field 단위 행 없음)
- `files/README.md`: 개요 + `## Provenance` 섹션(60자 이상)

### 5.3 `missing_metadata`
`clean_tabular`과 파일 동일. `dataset.json`만 변경: `description: "측정 데이터"`, `keywords: []`, `domain: null`, `contact_email: null`.

### 5.4 `invalid_units`
`clean_tabular`과 동일하되 `_schema.json`의 `temperature_c.unit="degC"`, `pressure_kpa.unit="kilopascal"`.

### 5.5 `missing_provenance`
`clean_tabular`과 동일하되 `dataset.json.provenance: null`, `README.md`에서 `## Provenance` 섹션 제거.

### 5.6 Golden 결과

| check_id | clean_tabular | missing_metadata | invalid_units | missing_provenance |
|---|---|---|---|---|
| metadata.completeness | PASS | **FAIL** (REQ: contact_email, description, keywords / REC: domain, keywords_min_3) | PASS | PASS |
| schema.presence | PASS | PASS | PASS | PASS |
| schema.datatype_validity | PASS | PASS | PASS | PASS |
| data.missing_values | PASS (pressure_kpa 1%) | PASS | PASS | PASS |
| semantics.units_codebook | PASS | PASS | **FAIL** (invalid 2) | PASS |
| provenance.presence | PASS | PASS | PASS | **FAIL** |
| policy.license_usage | PASS | PASS | PASS | PASS |
| integrity.file_checksum | PASS | PASS | PASS | PASS |
| semantics.mapping_status | PASS (5/5) | PASS | PASS | PASS |
| **Overall GENERIC_BASIC** | **PASS** | **FAIL** | **WARNING** (units는 RECOMMENDED) | **FAIL** |
| **Overall TABULAR_ML_BASIC** | **PASS** | **FAIL** | **FAIL** | **FAIL** |

(GENERIC_BASIC에는 `schema.datatype_validity`, `data.missing_values`가 없다.)

`expected/*.json` 예:
```json
{
  "profile_id": "TABULAR_ML_BASIC",
  "profile_version": "1.0.0",
  "validator_version": "1.0.0",
  "overall_status": "FAIL",
  "checks": {"metadata.completeness": "PASS", "semantics.units_codebook": "FAIL", "...": "..."},
  "result_sha256": "<첫 승인 실행에서 기록>"
}
```
`result_sha256`은 첫 구현이 리뷰를 통과한 뒤 기록하며, 이후 바뀌면 `validator_version` 증가가 동반되어야 한다 (CI 검사).


---

# FILE: 10_SEED_DATA.md

# Seed Data Specification

`make seed`는 아래 데이터를 **멱등**하게 적재한다. 여러 번 실행해도 결과가 같아야 한다(고정 UUID 사용).
Seed는 각 모듈이 자기 schema에 대해 제공하는 `seed()` 함수를 Agent 0의 `apps/api/platform/seed.py`가 순서대로 호출한다.

> 개발 전용 데이터다. 실제 개인정보·민감정보를 넣지 않는다 (04_SECURITY_GOVERNANCE §3).

## 1. 실행 순서

```text
1. identity   (organizations → users → memberships)   + Keycloak realm import
2. project    (seed project 1개)
3. catalog    (datasets → versions → files → MinIO objects → publish → OpenSearch index)
4. readiness  (publish 이벤트로 자동 실행되므로 별도 seed 없음. worker 처리 대기)
5. governance (seed grant 1개: 만료 임박 알림 확인용)
```

## 2. Organizations (M01)

| 고정 ID | code | name | type | bucket |
|---|---|---|---|---|
| `00000000-0000-7000-8000-000000000001` | `nais` | NAIS | PLATFORM_OPERATOR | `nais-platform` |
| `00000000-0000-7000-8000-00000000000a` | `inst-a` | Institute A | RESEARCH_INSTITUTE | `nais-inst-a` |
| `00000000-0000-7000-8000-00000000000b` | `inst-b` | Institute B | RESEARCH_INSTITUTE | `nais-inst-b` |

## 3. Users (M01 + Keycloak)

개발용 공통 비밀번호: `nais-dev-pass` (Keycloak realm import 시 설정, 운영 금지)

| 고정 ID 접미사 | email | display_name | org | org roles | platform roles | membership |
|---|---|---|---|---|---|---|
| `...0101` | admin@nais.local | NAIS Admin | nais | ORG_ADMIN | PLATFORM_ADMIN | ACTIVE |
| `...0a01` | a.admin@inst-a.local | A Admin | inst-a | ORG_ADMIN | - | ACTIVE |
| `...0a02` | a.researcher@inst-a.local | A Researcher | inst-a | - | - | ACTIVE |
| `...0a03` | a.steward@inst-a.local | A Steward | inst-a | DATA_STEWARD | - | ACTIVE |
| `...0b01` | b.admin@inst-b.local | B Admin | inst-b | ORG_ADMIN | - | ACTIVE |
| `...0b02` | b.researcher@inst-b.local | B Researcher | inst-b | - | - | ACTIVE |
| `...0b03` | b.steward@inst-b.local | B Steward | inst-b | DATA_STEWARD | - | ACTIVE |
| `...0b04` | b.disabled@inst-b.local | B Disabled | inst-b | - | - | **DISABLED** |

고정 ID 전체 형식: `00000000-0000-7000-8000-00000000XXXX` (XXXX = 표의 접미사).
Keycloak 사용자 attribute `org_code`에 org code를 넣고, protocol mapper로 access token claim `org_code`에 싣는다.

## 4. Project (M02)

| 고정 ID | name | lead | visibility | members |
|---|---|---|---|---|
| `...1001` | Seed: Battery Materials Joint Study | inst-a | PRIVATE | a.researcher (PROJECT_OWNER), b.researcher (RESEARCHER) |

Golden E2E(05 §2)는 이 project를 쓰지 않고 **새로 생성**한다. Seed project는 UI 확인·grant seed용이다.

## 5. Datasets (M03)

| 고정 ID | title | owner | access_level | allowed_purposes | max_grant_days | version | 파일 (readiness fixture) |
|---|---|---|---|---|---:|---|---|
| `...2001` | Battery Cycling Measurements | inst-b | CONTROLLED | ACADEMIC_RESEARCH, AI_TRAINING | 180 | v1 PUBLISHED | `clean_tabular` |
| `...2002` | Open Materials Properties | inst-b | PUBLIC | 전체 | 365 | v1 PUBLISHED | `missing_provenance` |
| `...2003` | Inst-B Internal QC Logs | inst-b | INTERNAL | ACADEMIC_RESEARCH | 90 | v1 PUBLISHED | `invalid_units` |
| `...2004` | Facility Sensor Streams | inst-a | SENSITIVE | ACADEMIC_RESEARCH | 30 | v1 PUBLISHED | `missing_metadata` |
| `...2005` | Electrolyte Screening (draft) | inst-a | CONTROLLED | AI_TRAINING | 90 | v1 DRAFT (파일 없음) | - |

- 파일 내용은 `tests/fixtures/readiness/<fixture>/`(M05 소유)를 그대로 업로드한다. fixture 정의는 `09_AI_READY_RULES.md`.
- 모든 seed dataset은 `created_by` = 소유기관 steward.
- Publish 후 readiness 자동 실행 결과는 `09_AI_READY_RULES.md`의 golden output과 같아야 한다 (seed 검증 항목).

## 6. Governance (M04)

| 고정 ID | 내용 |
|---|---|
| request `...3001` | a.researcher → dataset `...2001`, project `...1001`, ACADEMIC_RESEARCH, READ, 30일 요청 → b.steward APPROVED |
| grant `...4001` | 위 요청의 grant. `valid_from = seed 시각`, `expires_at = seed 시각 + 2일` (72시간 이내이므로 다음 sweeper에서 `ACCESS_EXPIRING` 알림 발생) |

## 7. Seed 검증 (`make seed-check`)

- [ ] 8명 모두 `http://localhost:21051`에서 로그인 가능, b.disabled는 로그인 후 API 403 `MEMBERSHIP_DISABLED`
- [ ] a.researcher의 `/datasets` 검색 결과: `...2001`, `...2002`, `...2004` 노출, `...2003`(INTERNAL) 비노출, `...2005`(DRAFT만 있음)는 메타데이터만 노출
- [ ] b.researcher 검색 결과에 `...2003` 노출
- [ ] seed dataset 4개의 readiness 결과가 golden output과 일치
- [ ] a.researcher가 project `...1001`로 `...2001` download-session 생성 성공 (basis GRANT)
- [ ] a.researcher 알림함에 `ACCESS_EXPIRING` 1건
- [ ] audit-events에 seed 과정의 `DATASET_CREATED`, `DATASET_VERSION_PUBLISHED`, `ACCESS_REQUESTED`, `ACCESS_APPROVED` 존재


---

# FILE: 11_DECISION_LOG.md

# Decision Log (PRD v1.1 보완 결정)

PRD v1.0에서 비어 있거나 모호했던 부분을 v1.1에서 확정한 기록이다.
각 결정은 `contracts/`와 모듈 명세에 반영되어 있으며, 변경하려면 contract change request를 거친다.

| ID | 주제 | 결정 | 근거 / 비고 |
|---|---|---|---|
| D-001 | 외부 포트 | 시스템 단일 진입점은 **Nginx `:21051`**. web, api, keycloak, 객체 스토리지 presigned 경로 모두 21051 아래 path로 라우팅 | 요청자 지정. 상세 `07_RUNTIME_ENVIRONMENT.md` |
| D-002 | 개발 도구 포트 | Mailpit UI, MinIO console 등 개발 도구는 `127.0.0.1:21052~21059`에만 bind. 운영 배포에서는 노출하지 않음 | 21051은 서비스 포트로만 사용 |
| D-003 | OPA 소유 경로 | M04가 `infra/opa` 전체 소유. Rego는 `infra/opa/policies/data_access/` | v1.0 문서 간 경로 불일치 해소 |
| D-004 | 추가 schema | PostgreSQL schema 목록에 `knowledge`(M11), `autonomy`(M12), `platform`(M00) 추가 | v1.0 누락 |
| D-005 | Outbox 위치 | 단일 `platform.outbox_events` 테이블(M00 소유). 각 모듈은 `platform.outbox.OutboxWriter`로 **자기 트랜잭션 안에서** insert | 같은 PG instance이므로 cross-schema 트랜잭션 가능. 모듈 테이블 직접 접근 금지 원칙과 별개인 플랫폼 인프라 |
| D-006 | Event 소비 | Worker의 outbox relay가 in-process handler registry로 전달. **At-least-once**. 각 consumer는 `<schema>.processed_events(event_id)`로 멱등 처리 | Kafka/NATS 교체 시 envelope 불변 |
| D-007 | 멤버 초대 | P0는 **직접 추가**(status ACTIVE) + 초대 알림. 수락/거절 플로우는 P1 | Golden E2E 단순화 |
| D-008 | Grant 주체 | P0 Grant subject는 **요청한 사용자 1명** (`subject_type=USER`). 같은 Project의 다른 멤버는 각자 요청 | 최소권한. Project 단위 grant는 P1 검토 |
| D-009 | Grant operation | `READ`(파일 목록·다운로드), `COMPUTE`(P2 compute-to-data, P0에서 요청 불가), `WRITE`(예약, 요청 불가) | 보안 테스트 "READ만 가진 사용자의 WRITE 불가" 충족 |
| D-010 | 만료 enforcement | 만료는 **검사 시점 비교**(`expires_at <= now` → deny)로 강제. Worker의 1분 주기 sweeper는 상태를 `EXPIRED`로 바꾸고 이벤트만 발행 | sweeper 지연이 있어도 접근 차단 100% |
| D-011 | 접근 등급별 규칙 | PUBLIC: 인증 사용자 누구나 다운로드. INTERNAL: 소유기관 ACTIVE 멤버만. CONTROLLED: active grant 필수. SENSITIVE: active grant 필수 + `max_grant_days ≤ 30` | 소유기관 `DATA_STEWARD`/`ORG_ADMIN`은 자기 기관 데이터에 grant 없이 접근 |
| D-012 | 메타데이터 공개 | PUBLIC/CONTROLLED/SENSITIVE 메타데이터는 모든 인증 사용자 검색 가능. INTERNAL은 소유기관 멤버에게만 검색 노출 | "metadata centrally discoverable" |
| D-013 | Dataset 생성 권한 | 소유기관의 `DATA_STEWARD`만 Dataset 생성·Version publish·정책 변경 가능 | Seed에 기관별 steward 계정 포함 |
| D-014 | Upload 완료 | 기존 surface에 `POST /api/v1/upload-sessions/{id}/complete` 추가. 64 MiB 초과 파일은 multipart | checksum 검증 지점 필요 |
| D-015 | Access Request 생성 | `POST /access-requests`는 바로 `SUBMITTED`로 생성. `DRAFT`는 enum에만 예약 | P0 UI 단순화 |
| D-016 | 추가 endpoint | `resubmit`, `withdraw`, `GET /access-grants`, `GET /users`, 기관 멤버 관리, notifications, readiness profiles 추가 | `contracts/openapi.yaml`이 최종 |
| D-017 | 다운로드 감사 | `FILE_DOWNLOADED`는 **다운로드 URL 발급 시점** 기준으로 기록 (`governance.download.authorized.v1`). 거부도 `governance.download.denied.v1`로 기록 | 스토리지 access log 연동은 P1 |
| D-018 | Readiness 파일 접근 | Readiness worker는 사용자 grant가 아니라 **서비스 계정**으로 스토리지 읽기. 결과에는 원본 값이 아닌 통계·위치만 evidence로 기록 | 검증 결과가 데이터 유출 경로가 되지 않도록 |
| D-019 | 인증 방식 | Web은 Auth.js(Keycloak provider, Authorization Code + PKCE). API는 Bearer JWT를 JWKS로 검증. 기관은 토큰 claim `org_code`로 식별 | 역할의 source of truth는 NAIS identity DB, Keycloak은 인증만 |
| D-020 | 로그인 감사 | 첫 인증 요청 시 identity가 세션당 1회 `identity.user.logged_in.v1` 발행 | Audit `LOGIN` 충족 |
| D-021 | Migration | Alembic 멀티 version location. 모듈별 `apps/api/modules/<m>/migrations`, `version_table`도 모듈 schema 안 | 모듈이 자기 migration만 소유 |
| D-022 | OPA 장애 | OPA 호출 timeout 500ms, 실패 시 deny + `POLICY_ENGINE_UNAVAILABLE`(503) | fail-closed |
| D-023 | 프로젝트 공개범위 | `PRIVATE`(기본, 멤버만 조회) / `PUBLIC`(요약만 전체 인증 사용자 조회, 상세는 멤버만) | |
| D-024 | 스토리지 매핑·Port | 기관 스토리지는 기관 `code`에서 env prefix를 유도(`inst-b` → `STORAGE_INST_B_*`). identity는 스토리지를 모른다. `StoragePort`/`CatalogQueryPort`의 구현과 타입 정본은 M03 §8. Governance는 권한만 판정하고 `presign_get(version_id, file_ids, ttl)`을 호출 | storage key는 catalog 내부 정보 |
| D-025 | 검토 시작 | `GET /access-requests/{id}`는 상태를 바꾸지 않는다. `POST /access-requests/{id}/start-review`로 SUBMITTED → UNDER_REVIEW, `governance.access.review_started.v1` 발행. 승인·거절·수정요청은 SUBMITTED에서도 가능 | 부수효과 있는 GET은 prefetch/캐시에서 오작동 |
| D-026 | Web 인증 경로 | Auth.js `basePath=/web-auth` | gateway가 `/api/`를 FastAPI로 보냄 |
| D-027 | DB role 분리 | `nais_migrator`(schema owner) / `nais_app`(런타임). audit 테이블은 `nais_app`에 INSERT/SELECT만 | audit 불변성 |
| D-028 | readiness_overall 기준 | 검색·목록의 `readiness_overall`은 TABULAR_ML_BASIC 최신 COMPLETED 결과, 없으면 GENERIC_BASIC | 표시 기준 단일화 |
| D-029 | input_fingerprint | `sha256(manifest_sha256 + metadata_snapshot_sha256 + profile_id + profile_version + validator_version)`. publish 시 dataset metadata를 동결(`metadata_snapshot`) | metadata 변경이 결과 재사용에 반영되도록 |
| D-030 | Governance 이벤트 payload | 모든 governance 이벤트에 `owner_organization_id` 포함, `requested`에 `dataset_title`/`project_name` 포함 | M09가 추가 조회 없이 audit/알림 생성 |
| D-031 | VIEWER 접근 요청 | project `VIEWER`는 access request 불가(`FORBIDDEN`) | 최소권한 |

## P1 이후로 미룬 항목 (v1.1 검토 중 식별)
- Dataset version withdraw API 및 `catalog.dataset.version_withdrawn.v1` (enum `WITHDRAWN`만 예약)
- Dataset 일반 메타데이터 변경 이벤트 (P0는 검색 색인이 catalog 내부라 불필요)
- PLATFORM_ADMIN 긴급 grant 회수 (break-glass) — 현재는 소유기관 steward/ORG_ADMIN만 회수
- Project 단위 grant (D-008), 멤버 초대 수락 플로우 (D-007)
- 스토리지 access log 기반 실제 다운로드 감사 (D-017)


---

# FILE: modules/M01_identity_org.md

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
dev password: `nais-dev-pass` (dev/test realm 한정)

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


---

# FILE: modules/M02_project_collaboration.md

# M02 Project Collaboration

> 기준 계약: `contracts/openapi.yaml`(tag `projects`), `contracts/events/p0_events.schema.json`, `11_DECISION_LOG.md`(D-007, D-023)

## 1. Goal / Scope

### Goal
기관 간 공동 연구 Project와 참여자·역할을 관리한다.

### P0
- Project create/update/archive
- lead organization (생성자 기관)
- partner organizations (멤버 소속 기관에서 자동 파생)
- member add/remove, role 변경 (P0는 **직접 추가** + 초대 알림, D-007)
- project roles: `PROJECT_OWNER`, `PROJECT_ADMIN`, `RESEARCHER`, `VIEWER`
- visibility: `PRIVATE`(기본) / `PUBLIC` (D-023)
- activity event emit (M09 audit/notification 소비)

### Rules (v1.0 유지)
- PROJECT_OWNER는 1명 이상이어야 한다.
- 외부기관 member가 가능하다.
- project member가 아니면 private project detail을 볼 수 없다.
- dataset 권한과 project membership은 별개다. 멤버가 되었다고 데이터 접근이 생기지 않는다.

### Out of scope
- 초대 수락/거절 플로우 (P1)
- Project Resource 연결 (Dataset/Model/GPU를 Project에 붙이는 것, P1 M06/M07)
- 산출물(Output) 관리 (P1)
- 프로젝트 삭제 (archive만 가능)

### 후속 단계
- P1: invitation 수락, Project Resource, Output 등록
- P3: Experiment workflow 연결 (M12)

## 2. Ownership

| 항목 | 값 |
|---|---|
| Owner | Agent 2 — Project |
| Paths | `apps/api/modules/project` |
| DB schema | `project` |
| Migration | `apps/api/modules/project/migrations` (version_table `project.alembic_version`) |

## 3. Dependencies

### Ports consumed
```python
class IdentityQueryPort(Protocol):   # M01
    def get_public_profile(self, user_id: UUID) -> IdentityPublicProfile | None: ...
    def get_public_profiles(self, user_ids: list[UUID]) -> dict[UUID, IdentityPublicProfile]: ...
    def get_organization_summary(self, organization_id: UUID) -> OrganizationSummary | None: ...
    def is_active_user(self, user_id: UUID) -> bool: ...
```
Wave 1에서는 seed 사용자 목록을 가진 `FakeIdentityQueryPort`를 사용한다.

`CurrentUser`는 platform auth dependency로 받는다.

### Events consumed
해당 없음. 기관 membership이 DISABLED가 되어도 project 멤버 행은 유지된다. 해당 사용자는 M01에서 요청 자체가 차단되고, grant 회수는 M04가 처리한다.

## 4. Data Model (`project.*`)

### `project.projects`
| column | type | null | default | constraint |
|---|---|---|---|---|
| project_id | uuid | N | uuidv7 | PK |
| name | varchar(200) | N | | CHECK length ≥ 2 |
| description | text | N | `''` | ≤ 10000 |
| visibility | varchar(16) | N | `'PRIVATE'` | CHECK in (`PRIVATE`,`PUBLIC`) |
| status | varchar(16) | N | `'ACTIVE'` | CHECK in (`ACTIVE`,`ARCHIVED`) |
| lead_organization_id | uuid | N | | (identity 참조, FK 없음) |
| keywords | text[] | N | `'{}'` | ≤ 20개, 각 ≤ 50자 |
| start_date | date | Y | | |
| end_date | date | Y | | CHECK `end_date IS NULL OR start_date IS NULL OR end_date >= start_date` |
| created_by | uuid | N | | |
| created_at | timestamptz | N | now() | |
| updated_at | timestamptz | N | now() | |
| archived_at | timestamptz | Y | | |

Index: `ix_projects_visibility_status (visibility, status)`, `ix_projects_name_trgm` (GIN trgm, `q` 검색).

### `project.project_members`
| column | type | null | default | constraint |
|---|---|---|---|---|
| project_member_id | uuid | N | uuidv7 | PK |
| project_id | uuid | N | | FK → `project.projects` |
| user_id | uuid | N | | |
| organization_id | uuid | N | | 추가 시점 사용자 소속 기관 (IdentityQueryPort로 조회해 복사) |
| role | varchar(16) | N | | CHECK in (`PROJECT_OWNER`,`PROJECT_ADMIN`,`RESEARCHER`,`VIEWER`) |
| status | varchar(16) | N | `'ACTIVE'` | CHECK in (`ACTIVE`,`REMOVED`) |
| joined_at | timestamptz | N | now() | |
| added_by | uuid | N | | |
| removed_at | timestamptz | Y | | |
| removed_by | uuid | Y | | |
| removal_reason | text | Y | | |

Unique: `ux_project_members_active (project_id, user_id) WHERE status = 'ACTIVE'`.
Index: `ix_project_members_user (user_id, status)`. "내 프로젝트" 조회용이다 (한 사용자가 여러 프로젝트에 소속 가능).

제거는 soft delete(`REMOVED`)로 처리해 이력을 남긴다. 다시 추가하면 새 행을 만든다.

### `project.project_organizations`
멤버 구성으로부터 파생되는 참여기관 테이블. 멤버 변경과 **같은 트랜잭션**에서 갱신한다.

| column | type | null | default | constraint |
|---|---|---|---|---|
| project_id | uuid | N | | PK part, FK → `project.projects` |
| organization_id | uuid | N | | PK part |
| role | varchar(8) | N | | CHECK in (`LEAD`,`PARTNER`) |
| active_member_count | int | N | 0 | CHECK ≥ 0 |

규칙:
- 생성 시 lead 기관 행(`LEAD`)을 만든다.
- 다른 기관 멤버가 처음 추가되면 `PARTNER` 행을 insert한다.
- `PARTNER`의 `active_member_count`가 0이 되면 행을 삭제한다. `LEAD` 행은 삭제하지 않는다.

`project.processed_events`: 해당 없음.

## 5. State machine

### Project
| from | to | 주체 | 조건 |
|---|---|---|---|
| (없음) | ACTIVE | 인증 사용자 | 생성자 = PROJECT_OWNER |
| ACTIVE | ARCHIVED | PROJECT_OWNER | `project.archived.v1` → M04가 project-scoped grant 전부 회수 (`PROJECT_ARCHIVED`) |
| ARCHIVED | (변경 불가) | | P0에 unarchive 없음. 모든 mutation은 409 `PROJECT_ARCHIVED` |

### Member
| from | to | 주체 |
|---|---|---|
| (없음) | ACTIVE | OWNER/ADMIN 추가, 생성자 자동 |
| ACTIVE | ACTIVE(role 변경) | 아래 role 규칙 |
| ACTIVE | REMOVED | OWNER/ADMIN 제거, 본인 탈퇴 → M04가 해당 사용자의 이 project grant 회수 (`PROJECT_MEMBER_REMOVED`) |

### Role 변경 규칙
- `PROJECT_OWNER` 역할의 부여·박탈·OWNER 멤버 제거는 **OWNER만** 할 수 있다.
- `PROJECT_ADMIN`은 `RESEARCHER`, `VIEWER` 멤버의 추가·제거·역할 변경만 할 수 있다. 다른 ADMIN의 부여·박탈은 OWNER만 할 수 있다.
- **ACTIVE OWNER가 0명이 되는 변경**(마지막 OWNER의 강등·제거·탈퇴)은 409 `PROJECT_LAST_OWNER`다.
- 불변식 `count(ACTIVE members where role=OWNER) >= 1`은 트랜잭션 안에서 `SELECT ... FOR UPDATE`(projects 행 잠금)로 보장한다.

## 6. API

| operationId | 호출 가능 | 규칙 | Side effect | Error |
|---|---|---|---|---|
| `listProjects` | 인증 사용자 | `scope=mine`(기본): 내가 ACTIVE 멤버인 프로젝트 (ARCHIVED 포함, `status`로 필터). `scope=discover`: `PUBLIC` + `ACTIVE` 프로젝트 요약. `my_role`은 비멤버면 null. `q`는 name 부분일치. 정렬 `updated_at desc` | 없음 | 401 |
| `createProject` | 인증 사용자 | lead = 호출자 기관, 호출자 = OWNER. visibility 기본 PRIVATE. start/end 검증 | `project.created.v1`, 생성자 `project.member.added.v1`은 발행하지 않음 (created 이벤트에 owner 포함) | 422 `VALIDATION_FAILED` |
| `getProject` | ACTIVE 멤버, PLATFORM_ADMIN(읽기) | 비멤버: PRIVATE → 404 `NOT_FOUND`, PUBLIC → 403 `FORBIDDEN` | 없음 | 403, 404 |
| `updateProject` | OWNER, ADMIN | ARCHIVED면 거부. `visibility` 변경은 OWNER만 | 없음 (P0 이벤트 없음) | 403 `FORBIDDEN`, 409 `PROJECT_ARCHIVED`, 422 |
| `archiveProject` | OWNER | 이미 ARCHIVED면 409 | `project.archived.v1` | 403, 409 `PROJECT_ARCHIVED` |
| `listProjectMembers` | ACTIVE 멤버, PLATFORM_ADMIN | ACTIVE 멤버만. display_name/organization_name은 IdentityQueryPort batch 조회 | 없음 | 404 (비멤버, visibility 무관) |
| `addProjectMember` | OWNER, ADMIN(RESEARCHER/VIEWER만) | 대상이 `is_active_user` 아니면 422 `VALIDATION_FAILED`(`details.fields=["user_id"]`). 이미 ACTIVE 멤버면 409 `PROJECT_MEMBER_EXISTS`. 타 기관 사용자 허용. `project_organizations` 갱신 | `project.member.added.v1` (M09가 PROJECT_INVITATION 알림) | 403, 409 `PROJECT_MEMBER_EXISTS`/`PROJECT_ARCHIVED`, 422 |
| `updateProjectMemberRole` | 위 role 규칙 | 동일 role이면 이벤트 없이 200 | `project.member.role_changed.v1` | 403, 404 `PROJECT_MEMBER_NOT_FOUND`, 409 `PROJECT_LAST_OWNER`/`PROJECT_ARCHIVED` |
| `removeProjectMember` | OWNER, ADMIN(RESEARCHER/VIEWER 대상), 본인(탈퇴) | soft delete, `project_organizations` 갱신 | `project.member.removed.v1` (`removed_by`=호출자, 탈퇴면 본인) | 403, 404 `PROJECT_MEMBER_NOT_FOUND`, 409 `PROJECT_LAST_OWNER`/`PROJECT_ARCHIVED` |

ARCHIVED 프로젝트에서의 탈퇴는 허용한다 (grant는 이미 회수된 상태). 마지막 OWNER 규칙은 동일하게 적용한다.

## 7. Events

### Produced (모두 도메인 변경과 같은 트랜잭션에서 outbox write)
| event_type | 시점 | payload 주의 |
|---|---|---|
| `project.created.v1` | 생성 | `owner_user_id` = 생성자 |
| `project.archived.v1` | archive | |
| `project.member.added.v1` | 멤버 추가 | `project_name`, `organization_id`(대상 기관), `added_by` |
| `project.member.removed.v1` | 제거/탈퇴 | `reason` = 요청 본문 없음 → null (P0) |
| `project.member.role_changed.v1` | role 변경 | `previous_role`, `role`, `changed_by` |

### Consumed
해당 없음.

## 8. Public Service Interface

```python
class ProjectQueryPort(Protocol):
    def is_active_member(self, project_id: UUID, user_id: UUID) -> bool: ...
        # project.status == ACTIVE 이고 member.status == ACTIVE 일 때만 True
        # (ARCHIVED 프로젝트는 False — governance 다운로드 검사에 사용)
    def get_member_role(self, project_id: UUID, user_id: UUID) -> str | None: ...
    def get_summary(self, project_id: UUID) -> ProjectSummary | None: ...     # openapi ProjectSummary, my_role=None
    def list_active_member_ids(self, project_id: UUID) -> list[UUID]: ...      # M09 audit 가시성용
    def list_project_ids_for_member(self, user_id: UUID) -> list[UUID]: ...    # M09 audit 가시성용 (ACTIVE 멤버십)
```

## 9. Authorization matrix

| Action | 비멤버 | VIEWER | RESEARCHER | PROJECT_ADMIN | PROJECT_OWNER | PLATFORM_ADMIN |
|---|---|---|---|---|---|---|
| Project 생성 | O | O | O | O | O | O |
| 조회 (PRIVATE) | X (404) | O | O | O | O | O (읽기) |
| 조회 (PUBLIC) 요약 | O (discover) | O | O | O | O | O |
| 조회 (PUBLIC) 상세 | X (403) | O | O | O | O | O |
| 멤버 목록 | X | O | O | O | O | O |
| 정보 수정 | X | X | X | O | O | X |
| visibility 변경 | X | X | X | X | O | X |
| RESEARCHER/VIEWER 추가·제거·변경 | X | X | X | O | O | X |
| ADMIN 부여·박탈·제거 | X | X | X | X | O | X |
| OWNER 부여·박탈·제거 | X | X | X | X | O | X |
| 본인 탈퇴 | - | O | O | O | O (마지막 OWNER 불가) | - |
| Archive | X | X | X | X | O | X |

## 10. Background jobs
해당 없음.

## 11. Config / env vars

| 변수 | 기본값 | 용도 |
|---|---|---|
| `PROJECT_MAX_MEMBERS` | `200` | 초과 시 422 `VALIDATION_FAILED` |

## 12. Acceptance tests

| ID | Given | When | Then |
|---|---|---|---|
| M02-AT-01 | a.researcher | `POST /projects` | 201, lead = inst-a, members = [a.researcher OWNER], `project.created.v1` |
| M02-AT-02 | M02-AT-01 프로젝트 | a.researcher가 b.researcher를 RESEARCHER로 추가 | 201, `organizations`에 inst-b PARTNER, `project.member.added.v1`, b.researcher 알림 생성 (M09) |
| M02-AT-03 | M02-AT-02 | b.researcher `GET /projects/{id}` | 200, `my_role=RESEARCHER` |
| M02-AT-04 | PRIVATE 프로젝트 | b.steward(비멤버) `GET /projects/{id}` | 404 `NOT_FOUND` |
| M02-AT-05 | PUBLIC 프로젝트 | 비멤버 `GET /projects?scope=discover` / `GET /projects/{id}` | 목록 포함 / 403 `FORBIDDEN` |
| M02-AT-06 | 멤버 1명(OWNER) | 본인 탈퇴 | 409 `PROJECT_LAST_OWNER` |
| M02-AT-07 | OWNER 2명 | 한 명 강등 | 200. 이후 남은 1명 강등 → 409 `PROJECT_LAST_OWNER` |
| M02-AT-08 | PROJECT_ADMIN | 다른 멤버를 OWNER로 변경 | 403 `FORBIDDEN` |
| M02-AT-09 | RESEARCHER | 멤버 추가 | 403 `FORBIDDEN` |
| M02-AT-10 | 이미 ACTIVE 멤버 | 다시 추가 | 409 `PROJECT_MEMBER_EXISTS` |
| M02-AT-11 | b.disabled | 추가 대상으로 지정 | 422 `VALIDATION_FAILED` |
| M02-AT-12 | b.researcher 제거 | inst-b 멤버가 더 없음 | inst-b PARTNER 행 삭제, `project.member.removed.v1`, M04 grant 회수 트리거 |
| M02-AT-13 | 프로젝트 archive | 멤버 추가/수정 시도 | 409 `PROJECT_ARCHIVED`, `is_active_member`는 False |
| M02-AT-14 | 동시 요청 2건 | 두 OWNER가 서로를 동시에 강등 | 하나만 성공, OWNER ≥ 1 유지 |
| M02-AT-15 | b.researcher가 inst-a CONTROLLED 데이터셋에 대한 grant 없이 프로젝트 멤버 | 해당 버전 `download-session` 요청 | 403 `ACCESS_GRANT_REQUIRED` (membership ≠ dataset 권한) |

## 13. Deliverables & Known limitations

### Deliverables
- README, FastAPI router, `ProjectQueryPort` 구현
- Alembic migration (`project` schema)
- Seed: `10_SEED_DATA.md`의 데모 프로젝트 (없으면 golden E2E에서 생성)
- Unit/contract tests
- Integration notes: `is_active_member`는 ARCHIVED 프로젝트에서 False를 반환한다. governance는 이 값만 신뢰한다.

### Known limitations
- 초대는 수락 없이 즉시 멤버가 된다 (D-007).
- 멤버 `organization_id`는 추가 시점 값으로 고정된다 (P0 1인 1기관이라 문제 없음).
- 프로젝트 삭제·unarchive는 없다.
- `updateProject` 변경 이력(감사)은 P0 범위 밖이다.


---

# FILE: modules/M03_data_catalog.md

# M03 Data Catalog & Versioning

> v1.1 상세 명세. 기준 문서: `contracts/openapi.yaml`, `contracts/events/p0_events.schema.json`, `contracts/error_codes.json`, `11_DECISION_LOG.md`(D-011, D-012, D-013, D-014, D-018), `07_RUNTIME_ENVIRONMENT.md`.
> 충돌 시 `contracts/`가 우선한다.

---

## 1. Goal / Scope

### Goal
연구데이터의 metadata, version, file manifest, catalog discovery를 제공한다.
Catalog는 **데이터가 어디에 어떻게 있는지**를 안다. **누가 받을 수 있는지는 결정하지 않는다** (M04 Governance가 결정).

### P0
- Dataset create / update (소유기관 `DATA_STEWARD`만, D-013)
- owner organization, access level (`PUBLIC / INTERNAL / CONTROLLED / SENSITIVE`)
- Dataset policy (`allowed_purposes`, `approval_required`, `max_grant_days`) 관리와 검증
- Dataset Version (DRAFT → PUBLISHED, immutable)
- Upload session (presigned PUT, 64 MiB 초과 multipart), upload complete, size + sha256 검증
- File manifest / checksum / `manifest_sha256`
- MIME/확장자 allow list, archive bomb 방어, malware scan extension point
- OpenSearch indexing (`nais-datasets-v1`), keyword + faceted search, 가시성 필터(D-012)
- Readiness 결과 read model(`readiness_overall`)을 검색·상세에 반영
- Governance/Readiness가 쓰는 Port 제공 (`CatalogQueryPort`, `StoragePort`, `CatalogReadPort`)

### Out of scope (P0)
- 다운로드 권한 판정과 다운로드 URL 발급 결정 (M04)
- 파일 내용 검증·AI-ready 판정 (M05)
- DRAFT version의 파일 삭제 API, version withdraw API (Known limitations 참조)
- vector / hybrid search (P1+)
- 원격 기관 스토리지 adapter, metadata federation (M08, P2)
- PID/DOI 발급 (P2)

### 후속 단계
- P1: storage-side checksum(multipart composite)으로 서버 재해시 제거, dataset → ontology mapping 필드(M11), vector search
- P2: Data Node storage adapter로 `StoragePort` 구현 교체 (bytes remain at owner)

---

## 2. Ownership

| 항목 | 값 |
|---|---|
| Agent | Agent 3 — Catalog |
| Paths | `apps/api/modules/catalog`, `infra/opensearch` |
| DB schema | `catalog` |
| Migrations | `apps/api/modules/catalog/migrations` (alembic version table: `catalog.alembic_version`, D-021) |
| Outbox | `platform.outbox.OutboxWriter` 사용 (D-005) |

`infra/opensearch`에는 `analysis-nori` 플러그인을 설치한 OpenSearch Dockerfile과 index template(`nais-datasets-v1.json`)을 둔다.

---

## 3. Dependencies

### 3.1 Ports consumed

```python
from typing import Protocol, Sequence
from uuid import UUID

class AuthContext(Protocol):          # apps/api/platform/auth (M00)
    user_id: UUID
    organization_id: UUID
    org_roles: frozenset[str]         # {"ORG_ADMIN","DATA_STEWARD","RESOURCE_MANAGER"}
    platform_roles: frozenset[str]    # {"PLATFORM_ADMIN"}
    trace_id: str

class IdentityPort(Protocol):         # provided by M01
    def get_organization_summary(self, organization_id: UUID) -> "OrganizationSummary | None": ...
    def get_organization_summaries(self, ids: Sequence[UUID]) -> dict[UUID, "OrganizationSummary"]: ...

class MalwareScannerPort(Protocol):   # M03 내부 extension point, P0 구현 = NoopScanner
    def scan(self, bucket: str, key: str) -> "ScanResult": ...   # CLEAN | INFECTED | SKIPPED
```

- `OrganizationSummary.code`로 기관 스토리지(bucket)를 결정한다 (§4.8, D-024).
- Wave 1에서는 `FakeIdentityPort`(Institute A/B 고정 반환)로 개발한다.

### 3.2 Events consumed

| event_type | 처리 |
|---|---|
| `readiness.validation.completed.v1` | `catalog.readiness_summaries` upsert → `index_queue`에 dataset 추가 (primary profile 규칙 §4.5) |
| `identity.organization.created.v1` | 선택. 기관명 캐시 무효화 후 해당 기관 dataset 재색인 |

---

## 4. Data Model (`catalog.*`)

공통: 모든 시간 `timestamptz`(UTC), ID는 앱에서 UUIDv7 생성. 다른 schema로의 FK 금지 (`owner_organization_id`, `created_by` 등은 FK 없는 uuid).

### 4.1 `catalog.datasets`

| column | type | null | default | constraint |
|---|---|---|---|---|
| dataset_id | uuid | N | | PK |
| owner_organization_id | uuid | N | | |
| title | text | N | | length 3..300 |
| description | text | N | `''` | length ≤ 20000 |
| keywords | text[] | N | `'{}'` | cardinality ≤ 30 |
| domain | text | Y | | |
| access_level | text | N | | IN (`PUBLIC`,`INTERNAL`,`CONTROLLED`,`SENSITIVE`) |
| license | text | N | | length ≥ 1 |
| usage_policy | text | Y | | length ≤ 10000 |
| allowed_purposes | text[] | N | | cardinality ≥ 1, 원소 ∈ Purpose enum |
| approval_required | boolean | N | `true` | CONTROLLED/SENSITIVE이면 항상 true |
| max_grant_days | integer | N | `180` | 1..365 |
| contact_email | text | Y | | |
| provenance | text | Y | | length ≤ 10000 |
| status | text | N | `'ACTIVE'` | IN (`ACTIVE`,`WITHDRAWN`) |
| created_by | uuid | N | | |
| created_at | timestamptz | N | `now()` | |
| updated_at | timestamptz | N | `now()` | |
| row_version | integer | N | `1` | optimistic lock |

- CHECK `ck_datasets_sensitive_max_days`: `access_level <> 'SENSITIVE' OR max_grant_days <= 30`
- Index: `ix_datasets_owner_org (owner_organization_id)`, `ix_datasets_status (status)`

### 4.2 `catalog.dataset_versions`

| column | type | null | default | constraint |
|---|---|---|---|---|
| dataset_version_id | uuid | N | | PK |
| dataset_id | uuid | N | | FK → `catalog.datasets` |
| version_label | text | N | | `^[A-Za-z0-9._-]{1,32}$` |
| status | text | N | `'DRAFT'` | IN (`DRAFT`,`PUBLISHED`,`WITHDRAWN`) |
| change_note | text | Y | | ≤ 2000 |
| file_count | integer | N | `0` | ≥ 0 |
| total_bytes | bigint | N | `0` | ≥ 0 |
| manifest_sha256 | char(64) | Y | | publish 시 설정 |
| metadata_snapshot | jsonb | Y | | publish 시 dataset metadata 동결본 (§6.9) |
| published_at | timestamptz | Y | | |
| published_by | uuid | Y | | |
| created_by | uuid | N | | |
| created_at | timestamptz | N | `now()` | |
| updated_at | timestamptz | N | `now()` | |

- UNIQUE `uq_versions_label (dataset_id, version_label)`
- CHECK `ck_versions_published`: `status = 'DRAFT' OR (manifest_sha256 IS NOT NULL AND published_at IS NOT NULL AND metadata_snapshot IS NOT NULL)`
- Index: `ix_versions_dataset (dataset_id, created_at DESC)`
- Trigger `trg_versions_immutable` (BEFORE UPDATE): `OLD.status = 'PUBLISHED'`이면 `status → 'WITHDRAWN'`과 `updated_at` 변경 외 모든 변경을 거부(RAISE). DB 레벨 immutability 보장.

### 4.3 `catalog.dataset_files`

| column | type | null | default | constraint |
|---|---|---|---|---|
| file_id | uuid | N | | PK |
| dataset_version_id | uuid | N | | FK → `catalog.dataset_versions` |
| upload_session_id | uuid | N | | FK → `catalog.upload_sessions` |
| path | text | N | | `^[A-Za-z0-9._/-]{1,512}$`, `..`·선행 `/`·`//` 금지 |
| size_bytes | bigint | N | | 1..53687091200 (50 GiB) |
| sha256 | char(64) | N | | `^[a-f0-9]{64}$` (클라이언트 선언값) |
| media_type | text | N | | allow list (§6.6) |
| storage_bucket | text | N | | |
| storage_key | text | N | | `datasets/{dataset_id}/{dataset_version_id}/{path}` |
| multipart_upload_id | text | Y | | multipart일 때 |
| part_size_bytes | bigint | Y | | |
| status | text | N | `'PENDING'` | IN (`PENDING`,`UPLOADED`,`VERIFIED`,`FAILED`) |
| failure_code | text | Y | | §6.7 |
| scan_status | text | N | `'SKIPPED'` | IN (`CLEAN`,`INFECTED`,`SKIPPED`) |
| verified_at | timestamptz | Y | | |
| created_at | timestamptz | N | `now()` | |
| updated_at | timestamptz | N | `now()` | |

- UNIQUE `uq_files_path (dataset_version_id, path)`
- Index: `ix_files_session (upload_session_id)`, `ix_files_status (status) WHERE status IN ('PENDING','UPLOADED')`
- Trigger `trg_files_immutable`: 소속 version이 `PUBLISHED`이면 UPDATE/DELETE 거부.

### 4.4 `catalog.upload_sessions`

| column | type | null | default | constraint |
|---|---|---|---|---|
| upload_session_id | uuid | N | | PK |
| dataset_version_id | uuid | N | | FK → `catalog.dataset_versions` |
| status | text | N | `'OPEN'` | IN (`OPEN`,`COMPLETED`,`EXPIRED`) |
| created_by | uuid | N | | |
| expires_at | timestamptz | N | | created_at + 1h |
| completed_at | timestamptz | Y | | |
| created_at | timestamptz | N | `now()` | |

- Index: `ix_sessions_open (expires_at) WHERE status = 'OPEN'`

### 4.5 `catalog.readiness_summaries` (read model)

| column | type | null | default | constraint |
|---|---|---|---|---|
| dataset_version_id | uuid | N | | PK (part) |
| profile_id | text | N | | PK (part) |
| dataset_id | uuid | N | | |
| validation_id | uuid | N | | |
| run_status | text | N | | `COMPLETED`/`FAILED` |
| overall_status | text | Y | | `PASS`/`WARNING`/`FAIL` |
| completed_at | timestamptz | N | | event `occurred_at` |
| source_event_id | uuid | N | | |

- PK `(dataset_version_id, profile_id)`. 더 오래된 `occurred_at`의 이벤트는 무시(out-of-order 방어).
- **Primary profile 규칙**: `DatasetVersionSummary.readiness_overall`과 검색 필드 `readiness_overall`은
  `TABULAR_ML_BASIC`의 COMPLETED 결과가 있으면 그 값, 없으면 `GENERIC_BASIC`의 COMPLETED 결과, 둘 다 없으면 `null`.
  FAILED run은 `readiness_overall`에 반영하지 않는다.

### 4.6 `catalog.index_queue`

| column | type | null | default | constraint |
|---|---|---|---|---|
| dataset_id | uuid | N | | PK |
| enqueued_at | timestamptz | N | `now()` | |
| attempts | integer | N | `0` | |

- 데이터 변경 트랜잭션 안에서 `INSERT ... ON CONFLICT (dataset_id) DO UPDATE SET enqueued_at = now()`.
- indexer job이 drain 후 삭제한다 (§10). OpenSearch가 system of record가 아님을 보장.

### 4.7 `catalog.processed_events`

| column | type | null | default |
|---|---|---|---|
| event_id | uuid | N | PK |
| event_type | text | N | |
| processed_at | timestamptz | N | `now()` |

### 4.8 Storage 배치

- Bucket: owner organization `code` → env `STORAGE_<CODE>_BUCKET` (code를 대문자화, `-`→`_`. 예: `inst-b` → `STORAGE_INST_B_BUCKET=nais-inst-b`).
- Key: `datasets/{dataset_id}/{dataset_version_id}/{path}`
- 기관 스토리지 설정이 없는 기관으로 Dataset 생성 시 `422 VALIDATION_FAILED` (`details.fields=[{"field":"owner_organization_id","reason":"STORAGE_NOT_CONFIGURED"}]`).
- 모든 bucket은 private. 서비스 자격증명은 API/worker만 가진다.

### 4.9 `manifest_sha256` 정의

```text
lines = sorted(files, key=path의 UTF-8 bytes)
text  = "".join(f"{path}\t{size_bytes}\t{sha256}\n" for each file)
manifest_sha256 = sha256(text.encode("utf-8")).hexdigest()
```
대상은 해당 version의 모든 `VERIFIED` 파일(= publish 시점 전체 파일). 결정론적이며 M05의 `input_fingerprint` 입력이다.

---

## 5. State Machines

### 5.1 Dataset Version

| From | To | Trigger | 조건 |
|---|---|---|---|
| (none) | DRAFT | `createDatasetVersion` | label 중복 없음 |
| DRAFT | PUBLISHED | `publishDatasetVersion` | 파일 ≥ 1, 모든 파일 `VERIFIED`, `OPEN` session의 미완료 파일 없음 |
| PUBLISHED | WITHDRAWN | (P0 API 없음, 운영 SQL/P1 API) | |
| PUBLISHED | DRAFT | **금지** | |

### 5.2 Dataset File

| From | To | Trigger |
|---|---|---|
| (none) | PENDING | `createUploadSession` |
| PENDING | UPLOADED | `completeUploadSession`: object 존재 + size 일치 (+ multipart complete 성공) |
| PENDING | FAILED | complete 시 object 없음(`OBJECT_MISSING`) / size 불일치 / session 만료 |
| UPLOADED | VERIFIED | sha256 일치 + type sniff 통과 + archive 검사 통과 + scan ≠ INFECTED |
| UPLOADED | FAILED | 검증 실패. storage object 즉시 삭제 |
| FAILED | PENDING | 같은 path로 새 upload session 생성 시 (행 재사용, 새 session id) |

### 5.3 Upload Session

| From | To | Trigger |
|---|---|---|
| (none) | OPEN | `createUploadSession` |
| OPEN | COMPLETED | `completeUploadSession` (파일별 결과와 무관하게 session은 종료) |
| OPEN | EXPIRED | `expires_at` 경과 (sweeper) — PENDING 파일은 FAILED(`SESSION_EXPIRED`), multipart abort |

### 5.4 Dataset

`ACTIVE` ↔ `WITHDRAWN` (`updateDataset.status`). WITHDRAWN dataset은 검색에서 제외되고 새 version 생성 불가.

---

## 6. API

모든 요청은 `AuthContext` 필요(401 `UNAUTHENTICATED`). "Steward" = `DATA_STEWARD ∈ ctx.org_roles` 이고 `ctx.organization_id == dataset.owner_organization_id`.

### 6.1 `createDataset` — `POST /datasets`
- 호출자: `owner_organization_id`의 Steward. 아니면 `403 FORBIDDEN`.
- 규칙:
  - `approval_required`는 요청 필드가 없으며, `CONTROLLED`/`SENSITIVE`이면 `true`, 그 외 `false`로 저장.
  - `SENSITIVE`인데 `max_grant_days > 30` → `422 INVALID_POLICY`. `SENSITIVE`이고 `max_grant_days` 미지정이면 기본 30.
  - 기관 스토리지 미설정 → `422 VALIDATION_FAILED` (§4.8).
- 부수효과: `catalog.dataset.created.v1`, `index_queue` 추가.
- 에러: `VALIDATION_FAILED`, `FORBIDDEN`, `INVALID_POLICY`.

### 6.2 `searchDatasets` — `GET /datasets`
- 호출자: 모든 인증 사용자.
- 가시성(D-012), OpenSearch query `filter`로 강제 (post-filter 금지):
  ```text
  status = ACTIVE
  AND (
        (access_level IN [PUBLIC, CONTROLLED, SENSITIVE] AND has_published_version = true)
     OR (owner_organization_id = ctx.organization_id)          # 자기 기관: INTERNAL, draft-only 포함
  )
  ```
- relevance: `multi_match(q, fields=[title^3, keywords.text^2, description, owner_organization_name.text])`. `q` 없으면 `updated_desc`.
- 정렬 tie-breaker는 항상 `dataset_id`. cursor = base64url(JSON `search_after` 값 배열).
- facets: `access_level`, `owner_organization_id`(label = 기관명), `purpose`(=`allowed_purposes`), `keyword`(top 20), `readiness_status`(=`readiness_overall`).
  P0 단순화: facet count는 모든 filter가 적용된 결과 집합 기준 (disjunctive faceting은 P1).
- `total`: `track_total_hits=10000`. 10000 초과 시 10000으로 표시.
- OpenSearch 장애 → `503 DEPENDENCY_UNAVAILABLE`. DB fallback 없음.
- 성능: 10k docs에서 p95 < 1.5s.

### 6.3 `getDataset` — `GET /datasets/{dataset_id}`
- 가시성 규칙은 §6.2와 동일하되 DB 기준으로 평가. 보이지 않으면 `404 NOT_FOUND`.
- `latest_published_version`: 가장 최근 `published_at`의 PUBLISHED version + `readiness_overall`(§4.5).

### 6.4 `updateDataset` — `PATCH /datasets/{dataset_id}`
- 호출자: Steward. 아니면 (보이면) `403 FORBIDDEN` / (안 보이면) `404`.
- `row_version` optimistic lock. 동시 수정 충돌 시 `409 CONFLICT`.
- 변경 후 정책 재검증 (`INVALID_POLICY`). `access_level`을 `SENSITIVE`로 올리면서 `max_grant_days > 30`이면 거부.
- 부수효과:
  - `access_level` 변경 → `catalog.dataset.access_level_changed.v1`
  - `allowed_purposes` / `approval_required` / `max_grant_days` 변경 → `catalog.dataset.policy_changed.v1` (`previous`, `current`)
  - 둘 다 바뀌면 두 이벤트 모두 발행 (같은 correlation_id)
  - 항상 `index_queue` 추가
- **기존 Grant는 변경하지 않는다** (openapi 명시). 이미 PUBLISHED된 version의 `metadata_snapshot`도 변경되지 않는다.
- WITHDRAWN dataset 수정: `status → ACTIVE`만 허용, 그 외 `409 CONFLICT`.

### 6.5 `getDatasetPolicy` — `GET /datasets/{dataset_id}/policy`
- `DatasetPolicyView` 반환. 가시성 규칙 §6.3. Governance는 HTTP 대신 `CatalogQueryPort.get_policy_view()`를 사용한다.

### 6.6 Versions & Upload

#### `listDatasetVersions` / `getDatasetVersion`
- Steward/소유기관 `ORG_ADMIN`/`PLATFORM_ADMIN`: 모든 상태. 그 외: `PUBLISHED`만 (DRAFT 단건 조회 → `404`).
- `files[]`(manifest: path, size, sha256, media_type, status)는 metadata이므로 dataset을 볼 수 있으면 반환. **URL·storage key는 절대 반환하지 않는다.**

#### `createDatasetVersion` — `POST /datasets/{id}/versions`
- Steward. dataset `ACTIVE` 필수 (WITHDRAWN → `409 CONFLICT`). label 중복 → `409 DATASET_VERSION_LABEL_EXISTS`.
- DRAFT version은 dataset당 동시에 여러 개 허용.

#### `createUploadSession` — `POST /dataset-versions/{id}/upload-session`
- Steward, version `DRAFT` (아니면 `409 DATASET_VERSION_IMMUTABLE`).
- 파일별 검증:
  - path 정규화: `..` segment, 선행 `/`, `//`, 제어문자 → `422 VALIDATION_FAILED`
  - 확장자 allow list (아래 표) 불일치 또는 `media_type`이 확장자 매핑과 불일치 → `422 FILE_TYPE_NOT_ALLOWED`
  - `size_bytes > 50 GiB` → `422 FILE_TOO_LARGE`
  - version 전체 파일 수 > 10,000 → `422 VALIDATION_FAILED`
  - 같은 path가 이미 `VERIFIED`/`UPLOADED`/`PENDING`(다른 OPEN session) → `409 CONFLICT`. `FAILED`면 행 재사용.
- 하나라도 실패하면 session 전체 거부 (부분 생성 없음).
- Upload 방식:
  - `size_bytes ≤ 64 MiB` (`STORAGE_MULTIPART_THRESHOLD_BYTES`): 단일 presigned `PUT`.
    서명 헤더 `Content-Type`, `x-amz-checksum-sha256`(선언 sha256의 base64) 포함 → 스토리지가 불일치 본문을 거부.
  - 초과: S3 multipart. `part_size_bytes = 64 MiB`, part별 presigned `UploadPart` URL (part 수 ≤ 10,000).
  - presign은 **public endpoint `NAIS_PUBLIC_BASE_URL`, path-style**, SigV4, region `us-east-1`, URL TTL `UPLOAD_URL_TTL_SECONDS`(3600).
    예: `http://localhost:21051/nais-inst-b/datasets/{dataset_id}/{version_id}/data/a.csv?X-Amz-...`
- session `expires_at = now + 1h`.

**Allow list (P0)**

| 확장자 | media_type | sniff 규칙 |
|---|---|---|
| `.csv` | `text/csv` | UTF-8(BOM 허용) 디코딩 가능, NUL 없음 (첫 8 KiB) |
| `.tsv` | `text/tab-separated-values` | 동일 |
| `.json` | `application/json` | 동일 + 첫 비공백 문자 `{` 또는 `[` |
| `.jsonl` | `application/x-ndjson` | 동일 |
| `.txt` | `text/plain` | UTF-8, NUL 없음 |
| `.md` | `text/markdown` | UTF-8, NUL 없음 |
| `.parquet` | `application/vnd.apache.parquet` | 시작·끝 4바이트 `PAR1` |
| `.h5`, `.hdf5` | `application/x-hdf5` | 시그니처 `\x89HDF\r\n\x1a\n` |
| `.nc` | `application/x-netcdf` | `CDF\x01`/`CDF\x02` 또는 HDF5 시그니처 |
| `.zip` | `application/zip` | `PK\x03\x04` + archive 검사 |

**Archive bomb 방어 (`.zip`)** — central directory만 읽어서 판정 (압축 해제 안 함):
- entry 수 ≤ 10,000
- 선언 uncompressed 합 ≤ 20 GiB
- entry별 압축률(uncompressed/compressed) ≤ 100
- entry 경로에 절대경로, `..`, symlink 속성 금지
- 중첩 archive(.zip 안의 .zip)는 허용하되 내부 검사는 하지 않음 (Known limitation)
- 위반 → file `FAILED`, `failure_code=ARCHIVE_UNSAFE`

#### `completeUploadSession` — `POST /upload-sessions/{id}/complete`
- 호출자: session 생성자 또는 같은 기관 Steward. session `OPEN` 필수, 만료 시 `409 UPLOAD_SESSION_EXPIRED`.
- 동기 처리:
  1. multipart 파일: 요청 `parts[]`로 `CompleteMultipartUpload` (누락 시 `422 VALIDATION_FAILED`)
  2. 파일별 `HEAD` → 없으면 `FAILED(OBJECT_MISSING)`, 크기 불일치면 `FAILED(SIZE_MISMATCH)` + object 삭제
  3. 통과 파일 → `UPLOADED`
  4. session `COMPLETED`
- 비동기 처리 (`catalog.verify_file` Dramatiq actor, 파일당 1 job):
  - storage에서 **스트리밍으로 sha256 재계산** (서버 재해시). 불일치 → `FAILED(CHECKSUM_MISMATCH)`, object 삭제
  - type sniff (첫 8 KiB / parquet 끝 4 바이트) → 불일치 `FAILED(TYPE_MISMATCH)`
  - zip 검사 → `FAILED(ARCHIVE_UNSAFE)`
  - `MalwareScannerPort.scan` → `INFECTED`면 `FAILED(MALWARE_DETECTED)`, object 삭제
  - 모두 통과 → `VERIFIED`, `verified_at`
  - session 내 총 크기 ≤ 256 MiB면 complete 응답 전에 동기로 수행해 즉시 `VERIFIED`를 반환 (UX용 최적화, 결과 동일)
- 응답: `UploadSession` (파일별 `status`, `failure_code`). 클라이언트는 `UPLOADED` 파일이 `VERIFIED`가 될 때까지 `getUploadSession`(또는 `getDatasetVersion`)을 polling한다.
- **비용 메모**: 서버 재해시는 파일 전체를 한 번 더 읽는다 (50 GiB 파일 ≈ 수 분, 스토리지 egress). P1에서는 스토리지 측 checksum(`x-amz-checksum-sha256` / multipart composite checksum)을 신뢰해 재해시를 생략하는 방향을 검토한다.
- 에러: `UPLOAD_SESSION_EXPIRED`, `VALIDATION_FAILED`, `FORBIDDEN`, `NOT_FOUND`.

**failure_code 값**: `OBJECT_MISSING`, `SIZE_MISMATCH`, `CHECKSUM_MISMATCH`, `TYPE_MISMATCH`, `ARCHIVE_UNSAFE`, `MALWARE_DETECTED`, `SESSION_EXPIRED`.
API 에러 코드로 매핑할 때: `CHECKSUM_MISMATCH`/`SIZE_MISMATCH` → `UPLOAD_CHECKSUM_MISMATCH`, `TYPE_MISMATCH` → `FILE_TYPE_NOT_ALLOWED`, `ARCHIVE_UNSAFE` → `UPLOAD_ARCHIVE_UNSAFE`, `MALWARE_DETECTED` → `MALWARE_DETECTED`.

#### `getUploadSession` — `GET /upload-sessions/{id}`
- Steward. 파일별 `status`/`failure_code` 조회용. session이 COMPLETED/EXPIRED면 presigned URL은 응답에서 제외한다.

#### `deleteDraftFile` — `DELETE /dataset-versions/{version_id}/files/{file_id}`
- Steward, DRAFT version만 (PUBLISHED → `409 DATASET_VERSION_IMMUTABLE`). manifest 행과 스토리지 object를 삭제한다. 이벤트 없음(DRAFT는 감사 대상 아님).

#### 6.9 `publishDatasetVersion` — `POST /dataset-versions/{id}/publish`
- Steward. version `DRAFT` 필수 (PUBLISHED면 `409 DATASET_VERSION_IMMUTABLE`).
- 파일 0개, 또는 `VERIFIED`가 아닌 파일 존재(`FAILED` 포함) → `409 DATASET_VERSION_INCOMPLETE` (`details.files=[{file_id,path,status}]`).
  FAILED 파일은 같은 path로 재업로드하거나 `deleteDraftFile`로 제거한다.
- 한 트랜잭션에서:
  1. `manifest_sha256` 계산 (§4.9), `file_count`, `total_bytes`
  2. `metadata_snapshot` 저장: 그 시점 dataset의 `title, description, keywords, domain, access_level, license, usage_policy, allowed_purposes, max_grant_days, contact_email, provenance` (JSON, key 정렬). M05는 live dataset이 아니라 이 snapshot을 평가한다 → 같은 version의 판정 결정론 보장
  3. `status=PUBLISHED`, `published_at`, `published_by`
  4. `catalog.dataset.version_published.v1` outbox insert
  5. `index_queue` 추가
- 이후 version과 파일은 DB trigger로 불변. storage object 삭제 경로도 API에 없다.

---

## 7. Events

### 7.1 Produced

| event_type | 시점 | payload 핵심 |
|---|---|---|
| `catalog.dataset.created.v1` | createDataset commit | dataset_id, owner_organization_id, title, access_level |
| `catalog.dataset.access_level_changed.v1` | updateDataset에서 access_level 변경 | previous_access_level, access_level |
| `catalog.dataset.policy_changed.v1` | allowed_purposes/approval_required/max_grant_days 변경 | previous, current (DatasetPolicy) |
| `catalog.dataset.version_published.v1` | publish commit | dataset_version_id, version_label, file_count, total_bytes, manifest_sha256 |

actor는 호출자(`USER`). `correlation_id`는 요청 trace id.

### 7.2 Consumed
§3.2 참조. handler는 `catalog.processed_events`로 멱등 처리 (D-006).

---

## 8. Public Service Interface (다른 모듈용)

`apps/api/modules/catalog/public.py`에서만 export. 다른 모듈은 이 파일 외 catalog 코드를 import하지 않는다.

```python
from dataclasses import dataclass
from datetime import datetime
from typing import BinaryIO, Literal, Protocol, Sequence
from uuid import UUID

AccessLevel = Literal["PUBLIC", "INTERNAL", "CONTROLLED", "SENSITIVE"]

@dataclass(frozen=True)
class DatasetPolicyView:            # = openapi DatasetPolicyView
    dataset_id: UUID
    owner_organization_id: UUID
    access_level: AccessLevel
    allowed_purposes: tuple[str, ...]
    approval_required: bool
    max_grant_days: int
    status: Literal["ACTIVE", "WITHDRAWN"]
    title: str

@dataclass(frozen=True)
class FileRef:
    file_id: UUID
    path: str
    size_bytes: int
    sha256: str
    media_type: str
    status: Literal["PENDING", "UPLOADED", "VERIFIED", "FAILED"]
    storage_bucket: str             # 내부 전용. API 응답·이벤트·로그에 노출 금지
    storage_key: str

@dataclass(frozen=True)
class VersionView:
    dataset_version_id: UUID
    dataset_id: UUID
    owner_organization_id: UUID
    version_label: str
    status: Literal["DRAFT", "PUBLISHED", "WITHDRAWN"]
    manifest_sha256: str | None
    metadata_snapshot: dict | None  # PUBLISHED에서만 not None
    files: tuple[FileRef, ...]      # path 오름차순

class CatalogQueryPort(Protocol):
    """Governance(M04), Readiness(M05)용 조회. 권한 판단은 하지 않는다 (is_visible 제외)."""
    def get_policy_view(self, dataset_id: UUID) -> DatasetPolicyView | None: ...
    def get_version(self, dataset_version_id: UUID) -> VersionView | None: ...
    def is_visible(self, ctx: "AuthContext", dataset_id: UUID) -> bool: ...   # D-012 metadata 가시성

@dataclass(frozen=True)
class PresignedGet:
    file_id: UUID
    path: str
    url: str
    size_bytes: int
    sha256: str
    expires_at: datetime

class StoragePort(Protocol):
    """Governance 전용. 호출 전에 Governance가 권한을 결정했다는 전제.
    Catalog는 요청된 파일이 해당 version의 VERIFIED 파일인지 확인만 하고 URL을 서명한다."""
    def presign_get(
        self,
        dataset_version_id: UUID,
        file_ids: Sequence[UUID] | None,   # None = 전체
        ttl_seconds: int,                  # STORAGE_PRESIGN_TTL_SECONDS (300)
    ) -> list[PresignedGet]: ...           # 알 수 없는 file_id → ValueError(NOT_FOUND)

class CatalogReadPort(Protocol):
    """Readiness(M05) worker 전용. 서비스 자격증명으로 읽기 (D-018). 사용자 grant와 무관."""
    def open_stream(self, file: FileRef, byte_range: tuple[int, int] | None = None) -> BinaryIO: ...
```

원칙:
- Catalog HTTP API에는 **다운로드 URL을 반환하는 endpoint가 없다.** URL은 `StoragePort.presign_get`을 통해 Governance의 `createDownloadSession`에서만 발급된다.
- `presign_get`의 URL도 `NAIS_PUBLIC_BASE_URL` path-style, `ResponseContentDisposition=attachment; filename="<basename>"`.
- `StoragePort`, `CatalogReadPort`는 M04, M05 모듈에만 wiring한다 (DI container에서 주입 대상 제한).

---

## 9. Authorization Matrix

| Operation | 인증 사용자 | 소유기관 멤버 | 소유기관 DATA_STEWARD | 소유기관 ORG_ADMIN | PLATFORM_ADMIN |
|---|---|---|---|---|---|
| searchDatasets | D-012 가시분 | + INTERNAL, draft-only | 동일 | 동일 | D-012 가시분 + 전체 조회 옵션 없음(P0) |
| getDataset / getDatasetPolicy | D-012 | O | O | O | O |
| createDataset | X | X | O | X | X |
| updateDataset | X | X | O | X | X |
| listDatasetVersions / getDatasetVersion | PUBLISHED만 | PUBLISHED만 | 전체 | 전체 | 전체 |
| createDatasetVersion / createUploadSession / publish | X | X | O | X | X |
| completeUploadSession | 생성자 | 생성자 | O | X | X |
| 파일 다운로드 | **Catalog에 없음 (M04)** | | | | |

비가시 리소스는 `404`, 가시하지만 권한 없는 쓰기는 `403 FORBIDDEN`.

---

## 10. Background Jobs

| Job | 방식 | 주기 | 동작 |
|---|---|---|---|
| `catalog.index_drain` | worker scheduler | 2초 | `index_queue`에서 최대 200건 `FOR UPDATE SKIP LOCKED` → DB에서 문서 재구성 → OpenSearch upsert (WITHDRAWN이면 delete) → 삭제. 실패 시 `attempts+1`, 지수 backoff, 10회 초과 시 error log + metric |
| `catalog.verify_file` | Dramatiq actor | 이벤트성 | §6.6 비동기 검증. time_limit 2h, 재시도 3회(스토리지 연결 오류만) |
| `catalog.expire_upload_sessions` | scheduler | 5분 | OPEN & `expires_at < now` → EXPIRED, PENDING 파일 FAILED(`SESSION_EXPIRED`), `AbortMultipartUpload`, 부분 object 삭제 |
| `catalog.reindex_all` | CLI `python -m modules.catalog.reindex` | 수동 | 새 index `nais-datasets-v{n}` 생성 → 전체 색인 → alias `nais-datasets` 원자적 전환 |

### OpenSearch index `nais-datasets-v1` (alias `nais-datasets`)

```json
{
  "settings": {
    "number_of_shards": 1,
    "analysis": {
      "analyzer": {
        "ko_en": {
          "type": "custom",
          "tokenizer": "nori_mixed",
          "filter": ["lowercase", "nori_part_of_speech", "nori_readingform"]
        }
      },
      "tokenizer": { "nori_mixed": { "type": "nori_tokenizer", "decompound_mode": "mixed" } },
      "normalizer": { "lc": { "type": "custom", "filter": ["lowercase"] } }
    }
  },
  "mappings": {
    "dynamic": "strict",
    "properties": {
      "dataset_id":              { "type": "keyword" },
      "title":                   { "type": "text", "analyzer": "ko_en", "fields": { "raw": { "type": "keyword", "normalizer": "lc" } } },
      "description":             { "type": "text", "analyzer": "ko_en" },
      "snippet":                 { "type": "keyword", "index": false },
      "keywords":                { "type": "keyword", "normalizer": "lc", "fields": { "text": { "type": "text", "analyzer": "ko_en" } } },
      "domain":                  { "type": "keyword" },
      "access_level":            { "type": "keyword" },
      "owner_organization_id":   { "type": "keyword" },
      "owner_organization_name": { "type": "keyword", "fields": { "text": { "type": "text", "analyzer": "ko_en" } } },
      "allowed_purposes":        { "type": "keyword" },
      "license":                 { "type": "keyword" },
      "status":                  { "type": "keyword" },
      "has_published_version":   { "type": "boolean" },
      "latest_version_id":       { "type": "keyword" },
      "latest_version_label":    { "type": "keyword" },
      "readiness_overall":       { "type": "keyword" },
      "published_at":            { "type": "date" },
      "updated_at":              { "type": "date" }
    }
  }
}
```

- `snippet` = description 앞 300자 (색인 시 생성).
- **nori fallback**: `analysis-nori` 플러그인이 없는 환경에서는 `ko_en`을 `standard` tokenizer + `lowercase` + `cjk_bigram` filter로 정의한 대체 template을 사용한다. index 이름은 동일하고 한국어 형태소 품질만 떨어진다. `infra/opensearch/Dockerfile`은 nori를 기본 설치한다.
- `sort=title_asc` → `title.raw`, `updated_desc` → `updated_at`, `relevance` → `_score`. tie-breaker는 항상 `dataset_id`.

---

## 11. Config / Env

| 변수 | 기본값 | 설명 |
|---|---|---|
| `NAIS_PUBLIC_BASE_URL` | `http://localhost:21051` | presign endpoint (path-style) |
| `STORAGE_<CODE>_ENDPOINT` | 예 `http://minio-a:9000` | 내부 endpoint (HEAD, 해시, multipart complete) |
| `STORAGE_<CODE>_BUCKET` | 예 `nais-inst-a` | 기관 bucket |
| `STORAGE_<CODE>_ACCESS_KEY` / `STORAGE_<CODE>_SECRET_KEY` | (secret) | 기관 스토리지 서비스 자격증명 |
| `STORAGE_PRESIGN_TTL_SECONDS` | `300` | 다운로드 URL TTL (StoragePort) |
| `UPLOAD_URL_TTL_SECONDS` | `3600` | 업로드 URL TTL |
| `UPLOAD_SESSION_TTL_SECONDS` | `3600` | session 만료 |
| `STORAGE_MULTIPART_THRESHOLD_BYTES` | `67108864` | 64 MiB |
| `CATALOG_SYNC_VERIFY_MAX_BYTES` | `268435456` | complete 시 동기 검증 상한 |
| `OPENSEARCH_URL` | `http://opensearch:9200` | |
| `CATALOG_INDEX_ALIAS` | `nais-datasets` | |
| `MALWARE_SCANNER` | `noop` | `noop` / (P1) `clamav` |

---

## 12. Acceptance Tests

| ID | Given | When | Then |
|---|---|---|---|
| M03-AT-01 | Institute B steward | CONTROLLED dataset 생성 | 201, `approval_required=true`, `catalog.dataset.created.v1` 1건 |
| M03-AT-02 | Institute B researcher(steward 아님) | createDataset | 403 `FORBIDDEN`, 이벤트 없음 |
| M03-AT-03 | Institute A steward | owner=Institute B로 createDataset | 403 `FORBIDDEN` |
| M03-AT-04 | steward | SENSITIVE, `max_grant_days=60` | 422 `INVALID_POLICY` |
| M03-AT-05 | DRAFT v1 | 1 KiB csv upload session → PUT → complete | 파일 `VERIFIED`, 응답 URL host가 `localhost:21051`, path `/nais-inst-b/datasets/...` |
| M03-AT-06 | DRAFT v1 | 100 MiB 파일 session | `method=MULTIPART`, parts 2개, complete 후 `VERIFIED` |
| M03-AT-07 | 선언 sha256과 다른 내용 업로드(multipart) | complete + verify | `FAILED(CHECKSUM_MISMATCH)`, storage object 없음 |
| M03-AT-08 | `.exe` 또는 `media_type` 불일치 | createUploadSession | 422 `FILE_TYPE_NOT_ALLOWED`, 파일 행 없음 |
| M03-AT-09 | 압축률 1000:1 zip | complete + verify | `FAILED(ARCHIVE_UNSAFE)` |
| M03-AT-10 | path `../etc/passwd` | createUploadSession | 422 `VALIDATION_FAILED` |
| M03-AT-11 | 파일 0개 DRAFT | publish | 409 `DATASET_VERSION_INCOMPLETE` |
| M03-AT-12 | v1 PUBLISHED | createUploadSession(v1) | 409 `DATASET_VERSION_IMMUTABLE`; DB에서 직접 UPDATE 시 trigger 거부 |
| M03-AT-13 | v1 PUBLISHED | v2 생성 / label `v1` 재사용 | v2 201 / 409 `DATASET_VERSION_LABEL_EXISTS` |
| M03-AT-14 | 같은 파일 집합을 다른 순서로 업로드한 두 version | publish | 두 `manifest_sha256` 동일 |
| M03-AT-15 | Institute B INTERNAL dataset | Institute A 사용자 search / GET | 검색 결과 없음 / 404 |
| M03-AT-16 | Institute B CONTROLLED dataset, v1 PUBLISHED | Institute A 사용자 search | 결과 포함, facet `access_level.CONTROLLED ≥ 1`, 응답에 URL·storage key 없음 |
| M03-AT-17 | CONTROLLED dataset, DRAFT만 존재 | Institute A 사용자 search / GET v-draft | 결과 없음 / 404 |
| M03-AT-18 | 모든 catalog router | route 목록 검사(contract test) | presigned GET URL을 반환하는 endpoint 없음 |
| M03-AT-19 | dataset PUBLISHED | `readiness.validation.completed.v1`(TABULAR_ML_BASIC, FAIL) 수신 | 10초 내 search hit `readiness_overall=FAIL`; 같은 이벤트 재전달 시 변화 없음 |
| M03-AT-20 | 10k dataset 문서 | 50 concurrent search | p95 < 1.5s |
| M03-AT-21 | access_level CONTROLLED → PUBLIC | updateDataset | `access_level_changed.v1` 1건, 기존 grant 행 변화 없음(M04 확인) |
| M03-AT-22 | upload session 1h 경과 | sweeper 실행 | session EXPIRED, PENDING 파일 FAILED, multipart abort |
| M03-AT-23 | `StoragePort.presign_get`에 다른 version의 file_id | 호출 | NOT_FOUND 예외, URL 미발급 |
| M03-AT-24 | 한국어 제목 "고분자 전해질 막 측정" | q=`전해질` | 검색 결과 포함 (nori) |

---

## 13. Deliverables & Known Limitations

### Deliverables (02 §8 공통 + 모듈 특화)
1. `apps/api/modules/catalog/README.md`
2. Router (openapi operationId와 1:1), `public.py` Ports
3. Alembic migrations (`catalog` schema, trigger 포함)
4. Outbox 이벤트 4종 + consumer 2종
5. Error code 매핑 테스트
6. Unit / contract / integration 테스트 (MinIO, OpenSearch testcontainer)
7. Seed: Institute A/B dataset (10_SEED_DATA.md 기준)
8. `infra/opensearch/Dockerfile`, `nais-datasets-v1.json`, fallback template
9. Integration notes (M04: `StoragePort`/`CatalogQueryPort`, M05: `CatalogReadPort`/`metadata_snapshot`)

### Known limitations (P0)
- DRAFT version의 파일 삭제 API 없음 → FAILED 파일은 같은 path로 재업로드해야 publish 가능
- version/dataset WITHDRAWN 전용 API와 이벤트 없음 (dataset은 PATCH status로만)
- 중첩 archive 내부 검사 없음, malware scan은 Noop
- 서버 재해시 비용 (P1: storage-side checksum)
- facet count는 disjunctive가 아님, `total` 최대 10000
- 기관명 변경 시 재색인은 이벤트가 없어 수동 `reindex_all`


---

# FILE: modules/M04_access_governance.md

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
from nais.catalog.ports import DatasetPolicyView, VersionView, PresignedGet  # 계약 타입만 import

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
| M04-AT-18 | AT-11 URL | 쿼리의 object key/`X-Amz-Expires`/서명 한 글자 변조 후 GET, 또는 다른 file의 path로 교체 | MinIO 403 (`SignatureDoesNotMatch`/`AccessDenied`) (**URL tampering 불가**). 301초 후 원본 URL GET → 403 (만료) |
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
- `FILE_DOWNLOADED` 감사는 **URL 발급 기준**이며 실제 전송 완료를 의미하지 않는다(D-017). P1에서 MinIO bucket notification/access log 연동.
- Grant subject는 사용자 1명(D-008). 같은 프로젝트 공동연구자도 각자 요청해야 한다.
- `COMPUTE`/`WRITE` operation은 enum만 존재, P0에서 부여 불가.
- Reviewer의 GET이 상태를 바꾸는(SUBMITTED → UNDER_REVIEW) 부수효과가 있다. 이 전이는 이벤트/감사가 없다.
- 단일 승인자 모델. 다단계 승인, 승인 위임, 부재 시 대리 승인 없음.
- Policy 변경(`allowed_purposes`, `max_grant_days` 축소)은 기존 grant에 소급 적용되지 않는다. 필요 시 steward가 수동 revoke.


---

# FILE: modules/M05_ai_ready.md

# M05 AI-Ready Pipeline

> v1.1 상세 명세. 판정 규칙·임계값·fixture는 `09_AI_READY_RULES.md`에 있다.
> 기준 문서: `contracts/openapi.yaml`(readiness tag), `contracts/events/p0_events.schema.json`, `contracts/error_codes.json`, `11_DECISION_LOG.md`(D-018).

---

## 1. Goal / Scope

### Goal
Dataset Version이 특정 AI 활용 profile의 요구를 충족하는지 **결정론적으로** 검증하고, 판정과 함께 **검증 근거(evidence)**를 보여준다 ("Evidence over Score").

### P0
- Profiles: `GENERIC_BASIC@1.0.0`, `TABULAR_ML_BASIC@1.0.0`
- Validators 9종: metadata completeness, schema presence, datatype validity, missing value summary, unit/codebook presence, provenance presence, license/usage policy presence, file checksum, semantic mapping status
- 결과: check별 `PASS / WARNING / FAIL / NOT_APPLICABLE` + evidence, overall `PASS / WARNING / FAIL`
- Run 상태 `QUEUED → RUNNING → COMPLETED / FAILED`
- publish 시 자동 실행, steward 수동 실행, 동일 입력 결과 재사용
- 4개 test fixture와 golden 결과

### 중요
- **LLM이 pass/fail을 판정하지 않는다.** 네트워크 조회도 하지 않는다.
- 같은 input / version / profile이면 같은 validation 결과.
- evidence에 원본 데이터 값을 넣지 않는다 (D-018).

### Out of scope (P0)
- 데이터 변환(transform), 단위 정규화, metadata enrichment
- 비표 형식(HDF5, NetCDF, JSON) 내부 구조 검증 — 해당 check는 T 기준이므로 `NOT_APPLICABLE`
- 사용자 정의 profile

### 후속 단계 (P1)
- transform job (결과를 새 DRAFT version으로 M03에 등록, 산출물 bucket `nais-platform`)
- unit normalization, metadata enrichment
- ontology mapping assistance (M11 mapping을 `semantics.mapping_status` 출처로 추가)
- LLM은 **제안(assistance)**에만 사용 가능하며 판정 경로에는 들어오지 않는다

---

## 2. Ownership

| 항목 | 값 |
|---|---|
| Agent | Agent 5 — Readiness |
| Paths | `apps/api/modules/readiness`, `tests/fixtures/readiness` |
| DB schema | `readiness` |
| Migrations | `apps/api/modules/readiness/migrations` (`readiness.alembic_version`) |
| 코드 구성 | `validators/` (check별 1파일), `profiles/*.yaml`, `dictionaries/` (`ucum_atoms_v1.txt`, `ucum_prefixes_v1.txt`, `unit_aliases_v1.csv`, `spdx_license_ids_v1.txt`), `schemas/table_schema_subset_v1.json` |

worker 진입점 `apps/api/worker.py`는 Agent 0 소유이며, readiness는 `register(broker, scheduler)` 함수로 actor와 event handler를 등록한다.

---

## 3. Dependencies

### 3.1 Ports consumed

```python
from typing import BinaryIO, Protocol
from uuid import UUID

class CatalogQueryPort(Protocol):     # M03 public.py
    def get_version(self, dataset_version_id: UUID) -> "VersionView | None": ...
    def is_visible(self, ctx: "AuthContext", dataset_id: UUID) -> bool: ...

class CatalogReadPort(Protocol):      # M03 public.py, 서비스 자격증명 (D-018)
    def open_stream(self, file: "FileRef", byte_range: tuple[int, int] | None = None) -> BinaryIO: ...

class AuthContext(Protocol):          # M00
    user_id: UUID
    organization_id: UUID
    org_roles: frozenset[str]
    platform_roles: frozenset[str]
    trace_id: str
```

- `VersionView`, `FileRef` 정의는 `modules/M03_data_catalog.md` §8.
- 평가 입력은 `VersionView.metadata_snapshot` + `files` + bytes. live dataset metadata는 쓰지 않는다.
- Wave 1: `FakeCatalogPort`가 `tests/fixtures/readiness/<fixture>/`를 VersionView로 노출 (로컬 파일 stream).

### 3.2 Events consumed

| event_type | 처리 |
|---|---|
| `catalog.dataset.version_published.v1` | `GENERIC_BASIC` 자동 enqueue. `CatalogQueryPort.get_version`으로 T(csv/tsv/parquet, `_` 접두어 제외) ≠ ∅이면 `TABULAR_ML_BASIC`도 enqueue. `triggered_by=AUTO_ON_PUBLISH`, `requested_by=null` |

---

## 4. Data Model (`readiness.*`)

### 4.1 `readiness.validations`

| column | type | null | default | constraint |
|---|---|---|---|---|
| validation_id | uuid | N | | PK |
| dataset_version_id | uuid | N | | |
| dataset_id | uuid | N | | |
| owner_organization_id | uuid | N | | |
| profile_id | text | N | | IN (`GENERIC_BASIC`,`TABULAR_ML_BASIC`) (코드 registry와 동기) |
| profile_version | text | N | | semver |
| validator_version | text | N | | semver |
| input_fingerprint | char(64) | N | | |
| run_status | text | N | `'QUEUED'` | IN (`QUEUED`,`RUNNING`,`COMPLETED`,`FAILED`) |
| overall_status | text | Y | | IN (`PASS`,`WARNING`,`FAIL`); `run_status='COMPLETED'` ⇔ NOT NULL |
| summary | jsonb | Y | | `{"pass":n,"warning":n,"fail":n,"not_applicable":n}` |
| result_sha256 | char(64) | Y | | COMPLETED에서 필수 (09 §4) |
| error | text | Y | | FAILED에서 필수 (오류 코드 + 짧은 설명, 데이터 값 금지) |
| triggered_by | text | N | | IN (`AUTO_ON_PUBLISH`,`USER`) |
| requested_by | uuid | Y | | USER일 때 |
| attempt | integer | N | `0` | |
| correlation_id | uuid | N | | 이벤트 발행용 |
| created_at | timestamptz | N | `now()` | |
| started_at | timestamptz | Y | | |
| completed_at | timestamptz | Y | | |

- UNIQUE partial `uq_validation_inflight (dataset_version_id, profile_id) WHERE run_status IN ('QUEUED','RUNNING')` → 동시 실행 방지
- UNIQUE partial `uq_validation_reuse (dataset_version_id, profile_id, input_fingerprint) WHERE run_status = 'COMPLETED'`
- Index `ix_validation_latest (dataset_version_id, profile_id, created_at DESC)`
- CHECK `ck_completed`: `run_status <> 'COMPLETED' OR (overall_status IS NOT NULL AND result_sha256 IS NOT NULL AND completed_at IS NOT NULL)`
- CHECK `ck_failed`: `run_status <> 'FAILED' OR error IS NOT NULL`

### 4.2 `readiness.check_results`

| column | type | null | default | constraint |
|---|---|---|---|---|
| validation_id | uuid | N | | FK → `readiness.validations` ON DELETE CASCADE |
| check_id | text | N | | |
| ordinal | smallint | N | | profile 내 순서 |
| severity | text | N | | IN (`REQUIRED`,`RECOMMENDED`) |
| status | text | N | | IN (`PASS`,`WARNING`,`FAIL`,`NOT_APPLICABLE`) |
| message | text | N | | 한국어 1~2문장 |
| evidence | jsonb | N | `'{}'` | 크기 ≤ 64 KiB (초과 시 배열 절단 + `"truncated": true`) |

- PK `(validation_id, check_id)`
- COMPLETED 이후 insert/update 금지 (앱 레벨 + trigger)

### 4.3 `readiness.processed_events`

| column | type | null | default |
|---|---|---|---|
| event_id | uuid | N | PK |
| event_type | text | N | |
| processed_at | timestamptz | N | `now()` |

Profile 정의는 DB가 아니라 코드(`profiles/*.yaml`)에 둔다. 코드 리뷰를 거친 정의만 판정에 쓰이게 하기 위함이다.

---

## 5. State Machine

| From | To | Trigger | 비고 |
|---|---|---|---|
| (none) | QUEUED | 수동 요청 / publish 이벤트 | fingerprint 계산 후 insert |
| QUEUED | RUNNING | worker가 job 수신 | `attempt+1`, `started_at`, `readiness.validation.started.v1` |
| RUNNING | COMPLETED | 모든 check 평가 완료 | check_results insert, overall 집계, `readiness.validation.completed.v1(run_status=COMPLETED)` |
| RUNNING | FAILED | 평가 불가: 코드 예외, timeout, 파일 없음(storage 404), 재시도 소진 | `readiness.validation.completed.v1(run_status=FAILED, overall_status=null)` |
| RUNNING | QUEUED | 인프라 오류(스토리지 연결, DB 끊김)로 재시도, `attempt < 3` | 이벤트 없음 |
| QUEUED | FAILED | stale job sweeper (QUEUED 1h 초과) | |

**Run FAILED vs check FAIL**
- `run_status=FAILED`: 검증을 **수행하지 못함** (시스템 문제). `overall_status=null`, 재사용 대상 아님, 사용자는 재실행 가능. 데이터 품질에 대한 판단이 아니다.
- check `status=FAIL`: 검증을 수행했고 데이터가 기준을 **충족하지 못함**. run은 `COMPLETED`.
- 예: 파일 인코딩이 UTF-8이 아님 → check FAIL (데이터 문제). storage 연결 실패 → run FAILED.

---

## 6. API

### 6.1 `listReadinessProfiles` — `GET /readiness-profiles`
- 모든 인증 사용자. `profiles/*.yaml`을 `ReadinessProfile`로 반환 (check_id, severity 순서 포함).

### 6.2 `startReadinessValidation` — `POST /dataset-versions/{version_id}/readiness-validations`
- 호출자: version 소유기관의 `DATA_STEWARD`, 또는 `PLATFORM_ADMIN`.
- 처리 순서:
  1. `get_version` → 없음 또는 호출자에게 비가시 → `404 NOT_FOUND`
  2. 권한 없음 → `403 FORBIDDEN`
  3. `status != PUBLISHED` → `409 DATASET_VERSION_NOT_PUBLISHED`
  4. `profile_id` 미등록 → `422 READINESS_PROFILE_UNKNOWN`
  5. fingerprint 계산. 같은 `(version, profile, fingerprint)` COMPLETED 존재 → **`200`** + 기존 결과 (재실행 없음, 이벤트 없음)
  6. QUEUED/RUNNING 존재 → `409 READINESS_VALIDATION_IN_PROGRESS` (`details.validation_id`)
  7. insert QUEUED (`triggered_by=USER`) + Dramatiq enqueue (outbox 커밋 후) → **`202`**
- `TABULAR_ML_BASIC`를 T가 빈 version에 수동 요청하는 것은 허용 (T 의존 check는 NOT_APPLICABLE).

### 6.3 `getReadiness` — `GET /dataset-versions/{version_id}/readiness`
- 호출자: dataset metadata를 볼 수 있는 사용자 (`CatalogQueryPort.is_visible`). DRAFT version 또는 비가시 → `404 NOT_FOUND`.
- profile별 **가장 최근** validation 1건 (run_status 무관: QUEUED/RUNNING/FAILED도 반환). `checks` 포함.
- `profile_id` 지정 + 결과 없음 → `404 READINESS_NOT_AVAILABLE`. 미지정 + 결과 없음 → `200 {"items": []}`.
- evidence는 D-018에 따라 원값이 없으므로 grant 없는 사용자에게도 반환한다.

---

## 7. Events

### Produced

| event_type | 시점 | 비고 |
|---|---|---|
| `readiness.validation.started.v1` | RUNNING 전환 commit | actor SYSTEM |
| `readiness.validation.completed.v1` | COMPLETED 또는 FAILED commit | `run_status`, `overall_status`, `summary`, `validator_version`, `input_fingerprint`, `owner_organization_id` |

actor: 수동 실행이면 `USER`(requested_by), 자동이면 `SYSTEM`. `correlation_id`: 수동은 요청 trace id, 자동은 publish 이벤트의 correlation_id를 이어받음.
Consumer: M03(`readiness_overall` read model), M09(Audit `READINESS_VALIDATION_COMPLETED`).

### Consumed
§3.2. `readiness.processed_events`로 멱등 처리. 같은 publish 이벤트가 두 번 와도 `uq_validation_inflight`/재사용 규칙으로 중복 run이 생기지 않는다.

---

## 8. Public Service Interface

```python
from typing import Literal, Protocol
from uuid import UUID

class ReadinessQueryPort(Protocol):
    """다른 모듈용 (P1: M06 Marketplace 품질 배지 등). P0에서는 M03이 이벤트 read model을 쓰므로 필수 아님."""
    def get_latest_overall(
        self, dataset_version_id: UUID, profile_id: str
    ) -> Literal["PASS", "WARNING", "FAIL"] | None: ...
```

---

## 9. Authorization Matrix

| Operation | 인증 사용자 | metadata 가시 사용자 | 소유기관 DATA_STEWARD | PLATFORM_ADMIN |
|---|---|---|---|---|
| listReadinessProfiles | O | O | O | O |
| getReadiness | 404 | O | O | O |
| startReadinessValidation | X | 403 | O | O |

파일 bytes 접근은 사용자 권한이 아니라 worker 서비스 자격증명(`CatalogReadPort`)으로만 한다. API 프로세스는 bytes를 읽지 않는다.

---

## 10. Background Jobs

| Job | 방식 | 설정 | 동작 |
|---|---|---|---|
| `readiness.run_validation` | Dramatiq actor, queue `readiness` | `time_limit=READINESS_RUN_TIMEOUT_SECONDS`, `max_retries=2` (인프라 예외만) | §5 상태 전이. profile의 check를 **ordinal 순으로 순차** 실행 |
| `readiness.on_version_published` | event handler | | §3.2 |
| `readiness.sweep_stale` | scheduler 10분 | | QUEUED > 1h, RUNNING > timeout + 10분 → FAILED(`STALE_JOB`) |

실행 세부:
- 파일 스트림은 check 간 공유하지 않고 파일별 1회 파싱 결과(sample 통계)를 캐시해 datatype/missing/units check가 재사용한다. 캐시는 run 메모리 내에서만.
- 파일당 파싱 timeout `READINESS_FILE_TIMEOUT_SECONDS` 초과 → run FAILED(`FILE_TIMEOUT`). (sample 한도가 있으므로 정상 데이터에서는 발생하지 않아야 함)
- 메모리 상한: 파일당 sample 256 MiB 스트리밍 처리, 전체 적재 금지.
- 라이브러리: CSV는 표준 `csv` 모듈(모든 값 str), parquet은 `pyarrow.parquet.ParquetFile.iter_batches`. pandas 타입 추론 금지.
- worker concurrency: `READINESS_WORKER_CONCURRENCY`(기본 2). 1 GB sample 비동기 처리 성능 테스트(05 §5) 대상.

---

## 11. Config / Env

| 변수 | 기본값 | 설명 |
|---|---|---|
| `READINESS_RUN_TIMEOUT_SECONDS` | `1800` | run 전체 |
| `READINESS_FILE_TIMEOUT_SECONDS` | `600` | 파일 하나 파싱 |
| `READINESS_WORKER_CONCURRENCY` | `2` | |
| `REDIS_URL` | 공통 | Dramatiq broker |

판정에 영향을 주는 값(sample 한도, 임계값)은 env가 아니라 **profile parameter**다 (`09_AI_READY_RULES.md` §2.3). `VALIDATOR_VERSION`은 코드 상수.

---

## 12. Acceptance Tests

| ID | Given | When | Then |
|---|---|---|---|
| M05-AT-01 | 4개 fixture를 각각 publish | 자동 실행 완료 | 각 fixture에 GENERIC_BASIC, TABULAR_ML_BASIC 2건 COMPLETED, check별 status와 overall이 09 §5.6 표와 일치 |
| M05-AT-02 | `clean_tabular` | 같은 version/profile을 재사용 끄고(`reuse=False` 내부 함수) 서로 다른 worker 프로세스에서 3회 실행 | 3개 `result_sha256` 동일, `expected/*.json`의 값과 동일 (**결정론**) |
| M05-AT-03 | `clean_tabular` COMPLETED | steward가 같은 profile로 POST | `200`, 기존 validation_id 반환, 새 행·이벤트 없음 |
| M05-AT-04 | RUNNING 존재 | steward POST | `409 READINESS_VALIDATION_IN_PROGRESS` |
| M05-AT-05 | DRAFT version | steward POST | `409 DATASET_VERSION_NOT_PUBLISHED` |
| M05-AT-06 | 다른 기관 연구자 | POST | `403 FORBIDDEN` |
| M05-AT-07 | `profile_id="FOO"` | POST | `422 READINESS_PROFILE_UNKNOWN` |
| M05-AT-08 | Institute B INTERNAL dataset의 version | Institute A 사용자 GET readiness | `404` |
| M05-AT-09 | Institute B CONTROLLED, grant 없는 Institute A 사용자 | GET readiness | `200`, evidence에 CSV 셀 값 문자열(`S0001`, `101.325` 등 fixture 값)이 **하나도 없음** (전체 응답 문자열 검사) |
| M05-AT-10 | storage 연결 차단 | run | 재시도 2회 후 `run_status=FAILED`, `overall_status=null`, completed 이벤트 `run_status=FAILED`; 복구 후 재실행 → COMPLETED |
| M05-AT-11 | 같은 `catalog.dataset.version_published.v1` 2회 전달 | handler | validation 행은 profile별 1건 |
| M05-AT-12 | publish 후 dataset `provenance`를 PATCH로 추가 | 기존 version GET readiness | 결과 불변 (snapshot 평가) |
| M05-AT-13 | T가 빈 version(README.md, .h5만) | publish | GENERIC_BASIC만 자동 실행, T 의존 check `NOT_APPLICABLE` |
| M05-AT-14 | 코드 검사 | readiness 모듈 import graph | LLM/HTTP client(`anthropic`, `openai`, `httpx` 외부 호출) import 없음; validators가 `datetime.now`/`random` 미사용 (lint rule) |
| M05-AT-15 | 1 GB csv | TABULAR_ML_BASIC | sample 한도로 `truncated=true`, timeout 내 COMPLETED |

---

## 13. Deliverables & Known Limitations

### Deliverables
1. `apps/api/modules/readiness/README.md` (규칙표 링크, profile/validator 버전 정책)
2. Router 3개 operation, event handler, Dramatiq actor
3. Migrations (`readiness` schema, partial unique index, trigger)
4. Validators 9종 + 단위 테스트 (check별 PASS/WARNING/FAIL/NA 경계값 테스트)
5. `profiles/GENERIC_BASIC.yaml`, `profiles/TABULAR_ML_BASIC.yaml`, 번들 사전, subset JSON Schema
6. `tests/fixtures/readiness/` 4종 + `generate.py` + `fixtures.lock` + golden `expected/*.json`
7. Integration notes: M03(`readiness_overall` primary profile 규칙), M09(audit 매핑), M10(evidence 표시 방법)

### Known limitations (P0)
- 비표 형식(HDF5/NetCDF/JSON) 내부 검증 없음
- sample 기반 판정이므로 sample 밖의 타입 오류·결측은 탐지하지 못함 (evidence `truncated`로 명시)
- 10 GiB 초과분 checksum은 M03 upload 검증 결과에 의존
- `semantics.mapping_status`는 `_schema.json`의 `x-nais-concept`만 본다 (IRI 존재 여부만, 실존·의미 검증 없음)
- UCUM은 번들 atom 사전 범위에서만 검증


---

# FILE: modules/M06_marketplace.md

# M06 AI Marketplace (P1)

## Goal
재사용 가능한 Research Asset을 발견하고 Project에 추가.

## Asset Types
DATASET, MODEL, TOOL, WORKFLOW, AGENT, ONTOLOGY, SOFTWARE

## P1
- publish asset
- asset version
- provider
- license
- usage policy
- technical requirements
- related assets
- add-to-project

## DB owner
`marketplace.*`

## Principle
download marketplace가 아니라 project reuse 중심.


---

# FILE: modules/M07_compute.md

# M07 Compute / GPU Resource (P1)

## Goal
GPU/HPC resource catalog, request, allocation.

## Resource
- provider
- type
- spec
- capacity
- availability
- policy

## Flow
Discover → Request → Review → Allocate → Use → Expire

## DB owner
`compute.*`

## P1 Demo
H100 virtual resource를 Project에 기간제 할당.


---

# FILE: modules/M08_federation_data_node.md

# M08 Federation / Data Node (P2)

## Goal
실제 데이터는 기관에 두고 NAIS Control Plane이 metadata/access를 연결.

## Separate service
`services/data-node`

## Responsibilities
- node identity
- storage adapter
- dataset manifest
- metadata sync
- grant validation
- direct transfer endpoint
- audit forwarding
- health

## P2 Demo
Institute A MinIO + Institute B MinIO를 별도 Node로 운영.

## Principle
metadata centrally discoverable, bytes remain at owner.


---

# FILE: modules/M09_audit_notification.md

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
class IdentityQueryPort(Protocol):     # M01
    def get_public_profiles(self, user_ids: list[UUID]) -> dict[UUID, IdentityPublicProfile]: ...
    def list_users_with_org_role(self, organization_id: UUID, role: str) -> list[UUID]: ...
    def has_org_role(self, user_id: UUID, organization_id: UUID, role: str) -> bool: ...
    def get_email(self, user_id: UUID) -> str | None: ...      # 알림 메일 전용 (M01 §8에 정의)

class ProjectQueryPort(Protocol):      # M02
    def list_project_ids_for_member(self, user_id: UUID) -> list[UUID]: ...
    def is_active_member(self, project_id: UUID, user_id: UUID) -> bool: ...

class CatalogQueryPort(Protocol):      # M03 §8 (정본). title, owner_organization_id 사용
    def get_policy_view(self, dataset_id: UUID) -> DatasetPolicyView | None: ...

class GrantQueryPort(Protocol):        # M04 §8 (정본)
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


---

# FILE: modules/M10_web_portal.md

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


---

# FILE: modules/M11_knowledge_ontology.md

# M11 Knowledge / Ontology (P1)

## Goal
Ontology/Taxonomy/Knowledge asset을 등록·검증하고 Dataset과 연결.

## P1
- ontology metadata/version
- concepts/relations counts
- validation result
- SHACL validation extension
- dataset semantic mapping
- marketplace publish

## Research Asset
ONTOLOGY

## Future
Knowledge Graph / cross-domain mapping.


---

# FILE: modules/M12_autonomous_science.md

# M12 Autonomous Science (P3)

## Goal
Research Commons 자산을 자율형 연구 workflow와 연결하는 Sandbox.

## P3
- experiment workflow
- instrument/facility registry
- simulation-only agent execution
- human approval gate
- experiment result → new dataset version
- provenance link

## Safety maturity
SIMULATION → SHADOW → HUMAN_APPROVED_LIMITED_CONTROL

실제 장비 제어는 P3 prototype 범위 밖.
