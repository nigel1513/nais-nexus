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
