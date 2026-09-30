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
