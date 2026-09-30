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

**Key rules:** backend ORM/model을 추측하지 않고 생성된 contract client만 사용. WCAG 2.2 AA. 브라우저가 S3 스토리지로 직접 업로드/다운로드(presigned URL).

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
