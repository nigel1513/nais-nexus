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


class AuthContext(Protocol):  # apps/api/platform/auth (M00)
    user_id: UUID
    organization_id: UUID
    org_roles: frozenset[str]  # {"ORG_ADMIN","DATA_STEWARD","RESOURCE_MANAGER"}
    platform_roles: frozenset[str]  # {"PLATFORM_ADMIN"}
    trace_id: str


class IdentityPort(Protocol):  # provided by M01
    def get_organization_summary(self, organization_id: UUID) -> "OrganizationSummary | None": ...
    def get_organization_summaries(self, ids: Sequence[UUID]) -> dict[UUID, "OrganizationSummary"]: ...


class MalwareScannerPort(Protocol):  # M03 내부 extension point, P0 구현 = NoopScanner
    def scan(self, bucket: str, key: str) -> "ScanResult": ...  # CLEAN | INFECTED | SKIPPED
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
- D-041 (Wave 1.5 Stage 2, catalog_0004): lineage columns `base_version_id`, `source_version_id`, `previous_version_id` (uuid, nullable, FK → `catalog.dataset_versions`); PUBLISHED이면 trigger가 이 세 열도 고정한다.

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
| storage_key | text | N | | `datasets/{dataset_id}/{dataset_version_id}/{upload_session_id}/{path}` (D-039) |
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
- D-041 (Wave 1.5 Stage 2, catalog_0004): `inherited_from_file_id` (uuid, nullable, FK → `catalog.dataset_files`)는 같은 데이터셋 PUBLISHED 행의 저장 객체를 공유하는 상속 행을 표시하며, 상속 행은 `upload_session_id`가 NULL이다(nullable로 변경, CHECK `ck_files_origin`: 둘 중 하나는 NOT NULL).

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
- Key: `datasets/{dataset_id}/{dataset_version_id}/{upload_session_id}/{path}` (D-039: 업로드 세션마다 고유 key)
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
    예: `http://localhost:21051/nais-inst-b/datasets/{dataset_id}/{version_id}/{upload_session_id}/data/a.csv?X-Amz-...` (URL TTL은 세션 잔여 시간으로 제한, D-039)
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
class DatasetPolicyView:  # = openapi DatasetPolicyView
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
    storage_bucket: str  # 내부 전용. API 응답·이벤트·로그에 노출 금지
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
    files: tuple[FileRef, ...]  # path 오름차순


class CatalogQueryPort(Protocol):
    """Governance(M04), Readiness(M05)용 조회. 권한 판단은 하지 않는다 (is_visible 제외)."""

    def get_policy_view(self, dataset_id: UUID) -> DatasetPolicyView | None: ...
    def get_version(self, dataset_version_id: UUID) -> VersionView | None: ...
    def is_visible(self, ctx: "AuthContext", dataset_id: UUID) -> bool: ...  # D-012 metadata 가시성


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
        file_ids: Sequence[UUID] | None,  # None = 전체
        ttl_seconds: int,  # STORAGE_PRESIGN_TTL_SECONDS (300)
    ) -> list[PresignedGet]: ...  # 알 수 없는 file_id → ValueError(NOT_FOUND)


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
| `STORAGE_<CODE>_ENDPOINT` | 예 `http://storage-a:8333` | 내부 endpoint (HEAD, 해시, multipart complete) |
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
6. Unit / contract / integration 테스트 (SeaweedFS S3, OpenSearch testcontainer)
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
