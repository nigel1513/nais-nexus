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
