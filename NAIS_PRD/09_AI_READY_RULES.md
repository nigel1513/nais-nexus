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
| `input_fingerprint` | `sha256(manifest_sha256 + "\|" + metadata_snapshot_sha256 + "\|" + profile_id + "\|" + profile_version + "\|" + validator_version)`. `metadata_snapshot_sha256`은 canonical JSON(metadata_snapshot)의 sha256 (D-029) |
| 재사용 범위 | `(dataset_version_id, profile_id, input_fingerprint)`가 같은 COMPLETED 결과가 있으면 재실행하지 않고 반환. metadata_snapshot 변경은 fingerprint에 반영되므로(D-029) 같은 fingerprint는 같은 입력을 뜻한다 |
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
