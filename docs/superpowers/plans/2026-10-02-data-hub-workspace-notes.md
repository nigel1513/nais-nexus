# AI Data-Hub · 프로젝트 작업 공간 · 연구노트 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 데이터 허브, Kaggle식 프로젝트 작업 공간(입력·레시피 변환·산출물·계보·토론), 연구노트(작성·LLM 초안·제출·서명·위변조 검증·내보내기·검색)를 실제 백엔드 모듈 + 계약 + 웹 mock + 웹 화면으로 운영 수준까지 구현한다.

**Architecture:** 새 백엔드 모듈 `workspace`(`workspace.*`)와 `notes`(`notes.*`)를 기존 모듈 규칙(ModuleSpec, Alembic, SQLAlchemy Core, outbox 이벤트, Dramatiq 작업, public 포트)대로 추가한다. 다른 모듈은 public 포트로만 부르고, 거버넌스 백엔드가 없으므로 권한 확인은 fail-closed 소비자 포트로 둔다. 연구노트는 관련 이벤트를 구독해 자기 근거 테이블을 만들고, 워커가 사내 vLLM(:8001)으로 초안을 쓴다. 웹은 계약 → MSW mock(백엔드 규칙 미러) → 화면 순서.

**Tech Stack:** FastAPI, SQLAlchemy 2 Core(psycopg3, sync), Alembic, Dramatiq(Redis), httpx, pandas/pyarrow(레시피 실행), OpenAPI 3.1 + openapi-typescript + datamodel-codegen, Next.js 15 + React Query + openapi-fetch + MSW, vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-02-data-hub-workspace-notes-design.md`

## Global Constraints
- 모듈 경계: 다른 모듈 테이블 직접 조회 금지, `public.py` 포트만. `public.py`는 leaf(typing/uuid/nais_contracts만 import).
- 이벤트 이름 `<module>.<entity>.<verb>.v1`, `NAIS_PRD/contracts/events/{index.json,p0_events.schema.json}`에 등록, outbox로 같은 트랜잭션에서 기록.
- 감사·알림은 audit 모듈의 `mapping.py`/`notification_rules.py`에서만.
- 계약 변경은 `NAIS_PRD/contracts/openapi.yaml`(버전 1.3.0 → 1.4.0) + `error_codes.json` + 생성(`uv run python packages/contracts/generate.py`) + 웹 `contracts:sync`, `docs/adr/` CCR 문서, `NAIS_PRD/11_DECISION_LOG.md` 항목.
- 새 enum/오류 코드는 `apps/web/src/messages/ko.json`의 `enums.*`/`errors.*` 필수.
- LLM 입력은 활동 메타데이터만(데이터셋 제목·버전·열 이름·행 수·오류 요약). 파일 내용·행 값 금지.
- LLM 설정: `NAIS_LLM_ENABLED`(기본 false), `NAIS_LLM_BASE_URL`(예 `http://192.168.0.2:8001`), `NAIS_LLM_MODEL`(기본 `llm`), `NAIS_LLM_TIMEOUT_S`(기본 60), 임베딩 `NAIS_EMBED_BASE_URL`(`:8002`, 모델 `bge-m3`), 재정렬 `NAIS_RERANK_BASE_URL`(`:8003`, 모델 `bge-reranker`). `.env.example`에 모두 기재(테스트가 검사).
- 공인 IP(`/data/project/nst-nexus/.env`의 `NAIS_EXTERNAL_HOST`) 커밋 금지. 내부 IP 192.168.0.2는 `.env.example`에 예시로만.
- 시각: 서버 UTC 저장, 노트 날짜는 Asia/Seoul 기준 `note_date`.
- 웹: 디자인 시스템 토큰, 담백한 업무 화면, axe 0, 390px 가로 스크롤 없음, 라이트/다크.

## Review Focus
1. 권한 회수·만료 후 입력/실행/산출물 접근: 입력은 `access_lapsed`로 보이고 실행·다운로드는 `INPUT_ACCESS_LAPSED`(409)로 막혀야 한다 — Task 3, 6 테스트.
2. SIGNED 노트 수정 시도(블록 PATCH, 삭제, 재서명): 항상 `NOTE_LOCKED`(409), 새 버전만 허용 — Task 9 테스트.
3. LLM이 근거 없는 문장·잘못된 JSON·타임아웃을 줄 때: 재시도 1회, 실패면 노트에 `draft_status=FAILED`만 남고 사람 블록 무손상 — Task 10 테스트.
4. 공동과제에서 다른 기관 기록자의 노트 열람: 기록자·확인자(같은 프로젝트, 서명 요청 대상) 외 403, 확인자 열람 시 `notes.note.viewed.v1` 이벤트 — Task 9 테스트.
5. 산출물 접근 등급 하향 시도(PUBLIC으로 업로드·공개 요청): 입력 중 가장 엄격한 등급 아래로 못 내린다(`VALIDATION_FAILED`) — Task 5 테스트.

---

### Task 1: 계약 1.4.0 — 경로·스키마·오류 코드·이벤트·소유권·스키마 생성

**Files:**
- Modify: `NAIS_PRD/contracts/openapi.yaml` (tags `hub`, `workspace`, `notes`; version 1.4.0)
- Modify: `NAIS_PRD/contracts/error_codes.json`, `NAIS_PRD/contracts/events/index.json`, `NAIS_PRD/contracts/events/p0_events.schema.json`, `NAIS_PRD/contracts/module_ownership.json`
- Modify: `infra/docker/postgres/init.sql` (스키마 `workspace`, `notes` 추가 + 역할 권한 기존 패턴대로)
- Create: `docs/adr/CCR-2026-10-02-workspace-notes.md`; Modify: `NAIS_PRD/11_DECISION_LOG.md` (연구노트·로컬 LLM·작업 공간 결정)
- Regenerate: `packages/contracts/ts/openapi.d.ts`, `packages/contracts/python/nais_contracts/api_models.py`, `apps/api/platform/generated/*`, `apps/web/src/generated/contracts.ts`
- Modify: `apps/web/src/messages/ko.json` (`enums.*`, `errors.*`), 계약 테스트 기대값(`platform/tests/test_contract_v1_3.py` 패턴으로 `test_contract_v1_4.py` 신설)

**Operations (operationId — method path):**
- hub: `getHubOverview` GET `/hub/overview`; `listDatasetProjects` GET `/datasets/{dataset_id}/projects`; `listDatasetActivity` GET `/datasets/{dataset_id}/activity`
- workspace inputs: `listProjectInputs` GET `/projects/{project_id}/inputs`; `addProjectInput` POST same; `updateProjectInput` PATCH `/projects/{project_id}/inputs/{input_id}` (버전 변경·메모); `removeProjectInput` DELETE same
- recipes: `listRecipes` GET `/projects/{project_id}/recipes`; `createRecipe` POST; `getRecipe` GET `/projects/{project_id}/recipes/{recipe_id}`; `updateRecipe` PUT same (If-Match 버전); `deleteRecipe` DELETE same; `previewRecipe` POST `/projects/{project_id}/recipes/{recipe_id}/preview` (처음 100행)
- runs: `startRun` POST `/projects/{project_id}/recipes/{recipe_id}/runs`; `listRuns` GET `/projects/{project_id}/runs`; `getRun` GET `/projects/{project_id}/runs/{run_id}`
- outputs: `listOutputs` GET `/projects/{project_id}/outputs`; `createOutputUpload` POST `/projects/{project_id}/outputs` (파일 업로드 세션, presign PUT); `completeOutputUpload` POST `/projects/{project_id}/outputs/{output_id}/complete`; `getOutput` GET `/projects/{project_id}/outputs/{output_id}` (lineage 포함); `getOutputDownload` POST `/projects/{project_id}/outputs/{output_id}/download`; `requestOutputPublish` POST `/projects/{project_id}/outputs/{output_id}/publish-requests`; `listPublishRequests` GET `/publish-requests?role=reviewer|requester`; `decidePublishRequest` POST `/publish-requests/{request_id}/decision`
- discussion: `listThreads` GET `/threads?scope=&target_id=`; `createThread` POST `/threads`; `listComments` GET `/threads/{thread_id}/comments`; `addComment` POST same; `updateThread` PATCH `/threads/{thread_id}` (resolved)
- notes: `listNotes` GET `/notes?project_id=&status=&from=&to=&role=recorder|witness`; `getOrCreateTodayNote` POST `/projects/{project_id}/notes/today`; `getNote` GET `/notes/{note_id}`; `updateNoteBlocks` PUT `/notes/{note_id}/blocks` (If-Match revision); `draftNote` POST `/notes/{note_id}/draft`; `submitNote` POST `/notes/{note_id}/submit`; `rejectNote` POST `/notes/{note_id}/reject`; `signNote` POST `/notes/{note_id}/sign`; `reviseNote` POST `/notes/{note_id}/revise` (SIGNED → 새 DRAFT 버전); `verifyNote` GET `/notes/{note_id}/verify`; `exportNotes` GET `/notes/export?project_id=&from=&to=` (application/zip); `searchNotes` GET `/notes/search?q=&project_id=`; `getNoteSettings`/`updateNoteSettings` GET/PATCH `/projects/{project_id}/note-settings` (`witness_required`, `witness_user_ids`)

**Schemas (요지, 필드명 고정):**
- `ProjectInput { input_id, project_id, dataset_id, dataset_title, dataset_version_id, version_label, newer_version_label|null, access_level, access_lapsed, added_by, added_by_display_name, added_at, note|null }`
- `RecipeStep = oneOf(select_columns{columns[]}, filter_rows{column, op(eq|ne|lt|le|gt|ge|contains|in|is_null|not_null), value}, drop_missing{columns[]|null}, fill_missing{column, value}, cast_type{column, to(int|float|string|bool|datetime)}, convert_unit{column, factor, offset, unit_label}, aggregate{group_by[], metrics[{column, fn(count|sum|mean|min|max)}]}, join{right_input_id, on[], how(inner|left)}, sort{by[], descending}, limit{n})`, 판별자 `type`.
- `Recipe { recipe_id, project_id, name, input_ids[], steps[], version, updated_by, updated_at }`
- `Run { run_id, recipe_id, recipe_version, status(QUEUED|RUNNING|SUCCEEDED|FAILED), started_by, queued_at, started_at|null, finished_at|null, input_rows|null, output_rows|null, error|null, output_id|null }`
- `Output { output_id, project_id, kind(DERIVED_DATASET|FILE), title, access_level, files[{name, size_bytes, sha256, media_type}], produced_by_run_id|null, lineage{inputs[{dataset_id, dataset_title, dataset_version_id, version_label}], recipe_id|null, recipe_version|null, run_id|null}, publish_status(NONE|PENDING|APPROVED|REJECTED|PUBLISHED), created_by, created_at }`
- `PublishRequest { request_id, output_id, project_id, status(PENDING|APPROVED|REJECTED), approvals[{organization_id, decided_by|null, decision(APPROVE|REJECT)|null, comment|null, decided_at|null}], created_by, created_at }`
- `Thread { thread_id, scope(PROJECT|DATASET|OUTPUT|RECIPE), target_id, title, created_by, created_by_display_name, created_at, resolved, comment_count, last_comment_at }`, `Comment { comment_id, thread_id, body, author_id, author_display_name, created_at, edited_at|null }`
- `HubOverview { rails{trending[HubCard], recent[HubCard], most_used[HubCard]}, organizations[{organization_id, name, dataset_count, public_count, controlled_count, last_updated_at|null}] }`, `HubCard { dataset_id, title, owner_organization_name, subject_labels[], access_level, readiness_overall|null, updated_at, metric|null }`
- `ResearchNote { note_id, project_id, project_name, organization_id, recorder_id, recorder_display_name, note_date, version, previous_version_id|null, status(DRAFT|SUBMITTED|SIGNED), revision, blocks[NoteBlock], draft_status(NONE|QUEUED|RUNNING|FAILED|DONE), draft_error|null, signatures[{signer_id, signer_display_name, role(RECORDER|WITNESS), signed_at, content_hash}], content_hash|null, chain_hash|null, submitted_at|null, rejected_reason|null, created_at, updated_at }`
- `NoteBlock { block_id, section(DIRECTION|STEPS|RESULTS|NEXT|MEMO), text, origin(HUMAN|AI), accepted, evidence[{type(INPUT_ADDED|INPUT_VERSION_CHANGED|RECIPE_SAVED|RUN_SUCCEEDED|RUN_FAILED|OUTPUT_CREATED|PUBLISH_REQUESTED|DATASET_DOWNLOADED|ACCESS_DECIDED), ref_id, label, at}] }`
- `NoteVerification { note_id, valid, content_hash, recomputed_hash, chain_valid, checked_at }`
- `NoteSearchHit { note_id, project_name, note_date, snippet, score|null }`
- `NoteSettings { project_id, witness_required, witness_user_ids[], llm_enabled }` (`llm_enabled`는 서버 설정 읽기 전용)
- 오류 코드(§8 + http): `ACCESS_REQUIRED` 403, `INPUT_ACCESS_LAPSED` 409, `RECIPE_INVALID` 422, `RUN_NOT_ALLOWED` 409, `OUTPUT_PUBLISH_PENDING` 409, `NOTE_LOCKED` 409, `NOTE_HAS_UNACCEPTED_AI` 409, `NOTE_SIGNATURE_EXPIRED` 401, `NOTE_NOT_WITNESS` 403, `LLM_UNAVAILABLE` 503, `RATE_LIMITED` 429.
- 이벤트: `workspace.input.added.v1`, `workspace.input.version_changed.v1`, `workspace.input.removed.v1`, `workspace.recipe.saved.v1`, `workspace.run.succeeded.v1`, `workspace.run.failed.v1`, `workspace.output.created.v1`, `workspace.publish.requested.v1`, `workspace.publish.decided.v1`, `workspace.comment.added.v1`, `notes.note.submitted.v1`, `notes.note.signed.v1`, `notes.note.rejected.v1`, `notes.note.viewed.v1`. 공통 payload: `project_id, actor_id, occurred_at` + 엔티티 id·label.

- [ ] **Step 1:** CCR 문서·결정 기록 작성(배경·변경 목록·호환성: 추가만, 기존 경로 무변경).
- [ ] **Step 2:** openapi.yaml에 위 경로·스키마 추가, 각 operation에 `security`, 공통 오류 응답 참조, 예제 1개씩. version 1.4.0.
- [ ] **Step 3:** error_codes.json·events·module_ownership·init.sql 수정.
- [ ] **Step 4:** `uv run python packages/contracts/generate.py` → `--check` 통과, `pnpm --filter @nais/web contracts:sync`.
- [ ] **Step 5:** `ko.json`에 새 enum·오류 라벨, `apps/api/platform/tests/test_contract_v1_4.py`(새 operationId 집합·오류 코드·이벤트 등록 확인), `uv run pytest tests/contract apps/api/platform/tests -q` 통과, 웹 `pnpm --filter @nais/web test src/i18n` 통과.
- [ ] **Step 6:** Commit `feat(contracts): 1.4.0 hub, workspace and research notes`.

### Task 2: 플랫폼 — LLM/임베딩/재정렬 클라이언트와 모듈 등록

**Files:**
- Create: `apps/api/platform/llm.py`, `apps/api/platform/tests/test_llm.py`
- Modify: `apps/api/platform/settings.py`(LLM 필드), `apps/api/platform/modules.py`(`DEFAULT_MODULE_ORDER`에 `workspace`, `notes`를 `catalog`·`project` 뒤, `audit` 앞), `.env.example`

**Interfaces (Produces):**
```python
class LlmUnavailable(Exception): ...
@dataclass(frozen=True)
class ChatMessage: role: Literal["system","user","assistant"]; content: str
class LlmClient(Protocol):
    def chat_json(self, messages: list[ChatMessage], *, max_tokens: int = 800, temperature: float = 0.2) -> dict: ...
class EmbeddingClient(Protocol):
    def embed(self, texts: list[str]) -> list[list[float]]: ...
class RerankClient(Protocol):
    def rerank(self, query: str, documents: list[str]) -> list[float]: ...
def get_llm_client() -> LlmClient | None   # None when NAIS_LLM_ENABLED is false
def get_embedding_client() -> EmbeddingClient | None
def get_rerank_client() -> RerankClient | None
```
- httpx 동기, `transport` 주입 가능, 타임아웃·연결 실패·5xx → `LlmUnavailable`. `chat_json`은 응답 본문에서 첫 JSON 객체를 파싱(코드펜스 허용), 실패 시 `ValueError`.
- 동시성 1: 모듈 수준 `threading.Semaphore(1)`로 프로세스 내 직렬화(규정 플랫폼과 GPU 공유).

- [ ] **Step 1:** 테스트: httpx.MockTransport로 (a) 정상 JSON, (b) 코드펜스 JSON, (c) 깨진 JSON → ValueError, (d) 503 → LlmUnavailable, (e) disabled → None, (f) embed/rerank 응답 형태(`/v1/embeddings` `data[].embedding`, `/v1/score` 또는 `/rerank` — vLLM rerank는 `POST /rerank` `{"model","query","documents"}` → `results[{index, relevance_score}]`).
- [ ] **Step 2:** 실패 확인 → 구현 → 통과. `.env.example`에 키 추가 후 `apps/api/platform/tests/test_env_example.py` 통과.
- [ ] **Step 3:** Commit `feat(platform): OpenAI-compatible LLM, embedding and rerank clients`.

### Task 3: workspace 모듈 골격 + 입력(Input) API

**Files (Create under `apps/api/modules/workspace/`):** `__init__.py`(MODULE), `settings.py`, `tables.py`, `migrations/workspace_0001_initial.py`, `public.py`, `interfaces.py`(소비 포트: `GrantQueryPort.has_active_grant(user_id, dataset_id) -> bool` + `NoGrants` fail-closed 기본, 거버넌스 모듈 생기면 교체), `deps.py`, `wiring.py`, `errors.py`, `schemas.py`(nais_contracts 모델 재사용), `routes/inputs.py`, `service/inputs.py`, `tests/conftest.py`, `tests/test_inputs.py`, `tests/test_routes_contract.py`, `README.md`

**Tables (`workspace` 스키마):** `inputs(input_id pk, project_id, dataset_id, dataset_version_id, added_by, added_at, note, removed_at null)`, unique (project_id, dataset_id) where removed_at is null; `processed_events`(claim_event 패턴).

**Rules:**
- 추가: 프로젝트 활성 구성원(`ProjectQueryPort.is_active_member`) 아니면 403 `FORBIDDEN`; 데이터셋 가시성(`CatalogQueryPort.is_visible`) 없으면 404; 버전 존재·발행 상태(`get_version`) 확인; `access_level != PUBLIC`이면 `GrantQueryPort.has_active_grant(user, dataset)` 필요 → 없으면 403 `ACCESS_REQUIRED`.
- 조회 시 `access_lapsed = level != PUBLIC and not has_active_grant(any active member? → 요청자 기준)`, `newer_version_label` = 카탈로그 최신 발행 버전이 고정 버전보다 새로우면 그 라벨.
- 버전 변경·삭제: 구성원만, 이벤트 기록.
- 이벤트: `workspace.input.added.v1`, `...version_changed.v1`, `...removed.v1`.

- [ ] **Step 1:** conftest(프로젝트 conftest 패턴: upgrade_all, truncate, 가짜 Project/Catalog/Grant 포트), 실패 테스트: 비구성원 403, 비공개 데이터셋 404, CONTROLLED 권한 없음 403 `ACCESS_REQUIRED`, PUBLIC 추가 성공 + outbox 이벤트 1건, 중복 추가 409 `CONFLICT`, 권한 회수 후 목록 `access_lapsed=true`, 새 버전 있을 때 `newer_version_label`, 라우트 계약 테스트(operationId 집합 + `assert_matches_response`).
- [ ] **Step 2:** 마이그레이션·테이블·서비스·라우트 구현, 모듈 등록, `uv run pytest apps/api/modules/workspace -q` 통과.
- [ ] **Step 3:** Commit `feat(workspace): module skeleton and pinned dataset inputs`.

### Task 4: workspace — 토론(스레드·댓글) + 허브 집계 API

**Files:** `routes/threads.py`, `service/threads.py`, `routes/hub.py`, `service/hub.py`, `tables.py`(threads, comments, hub_counters), migration `workspace_0002_threads_hub.py`, `handlers.py`(카탈로그·거버넌스 이벤트 구독으로 허브 카운터 갱신: 버전 발행 시 recent, 입력 추가 시 most_used, 접근 요청 이벤트가 있으면 trending 7일 창), tests `test_threads.py`, `test_hub.py`

**Rules:**
- 스레드 scope=PROJECT/OUTPUT/RECIPE: 프로젝트 구성원만 읽기·쓰기. DATASET: 데이터셋을 볼 수 있는 사람은 읽기, 쓰기는 로그인 사용자 전원(기관 무관), 본문 마크다운 10,000자 제한.
- 허브: `getHubOverview`는 사용자가 볼 수 있는 데이터셋만(`is_visible`), 각 레일 최대 6, trending=최근 7일 `access_requests_7d` 내림차순(0은 제외), recent=최근 발행, most_used=입력 수. 기관 표는 카탈로그 공개 집계 포트(없으면 카탈로그 `CatalogQueryPort`에 `list_dataset_summaries()` 추가 — catalog public 변경은 이 Task에서 함께, catalog 테스트 포함).
- `listDatasetProjects`: 입력으로 쓰는 프로젝트 중 요청자가 구성원인 것은 이름·링크, 나머지는 `hidden_count`.
- `listDatasetActivity`: workspace 자체 기록(입력·산출물 공개)과 카탈로그 버전 이벤트를 구독해 둔 `dataset_activity` 테이블에서.

- [ ] **Step 1:** 실패 테스트(권한 경계, 마크다운 길이 422, 허브 가시성 필터, trending 0 제외, hidden_count).
- [ ] **Step 2:** 구현 → 통과. Commit `feat(workspace): discussions and hub overview`.

### Task 5: workspace — 산출물(업로드)·다운로드·접근 등급 상속

**Files:** `routes/outputs.py`, `service/outputs.py`, `storage.py`(플랫폼 `load_storage_config(org_code)` + boto3로 프로젝트 주관 기관 버킷의 `workspace/{project_id}/outputs/{output_id}/` 접두사에 presign PUT/GET; 카탈로그 내부 코드 import 금지), migration `workspace_0003_outputs.py`, tests `test_outputs.py`

**Rules:**
- 업로드 세션: 파일명·크기·sha256 선언 → presign PUT(15분) → complete 시 HEAD로 크기 확인, sha256 서버 재계산(스트리밍) 불일치면 422.
- 접근 등급: 요청 등급이 입력 중 가장 엄격한 등급보다 느슨하면 422 `VALIDATION_FAILED`(필드 `access_level`). 입력이 없으면 기본 INTERNAL.
- 다운로드: 구성원 + 계보 입력 모두 `access_lapsed=false`여야, 아니면 409 `INPUT_ACCESS_LAPSED`. presign GET 5분.
- 이벤트 `workspace.output.created.v1`.

- [ ] **Step 1:** moto 또는 가짜 S3 포트로 실패 테스트(등급 하향 422, sha 불일치 422, 회수 후 다운로드 409, 비구성원 403).
- [ ] **Step 2:** 구현 → 통과. Commit `feat(workspace): project outputs with inherited access level`.

### Task 6: workspace — 레시피, 미리보기, 실행(워커), 파생 데이터셋, 계보

**Files:** `recipes/steps.py`(단계 검증·pandas 적용 순수 함수), `recipes/reader.py`(카탈로그 `CatalogReadPort.open_stream`으로 입력 버전의 표 파일(CSV/Parquet) 읽기, 행 상한 `WORKSPACE_MAX_ROWS` 기본 5,000,000), `routes/recipes.py`, `routes/runs.py`, `service/recipes.py`, `service/runs.py`, `jobs.py`(actor `workspace.run_recipe`, queue `workspace`), migration `workspace_0004_recipes_runs.py`, tests `test_steps.py`(순수), `test_recipes.py`, `test_runs.py`
- 의존 추가: `pandas`, `pyarrow` (pyproject + uv.lock; 이미 있으면 생략)

**Rules:**
- 단계 검증: 존재하지 않는 열, 타입 불일치, join의 `right_input_id`가 레시피 입력에 없음 → 422 `RECIPE_INVALID`(어느 단계·무엇인지 details).
- 저장 시 version+1, If-Match 불일치 409 `CONFLICT`. 이벤트 `workspace.recipe.saved.v1`.
- 미리보기: 동기, 각 입력 앞 10,000행만 읽어 처리 후 100행 반환(타임아웃 20초).
- 실행: 모든 입력 `access_lapsed=false` 아니면 409 `INPUT_ACCESS_LAPSED`; 같은 레시피 진행 중이면 409 `RUN_NOT_ALLOWED`. 커밋 후 enqueue. 워커: RUNNING → 읽기 → 단계 적용 → Parquet 저장(Task 5 storage) → `Output(kind=DERIVED_DATASET, lineage)` 생성 → SUCCEEDED + 이벤트 `workspace.run.succeeded.v1`/`workspace.output.created.v1`; 예외는 FAILED + 오류 요약(스택 아님) + `workspace.run.failed.v1`.

- [ ] **Step 1:** `test_steps.py`: 단계별 정상·오류 케이스(필터 연산자 10종, 집계, join inner/left, 단위 변환, 형 변환 실패), 실패 확인.
- [ ] **Step 2:** steps 구현 → 통과.
- [ ] **Step 3:** 레시피·실행 API 테스트(StubBroker로 actor 동기 실행, 가짜 CatalogReadPort가 CSV 바이트 제공) → 구현 → 통과.
- [ ] **Step 4:** Commit `feat(workspace): recipe transforms, runs and derived outputs with lineage`.

### Task 7: workspace — 산출물 허브 공개 요청·결정

**Files:** `routes/publish.py`, `service/publish.py`, migration `workspace_0005_publish.py`, tests `test_publish.py`
- catalog public 확장: `CatalogPublishPort.create_dataset_from_output(owner_org_id, title, access_level, files: list[FileUpload], lineage_note) -> UUID` (catalog 모듈에 구현 + 테스트; 파일은 카탈로그 업로드 경로로 복사 후 검증 큐) — catalog 변경은 최소·추가만.

**Rules:**
- 요청: 프로젝트 구성원, 산출물 publish_status NONE/REJECTED만, 승인자 = 계보 입력의 소유 기관별 DATA_STEWARD(기관당 1표). 입력이 없는 업로드 산출물은 프로젝트 주관 기관 관리자 1표.
- 결정: 해당 기관 DATA_STEWARD만(`CurrentUser`의 기관·역할로 판정; 승인자 목록 계산은 identity public 포트에 역할 조회가 없으면 `list_org_member_ids_with_role(org_id, role)`을 identity public에 추가 + 테스트), 하나라도 REJECT면 REJECTED, 전원 APPROVE면 카탈로그 생성 → PUBLISHED.
- 이벤트 `workspace.publish.requested.v1`, `workspace.publish.decided.v1`(알림 대상: 승인자, 요청자).

- [ ] **Step 1:** 실패 테스트 → 구현 → 통과 → Commit `feat(workspace): publish derived outputs to the hub through owner review`.

### Task 8: audit — 새 이벤트의 감사 매핑·알림 규칙

**Files:** `apps/api/modules/audit/mapping.py`, `notification_rules.py`, tests 갱신; 계약 enum `AuditAction`/`ResourceType`에 값 추가가 필요하면 Task 1 계약에 포함(이 Task에서 누락 발견 시 계약 갱신 + 재생성).
- 알림: 공개 요청 → 승인자, 결정 → 요청자, 노트 제출 → 확인자, 노트 반려·서명 → 기록자, 데이터셋 토론 댓글 → 데이터셋 관리자.

- [ ] **Step 1:** 실패 테스트(이벤트별 감사 행·알림 초안 한국어 제목) → 구현 → 통과 → Commit `feat(audit): audit and notifications for workspace and notes events`.

### Task 9: notes 모듈 — 노트·블록·상태·서명·해시 체인·검증·내보내기

**Files (Create `apps/api/modules/notes/`):** `__init__.py`, `settings.py`, `tables.py`, `migrations/notes_0001_initial.py`, `public.py`, `interfaces.py`, `deps.py`, `wiring.py`, `errors.py`, `hashing.py`(정규화 JSON + sha256 + 체인), `service/notes.py`, `service/signing.py`, `service/export.py`, `routes/notes.py`, `routes/settings.py`, tests `test_hashing.py`, `test_notes.py`, `test_signing.py`, `test_export.py`, `test_routes_contract.py`

**Tables:** `notes(note_id, project_id, organization_id, recorder_id, note_date, version, previous_version_id, status, revision, draft_status, draft_error, content_hash, chain_hash, submitted_at, signed_at, rejected_reason, created_at, updated_at)` unique (project_id, recorder_id, note_date, version); `blocks(block_id, note_id, position, section, text, origin, accepted, evidence jsonb)`; `signatures(signature_id, note_id, signer_id, role, signed_at, content_hash, auth_time)`; `chains(project_id, organization_id, last_chain_hash, updated_at)`; `settings(project_id, witness_required, witness_user_ids[])`; `evidence(evidence_id, project_id, actor_id, note_date, type, ref_id, label, at, payload jsonb)` (Task 10이 채움); `processed_events`.

**Rules:**
- `getOrCreateTodayNote`: 구성원만, 오늘(KST) 최신 버전이 있으면 반환, 없으면 DRAFT 생성(organization_id = 기록자 현재 기관).
- 읽기 권한: 기록자 본인; SUBMITTED/SIGNED는 + 확인자 목록의 사용자(같은 프로젝트 활성 구성원); DRAFT는 기록자만. 그 외 404(존재 숨김). 기록자 외 열람 시 이벤트 `notes.note.viewed.v1`.
- 블록 수정: DRAFT만(그 외 409 `NOTE_LOCKED`), If-Match revision.
- 제출: 미수락 AI 블록 있으면 409 `NOTE_HAS_UNACCEPTED_AI`; content_hash 계산·고정, SUBMITTED. `witness_required=false`면 제출 없이 바로 서명 가능(DRAFT→SIGNED 경로는 sign이 submit을 포함).
- 반려: 확인자만 → DRAFT, 사유 필수.
- 서명: 토큰 `auth_time` 클레임(플랫폼 `CurrentUser`에 없으면 `platform/auth.py`에 `auth_time: datetime | None` 추가 + 테스트)이 5분 이내여야(아니면 401 `NOTE_SIGNATURE_EXPIRED`, 웹은 재로그인 유도). RECORDER 서명(본인) / WITNESS 서명(확인자, 아니면 403 `NOTE_NOT_WITNESS`). 필요한 서명이 모두 모이면 SIGNED, `chain_hash = sha256(prev_chain + content_hash)`를 같은 트랜잭션에서 `chains` 행 잠금(`SELECT ... FOR UPDATE`)으로 갱신.
- 새 버전: SIGNED만 → 블록 복사한 새 DRAFT(version+1, previous_version_id).
- 검증: 저장된 내용으로 content_hash 재계산 비교 + 체인 재구성(해당 프로젝트×기관 SIGNED 노트를 서명 순으로) 비교.
- 내보내기: 기록자 본인 노트 또는 기관 관리자(ORG_ADMIN, 같은 기관) — ZIP(`notes/*.json`, `notes/*.html`, `hashes.csv`), 스트리밍.
- DRAFT 삭제는 기록자만, SIGNED 삭제 API 없음.

- [ ] **Step 1:** `test_hashing.py`(정규화: 키 정렬·공백 무관·한글 NFC), 상태 전이 표 전체(허용·거부 각 1개 이상), 권한 경계(타 기관·DRAFT 비공개·확인자), `auth_time` 만료, 체인 검증(중간 노트 DB 변조 시 valid=false), 내보내기 ZIP 내용 → 실패 확인.
- [ ] **Step 2:** 구현 → `uv run pytest apps/api/modules/notes -q` 통과 → Commit `feat(notes): research notes with signing, hash chain, verification and export`.

### Task 10: notes — 근거 수집(이벤트 구독)과 LLM 초안(워커·스케줄·즉시)

**Files:** `handlers.py`(`@subscribe`: workspace 이벤트 전부 + 존재하는 다운로드/접근 결정 이벤트 → `evidence` 행, claim_event로 멱등), `drafting/prompt.py`(시스템 프롬프트·사용자 메시지 구성, 입력 최대 60건·초과 시 유형별 집계), `drafting/parse.py`(JSON 스키마 검증: `{sections:{DIRECTION:[{text, evidence:[idx]}], STEPS:[], RESULTS:[], NEXT:[]}}`, 근거 인덱스 범위 확인, 근거 없는 STEPS/RESULTS 문장 버림), `drafting/apply.py`(AI 블록 덧붙이기, 같은 evidence 집합 중복 제거, HUMAN 블록 불변), `jobs.py`(actor `notes.draft_note`, 스케줄 `notes.daily_drafts` 15분마다 실행하되 KST 19:00–19:14 창에서만 대상 선정), `routes/notes.py`의 `draftNote`(1분 1회 제한 → 429 `RATE_LIMITED`, LLM 꺼짐 → 503 `LLM_UNAVAILABLE`), tests `test_evidence.py`, `test_prompt.py`, `test_parse.py`, `test_apply.py`, `test_drafting_job.py`

**System prompt (고정, `drafting/prompt.py`):**
```
너는 국가연구개발 연구노트의 초안을 쓰는 도우미다.
규칙:
1) 주어진 활동 기록(번호 매긴 목록)만 근거로 쓴다. 기록에 없는 사실·수치·해석을 만들지 않는다.
2) 각 문장에 근거 번호를 evidence 배열로 단다. STEPS와 RESULTS 문장은 근거가 반드시 있어야 한다.
3) DIRECTION(방향·결정)과 NEXT(다음 할 일)는 연구자 메모가 있을 때만 쓴다. 없으면 빈 배열.
4) 한국어 평서문, 문장당 120자 이내, 섹션당 최대 6문장.
5) 아래 JSON 하나만 출력한다: {"sections":{"DIRECTION":[],"STEPS":[],"RESULTS":[],"NEXT":[]}} 각 원소는 {"text": "...", "evidence": [번호...]}.
```

- [ ] **Step 1:** 실패 테스트: 이벤트→근거 멱등(같은 이벤트 2번 → 1행), 프롬프트에 파일 내용·행 값이 들어가지 않음(입력 페이로드에 금지 키 주입해도 제외), 파싱(코드펜스·여분 텍스트·잘못된 인덱스·근거 없는 STEPS 버림), 적용(HUMAN 불변, 중복 제거, accepted=false), 작업: LLM 가짜 클라이언트 성공 → DONE, 깨진 JSON 2회 → FAILED + 사람 블록 무손상, 타임아웃 → FAILED, disabled → 503, 1분 내 재호출 429, 스케줄 창 밖 대상 0.
- [ ] **Step 2:** 구현 → 통과 → Commit `feat(notes): evidence capture and local-LLM drafting`.

### Task 11: notes — 의미 검색(임베딩 + 재정렬)

**Files:** migration `notes_0002_embeddings.py`(`embeddings(note_id, version, vector float4[], text_hash, updated_at)`; pgvector 미사용 — 기록자 범위 수천 건 이내라 파이썬 코사인), `search.py`, handler(노트 SIGNED/DRAFT 저장 시 임베딩 재계산 작업 enqueue), `routes/notes.py` `searchNotes`, tests `test_search.py`

**Rules:** 검색 범위 = 요청자가 읽을 수 있는 노트만(Task 9 권한 그대로). 임베딩 클라이언트 없으면 PostgreSQL `ILIKE` 키워드 검색으로 대체(같은 응답 형태, score=null). 상위 50개 코사인 → 재정렬 클라이언트 있으면 재정렬 상위 20.

- [ ] **Step 1:** 실패 테스트(권한 필터, 대체 경로, 재정렬 순서) → 구현 → 통과 → Commit `feat(notes): semantic note search with embedding and rerank`.

### Task 12: 웹 mock — 허브·작업 공간·연구노트 핸들러(백엔드 규칙 미러)

**Files:** `apps/web/src/mocks/types.ts`(컬렉션 추가), `src/mocks/fixtures.ts`(시드: 기존 프로젝트에 입력 2개·레시피 1개·성공 실행 1개·파생 산출물 1개·스레드 2개·김민준의 SIGNED 노트 1개(과거 날짜)·DRAFT 노트 1개), `src/mocks/handlers/hub.ts`, `workspace.ts`, `notes.ts`, `src/mocks/handlers/index.ts`, `src/mocks/recipes.ts`(웹 mock용 단계 적용 — 미리 만든 CSV 시드에 적용), `src/mocks/llm.ts`(서버 env `NAIS_LLM_BASE_URL` 있으면 fetch로 :8001 호출, 없으면 근거로 결정적 문장), tests `src/mocks/handlers/workspace.test.ts`, `notes.test.ts`, `hub.test.ts`, `src/mocks/contract.test.ts`(operationId 총수 갱신 + 새 호출)
- mock 거버넌스 권한(`getDb().grants`)을 실제 `has_active_grant`로 사용(데모에서 전체 흐름 동작).
- 해시: Web Crypto `crypto.subtle.digest`는 서버(Node) 핸들러에서만 쓰므로 OK(브라우저 secure-context 문제 없음 — mock은 서버 라우트에서 실행).

- [ ] **Step 1:** 실패 테스트(백엔드 Task 3–11 규칙의 핵심 케이스 미러: ACCESS_REQUIRED, access_lapsed, NOTE_LOCKED, NOTE_HAS_UNACCEPTED_AI, 체인 검증, 초안 적용 규칙) → 구현 → `pnpm --filter @nais/web test src/mocks` 통과 → Commit `feat(web): mocks for hub, workspace and research notes`.

### Task 13: 웹 — 메뉴·데이터 허브 홈·데이터 카드 탭

**Files:** `src/shared/ui/nav.ts`(노트북(예정) → 연구노트 `/commons/notes`, 데이터 허브 `/commons/hub` 추가), `src/features/hub/{api.ts, hub-screen.tsx, components/hub-card.tsx, hub.test.tsx}`, `src/app/(platform)/commons/hub/page.tsx`, 데이터 카드 탭 추가(`src/features/catalog/...` 상세 화면의 탭 목록에 `프로젝트`, `토론`, `이력` + 각 컴포넌트, "프로젝트에서 열기" 다이얼로그), `src/features/discussion/{api.ts, thread-list.tsx, thread-view.tsx}`(공용), `ko.json`/`en.json` 문구, `platform-shell.test.tsx` 갱신
- 화면 규칙: PageHeader, 카드 레일은 3열 그리드(390px 1열), 카드 메타 한 줄, 수치 없으면 숨김, 기관 현황 DataTable.

- [ ] **Step 1:** 화면 테스트(레일 3개·빈 레일 숨김·필터 칩 → 검색 이동·탭 3개·프로젝트에서 열기 권한 없음 → 접근 요청 링크) 실패 → 구현 → 통과 → Commit `feat(web): data hub home and dataset projects, discussion and history tabs`.

### Task 14: 웹 — 프로젝트 작업 공간(개요·데이터·변환·산출물·토론)

**Files:** `src/features/workspace/{api.ts, workspace-layout.tsx(탭), overview-tab.tsx, inputs-tab.tsx, add-input-dialog.tsx, recipes-tab.tsx, recipe-editor.tsx(단계 목록 + 단계별 폼 + 미리보기 표), runs-list.tsx, outputs-tab.tsx, output-detail.tsx(계보 그래프: 입력 → 레시피@버전 → 산출물, SVG 단순 3열), upload-output-dialog.tsx, publish-dialog.tsx, discussion-tab.tsx}`, 라우트 `src/app/(platform)/commons/projects/[projectId]/{page.tsx(개요), data/page.tsx, recipes/page.tsx, recipes/[recipeId]/page.tsx, outputs/page.tsx, outputs/[outputId]/page.tsx, notes/page.tsx, members/page.tsx, discussion/page.tsx}` (기존 프로젝트 상세의 구성원 화면은 members 탭으로 이동), 접근 관리 화면에 "공개 요청" 탭(검토자), tests `workspace.test.tsx`
- 실행 상태는 react-query 폴링 2초(QUEUED/RUNNING일 때만).

- [ ] **Step 1:** 화면 테스트(입력 추가·권한 없음 안내·lapsed 표시, 레시피 단계 추가·검증 오류 표시·저장 충돌, 실행 → 성공 → 산출물 링크, 업로드 등급 하향 불가, 공개 요청·결정) 실패 → 구현 → 통과 → Commit `feat(web): project workspace with inputs, recipes, runs, outputs and discussion`.

### Task 15: 웹 — 연구노트(목록·편집기·제출·서명·검증·내보내기·검색)

**Files:** `src/features/notes/{api.ts, notes-screen.tsx(내 노트·확인할 노트 탭, 검색), note-editor.tsx(섹션별 블록, AI 회색 + 수락/수정/삭제, 근거 칩), note-status-bar.tsx, sign-dialog.tsx(서명 시 auth_time 만료 → 재로그인 `signIn("keycloak", { max_age: 0 })` 후 복귀, mock 모드에서는 확인 대화만), verify-panel.tsx, export-button.tsx, project-notes-tab.tsx}`, 라우트 `src/app/(platform)/commons/notes/page.tsx`, `notes/[noteId]/page.tsx`, 프로젝트 notes 탭, tests `notes.test.tsx`
- 편집 자동 저장(1초 디바운스, If-Match), 충돌 시 토스트 + 다시 불러오기.
- "지금 초안 만들기": 진행 상태 폴링, 실패 메시지, LLM 꺼짐이면 버튼 숨김(설정 조회 `getNoteSettings`의 `llm_enabled` 필드 — Task 1 스키마에 포함).

- [ ] **Step 1:** 화면 테스트(AI 블록 수락 전 제출 불가 메시지, 제출·반려·서명 흐름, SIGNED 읽기 전용·새 버전, 검증 결과 표시, 검색 결과) 실패 → 구현 → 통과 → Commit `feat(web): research notes with AI drafts, signing and verification`.

### Task 16: 통합 검증·e2e·배포

**Files:** `apps/web/e2e/workspace.spec.ts`(시나리오: 허브 → 데이터 카드 → 프로젝트에서 열기 → 레시피 저장·실행 → 산출물 → 노트 초안 → 수락 → 서명 → 검증, 각 화면 axe), `e2e/screens.spec.ts`(캡처 hub/workspace/notes), `apps/api/README` 운영 메모(마이그레이션·LLM 환경변수·GPU 공유 주의), `.superpowers/sdd/2026-10-02-data-hub/report.md`

- [ ] **Step 1:** 전체: `uv run pytest -q`(Docker testcontainers), `pnpm --filter @nais/web lint typecheck test`, 계약 check, e2e 두 프로젝트.
- [ ] **Step 2:** 실제 :8001 스모크: mock 서버(NAIS_LLM_BASE_URL 설정)로 초안 1회, 백엔드 `notes.draft_note`를 로컬 DB에서 1회.
- [ ] **Step 3:** feat/wave15 병합(ff), push(공인 IP 점검), 21051 web 재빌드(웹 컨테이너에 `NAIS_LLM_BASE_URL=http://192.168.0.2:8001` 추가 — compose의 web `environment` 또는 메인 `.env`), api/worker 이미지 재빌드 + `scripts/nais migrate`(운영 스택), 상태 확인, 롤백 태그.
- [ ] **Step 4:** 브랜치·worktree 정리, 보고서·메모리 갱신.
