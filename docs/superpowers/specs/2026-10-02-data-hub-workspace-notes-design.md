# AI Data-Hub · 프로젝트 작업 공간 · 연구노트 설계

- 날짜: 2026-10-02
- 상태: 사용자 승인 (대화 2026-10-02: "해주세요 전체 다 반영까지")
- 레퍼런스: `.superpowers/sdd/2026-10-02-data-hub/references.md` (HF Hub, Kaggle, Zenodo, KISTI DataON, Databricks Unity Catalog, DagsHub, W&B Reports, eLabFTW, SciNote, Benchling, Granola, Copilot PR 요약, 국가연구개발 연구노트 지침)
- 관련 결정: PRD 원칙 "AI Later, Platform First"(P0는 LLM 없이 동작), P1 "Project에 Research Asset 추가", "AI-ready Transformation Job"

## 1. 사용자가 원한 것 (요약)

1. 대시보드는 대시보드답게 (완료: 2026-10-02, `aa67bd9`).
2. 데모 티가 나지 않게, 실제 연구회 기관명 (완료: 웹 mock, `86fd2a5`. 백엔드 시드는 후속).
3. 포털 전체를 **AI Data-Hub**(통합 데이터센터)로: 기관을 넘는 연구 데이터를 한곳에서 찾는다.
4. 그 데이터로 **Kaggle처럼 프로젝트**를 한다: 데이터를 붙이고, 변환하고, 산출물을 만든다. Jupyter는 쓰지 않는다.
5. **연구노트**로 방향·결정·과정을 남긴다. 연구를 할 때마다 **로컬 LLM이 자동으로 초안**을 쓴다.
6. LLM은 사내 GPU PC(192.168.0.2, RTX 4090)의 vLLM 엔드포인트를 쓴다: `:8001` 생성(EXAONE-3.5-7.8B-Instruct-AWQ, 모델 id `llm`, 16K), `:8002` 임베딩(bge-m3), `:8003` 재정렬(bge-reranker-v2-m3).

## 2. 목표와 비목표

**목표**
- 데이터 허브 홈: 기관·분야를 넘는 데이터 발견(이번 주 많이 요청 / 새로 공개 / 많이 쓰인 + 분야·기관 필터).
- 데이터 카드에 "이 데이터를 쓴 프로젝트 · 토론 · 이력" 탭.
- 프로젝트 작업 공간: 입력(데이터셋@버전 고정) → 변환(단계 레시피, 서버 실행) → 산출물(파생 데이터셋, 계보 자동).
- 연구노트: 직접 작성 + LLM 초안, 초안 → 제출(잠금) → 확인 서명 → 확정(불변, 해시 체인), 수정은 새 버전.
- 모든 기능은 LLM이 꺼져 있어도 동작한다(초안 버튼만 비활성).

**비목표 (이번 범위 아님)**
- Jupyter/임의 코드 실행 환경. 스크립트 단계는 3단계(§9)에서 격리 실행으로만.
- 원본 데이터를 LLM에 넣는 것. LLM 입력은 활동 메타데이터뿐이다.
- 공인 전자서명(공동인증서) 연동, 외부 TSA 타임스탬프 — 3단계 선택 항목.
- 연구자 활동 감시 화면. 초안은 본인만 본다(지침 제5조③).

## 3. 정보 구조 (메뉴)

| 그룹 | 메뉴 | 경로 | 비고 |
|---|---|---|---|
| 작업 | 홈 | `/commons` | 지금 대시보드 |
| 작업 | 데이터 허브 | `/commons/hub` | 신규 홈. 기존 검색 `/commons/data` 는 "전체 데이터"로 유지 |
| 작업 | 프로젝트 | `/commons/projects` | 상세가 작업 공간으로 바뀜 |
| 작업 | 연구노트 | `/commons/notes` | "노트북(예정)" 자리를 대체 |
| 거버넌스 | 접근 관리 · 활동 | 기존 | |

## 4. 데이터 허브

### 4.1 허브 홈 `/commons/hub`
- 상단: 검색 입력(→ `/commons/data?q=`), 분야 칩(어휘 SUBJECT 상위), 기관 칩.
- 레일 3개, 각 6개 카드:
  - **이번 주 많이 요청된 데이터**: 최근 7일 접근 요청 수 기준(누적 다운로드 아님).
  - **새로 공개된 데이터**: 최근 발행 버전 순.
  - **많이 쓰인 데이터**: 프로젝트 입력으로 붙은 수 기준.
- 카드 한 줄 메타: `기관 · 분야 · 접근 등급 · AI-ready · 최근 갱신`. 수치는 실제 집계만, 없으면 표시하지 않는다.
- 하단: 기관별 데이터 현황 표(기관, 데이터셋 수, 공개/통제 수, 최근 갱신).

### 4.2 데이터 카드 탭 추가
- **이 데이터를 쓴 프로젝트**: 입력으로 붙인 프로젝트(볼 권한이 있는 것만, 나머지는 개수만).
- **토론**: 데이터셋에 달린 스레드(§5.6과 같은 토론 모델).
- **이력**: 버전·접근·검증 이벤트(기존 감사 로그를 데이터셋 기준으로).
- 주 버튼 "프로젝트에서 열기": 내 프로젝트를 골라 입력으로 붙인다(권한 없으면 접근 요청으로 이어짐).

### 4.3 API (요약)
- `GET /hub/overview` → `{ rails: { trending[], recent[], most_used[] }, organizations[] }`
- `GET /datasets/{id}/projects` → 입력으로 쓰는 프로젝트(가시 범위 + 숨김 개수)
- `GET /datasets/{id}/activity` → 데이터셋 기준 감사 이벤트
- 토론: §5.6

## 5. 프로젝트 작업 공간

### 5.1 탭
`개요 / 데이터 / 변환 / 산출물 / 연구노트 / 구성원 / 토론`

### 5.2 입력 (데이터)
- `ProjectInput { input_id, project_id, dataset_id, version_id(고정), added_by, added_at, note }`
- 추가 조건: 프로젝트 활성 구성원 + 해당 데이터셋 버전에 대한 **활성 접근 권한**(PUBLIC은 권한 불요). 없으면 `ACCESS_REQUIRED` 오류와 함께 접근 요청 링크.
- 원본에 더 새 버전이 있으면 `newer_version_label` 표시. 버전 바꾸기는 명시적 동작(감사 기록).
- 권한이 회수·만료되면 입력은 `access_lapsed=true`로 보이고 그 입력을 쓰는 실행은 막힌다.

### 5.3 변환 (레시피)
- `Recipe { recipe_id, project_id, name, inputs[input_id], steps[], version, updated_by, updated_at }`
- 단계 종류(2단계 실행): `select_columns`, `filter_rows`(열·연산자·값), `drop_missing`, `fill_missing`, `cast_type`, `convert_unit`, `aggregate`(group_by, 함수), `join`(두 입력, 키), `sort`, `limit`.
- 레시피 버전은 저장할 때마다 올라간다. 실행은 레시피 버전 + 입력 버전을 고정해 재현 가능.
- `Run { run_id, recipe_id, recipe_version, status(QUEUED|RUNNING|SUCCEEDED|FAILED), started_at, finished_at, row_counts, error, output_id? }` — 워커 작업, 데이터는 플랫폼 안에서만 처리.
- 1단계에서는 레시피 편집·저장만 하고 실행 버튼은 "곧 제공"이 아니라 **2단계에서 함께 나간다**(이번 범위에 포함: §9).

### 5.4 산출물
- `Output { output_id, project_id, kind(DERIVED_DATASET|FILE), title, files[], produced_by(run_id|upload), access_level, lineage[], created_at }`
- 접근 등급: 입력 중 가장 엄격한 등급을 상속(내릴 수 없음). 직접 업로드한 파일은 프로젝트 구성원만.
- 계보: `lineage = [{ dataset_id, version_id, input_id }] + recipe_id@version + run_id`. 산출물 화면에 그래프(입력 → 레시피 → 산출물).
- 허브 공개 승격: `POST /projects/{p}/outputs/{o}/publish-requests` → 원본 소유 기관 데이터 관리자 각각의 승인(기존 거버넌스 검토 흐름 재사용). 모두 승인되면 카탈로그에 새 데이터셋으로 등록(소유 기관 = 프로젝트 주관 기관).

### 5.5 개요
- 프로젝트 소개, 고정한 산출물 카드(표 미리보기·열 분포), 최근 실행, 최근 연구노트 제목. 보고서처럼 위에서 아래로 읽힌다.

### 5.6 토론
- `Thread { thread_id, scope(PROJECT|DATASET|OUTPUT|RECIPE), target_id, title, created_by, created_at, resolved }`, `Comment { comment_id, thread_id, body(markdown), author, created_at, edited_at }`.
- 데이터셋 토론은 데이터 카드에서, 나머지는 프로젝트 토론 탭에서 모아 본다.

## 6. 연구노트

### 6.1 단위와 소유
- 노트 = 프로젝트 × 기록자 × 날짜(Asia/Seoul). 공동과제라도 **기록자 소속 기관별**로 분리 저장(`organization_id` 고정, 지침 제8조).
- 권리는 기관(지침 제9조): 기록자가 기관을 옮겨도 노트의 `organization_id`는 바뀌지 않는다.

### 6.2 내용 구조
- 섹션(표준 연구노트 양식 7개, Amendment A1 — 이 순서로 표시·해시·내보내기): `OBJECTIVE` 연구 목표, `METHOD` 연구 방법·재료, `PROCEDURE` 수행 내용, `RESULTS` 결과 및 관찰, `DISCUSSION` 고찰·문제점, `NEXT` 향후 계획, `REFERENCES` 참고 자료.
- 문장 단위 블록: `Block { block_id, section, text, origin(HUMAN|AI), accepted(bool), evidence[] }`.
- `evidence`: 근거 참조 — `{ type, ref_id, label, at }`. AI 블록의 근거는 `NOTEBOOK`(그날 저장한 노트북 · 셀), 작업 공간 이벤트(입력 추가·레시피 저장·실행·산출물 등)는 화면의 "오늘 활동" 목록으로만 쓴다.

### 6.3 상태와 불변성
```
DRAFT(본인만) ──제출──▶ SUBMITTED(잠금, 확인자에게 보임) ──서명──▶ SIGNED(확정, 불변)
   ▲                         │반려(사유)
   └─────────────────────────┘
SIGNED 이후 수정 = 새 버전(DRAFT, previous_version_id 연결), 이전 버전은 그대로.
```
- 제출 조건: `origin=AI && accepted=false` 블록이 없어야 함. AI 문장은 고치면 그 문장이 확인한 것으로 기록되고, 그대로 둘 문장은 "초안 확인 완료"를 누르며, 필요 없는 문장은 삭제한다.
- 확인자: 프로젝트 정책(`notes_witness_required`, 기본 false). 꺼져 있으면 기록자 본인 서명으로 SIGNED.
- 서명 = SSO 재인증 직후 발급되는 서명 토큰(5분 유효) + 서명 레코드 `{ signer, role(RECORDER|WITNESS), signed_at(서버 시각), content_hash }`.
- 위·변조 확인: `content_hash = sha256(정규화 JSON(내용+메타))`, `chain_hash = sha256(이전 chain_hash + content_hash)` 를 프로젝트×기관 단위 체인으로 저장. `GET /notes/{id}/verify` 가 다시 계산해 비교.
- 열람 기록: 기록자 외 사람이 노트를 열면 감사 이벤트 `NOTE_VIEWED`(지침 제11조 열람 관리대장).
- 보존: 삭제 API 없음(SIGNED). DRAFT만 기록자가 삭제 가능.
- 내보내기: `GET /notes/export?project_id&from&to` → ZIP(노트 JSON + 사람이 읽는 HTML + 해시 목록).

### 6.4 자동 초안 (로컬 LLM)
- 재료(Amendment A1): 그날 그 프로젝트에서 기록자가 저장한 **Jupyter 노트북**(`NotebookActivityPort`, 노트북 최대 10개·셀 120개)만. 셀마다 앞부분(≤400자)과 출력 종류·개수·오류 여부만 보낸다. 작업 공간 감사 이벤트는 LLM에 보내지 않는다. 그날 노트북이 없으면 `draftNote` → 422 `VALIDATION_FAILED`(reason `NO_NOTEBOOK_ACTIVITY`). Jupyter(M07) 전까지 포트 기본값은 빈 목록이다.
- **출력 값·원본 데이터·파일 내용은 보내지 않는다.**
- 호출: 워커가 OpenAI 호환 `POST {NAIS_LLM_BASE_URL}/v1/chat/completions`, 모델 `NAIS_LLM_MODEL`(기본 `llm`), `temperature 0.2`, JSON 출력 지시(위 7개 섹션 키별 문장 배열 + 각 문장의 근거 번호; PROCEDURE·RESULTS는 근거 필수, 노트북에 없는 사실·수치 금지). 응답 검증 실패 시 1회 재시도 후 실패 기록.
- 시점: (a) 매일 19:00 KST 배치 — 그날 노트북을 저장했고 노트가 없거나 DRAFT인 기록자만, (b) "지금 초안 만들기" 버튼(1분에 1회 제한).
- 반영: 새 AI 블록은 `accepted=false`로 DRAFT에 덧붙인다. 사람이 쓴 블록은 절대 덮어쓰지 않는다. 같은 근거로 이미 만든 문장은 다시 만들지 않는다(evidence 중복 제거).
- 장애: LLM 연결 실패 → 노트에 "초안을 만들지 못했습니다" 상태만, 기능은 정상. `NAIS_LLM_ENABLED=false`면 버튼 숨김.
- 부하: GPU를 규정 플랫폼과 함께 쓰므로 동시 요청 1, 요청당 최대 출력 800토큰, 입력 이벤트 최대 60개(넘으면 요약 집계).

### 6.5 화면
- `/commons/notes`: 내 노트(프로젝트·날짜·상태 필터), 확인할 노트(확인자).
- 프로젝트 `연구노트` 탭: 날짜별 목록 + 오늘 노트 열기.
- 노트 편집기: 표준 양식 7개 섹션, AI 문장 회색(문장을 고치거나 "초안 확인 완료"로 확인, 또는 삭제), 근거 칩(누르면 그 데이터·실행으로), 하단 상태 바(상태, 해시 일부, 제출/서명 버튼).
- SIGNED 노트: 읽기 전용, 서명 목록, "위·변조 확인" 결과, "새 버전으로 수정".

## 7. 아키텍처

- 백엔드 새 모듈 2개(기존 모듈 규칙을 그대로 따름, DB 스키마 소유):
  - `workspace` (`workspace.*`): 입력, 레시피, 실행, 산출물, 계보, 토론, 허브 집계.
  - `notes` (`notes.*`): 노트, 블록, 버전, 서명, 체인, 초안 작업.
- 다른 모듈은 공개 인터페이스로만 호출: 구성원 여부(project), 활성 권한(governance), 데이터셋·버전 조회(catalog), 감사 기록·조회(audit), 객체 저장소(platform).
- 워커 작업: `workspace.run_recipe`, `workspace.publish_output`(허브 공개), `notes.draft_note`(버튼·저녁 일정 `notes.daily_drafts` 공용), `notes.embed_notes`(+ `notes.embed_sweep`).
- LLM 클라이언트: `platform` 아래 얇은 OpenAI 호환 httpx 클라이언트, 설정 `NAIS_LLM_BASE_URL`, `NAIS_LLM_MODEL`, `NAIS_LLM_ENABLED`, `NAIS_LLM_TIMEOUT_S`.
- 계약: `NAIS_PRD/contracts/openapi.yaml`에 경로·스키마·오류 코드 추가 → TS 생성 → 웹 MSW mock(백엔드와 같은 규칙) → 웹 화면.
- 데모(mock) 모드: 웹 서버 안의 mock API(`app/mock-api`, MSW 핸들러가 서버에서 실행)가 백엔드와 같은 규칙을 흉내 낸다. mock 초안은 LLM(`:8001`)을 부르지 않고 시드 노트북 활동으로 만든 결정적 문장을 쓴다(web 컨테이너는 LLM을 부르지 않는다). 실제 LLM 초안은 api/worker가 `NAIS_LLM_*`로 켜졌을 때만 나온다.
- 웹: 기존 기능 폴더 규칙(`features/hub`, `features/workspace`, `features/notes`), 디자인 시스템 토큰, 담백한 업무 화면.

## 8. 오류 코드 (추가)
`ACCESS_REQUIRED`, `INPUT_ACCESS_LAPSED`, `RECIPE_INVALID`, `RUN_NOT_ALLOWED`, `OUTPUT_PUBLISH_PENDING`, `NOTE_LOCKED`, `NOTE_HAS_UNACCEPTED_AI`, `NOTE_SIGNATURE_EXPIRED`, `NOTE_NOT_WITNESS`, `LLM_UNAVAILABLE`, `RATE_LIMITED`.

## 9. 단계 (모두 이번 작업 범위)
1. **허브·작업 공간 기초·연구노트**: 허브 홈과 데이터 카드 탭, 입력·산출물(업로드)·토론, 연구노트 전체(작성·LLM 초안·제출·서명·검증·내보내기).
2. **변환 실행·계보·공개 승격**: 레시피 실행(워커, pandas/pyarrow), 파생 데이터셋, 계보 그래프, 허브 공개 검토.
3. **확장**: 노트 의미 검색(`:8002` 임베딩 + `:8003` 재정렬), 스크립트 단계(격리 실행, 기본 비활성 플래그), 외부 TSA·기관 전자서명 연동 지점(인터페이스만).

## 10. 테스트·완료 기준
- API: 모듈 단위 테스트(권한 경계: 비구성원·권한 없음·회수 후), 상태 전이 테스트(노트 잠금·서명·새 버전), 해시 체인 검증, LLM 클라이언트는 가짜 서버로(실제 :8001 호출은 수동 스모크 1회).
- 웹: 화면 단위 테스트(MSW), e2e 시나리오: 허브 → 데이터 카드 → 프로젝트에 입력 추가 → 레시피 저장·실행 → 산출물 → 연구노트 초안 수락 → 제출 → 서명 → 위·변조 확인.
- 접근성 axe 0건, 390px 가로 스크롤 없음, 라이트/다크.
- 21051(mock 모드) 반영. 실제 :8001 초안 스모크는 api 쪽 `test_live_llm.py`(`NAIS_LIVE_LLM=1`, 사설망에서 수동).
