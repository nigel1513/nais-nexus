# 노트북 (Kaggle Notebooks형) 설계 — M07 Compute / Workspace

- 날짜: 2026-10-01
- 대상: M07 Compute/Workspace(신규 백엔드 모듈 `notebooks`), 인프라(JupyterHub, 노트북 이미지, 패키지 미러), M10 Web(코드 탭·노트북 화면)
- 선행: Wave 1.5 Stage 1(데이터 카드 화면) 완료 후 화면 통합. 백엔드·인프라는 병렬 진행 가능.

## 1. 목적과 결정 사항 (사용자 대화 2026-10-01)
프로젝트와 데이터셋에 **Jupyter 노트북을 Kaggle처럼** 붙인다. 연구자가 데이터를 서버 밖으로 내보내지 않고 분석하고(Compute-to-Data), 분석 과정을 버전으로 남겨 공유·재현한다.

| # | 결정 |
|---|---|
| N1 | **서버 실행(JupyterHub)**, 사용자별 격리 컨테이너. 일반적인 연구 환경(TRE) 샌드박스 층을 적용 |
| N2 | 노트북은 **만든 사람 소유**. 공유 범위: 비공개(기본) / 프로젝트 공유 / 데이터셋에 공개. 다른 사람은 **Fork**해서 수정 |
| N3 | **Kaggle식 버전 저장**: 작업 중 자동 임시 저장, \"버전 저장\" = 처음부터 끝까지 재실행 후 결과 포함 저장. 버전마다 사용 데이터셋 버전·이미지·패키지 기록 |
| N4 | **Python 단일 이미지**(과학 계산 스택), **매월 최신 라이브러리로 재빌드**(날짜 태그), 노트북별 \"항상 최신 / 원래 환경 고정\" 선택 |
| N5 | 사용자가 **패키지 버전 지정·다운그레이드** 가능(`pip install x==y`, 노트북 패키지 목록) |
| N6 | 현재 서버는 GPU 없음(CPU 8코어, RAM 22GB, 로컬). **GPU·다중 노드는 실제 서비스에서 붙일 수 있게** 구조만 마련 |
| N7 | 과금 없음: 전부 오픈소스 자체 호스팅 |

### 범위 밖
- R/Julia 커널, 실시간 공동 편집, 결과 반출 심사(Airlock)는 Wave 2 이후(M04 필요), GPU 실제 운영(하드웨어 확보 후).

## 2. 구성
```
브라우저 ─ nginx :21051 ─┬─ /commons/...           (Next.js 포털: 목록·뷰어·코드 탭)
                         ├─ /api/v1/notebooks/...  (API: 메타데이터·버전·공유·권한)
                         └─ /notebooks/            (JupyterHub → 사용자 JupyterLab)
JupyterHub ─(docker-socket-proxy: 컨테이너 생성/시작/중지만 허용)─ Docker
   └─ 사용자 컨테이너 nais-nb-<user>   네트워크: nais-nb (internal)
         ├─ /home/jovyan/work        사용자 작업 공간(볼륨, 10 GiB)
         ├─ /data/input/<slug>/<ver> 연결 데이터(읽기 전용)
         └─ pip → pypi-mirror(devpi, 캐시 프록시)   외부 인터넷 기본 차단
실행기(Runner): \"버전 저장\" 시 같은 이미지로 일회성 컨테이너에서 nbclient 실행 → 결과 저장
```
- **JupyterHub**: 공식 이미지 + `DockerSpawner` + `GenericOAuthenticator`(Keycloak realm `nais`, OIDC). 이후 실제 서비스에서는 `KubeSpawner`로 교체(GPU 노드·다중 서버). Spawner 교체 외 다른 구성은 그대로 유지되도록 설정을 분리한다.
- **Hub ↔ NAIS API**: Hub의 `pre_spawn_hook`이 NAIS API(`POST /internal/notebooks/sessions`)를 호출해 세션 정책(자원 프로필, 연결 데이터, 인터넷 허용 여부, 이미지 태그, 패키지 목록)을 받는다. 정책은 API가 결정한다(권한 판단은 한 곳).

## 3. 샌드박스 (일반 연구 환경 구조)
| 층 | 적용 |
|---|---|
| 격리 | 사용자 컨테이너 비root(uid 1000), `cap_drop: ALL`, `no-new-privileges`, 기본 seccomp, 읽기 전용 루트 FS(+ /tmp, 작업 공간만 쓰기). **gVisor(runsc)는 서버에 설치 가능할 때 런타임으로 사용**(설치는 운영자 승인 필요, 없으면 runc) |
| 자원 | 기본 프로필 `cpu-small`: CPU 2, RAM 4 GiB, pids 512, 작업 공간 10 GiB. 동시 세션 상한 `NOTEBOOK_MAX_SESSIONS=4`(현재 서버 기준). 상한 초과 시 대기 안내 |
| 시간 | 유휴 60분 자동 종료(idle-culler), 세션 최대 12시간, 버전 저장 실행 최대 60분 |
| 네트워크 | 전용 `nais-nb` 네트워크(internal: true). **NAIS 내부 서비스(DB, Redis, Keycloak, SeaweedFS, API)로 경로 없음.** 허용: pypi-mirror. 외부 인터넷은 노트북 설정 \"인터넷 사용\"을 켠 경우에만 egress 프록시를 통해 허용하며, **CONTROLLED/SENSITIVE 데이터가 연결되면 켤 수 없음** |
| 데이터 | 연결 권한이 있는 데이터셋 버전만 읽기 전용 마운트. 권한: 소유 기관 구성원, PUBLIC 데이터셋, PLATFORM_ADMIN (M04 이후 ACTIVE 접근 권한 보유자 추가 — Data Explorer 미리보기와 같은 규칙) |
| 기록 | 세션 시작·종료, 데이터 연결, 버전 저장, 노트북 공유 범위 변경을 감사(M09) 이벤트로 기록 |
| 반출 | Wave 1.5: 작업 공간 파일 다운로드는 PUBLIC/INTERNAL만 연결된 노트북에서만 허용. CONTROLLED/SENSITIVE가 연결된 노트북은 Jupyter 파일 다운로드 비활성(Airlock은 Wave 2 이후) |
| 비밀정보 | 사용자 컨테이너에는 NAIS 토큰·DB 비밀번호 등 어떤 비밀도 넣지 않는다. 데이터는 아래 로더가 미리 채운다 |
| Hub 권한 | Hub는 docker.sock을 직접 갖지 않고 **docker-socket-proxy**(컨테이너 생성·시작·중지·삭제·조회만 허용)를 통한다 |

**데이터 로더**: 세션 시작 전 API가 연결 데이터셋 버전의 파일을 **내용 해시(sha256) 기반 공유 캐시**(`nb-data-cache` 볼륨, `/cache/<sha256>`)에 내려받고(M03 `open_stream`, 버전·권한 검증), 사용자 컨테이너에는 `/data/input/<slug>/<ver>/<path>` → 캐시 파일 하드링크 디렉터리를 읽기 전용으로 마운트한다. 같은 파일은 사용자 간 한 번만 저장된다(lakeFS형 버전과 같은 원리). 캐시 상한 `NOTEBOOK_DATA_CACHE_GIB=200`, LRU 정리.

## 4. 환경 관리
- **이미지**: `nais-notebook-python:<YYYY.MM>` (예: 2026.10). 기반 jupyter/docker-stacks `scipy-notebook` + pandas, numpy, scipy, scikit-learn, matplotlib, seaborn, plotly, pyarrow, polars, xarray, statsmodels, torch(CPU), nais 헬퍼 패키지(데이터 경로 조회). **GPU 변형** `nais-notebook-python-gpu:<YYYY.MM>`(CUDA)은 Dockerfile만 준비하고 빌드는 GPU 확보 시.
- **월간 재빌드**: `infra/notebook-images/` + 빌드 스크립트. 빌드 시 `pip freeze` 결과를 이미지 매니페스트로 저장(`notebooks.environment_images`: tag, created_at, packages jsonb, status ACTIVE/DEPRECATED). 12개월 보관 후 DEPRECATED(고정한 노트북은 계속 실행 가능, 경고 표시).
- **노트북 환경 설정**: `environment_mode` = `LATEST`(기본) | `PINNED`(버전 저장 시점 이미지 태그 고정). 화면 문구: \"항상 최신 환경 사용 / 원래 환경으로 고정\".
- **패키지 지정(다운그레이드 포함)**: 노트북 설정의 패키지 목록(`requirements` 텍스트, pip 형식, ≤ 50줄, 직접 URL·로컬 경로·`--index-url` 금지). 세션 시작 시 사용자 공간(`--user`)에 설치, 버전 저장 시 실제 `pip freeze` 차이를 기록. 노트북 안 `pip install`도 허용(그 세션 한정, 버전 저장 시 경고: \"패키지 목록에 추가해야 재현됩니다\").
- **패키지 미러**: `pypi-mirror`(devpi-server, PyPI 캐시 프록시)만 외부 PyPI에 접근. 노트북 컨테이너는 미러만 본다 → 인터넷이 막힌 노트북도 설치 가능.
- **자원 프로필**: `notebooks.resource_profiles`(code, cpu, mem_gib, gpu_count, image_variant, enabled). 지금은 `cpu-small`만 enabled. GPU 프로필은 비활성 행으로 정의만.

## 5. 데이터 모델 (`notebooks` 스키마)
| 테이블 | 주요 컬럼 |
|---|---|
| notebooks | notebook_id, owner_user_id, owner_org_id(당시 소속), title, project_id null, visibility(`PRIVATE`/`PROJECT`/`DATASET_PUBLIC`), environment_mode, pinned_image_tag, requirements, internet_enabled, forked_from_version_id, created_at, updated_at |
| notebook_attachments | notebook_id, dataset_id, dataset_version_id(고정 버전) 또는 `follow_latest` |
| notebook_drafts | notebook_id, ipynb 객체 키, saved_at (자동 임시 저장, 최신 1개) |
| notebook_versions | version_id, notebook_id, seq(1..), message, ipynb 객체 키(결과 포함), html 객체 키(정적 렌더), image_tag, packages_freeze, attachments_snapshot(데이터셋·버전·manifest_sha256), run_status(`QUEUED/RUNNING/SUCCEEDED/FAILED/TIMEOUT`), run_log 키, duration, created_by, created_at |
| notebook_sessions | session_id, user_id, notebook_id, container_name, profile, started_at, ended_at, end_reason |
| environment_images, resource_profiles | §4 |

- 객체 저장: SeaweedFS 버킷 `nais-notebooks` (`notebooks/{notebook_id}/versions/{seq}.ipynb|.html`).
- 가시성:
  - PRIVATE: 소유자, PLATFORM_ADMIN
  - PROJECT: 위 + 프로젝트 ACTIVE 구성원
  - DATASET_PUBLIC: 위 + **연결된 모든 데이터셋을 볼 수 있는 사용자**(하나라도 못 보면 그 사용자에게는 숨김, 존재 은닉)
- 결과(출력 셀)에는 데이터 원값이 들어갈 수 있다. 따라서 **CONTROLLED/SENSITIVE가 연결된 노트북의 버전 결과(출력)는 그 데이터셋의 다운로드 권한자에게만** 보이고, 그 외 열람자에게는 코드만 보인다(Data Explorer 원값 규칙과 동일).

## 6. 흐름
1. **새 노트북**: 데이터 카드 \"코드\" 탭 또는 프로젝트에서 \"새 노트북\" → 데이터 연결(현재 버전) → JupyterHub 세션 시작 → JupyterLab 열림(포털 안 전체 화면 iframe 또는 새 탭).
2. **자동 임시 저장**: Jupyter contents 저장 시 Hub 확장(server extension)이 NAIS API로 초안 업로드.
3. **버전 저장**: 메시지 입력 → Runner 큐(Dramatiq 전용 큐 `notebooks`, 동시성 1) → 일회성 컨테이너(같은 이미지·같은 패키지·같은 데이터 마운트, 인터넷 설정 동일)에서 nbclient 전체 실행 → 결과 ipynb + nbconvert HTML(**sanitize: 스크립트 제거, 렌더는 sandbox iframe**) 저장 → 이벤트 `notebooks.version.saved.v1`.
4. **열람**: 포털 뷰어가 HTML 버전을 `sandbox` iframe(스크립트 불가, 다른 출처)으로 표시. 상단: 소유자(당시 소속), 버전 선택, 사용 데이터(버전 링크), 환경(이미지 태그·패키지), 실행 시간, Fork 버튼.
5. **Fork**: 버전의 ipynb·연결·환경 설정 복사 → 내 PRIVATE 노트북. 데이터 권한이 없는 연결은 \"권한 없음\"으로 남고 실행 시 마운트되지 않음.
6. **최신 데이터 안내**: 연결 데이터셋에 더 새 PUBLISHED 버전이 있으면 \"v2.0 사용 중 · 최신 v2.1\" 배지와 \"최신으로 바꿔 실행\".

## 7. API (태그 `notebooks`)
- `POST/GET /notebooks`, `GET/PATCH/DELETE /notebooks/{id}` (제목, 공유 범위, 환경, 패키지, 인터넷, 연결)
- `GET /notebooks/{id}/versions`, `POST /notebooks/{id}/versions`(버전 저장 요청), `GET /notebook-versions/{vid}`(메타 + 결과 접근 가능 여부), `GET /notebook-versions/{vid}/render`(HTML, 별도 출처 헤더·CSP), `POST /notebook-versions/{vid}/fork`
- `GET /datasets/{id}/notebooks`(코드 탭), `GET /projects/{id}/notebooks`
- `POST /notebooks/{id}/session`(세션 시작 → JupyterHub URL), `DELETE /notebooks/{id}/session`
- 내부(Hub 전용, 공유 비밀 + 내부 네트워크): `POST /internal/notebooks/sessions`(정책), `PUT /internal/notebooks/{id}/draft`
- `GET /notebook-environments`(이미지 목록·패키지 매니페스트), `GET /notebook-profiles`

## 8. 화면 (M10)
- 데이터 카드 **\"코드\" 탭**: 이 데이터를 쓴 공개 노트북 카드(제목, 작성자·당시 소속, 최근 버전, 사용 데이터 버전, 실행 시간), \"새 노트북\" 버튼
- 프로젝트 **\"노트북\" 탭**: 프로젝트 공유 노트북 + 내 노트북
- **내 노트북** `/commons/notebooks`
- **노트북 뷰어** `/commons/notebooks/{id}`: Kaggle 노트북 페이지형(왼쪽 본문 렌더, 오른쪽 \"Input\" 데이터 목록·환경·버전 이력)
- **편집**: JupyterLab(JupyterHub) — 포털 상단 바(노트북 제목, \"버전 저장\", 세션 상태·남은 시간, 환경, 데이터 연결 패널)
- 환경 설정 대화상자: 최신/고정, 이미지 태그, 패키지 목록, 인터넷 사용(통제 데이터 연결 시 비활성 + 이유)
- mock 모드: 노트북 목록·뷰어·버전은 mock, 편집(JupyterLab)은 \"실서버 모드에서 사용 가능\" 안내

## 9. 단계
| 단계 | 범위 |
|---|---|
| 1 | 인프라: JupyterHub(DockerSpawner, Keycloak OIDC, docker-socket-proxy), 노트북 이미지 2026.10, nais-nb 네트워크·자원·유휴 종료, nginx `/notebooks/`. 백엔드: notebooks 스키마·CRUD·공유·세션 정책·감사 |
| 2 | 데이터 연결(로더·공유 캐시·읽기 전용 마운트), 버전 저장 Runner, HTML 렌더·뷰어, Fork, 코드 탭·프로젝트 탭 |
| 3 | 환경 관리: 월간 이미지 빌드 스크립트·매니페스트, 최신/고정, 패키지 목록, devpi 미러, 인터넷 토글·egress 프록시 |
| 4 | (GPU 확보 시) GPU 이미지·프로필 활성화, KubeSpawner 전환 가이드 |

## 10. 위험
- **docker 권한**: Hub의 컨테이너 생성 권한은 호스트 장악 경로가 될 수 있다 → docker-socket-proxy로 API 제한, Hub 컨테이너 비root, Spawner 설정에서 privileged·호스트 마운트 금지 고정, 테스트로 검증.
- **gVisor 설치**는 호스트 패키지 설치(sudo)라 운영자 승인 후 진행. 미설치 시 runc + 위 하드닝으로 운영하고 README에 명시.
- **자원 경합**: 서버 1대에서 테스트·서비스와 공유 → 동시 세션 4개 상한, 버전 저장 Runner 동시성 1.
- **결과물 원값 노출**: §5 출력 가시성 규칙으로 제한, HTML은 sanitize + sandbox iframe.
- **Wave 1.5 웹이 mock 모드**: 실제 편집은 real 모드(Keycloak 로그인)에서만 동작 → Wave 2의 실제 로그인과 함께 완전 동작. 그 전에는 JupyterHub에 직접 Keycloak 로그인(nais/nais dev)으로 확인.

## 11. 테스트
- 백엔드: 가시성(PRIVATE/PROJECT/DATASET_PUBLIC × 데이터 권한), 출력 가림 규칙, 세션 정책(인터넷 금지 조건, 자원 프로필, 동시 상한), 버전 저장 상태 전이·타임아웃, Fork 권한, 감사 이벤트
- 인프라: 스모크 — 사용자 컨테이너에서 DB/Redis/Keycloak/SeaweedFS 접속 실패, 외부 인터넷 실패(기본), pypi-mirror 설치 성공, 루트 FS 쓰기 실패, 자원 상한 적용, 유휴 종료
- 웹: 코드 탭, 뷰어(sandbox iframe), 환경 설정 검증, Fork 흐름, Playwright 스모크
