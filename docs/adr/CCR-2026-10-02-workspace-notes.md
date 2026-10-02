# 계약 변경 요청: 데이터 허브 · 프로젝트 작업 공간 · 연구노트 (계약 1.6.0)

- 요청 모듈: M13 Workspace(신규, `workspace` 스키마), M14 Research Notes(신규, `notes` 스키마), M10 Web
- 승인: Agent 0 (Platform) — 2026-10-02
- 설계: `docs/superpowers/specs/2026-10-02-data-hub-workspace-notes-design.md` §4–8
- 계획: `docs/superpowers/plans/2026-10-02-data-hub-workspace-notes.md` Task 1
- 결정 기록: `NAIS_PRD/11_DECISION_LOG.md` D-043 ~ D-046

## 배경

연구자가 데이터를 찾고(허브), 프로젝트 안에서 버전을 고정한 입력으로 변환·분석하고(작업 공간), 그날 한 일을 근거와 함께
연구노트로 남기는 흐름이 필요하다. 현재 계약(1.3.0)은 데이터셋 조회·접근 요청·다운로드까지만 표현한다. 프로젝트에
데이터를 붙이는 입력, 레시피 변환과 실행, 산출물과 계보, 허브 공개 승인, 토론, 연구노트(서명·위변조 확인·내보내기)를
나타낼 경로·스키마·이벤트·오류 코드가 없다.

## 변경 목록

### openapi.yaml 1.3.0 → 1.6.0

버전 1.4.0(Wave 1.5 Stage 2 버전 관리 계획)과 1.5.0(M07 노트북 계획)은 다른 계획이 이미 예약해 이 변경은 1.6.0을 쓴다.

태그 `hub`, `workspace`, `notes` 추가. 새 operation 43개(전체 58 → 101). 모든 operation은 전역 `bearerAuth`를 상속하고
`401` 공통 오류 응답, 성공 응답마다 `components/examples` 예제 1개를 둔다.

| 영역 | operationId |
|---|---|
| 허브 | `getHubOverview`, `listDatasetProjects`, `listDatasetActivity` |
| 입력 | `listProjectInputs`, `addProjectInput`, `updateProjectInput`, `removeProjectInput` |
| 레시피·실행 | `listRecipes`, `createRecipe`, `getRecipe`, `updateRecipe`, `deleteRecipe`, `previewRecipe`, `startRun`, `listRuns`, `getRun` |
| 산출물·공개 | `listOutputs`, `createOutputUpload`, `completeOutputUpload`, `getOutput`, `getOutputDownload`, `requestOutputPublish`, `listPublishRequests`, `decidePublishRequest` |
| 토론 | `listThreads`, `createThread`, `updateThread`, `listComments`, `addComment` |
| 연구노트 | `listNotes`, `getOrCreateTodayNote`, `getNote`, `updateNoteBlocks`, `draftNote`, `submitNote`, `rejectNote`, `signNote`, `reviseNote`, `verifyNote`, `exportNotes`, `searchNotes`, `getNoteSettings`, `updateNoteSettings` |

목록 응답 규칙(기존 관례 유지):
- 프로젝트 설정 성격의 작은 목록은 `{ items }` 비페이지: 입력, 레시피, 데이터셋 사용 프로젝트(`hidden_count` 포함), 노트 검색(상위 20).
- 계속 쌓이는 목록은 `PageEnvelope` 커서 페이지 + `422`: 데이터셋 이력, 실행, 산출물, 공개 요청, 스레드, 댓글, 노트.

새 스키마:
- 허브: `HubOverview`, `HubCard`, `HubOrganizationStat`, `DatasetProjectsResult`, `DatasetProjectUse`, `DatasetActivity`, enum `DatasetActivityType`
- 작업 공간: `ProjectInput`(+`Create`/`Update`), `Recipe`, `RecipeWrite`, `RecipeStep`(판별자 `type`, 10종 `RecipeStep*`),
  `RecipePreviewRequest`, `RecipePreview`, `Run`, `Output`, `OutputFile`, `OutputLineage`, `OutputLineageInput`,
  `OutputUploadCreate`, `OutputUploadSession`, `OutputDownload`, `PublishRequest`, `PublishApproval`, `PublishRequestCreate`,
  `PublishDecisionCreate`, `Thread`, `ThreadCreate`, `ThreadUpdate`, `Comment`, `CommentCreate`
- 작업 공간 enum: `RunStatus`, `OutputKind`, `OutputPublishStatus`, `PublishRequestStatus`, `PublishDecision`, `ThreadScope`,
  `RecipeStepType`, `RecipeFilterOp`, `RecipeCastType`, `RecipeAggregateFn`, `RecipeJoinHow`
- 연구노트: `ResearchNote`, `ResearchNoteSummary`, `NoteBlock`, `NoteBlockWrite`, `NoteBlocksPut`, `NoteEvidence`, `NoteSignature`,
  `NoteVerification`, `NoteSearchHit`, `NoteSettings`(`llm_enabled`는 `readOnly`), `NoteSettingsUpdate`
- 연구노트 enum: `NoteStatus`, `NoteDraftStatus`, `NoteSection`, `NoteBlockOrigin`, `NoteSignerRole`, `NoteEvidenceType`
- 공통 파라미터: `InputId`, `RecipeId`, `RunId`, `OutputId`, `PublishRequestId`, `ThreadId`, `NoteId`, `IfMatch`(헤더, 필수)

기존 enum에 값 추가(감사·알림 매핑용, Task 8에서 사용):
- `ResourceType`: `PROJECT_INPUT`, `RECIPE`, `RUN`, `OUTPUT`, `PUBLISH_REQUEST`, `THREAD`, `RESEARCH_NOTE`
- `AuditAction`(이벤트당 1개): `PROJECT_INPUT_ADDED`, `PROJECT_INPUT_VERSION_CHANGED`, `PROJECT_INPUT_REMOVED`, `RECIPE_SAVED`,
  `RUN_SUCCEEDED`, `RUN_FAILED`, `OUTPUT_CREATED`, `OUTPUT_PUBLISH_REQUESTED`, `OUTPUT_PUBLISH_DECIDED`, `COMMENT_ADDED`,
  `NOTE_SUBMITTED`, `NOTE_SIGNED`, `NOTE_REJECTED`, `NOTE_VIEWED`
- `NotificationType`: `OUTPUT_PUBLISH_REQUESTED`, `OUTPUT_PUBLISH_DECIDED`, `NOTE_SUBMITTED`, `NOTE_REJECTED`, `NOTE_SIGNED`, `DATASET_COMMENT_ADDED`

### error_codes.json 1.1.1 → 1.2.0

| 코드 | HTTP | 모듈 |
|---|---|---|
| `ACCESS_REQUIRED` | 403 | workspace |
| `INPUT_ACCESS_LAPSED` | 409 | workspace |
| `RECIPE_INVALID` | 422 | workspace |
| `RUN_NOT_ALLOWED` | 409 | workspace |
| `OUTPUT_PUBLISH_PENDING` | 409 | workspace |
| `NOTE_LOCKED` | 409 | notes |
| `NOTE_HAS_UNACCEPTED_AI` | 409 | notes |
| `NOTE_SIGNATURE_EXPIRED` | 401 | notes |
| `NOTE_NOT_WITNESS` | 403 | notes |
| `LLM_UNAVAILABLE` | 503 | platform |

`RATE_LIMITED`(429)는 기존 코드를 그대로 쓴다(노트 초안 1분 1회 제한).

### events (index 1.2.0 → 1.3.0, `p0_events.schema.json`)

`producer` enum에 `workspace`, `notes` 추가. 새 이벤트 14개, 모든 payload에 `project_id`, `actor_id`, `occurred_at` +
엔티티 id·라벨(데이터 값 없음). `additionalProperties: false`.

- `workspace.input.added.v1`, `workspace.input.version_changed.v1`, `workspace.input.removed.v1`
- `workspace.recipe.saved.v1`, `workspace.run.succeeded.v1`, `workspace.run.failed.v1`, `workspace.output.created.v1`
- `workspace.publish.requested.v1`, `workspace.publish.decided.v1`
- `workspace.comment.added.v1` — 데이터셋 토론은 프로젝트가 없으므로 `project_id`만 `null` 허용
- `notes.note.submitted.v1`, `notes.note.signed.v1`, `notes.note.rejected.v1`, `notes.note.viewed.v1`

### module_ownership.json 1.1.1 → 1.2.0 · init.sql

- `M13` Project Workspace & Data Hub → `apps/api/modules/workspace`, 스키마 `workspace`
- `M14` Research Notes → `apps/api/modules/notes`, 스키마 `notes`
- `infra/docker/postgres/init.sql` 스키마 배열에 `workspace`, `notes` 추가(기존 역할 권한 패턴 그대로)

## 현재 계약으로 표현할 수 없는 이유

입력(버전 고정), 레시피·실행, 산출물 계보, 허브 공개 승인, 토론, 연구노트의 상태·서명·해시 체인은 기존 리소스에 대응하는
것이 없다. 감사·알림은 이벤트로만 만들어지므로(D-005, D-006) 새 이벤트와 enum 값이 있어야 audit 모듈이 기록할 수 있다.

## 영향받는 소비자

- 신규 백엔드 모듈 workspace(Task 3–7), notes(Task 9–11): 라우터 `operation_id`가 위 operationId와 같아야 한다.
- audit(Task 8): `mapping.py`/`notification_rules.py`에 새 이벤트 규칙. **`audit_0001_tables.py`의 CHECK 제약
  (`ck_audit_events_action`, `ck_audit_events_resource_type`, `ck_notifications_type`)이 값을 하드코딩하므로 새 마이그레이션으로 넓혀야 한다.**
  `test_mapping.py`/`test_audit_writer.py`의 이벤트 수(28) 단언과 `support/events.py` 페이로드 픽스처도 Task 8에서 갱신한다.
- web(Task 12–15): 생성 타입(`openapi.d.ts`, `contracts.ts`), `ko.json` 라벨 추가 완료. mock 계약 테스트의
  `PENDING_MOCK_OPERATIONS`(새 operation 43개)는 Task 12에서 비운다.

## 하위 호환성

예. 추가만 했다. 기존 경로·스키마·이벤트·오류 코드는 바뀌지 않았고 기존 enum에는 값만 덧붙였다(웹은 enum 라벨을 모두
`ko.json`에 두며 테스트로 검사한다). 운영 중인 DB는 `init.sql`이 다시 실행되지 않으므로, 배포 시 superuser로 아래를 한 번
실행해야 한다(Task 16).

```sql
-- init.sql의 DO 블록을 'workspace','notes'에 대해 실행한 것과 같다.
CREATE SCHEMA IF NOT EXISTS workspace AUTHORIZATION nais_migrator;
CREATE SCHEMA IF NOT EXISTS notes AUTHORIZATION nais_migrator;
GRANT USAGE ON SCHEMA workspace, notes TO nais_app;
ALTER DEFAULT PRIVILEGES FOR ROLE nais_migrator IN SCHEMA workspace GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO nais_app;
ALTER DEFAULT PRIVILEGES FOR ROLE nais_migrator IN SCHEMA workspace GRANT USAGE, SELECT ON SEQUENCES TO nais_app;
ALTER DEFAULT PRIVILEGES FOR ROLE nais_migrator IN SCHEMA notes GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO nais_app;
ALTER DEFAULT PRIVILEGES FOR ROLE nais_migrator IN SCHEMA notes GRANT USAGE, SELECT ON SEQUENCES TO nais_app;
```

## 계약에서 정한 세부 규칙 (구현 Task가 따른다)

- 낙관적 동시성: `updateRecipe`는 `If-Match: <Recipe.version>`, `updateNoteBlocks`는 `If-Match: <ResearchNote.revision>`.
  불일치는 `409 CONFLICT`(412 아님). 헤더 누락은 `422`.
- 블록 저장(`NoteBlocksPut`): 목록 순서대로 교체. 기존 `block_id`는 `origin`·`evidence`를 서버가 보존, 새 블록은 HUMAN·수락됨,
  빠진 블록은 삭제. 클라이언트는 근거를 쓸 수 없다.
- 노트 열람: 기록자 항상, SUBMITTED/SIGNED는 확인자도. 같은 프로젝트의 다른 활성 구성원은 `403 FORBIDDEN`, 비구성원과
  남의 DRAFT는 `404`. 기록자 외 열람은 `notes.note.viewed.v1`.
- 서명: 기록자 서명(RECORDER) + `witness_required`일 때 확인자 서명(WITNESS)이 모두 모이면 SIGNED. `witness_required=false`면
  DRAFT에서 바로 서명(제출 검사 포함).
- `exportNotes`는 `application/zip`(binary) 스트림, `getOutputDownload`는 다운로드 세션과 같은 presigned URL 객체(TTL 300초).
- 산출물 업로드는 단일 presigned PUT이므로 파일당 5 GiB 이하.
- 레시피 필터 값은 정수·실수·문자열·불리언·null·배열(`in`)을 받는다. 정수는 정수로 유지된다.
