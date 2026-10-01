# 연구 데이터 포털 고도화 설계 (Wave 1.5)

- 날짜: 2026-10-01
- 대상 모듈: M01 Identity(연구자 식별번호), M03 Data Catalog(백엔드), M09 Audit/Notification(알림 유형), M10 Web Portal(화면)
- 계약: `NAIS_PRD/contracts/openapi.yaml` 1.2.0 → **1.3.0**, events schema에 신규 이벤트 추가
- 선행 조건: Wave 1 완료(`feat/wave1`). 이 작업은 Wave 2(M04) 전에 수행한다.

## 1. 목적

데이터 화면을 **공공데이터포털(data.go.kr) 같은 연구 데이터 포털**로 만든다. 다른 기관 연구자가 한 화면에서
"이 데이터를 누가·언제·어떻게 만들었고, 누구에게 물어보고, 어떻게 쓸 수 있는지"를 판단할 수 있어야 한다.
또한 모든 메타데이터를 **기계가 이해하는 구조**로 저장해, 이후 온톨로지(M11)와 자연어 질의 AI에 그대로
활용할 수 있게 한다.

### 사용자가 결정한 사항 (2026-10-01 대화)
1. 연구책임자·담당자는 **가입 사용자 중에서 선택**한다.
2. 연락은 **플랫폼 내 문의 + 이메일 공개 둘 다** 지원한다(연구회 소속 기관만 접속하는 폐쇄형 포털).
3. **버전 이력**: 변경 메모(필수), 이전 버전 대비 파일 비교, 이전 버전 다운로드, 인용 문구, 버전 번호 규칙 안내.
4. **원본(raw) 데이터가 기준**이다. 정제본은 항상 원본을 가리킨다. 정제본만 올리는 경우는 예외로 허용하되
   "원본 미포함 사유"와 "원본 보관 위치·담당자"를 반드시 기록한다.
5. 원본·정제본은 기본적으로 **한 버전 안에서 파일 역할로 구분**하고, 접근 권한이 달라야 하면 **별도 데이터셋 +
   유래(derived-from) 연결**을 쓴다.
6. **데이터 정보**: 데이터 기간(언제부터 언제까지의 데이터인지), 수집 기관, 수집 방법·장비, 측정 대상.
7. 메타데이터는 **AI 활용 가능하게** 설계한다(구조화, 표준 어휘, JSON-LD 내보내기, 변경 이벤트, 영구 식별자).
8. **문의는 문의자와 담당자 두 사람만** 볼 수 있다(기관 관리자·플랫폼 관리자도 열람 불가).
9. 사람마다 **연구자 등록번호** 개념의 식별번호를 둔다(국가연구자번호, ORCID).

### 범위 밖 (이번에 하지 않음)
- 자연어 질의·AI 검색 기능 자체(M11 P1). 이번에는 그 기반이 되는 메타데이터만 만든다.
- 파일 단위 접근 권한(권한은 계속 데이터셋 단위, D-012).
- DOI 실제 발급(식별자 자리만 마련).
- 데이터 내용 수준의 diff(행 단위 비교). 파일 단위 비교만 한다.

## 2. AI 활용 설계 원칙 (모든 단계에 적용)

| 원칙 | 적용 |
|---|---|
| 글 대신 구조 | 사람=user_id, 기관=organization_id, 기간=date, 분야·방법·대상=어휘 코드. 자유 텍스트는 보조 필드로만 |
| 표준 어휘 정렬 | 데이터셋: DCAT 3 / DataCite 4.5 / schema.org `Dataset`. 계보: W3C PROV-O. 개념: 각 어휘 항목에 IRI(EMMO, QUDT 등) 매핑 |
| 통제 어휘 | 연구 분야·측정 방법·측정 대상은 **NAIS 어휘 테이블**에서 선택. 항목마다 `code`, 한/영 라벨, 선택적 외부 IRI |
| 기계 판독 내보내기 | `GET /datasets/{id}/metadata.jsonld`, `GET /dataset-versions/{vid}/metadata.jsonld` (JSON-LD, schema.org+DCAT+PROV 컨텍스트) |
| 변경 이벤트 | 메타데이터 변경 시 `catalog.dataset.metadata_changed.v1` 발행 → 향후 M11 색인이 구독 |
| 영구 식별자 | 데이터셋·버전 ID(UUIDv7)는 불변. 정규 URI `${NAIS_PUBLIC_BASE_URL}/id/dataset/{id}`, `/id/dataset-version/{vid}`. `doi` 컬럼(nullable)만 예약 |
| 발행 시 동결 | 아래 신규 메타데이터는 모두 `metadata_snapshot`(D-029)에 포함. 발행된 버전의 메타데이터는 변하지 않는다 |

## 3. 데이터 모델 (M03 `catalog` 스키마, 마이그레이션 `catalog_0002`)

### 3.0 연구자 식별번호 (M01 `identity` 스키마, 마이그레이션 `identity_0002`)
`identity.users` 추가 컬럼(모두 선택):
| column | type | 규칙 |
|---|---|---|
| national_researcher_number | text | 국가연구자번호(NTIS) 8자리 숫자 `^[0-9]{8}$`, UNIQUE(값이 있을 때) |
| orcid | text | `^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$` + ISO 7064 MOD 11-2 체크섬, UNIQUE(값이 있을 때) |

- 입력: 본인이 `/settings`에서 등록·수정(`updateMe`). 형식·체크섬 오류는 `VALIDATION_FAILED`, 중복은 `CONFLICT`.
- 노출: `IdentityPublicProfile`에 두 필드 추가 → 데이터 상세의 연구책임자·담당자·공동연구자 카드, 인용(DataCite `nameIdentifier`), JSON-LD(`schema:identifier`, ORCID는 `https://orcid.org/{id}` IRI)에 표시.
- `metadata_snapshot`에는 발행 시점의 사람 정보(user_id, 표시명, 소속, 두 식별번호)를 함께 동결한다.
- 이벤트: `identity.user.updated.v1`(필드 목록만) — 향후 M11 색인 갱신용.


### 3.1 통제 어휘
`catalog.vocabulary_terms`
| column | type | 설명 |
|---|---|---|
| term_id | uuid PK | |
| scheme | text | `SUBJECT`(연구 분야) / `METHOD`(수집 방법·장비 유형) / `MATERIAL`(측정 대상) |
| code | text | scheme 내 유일. `^[A-Z0-9_]{2,64}$` |
| label_ko, label_en | text | |
| iri | text null | 외부 개념 IRI(`^https?://\S+$`) |
| parent_code | text null | 계층(같은 scheme) |
| active | boolean | |
- UNIQUE(scheme, code). seed로 초기 어휘 제공(분야 약 20개, 방법 약 15개, 대상 약 20개; 각 항목 IRI 가능 시 매핑).
- 관리 API는 PLATFORM_ADMIN 전용(P0: seed + 관리자 추가만).

### 3.2 `catalog.datasets` 추가 컬럼
| column | type | null | 규칙 |
|---|---|---|---|
| principal_investigator_id | uuid | Y(기존 행) / 신규 필수 | 소유 기관 ACTIVE 사용자 |
| data_steward_contact_id | uuid | Y(기존) / 신규 필수 | 소유 기관 ACTIVE 사용자(문의 수신자) |
| contact_email_public | boolean | N, default false | true면 담당자 이메일을 상세에 공개 |
| project_title | text | Y | ≤ 300 |
| project_code | text | Y | ≤ 64 |
| funding_agency | text | Y | ≤ 200 |
| subject_codes | text[] | N, `'{}'` | 원소 ∈ vocabulary(SUBJECT), ≤ 5 |
| method_codes | text[] | N, `'{}'` | 원소 ∈ vocabulary(METHOD), ≤ 10 |
| material_codes | text[] | N, `'{}'` | 원소 ∈ vocabulary(MATERIAL), ≤ 20 |
| method_detail | text | Y | ≤ 4000 (예: "XRD, 장비 모델 ○○") |
| temporal_start | date | Y | 데이터 기간 시작 |
| temporal_end | date | Y | ≥ temporal_start |
| collecting_organization_id | uuid | Y | 연구회 기관(OrganizationSummary) |
| collecting_organization_name | text | Y | 연구회 밖 기관명(≤ 200). id와 name 중 최대 1개 |
| update_frequency | text | N, `'ONCE'` | IN (`ONCE`,`MONTHLY`,`QUARTERLY`,`YEARLY`,`IRREGULAR`) |
| related_publications | jsonb | N, `'[]'` | `[{title, doi?, url?}]` ≤ 20 |
| doi | text | Y | 예약(발급 미구현) |

`catalog.dataset_contributors` (공동연구자)
| column | type | 규칙 |
|---|---|---|
| dataset_id | uuid FK | |
| user_id | uuid | 연구회 소속 ACTIVE 사용자(기관 무관) |
| role | text | `CO_INVESTIGATOR` / `DATA_COLLECTOR` / `DATA_CURATOR` (DataCite contributorType 매핑) |
| PK | (dataset_id, user_id, role) | |

- 기존 `contact_email`, `provenance`는 하위 호환을 위해 유지(읽기 전용 표시, 신규 입력 UI에서 제거). `domain`은 `subject_codes`로 대체(마이그레이션에서 매핑 불가 시 유지).
- 기존 seed 데이터셋 5개는 마이그레이션 후 seed 갱신으로 연구책임자·담당자·기간 등을 채운다.

### 3.3 버전 이력 (`catalog.dataset_versions` 변경)
- `change_note`: 발행 시 **필수**(3..2000자). DRAFT에서는 선택.
- `previous_version_id uuid null`: 발행 시 같은 데이터셋의 직전 PUBLISHED 버전을 자동 기록(사용자 입력 아님).
- `raw_included boolean not null default true`, `raw_absence_reason text null`, `raw_location text null`,
  `raw_custodian_id uuid null`: 원본 미포함 시(`raw_included=false`) 사유·보관 위치·담당자 **필수**(발행 검증).
- 파일 비교는 저장하지 않고 조회 시 계산: 직전 버전과 `path` 기준으로 ADDED / REMOVED / CHANGED(sha256 다름) / UNCHANGED.

### 3.4 원본/정제 계보
`catalog.dataset_files` 추가: `role text not null default 'RAW'` IN (`RAW`,`PROCESSED`,`DOCUMENTATION`,`CODE`).
- 발행 규칙: `PROCESSED` 파일이 하나라도 있으면 해당 버전에 **정제 기록**이 1건 이상 있어야 한다.
- `raw_included=true`이면 `RAW` 파일이 1개 이상 있어야 한다.

`catalog.processing_steps` (버전별 정제 기록, PROV-O `prov:Activity`)
| column | type | 규칙 |
|---|---|---|
| step_id | uuid PK | |
| dataset_version_id | uuid FK | DRAFT일 때만 생성·수정(발행 후 불변 트리거) |
| seq | int | 1부터, 버전 내 유일 |
| title | text | 3..200 (예: "이상치 제거") |
| description | text | ≤ 4000 |
| tool_name, tool_version | text null | |
| code_url | text null | `^https?://` |
| performed_by | uuid null | 사용자 |
| performed_at | date null | |
| input_paths | text[] | 이 버전의 RAW/PROCESSED 파일 경로(유효성 검증) |
| output_paths | text[] | 이 버전의 PROCESSED 파일 경로 |

`catalog.dataset_lineage` (데이터셋 간 유래, PROV-O `prov:wasDerivedFrom`)
| column | type | 규칙 |
|---|---|---|
| derived_version_id | uuid FK | 정제본 데이터셋의 버전 |
| source_version_id | uuid FK | 원본 데이터셋의 **PUBLISHED** 버전 |
| relation | text | `PROCESSED_FROM` / `SUBSET_OF` / `MERGED_FROM` |
| PK | (derived_version_id, source_version_id) | 발행 후 불변 |
- 소스 데이터셋을 볼 권한이 없는 사용자에게는 링크 대상을 "접근 권한이 없는 데이터셋"으로만 표시(D-012, 존재 은닉 규칙 유지: 소스가 INTERNAL·타 기관이면 제목도 숨김).

### 3.5 문의
`catalog.dataset_inquiries`
| column | type | 규칙 |
|---|---|---|
| inquiry_id | uuid PK | |
| dataset_id | uuid FK | 문의자에게 **보이는** 데이터셋만 |
| asker_id | uuid | |
| recipient_id | uuid | 생성 시점의 `data_steward_contact_id` 고정 |
| subject | text | 3..200 |
| status | text | `OPEN` / `ANSWERED` / `CLOSED` |
| created_at, updated_at | timestamptz | |

`catalog.inquiry_messages` (`message_id`, `inquiry_id`, `author_id`, `body` 1..4000, `created_at`; 수정·삭제 불가)
- 조회·답변 권한: **문의자(asker)와 수신 담당자(recipient) 두 사람만**. 소유 기관 DATA_STEWARD·ORG_ADMIN, PLATFORM_ADMIN도 열람할 수 없다. 그 외 사용자는 404(존재 은닉).
- 담당자가 바뀌어도 기존 문의의 수신자는 바뀌지 않는다(새 문의부터 새 담당자). 수신자가 비활성화되면 문의자에게 "담당자 부재" 안내를 표시하고 새 문의를 권한다.
- 감사(M09)에는 문의 ID·데이터셋·당사자 ID만 남고 제목·본문은 남기지 않는다. 감사 열람 규칙상 기관 관리자가 '문의가 있었다'는 사실은 볼 수 있으나 내용은 볼 수 없다.
- 이메일 공개(`contact_email_public=true`)는 문의와 별개로 상세 화면 담당자 카드에 이메일을 노출.

## 4. API (openapi 1.3.0 추가·변경)

| operation | 내용 | 권한 |
|---|---|---|
| `createDataset` / `updateDataset` | §3.2 필드 추가. PI·담당자 필수(생성), ACTIVE·소유기관 검증 → 422 `VALIDATION_FAILED` reason `PERSON_NOT_ELIGIBLE` | 소유기관 DATA_STEWARD |
| `getDataset` | 응답에 `people{principal_investigator, steward_contact(email은 공개 시만), contributors[]}`, 연구 맥락, 데이터 정보, 자동 통계(형식·파일 수·용량·행/열 수=readiness profile) | 가시성 D-012 |
| `listVocabulary` (신규) | `GET /vocabulary/{scheme}` | 인증 사용자 |
| `listDatasetContributors` / `putDatasetContributors` (신규) | 공동연구자 일괄 설정 | 읽기: 가시성 / 쓰기: 소유기관 steward |
| `getDatasetVersion` | `change_note`, `previous_version_id`, raw 정보, 파일 `role`, 정제 기록, 계보 | 가시성 |
| `compareDatasetVersions` (신규) | `GET /dataset-versions/{vid}/diff?against={vid}` 기본=직전 | 두 버전 모두 가시 |
| `putProcessingSteps` (신규) | DRAFT 버전의 정제 기록 일괄 저장 | 소유기관 steward |
| `putVersionLineage` (신규) | DRAFT 버전의 유래 설정(소스는 호출자가 볼 수 있는 PUBLISHED 버전) | 소유기관 steward |
| `publishDatasetVersion` | 추가 검증: change_note, raw 규칙, PROCESSED→정제 기록 필수 → 409 `DATASET_VERSION_INCOMPLETE` details에 사유 코드 | 기존 |
| `getDatasetCitation` (신규) | `GET /dataset-versions/{vid}/citation?style=text|bibtex|datacite-json` | 가시성 |
| `getDatasetJsonLd` / `getVersionJsonLd` (신규) | JSON-LD (§2) | 가시성 |
| `createInquiry`, `listInquiries`(`role=asker|recipient`), `getInquiry`, `replyInquiry`, `closeInquiry` (신규) | §3.5 | §3.5 권한 |
| `searchDatasets` | 필터 추가: `subject`, `material`, `method`, `temporal_from/to`(기간 겹침), `collecting_org`, `pi`; facet 추가: subject, collecting_org | 기존 D-012 필터 유지 |

오류 코드 추가(`error_codes.json`): `INQUIRY_NOT_FOUND`(404) 하나만. 어휘 코드 오류·인물 자격 오류는 신규 코드 없이 `VALIDATION_FAILED`(422)의 field reason(`VOCABULARY_TERM_UNKNOWN`, `PERSON_NOT_ELIGIBLE`)으로 표현한다. NotificationType 추가: `DATASET_INQUIRY_RECEIVED`, `DATASET_INQUIRY_ANSWERED`.

## 5. 이벤트 (events schema 추가)
- `catalog.dataset.metadata_changed.v1` — `{dataset_id, owner_organization_id, changed_fields[]}` (M11 색인용, M09 audit `DATASET_UPDATED`)
- `catalog.inquiry.created.v1` — `{inquiry_id, dataset_id, owner_organization_id, asker_id, recipient_id}` → M09 알림(수신자)·감사
- `catalog.inquiry.replied.v1` — `{inquiry_id, dataset_id, author_id, recipient_ids[]}` → M09 알림(상대방)·감사
- 문의 본문은 이벤트·감사 details에 넣지 않는다(개인정보 최소화).

## 6. 검색 (OpenSearch 문서 확장)
`subject_codes`, `material_codes`, `method_codes`(keyword), `temporal_start/end`(date), `collecting_organization_id`,
`principal_investigator_name`(text, ko_en 분석기), `has_processed`(bool), `raw_included`(bool). 어휘 라벨(한/영)을
`subject_labels` 텍스트로 넣어 키워드 검색에 걸리게 한다. 인덱스 버전 `nais-datasets-v2` + `reindex_all`.

## 7. 웹 화면 (M10)
- **데이터 상세** (공공데이터포털형)
  - 상단: 제목, 제공 기관, 연구책임자, 데이터 기간, 공개 수준, AI-ready 배지, 최신 버전·발행일
  - 탭: `개요`(설명·연구 맥락·데이터 정보·키워드·관련 논문) / `파일·버전`(버전 목록, 변경 메모, 파일 역할 배지, 이전 버전 대비 비교, 이전 버전 다운로드) / `계보`(원본→정제 절차→정제본 흐름, 데이터셋 간 유래 링크) / `이용·인용`(라이선스·이용 조건·인용 문구 복사·JSON-LD 내려받기) / `문의`(내 문의 목록·새 문의)
  - 오른쪽 카드: 담당자(이름·소속·이메일 공개 시 표시·"문의하기"), 연구책임자, 접근 요청 CTA
- **데이터 등록·수정 폼**: 사람 선택(소유 기관 사용자 검색 콤보박스), 어휘 선택(계층 트리), 기간·수집 기관 입력, 공동연구자, 이메일 공개 토글
- **버전 상세**: 파일 업로드 시 역할 선택(기본 RAW), 정제 기록 편집기(단계 추가·순서 변경, 입력/출력 파일 선택), 원본 미포함 체크 시 사유·위치·담당자 필수, 발행 전 체크리스트(변경 메모·raw 규칙·정제 기록)
- **검색**: 분야·대상·방법 facet, 데이터 기간 범위 필터, 수집 기관 필터, 결과 카드에 연구책임자·기간·정제본 여부 표시
- **문의함**: `/commons/inquiries` (받은 문의 / 보낸 문의 탭), 스레드 화면
- mock API는 새 엔드포인트를 실제 규칙대로 미러링(Wave 1 원칙 유지), contract 검증 포함

## 8. 단계 (각 단계 = 구현 계획 1개, Wave 1과 같은 태스크·리뷰 방식)
| 단계 | 범위 | 완료 기준 |
|---|---|---|
| 1 연구 메타데이터 | 연구자 식별번호(M01), 어휘, datasets 추가 컬럼, 공동연구자, 스냅샷 확장, metadata_changed 이벤트, JSON-LD(데이터셋), 검색 v2, 상세·폼·검색 화면 | seed 5개 데이터셋에 PI·기간 등 표시, 기간/분야 검색 동작, JSON-LD가 schema.org 검증기 통과 |
| 2 버전 이력 | change_note 필수, previous_version, diff API·화면, 인용(text/bibtex/datacite), 이전 버전 다운로드 동선 | 두 버전 비교 화면, 인용 복사 |
| 3 원본/정제 계보 | 파일 role, processing_steps, raw 규칙, lineage, 발행 검증, 계보 탭, JSON-LD에 PROV 포함 | 원본+정제 / 정제본만 / 별도 데이터셋 유래 3가지 시나리오 동작 |
| 4 문의 | 문의 테이블·API·이벤트, M09 알림 유형, 문의함·상세 문의 탭, 이메일 공개 토글 | 문의→알림·메일→답변→알림 흐름, 권한 밖 사용자 404 |

## 9. 호환성·위험
- **readiness 지문(D-029)**: 스냅샷 필드가 늘면 이후 발행분의 `metadata_snapshot_sha256`이 달라진다. 기존 발행 버전은 불변이라 영향 없음. `metadata.completeness`(09 §3.1) 규칙은 이번에 바꾸지 않는다(필수 필드 확대는 별도 결정).
- **M04(Wave 2)**: 문의는 접근 승인과 별개이며 권한을 부여하지 않는다. 계보 링크는 소스 데이터셋 권한을 우회하지 않는다.
- **개인정보**: 담당자 이메일은 공개 토글이 켜진 경우에만 응답에 포함. 문의 본문은 감사·이벤트에 미포함.
- **기존 데이터**: `contact_email`/`provenance`/`domain` 유지(읽기 전용). 마이그레이션은 additive만 사용.

## 10. 테스트
- 백엔드: 각 신규 API의 권한·검증·계약 테스트, 발행 검증(raw/정제 규칙) 테스트, 스냅샷 동결·불변 트리거, JSON-LD 구조 테스트(필수 키·@context), diff 계산 테스트, 검색 필터(기간 겹침) 테스트, 이벤트 스키마 검증
- 웹: 폼 검증, 상세 탭, 계보 표시(권한 없는 소스 마스킹), 문의 흐름, mock 계약 검증, Playwright 스모크에 상세·문의 추가(비보안 출처 포함)
