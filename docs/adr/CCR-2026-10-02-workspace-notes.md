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

태그 `hub`, `workspace`, `notes` 추가. 새 operation 44개(전체 58 → 102). 모든 operation은 전역 `bearerAuth`를 상속하고
`401` 공통 오류 응답, 성공 응답마다 `components/examples` 예제 1개를 둔다.

| 영역 | operationId |
|---|---|
| 허브 | `getHubOverview`, `listDatasetProjects`, `listDatasetActivity` |
| 입력 | `listProjectInputs`, `addProjectInput`, `updateProjectInput`, `removeProjectInput` |
| 레시피·실행 | `listRecipes`, `createRecipe`, `getRecipe`, `updateRecipe`, `deleteRecipe`, `previewRecipe`, `startRun`, `listRuns`, `getRun` |
| 산출물·공개 | `listOutputs`, `createOutputUpload`, `completeOutputUpload`, `getOutput`, `getOutputDownload`, `requestOutputPublish`, `listPublishRequests`, `decidePublishRequest` |
| 토론 | `listThreads`, `createThread`, `updateThread`, `listComments`, `addComment` |
| 연구노트 | `listNotes`, `getOrCreateTodayNote`, `getNote`, `deleteNote`, `updateNoteBlocks`, `draftNote`, `submitNote`, `rejectNote`, `signNote`, `reviseNote`, `verifyNote`, `exportNotes`, `searchNotes`, `getNoteSettings`, `updateNoteSettings` |

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
- `NotificationType`: `OUTPUT_PUBLISH_REQUESTED`, `OUTPUT_PUBLISH_DECIDED`, `NOTE_SUBMITTED`, `NOTE_REJECTED`, `NOTE_SIGNED`, `DATASET_COMMENT_ADDED`,
  `RUN_FAILED`(Task 8 보완: 실행 실패를 실행한 사람에게 알림)

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
  이벤트 수 단언(42)과 `support/events.py` 페이로드 픽스처는 이 변경에서 이미 갱신했다. Task 8에는 `test_mapping.py`의
  `PENDING_AUDIT_RULES`를 비우는 일(새 이벤트마다 `AUDIT_RULES` 또는 `NOT_AUDITED`에 배정)만 남는다.
- web(Task 12–15): 생성 타입(`openapi.d.ts`, `contracts.ts`), `ko.json` 라벨 추가 완료. mock 계약 테스트의
  `PENDING_MOCK_OPERATIONS`(새 operation 44개)는 Task 12에서 비운다.

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
- 노트 열람: 기록자 항상, SUBMITTED/SIGNED는 노트의 확인자 스냅숏(`witness_user_ids`)에 든 사용자도. 같은 프로젝트의 다른 활성
  구성원은 `403 FORBIDDEN`, 비구성원과 남의 DRAFT는 `404`. 기록자 외 열람은 `notes.note.viewed.v1`.
- 기록자 전용 동작(`deleteNote`, `updateNoteBlocks`, `draftNote`, `submitNote`, `reviseNote`)도 같은 구분을 쓴다: 노트를 볼 수 없는
  사람은 `404`, 볼 수 있지만 기록자가 아닌 사람은 `403`.
- 삭제(`deleteNote`): 기록자·DRAFT만, `204`. SUBMITTED/SIGNED는 `409 NOTE_LOCKED`(서명된 노트는 삭제 API가 없다).
- 확인자 스냅숏: 제출(또는 DRAFT에서 바로 서명) 시 프로젝트 설정 `witness_required`·`witness_user_ids`를 노트에 복사한다(읽기 전용
  필드). 서명·반려·확인자 열람은 이 스냅숏만 본다. 설정을 나중에 바꿔도 이미 제출된 노트에는 영향이 없다.
- 서명: 기록자는 SUBMITTED에서 언제나 서명할 수 있고, DRAFT에서는 지금 확인자가 필요 없을 때만 서명한다(제출 검사 + 스냅숏 포함;
  확인자가 필요하면 `409 CONFLICT`). 확인자는 스냅숏이 확인자를 요구하는 SUBMITTED 노트에만 서명한다. RECORDER 서명과
  (스냅숏이 요구하면) WITNESS 서명이 모이면 SIGNED. 그래서 SUBMITTED 노트가 멈춰 있는 경우가 없다.
- `exportNotes`는 `application/zip`(binary) 스트림. 본인 노트는 모든 상태, ORG_ADMIN은 같은 기관 다른 기록자의 SUBMITTED/SIGNED
  노트만(남의 DRAFT 제외) 받으며, 그렇게 내보낸 남의 노트마다 `notes.note.viewed.v1`을 남긴다.
- `getOutputDownload`는 다운로드 세션과 같은 presigned URL 객체(TTL 300초).
- `workspace.comment.added.v1`: `scope=DATASET`이면 `project_id`는 `null`, 그 밖의 범위는 `project_id` 필수(스키마 if/then).
- 산출물 업로드는 단일 presigned PUT이므로 파일당 5 GiB 이하.
- 레시피 필터 값은 정수·실수·문자열·불리언·null·배열(`in`)을 받는다. 정수는 정수로 유지된다.

## 보완 (Task 7 리뷰, 계약 1.6.0 안의 설명·선택 필드 추가)
- 허브 공개 승인 슬롯(D-013): 계보 입력의 소유 기관마다 1개, 프로젝트 주관 기관(새 데이터셋 소유 기관)이 그중에 없으면 주관 기관
  슬롯 1개를 더한다. 입력이 없는 산출물은 주관 기관 슬롯만. 모든 슬롯은 해당 기관 DATA_STEWARD가 결정한다(ORG_ADMIN 아님).
- 요청자는 자기 요청을 결정할 수 없다(`403 FORBIDDEN`, 직무 분리).
- 승인 후 카탈로그 공개가 최종 실패하면(카탈로그 거부, 파일 검증 실패, 재시도 상한) 요청은 `REJECTED`가 되고 산출물도 `REJECTED`라서
  다시 요청할 수 있다. `PublishRequest.failure_reason`(nullable, 사람이 읽는 사유, 데이터 값 없음)과
  `workspace.publish.decided.v1` payload `failure_reason`(선택, nullable)을 추가했다. 이 시스템 반려 이벤트는 envelope actor가
  SYSTEM이고 `organization_id`는 주관 기관, `decision`은 `REJECT`다. 새 필드는 모두 선택이라 기존 소비자와 호환된다.
