# NAIS API · worker 운영 메모

모듈별 설명은 `apps/api/modules/<module>/README.md`, 전체 실행 방법은 저장소 루트 `README.md`에 있습니다.
여기에는 데이터 허브·프로젝트 작업 공간·연구노트(2026-10-02 계획)를 운영 스택에 반영할 때 필요한 것만 적습니다.

## 마이그레이션

- 새 스키마: `workspace`(입력·레시피·실행·산출물·허브 공개 요청·토론), `notes`(연구노트·블록·서명·체인·근거·임베딩·daily_runs).
- api/worker 이미지를 새로 빌드한 뒤, 트래픽을 받기 전에 한 번 실행합니다.

  ```sh
  scripts/nais migrate
  ```

  모든 모듈의 Alembic 마이그레이션을 순서대로 적용합니다(이미 적용된 것은 건너뜀). api와 worker는 같은 스키마를 보므로
  둘 다 새 이미지로 바꾼 다음 재시작합니다.

## 로컬 LLM·검색 환경변수

GPU(사설망 192.168.0.2, RTX 4090)는 **다른 플랫폼과 공유**합니다. 기본값은 꺼짐이며, 켜지 않으면 AI 초안 버튼이 숨고
(getNoteSettings.llm_enabled=false) 노트 검색은 키워드 검색만 합니다.

| 변수 | 기본값 | 뜻 |
| --- | --- | --- |
| `NAIS_LLM_ENABLED` | `false` | LLM·임베딩·리랭크 전체 스위치. `true`이고 각 base URL이 있을 때만 해당 클라이언트가 만들어집니다. |
| `NAIS_LLM_BASE_URL` | (없음) | OpenAI 호환 chat 엔드포인트, 예: `http://192.168.0.2:8001` (vLLM, EXAONE 3.5 7.8B AWQ, 16K 컨텍스트) |
| `NAIS_LLM_MODEL` | `llm` | vLLM에 등록된 모델 id |
| `NAIS_LLM_TIMEOUT_S` | `60` | chat 한 번의 제한 시간(초). 임베딩·리랭크 기본 제한 시간이기도 합니다. |
| `NAIS_EMBED_BASE_URL` | (없음) | 임베딩, 예: `http://192.168.0.2:8002` |
| `NAIS_EMBED_MODEL` | `bge-m3` | 임베딩 모델 id(바꾸면 노트 임베딩이 다시 계산됩니다: text_hash에 모델 id 포함) |
| `NAIS_RERANK_BASE_URL` | (없음) | 리랭크, 예: `http://192.168.0.2:8003` |
| `NAIS_RERANK_MODEL` | `bge-reranker` | 리랭크 모델 id |
| `NAIS_SEARCH_TIMEOUT_S` | `5` | searchNotes 요청 경로에서 질의 임베딩·리랭크를 각각 기다리는 최대 시간. 넘으면 키워드 검색으로 대체합니다. |

api와 worker 둘 다 같은 값을 받아야 합니다(api: 초안 요청 가능 여부·검색, worker: 초안 생성·임베딩).
web 컨테이너는 모의 모드가 아니면 LLM을 직접 부르지 않습니다.

## worker: `notes` 전용 큐

- `notes.draft_note`(AI 초안), `notes.embed_notes`(노트 임베딩)는 전용 큐 `notes`에서 **스레드 1개**로 돕니다
  (`apps/api/modules/notes/__init__.py`의 `dedicated_queues`).
- chat 호출 동시 1개 제한(`api.platform.llm._CHAT_SEMAPHORE`)은 **프로세스 단위**입니다. GPU를 공유하므로 worker
  프로세스는 **하나만** 띄웁니다(레플리카를 늘리면 동시 호출도 늘어납니다).
- 초안 작업 제한 시간은 10분(GPU 대기 + LLM 제한 시간 2회). 10분 + 1분이 지나도 QUEUED/RUNNING인 요청은 다음 요청이
  회수합니다.

## 매일 저녁 초안(19:00 KST)

- 스케줄러가 15분마다(그리고 worker 시작 시) 확인하고, **19:00 KST 이후 첫 틱**에 그날을 `notes.daily_runs`에 기록한 뒤
  그날 노트북을 저장한 연구자들의 오늘 노트 초안을 큐에 넣습니다. 그날 이후 틱은 아무것도 하지 않습니다.
- 19:00에 worker가 꺼져 있었으면 그날 저녁 다시 켜질 때 따라잡습니다. LLM이 꺼져 있으면 아무것도 하지 않고 그날을
  기록하지도 않습니다.

## 노트북 포트(초안의 유일한 근거)

- AI 초안은 그날 저장한 Jupyter 노트북(`NotebookActivityPort`, `apps/api/modules/notes/public.py`)만 근거로 씁니다.
  셀 앞부분과 출력 종류·개수만 전달되고 출력 값은 LLM에 가지 않습니다.
- Jupyter(M07)가 아직 없으므로 기본 구현은 비어 있습니다(`NoNotebooks`). 따라서 운영에서는 Jupyter가 포트를 제공하기
  전까지 `draftNote`가 `422 VALIDATION_FAILED`(reason `NO_NOTEBOOK_ACTIVITY`)로 답하고 19:00 일괄 초안도 대상이
  없습니다. 연구노트 작성·제출·서명·검증·검색은 그대로 동작합니다.

## 실제 GPU 스모크 테스트(선택)

CI는 GPU를 부르지 않습니다. 사설망에서 직접 확인할 때만:

```sh
NAIS_LIVE_LLM=1 NAIS_LLM_ENABLED=true NAIS_LLM_BASE_URL=http://192.168.0.2:8001 \
NAIS_EMBED_BASE_URL=http://192.168.0.2:8002 NAIS_RERANK_BASE_URL=http://192.168.0.2:8003 \
uv run pytest apps/api/modules/notes/tests/test_live_llm.py -m live_llm -s -q
```

테스트 DB(testcontainers)에서 `notes.draft_note`를 한 번(초안 chat 1~2회), 임베딩·리랭크를 한 번씩 호출합니다.

## 공인 IP

서버 공인 IP는 어떤 파일에도 쓰지 않습니다(`.env`의 `NAIS_EXTERNAL_HOST`). 커밋 전 `scripts/check_no_public_ip.sh`.
GPU 호스트 192.168.0.2는 사설 주소라 예시로 적어도 됩니다.
