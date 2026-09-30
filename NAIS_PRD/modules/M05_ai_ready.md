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


class CatalogQueryPort(Protocol):  # M03 public.py
    def get_version(self, dataset_version_id: UUID) -> "VersionView | None": ...
    def is_visible(self, ctx: "AuthContext", dataset_id: UUID) -> bool: ...


class CatalogReadPort(Protocol):  # M03 public.py, 서비스 자격증명 (D-018)
    def open_stream(self, file: "FileRef", byte_range: tuple[int, int] | None = None) -> BinaryIO: ...


class AuthContext(Protocol):  # M00
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
