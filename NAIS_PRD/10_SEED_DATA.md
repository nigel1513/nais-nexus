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
