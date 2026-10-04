# NAIS Research Commons (NAIS AI-OS)

국가과학기술연구회(NST) 소관 출연연 연구자가 연구 데이터를 공유·검색·분석하는 연구 데이터 포털입니다.
데이터셋 카탈로그와 버전 관리, 프로젝트 작업 공간, 공유 JupyterLab, 연구노트를 한 곳에서 제공하며,
NAIS 국가과학AI연구센터의 패밀리 사이트로 운영됩니다.

- 제품 정의·계약: [`NAIS_PRD/README.md`](NAIS_PRD/README.md) (PRD v1.1, API 계약 `openapi.yaml` 1.9.0)
- 단일 진입점: gateway 포트 **21051** (`NAIS_GATEWAY_PORT`)
- 현재 단계: Wave 1.5 (데이터 포털 고도화) 진행 중. 접근 승인 백엔드(M04)는 아직 없습니다. [현재 상태](#현재-상태와-로드맵) 참고.

## 목차

1. [주요 기능](#주요-기능)
2. [아키텍처](#아키텍처)
3. [빠른 시작 (개발)](#빠른-시작-개발)
4. [설정](#설정)
5. [운영·배포](#운영배포)
6. [개발](#개발)
7. [보안](#보안)
8. [문서](#문서)
9. [현재 상태와 로드맵](#현재-상태와-로드맵)
10. [라이선스](#라이선스)

## 주요 기능

| 기능 | 내용 | 위치 |
|---|---|---|
| 데이터 카탈로그 | 데이터셋 등록·업로드(presigned PUT/멀티파트, sha256 검증)·게시, 연구 메타데이터(분야·소재·방법 어휘, 기간, 연구책임자), JSON-LD 내보내기 | `apps/api/modules/catalog` |
| Data Card · Data Explorer | AI-ready 점수와 근거, 열 설명표, 파일 트리와 최대 100행 미리보기·열 프로파일(격리된 하위 프로세스에서 생성) | catalog, `apps/web/src/features/catalog` |
| AI-ready 검증 | 게시된 버전에 대한 결정적 규칙 검사(`GENERIC_BASIC`, `TABULAR_ML_BASIC`). LLM·네트워크가 판정에 관여하지 않음 | `apps/api/modules/readiness` |
| lakeFS식 버전 관리 | 초안 분기(재업로드 없는 파일 공유), 변경 메모가 필요한 게시, 3-way rebase(MINE/THEIRS), 되돌리기, 파일·스키마·메타데이터 3단 비교, 파일 이력, 인용(text, BibTeX, DataCite JSON) | catalog `versioning/` (D-041) |
| 프로젝트 협업 | 프로젝트·구성원·역할(OWNER/ADMIN/RESEARCHER/VIEWER), 공개 범위 PRIVATE/PUBLIC | `apps/api/modules/project` |
| 데이터 허브·작업 공간 | 버전을 고정한 입력, 레시피 실행(워커), 산출물과 계보, 토론, 산출물의 허브 공개 승인(기관별 DATA_STEWARD) | `apps/api/modules/workspace` (D-043, D-047) |
| 공유 JupyterLab | 게이트웨이 `/notebooks/`, 연구자·프로젝트별 폴더와 JupyterLab 작업 공간, 저장할 때마다 폴더 단위 Git 커밋(nbdime diff) | `infra/notebook`, compose `notebook` (D-049) |
| 연구노트 | 프로젝트 × 기록자 × 날짜 단위, 제출·서명·확인자 서명, 해시 체인 검증, ZIP 내보내기, 그날 저장한 노트북 기반 로컬 LLM 초안 | `apps/api/modules/notes` (D-044, D-045) |
| 검색 | 데이터셋·공개 프로젝트: OpenSearch(nori) BM25 + bge-m3 k-NN 하이브리드. 연구노트: Postgres에 저장한 bge-m3 벡터 + 키워드, 리랭커 또는 RRF | `apps/api/platform/search_index.py`, catalog, project, notes |
| 감사·알림 | 모든 도메인 이벤트를 append-only 감사 로그로 기록(권한 회수 + 트리거), 인앱·이메일 알림 | `apps/api/modules/audit` |
| 기관·사용자 | Keycloak 인증(OIDC), 사용자·기관·소속·역할은 NAIS DB가 원본, 기관 이동 이력, NTIS 연구자번호 | `apps/api/modules/identity` |
| 접근 거버넌스 | 접근 요청·승인·기한부 권한(grant)·OPA 정책은 **계약과 웹 화면(mock)만 있고 백엔드 모듈은 미구현** | 계약 tag `governance`, [`NAIS_PRD/08_OPA_POLICY.md`](NAIS_PRD/08_OPA_POLICY.md) |

## 아키텍처

FastAPI modular monolith(api + Dramatiq worker)와 Next.js 웹을 nginx gateway 하나 뒤에 둡니다.
서비스 이름은 [`docker-compose.yml`](docker-compose.yml) 기준입니다.

```mermaid
flowchart LR
  B[브라우저] -->|:21051| GW[gateway<br/>nginx 1.27]
  GW -->|/| WEB[web<br/>Next.js 15]
  GW -->|/api/| API[api<br/>FastAPI]
  GW -->|/auth/| KC[keycloak 26]
  GW -->|/notebooks/| NB[notebook<br/>JupyterLab 4.6]
  GW -->|/nais-inst-a, /nais-inst-b, /nais-platform| S3[(storage-a / storage-b<br/>SeaweedFS S3)]
  WEB -->|NAIS_INTERNAL_API_URL| API
  API --> PG[(postgres 16<br/>모듈별 schema)]
  API --> RD[(redis 7)]
  API --> S3
  API --> OS[(OpenSearch<br/>OPENSEARCH_URL)]
  API --> OPA[opa 1.4]
  API -->|contents API| NB
  WK[worker<br/>Dramatiq] --> PG
  WK --> RD
  WK --> S3
  WK --> OS
  WK --> LLM[로컬 LLM · 임베딩 · 리랭커<br/>NAIS_*_BASE_URL]
  WK --> MP[mailpit<br/>SMTP]
  API --> LLM
```

- `notebook`은 내부 전용 네트워크 `notebooks`에만 붙습니다. 커널에서 postgres·redis·스토리지·keycloak·LAN·인터넷으로 나갈 수 없습니다(`pip install` 불가).
- OpenSearch는 기본 compose에 포함되지 않습니다(2026-10-03부터 외부 OpenSearch 사용). 로컬 컨테이너는 profile `legacy-opensearch`로만 뜹니다. [OpenSearch](#opensearch) 참고.
- OPA 컨테이너는 떠 있고 `/health/ready`가 확인하지만 `infra/opa/policies`에는 아직 정책이 없습니다(M04 미구현).

### API 모듈

각 모듈은 `apps/api/modules/<name>/__init__.py`의 `MODULE = ModuleSpec(...)`로 등록되고(D-036), 자기 PostgreSQL schema와 Alembic 마이그레이션만 소유합니다(D-021). 다른 모듈의 테이블은 읽지 않고 `public.py`의 Port로만 호출합니다(D-038).

| 모듈 | 경로 | schema | 역할 |
|---|---|---|---|
| M00 Platform | `apps/api/platform` | `platform` | 앱 구성, 인증(JWT/JWKS), outbox·relay·event bus, 스토리지, 검색 인덱스, LLM 클라이언트, CLI |
| M01 Identity | [`identity`](apps/api/modules/identity/README.md) | `identity` | 사용자 JIT 생성, 기관·소속·역할, 기관 이동 |
| M02 Project | [`project`](apps/api/modules/project/README.md) | `project` | 프로젝트·구성원, 공개 프로젝트 검색 |
| M03 Catalog | [`catalog`](apps/api/modules/catalog/README.md) | `catalog` | 데이터셋·버전·파일·업로드, 미리보기, 검색 인덱스, 버전 관리 |
| M05 Readiness | [`readiness`](apps/api/modules/readiness/README.md) | `readiness` | AI-ready 결정적 검증 |
| M09 Audit | [`audit`](apps/api/modules/audit/README.md) | `audit` | 감사 로그, 알림, 이메일 발송 |
| M13 Workspace | [`workspace`](apps/api/modules/workspace/README.md) | `workspace` | 입력·레시피·실행·산출물·토론·허브 공개 |
| M14 Notes | `apps/api/modules/notes` | `notes` | 연구노트, 서명·체인, 초안, 노트 검색 (모듈 README 없음, [`apps/api/README.md`](apps/api/README.md) 참고) |

M04 Governance(`governance`)는 계약과 소유 경로만 정해져 있고 코드는 없습니다. 모듈 목록과 소유 경로는 [`NAIS_PRD/contracts/module_ownership.json`](NAIS_PRD/contracts/module_ownership.json)에 있습니다.

### 웹

`apps/web`: Next.js 15 App Router, TypeScript, Tailwind v4, TanStack Query, next-intl(기본 ko), Auth.js v5(`basePath=/web-auth`, D-026). 공용 컴포넌트는 `packages/ui`(`@nais/ui`).

- `src/app/(public)`: 첫 화면. `src/app/(platform)/commons/*`: 데이터, 허브, 프로젝트(작업 공간·노트북·연구노트 탭), 접근 요청, 활동. `settings/*`: 개인·기관 설정.
- `src/features/<도메인>`: 화면 단위 기능. `src/mocks`: mock 모드용 MSW 핸들러(서버에서 `/mock-api/v1/*`로 제공).
- 자세한 실행·환경·e2e: [`apps/web/README.md`](apps/web/README.md)

### 계약과 이벤트

- 계약이 우선합니다(contract-first). 원본은 [`NAIS_PRD/contracts/`](NAIS_PRD/contracts): `openapi.yaml`(OpenAPI 3.1, 1.9.0, 114개 operation), `events/p0_events.schema.json`·`events/index.json`(이벤트 42종), `error_codes.json`.
- 생성물: `packages/contracts/python/nais_contracts`(pydantic 모델·enum), `packages/contracts/ts/openapi.d.ts`, 웹의 `apps/web/src/generated`. 계약 변경 후 `scripts/nais contracts`와 `corepack pnpm --filter @nais/web contracts:sync`로 다시 생성합니다.
- 계약 변경은 change request로 기록합니다: [`docs/adr/CONTRACT_CHANGE_REQUEST.template.md`](docs/adr/CONTRACT_CHANGE_REQUEST.template.md).
- 이벤트는 transactional outbox로 발행합니다. 변경과 같은 세션에서 `api.platform.outbox.outbox.write(...)`, worker의 relay가 전달하고, 소비자는 `@api.platform.event_bus.subscribe(...)` + `claim_event(...)`로 at-least-once를 멱등 처리합니다(D-006).

## 빠른 시작 (개발)

### 준비물

| 도구 | 버전 | 출처 |
|---|---|---|
| Docker + Compose v2 | Compose `!override`/`!reset` 지원 버전 | `docker-compose.prod.yml` |
| Python | 3.13 | `.python-version`, `pyproject.toml` |
| uv | 0.11 이상 (CI 0.11.19) | `.github/workflows/ci.yml` |
| Node.js | 22 | `apps/web/Dockerfile`, CI |
| pnpm | 9.15.0 (corepack) | `package.json` `packageManager` |

Node·pnpm은 웹을 컨테이너 밖에서 개발하거나 계약 생성물을 갱신할 때만 필요합니다.

### 실행

```bash
git clone https://github.com/nigel1513/nais-nexus.git
cd nais-nexus
cp .env.example .env        # scripts/nais up 이 없으면 만들어 줍니다
```

`.env`에서 최소한 다음을 정합니다(값은 커밋하지 않습니다).

- `NAIS_JUPYTER_TOKEN`, `NAIS_INTERNAL_TOKEN`: 예) `openssl rand -hex 32`. `NAIS_JUPYTER_TOKEN`이 비어 있으면 `notebook` 컨테이너는 시작을 거부합니다.
- `AUTH_SECRET`: 32바이트 이상 임의 값(`.env.example`의 `change-me-32-bytes`는 자리표시자).
- `OPENSEARCH_URL`: 아래 [OpenSearch](#opensearch) 참고.

```bash
scripts/nais up             # docker compose up -d --build
scripts/nais migrate        # platform + 모든 모듈 마이그레이션
scripts/nais storage-init   # 기관별 버킷 생성
scripts/nais seed           # 개발 seed (NAIS_PRD/10_SEED_DATA.md)
scripts/nais credentials    # 포트·계정 표
scripts/nais gate-a         # 부팅 + health + 스토리지 smoke
```

`make up`, `make migrate` 등도 같지만 `Makefile`은 `scripts/nais`에 위임만 합니다(D-033).

### 포트

| 포트 | 서비스 | 비고 |
|---:|---|---|
| 21051 | gateway | 포털 `/`, API `/api/v1` (문서 `/api/v1/docs`), Keycloak `/auth/`, JupyterLab `/notebooks/` |
| 21052 | mailpit UI | 개발용 메일함 |
| 21053 | storage-a S3 | 디버깅용 |
| 21054 | storage-b S3 | 디버깅용 |
| 21055 | postgres | DB `nais` |
| 21056 | gateway → OpenSearch | Basic 인증 |
| 21057 | gateway → OPA | Basic 인증 |
| 21058 | redis | |
| 21059 | 예약 | 미사용 |

개발 서버에서는 21051~21058이 모두 외부에 열려 있습니다(D-037, 공유기 포트포워딩 필요). 외부 주소는 로컬 `.env`의 `NAIS_EXTERNAL_HOST`에만 둡니다. `docker-compose.prod.yml`은 21051만 남깁니다.

### 개발 기본 계정 (개발 전용)

D-037에 따라 개발 스택의 모든 계정은 `nais` / `nais`입니다(Postgres, `nais_app`·`nais_migrator`, Keycloak 관리자, S3 키, Mailpit, Redis, OpenSearch·OPA의 gateway Basic 인증). seed 사용자(`admin@nais.local`, `a.researcher@inst-a.local` 등, 목록은 [identity README](apps/api/modules/identity/README.md))의 비밀번호도 `nais`입니다. **이 값들은 개발용이며 외부에 공개되는 운영 환경에서 그대로 쓰면 안 됩니다.**

### mock 모드와 real 모드

웹은 빌드 시점에 모드가 정해집니다. compose는 `.env`의 `WEB_API_MOCKING`(기본 `enabled`)을 `NEXT_PUBLIC_API_MOCKING` 빌드 인자와 런타임 값으로 함께 넘깁니다.

| 모드 | `WEB_API_MOCKING` | 동작 |
|---|---|---|
| mock (기본, 현재 21051 시연 환경) | `enabled` | 웹 서버 안의 MSW mock API(seed를 반영한 메모리 상태, 재시작 시 초기화), `/mock-login`에서 seed 사용자 선택. `NAIS_INTERNAL_TOKEN`이 있으면 연구노트 초안과 데이터셋·공개 프로젝트 텍스트 검색은 내부 API(`/api/v1/internal/*`)를 통해 실제 Jupyter·LLM·OpenSearch를 사용 |
| real | `disabled` | Keycloak 로그인(Authorization Code + PKCE, 클라이언트 `nais-web`)과 실제 API. 한 origin(`NAIS_PUBLIC_BASE_URL`)에서만 동작. 접근 요청·승인 등 M04 기능은 백엔드가 없어 동작하지 않음 |

모드를 바꾼 뒤에는 웹 이미지를 다시 빌드합니다.

```bash
docker compose build web && docker compose up -d --no-build web
```

real 모드 규칙(단일 origin, `AUTH_URL`·`AUTH_KEYCLOAK_ISSUER`·`OIDC_ISSUER`의 일치)은 [`apps/web/README.md`](apps/web/README.md)의 "Real mode"에 있습니다. API를 직접 호출할 토큰은 [identity README](apps/api/modules/identity/README.md)의 `nais-e2e` 예시를 씁니다(개발 realm 전용).

### OpenSearch

`.env.example`의 `OPENSEARCH_URL=http://opensearch:9200`은 기본으로 뜨지 않는 legacy 서비스를 가리킵니다. 둘 중 하나를 고릅니다.

1. 이미 있는 OpenSearch 2.x(k-NN 플러그인, `analysis-nori` 권장)를 `OPENSEARCH_URL`에 지정합니다(인증이 필요하면 URL에 계정 포함). 21056 프록시의 upstream은 `infra/nginx/nais.conf`, 서비스 계정 헤더는 git에서 제외된 `infra/nginx/opensearch-auth.conf`에 둡니다.
2. 로컬 컨테이너: `.env`에 `COMPOSE_PROFILES=legacy-opensearch`와 `OPENSEARCH_ADMIN_PASSWORD`를 넣고, 보안 플러그인이 켜져 있으므로 `OPENSEARCH_URL`에 admin 계정을 포함합니다(`http://admin:<password>@opensearch:9200`).

OpenSearch에 닿지 않으면 `/api/v1/health/ready`가 503(`degraded`)을 돌려주고 `scripts/nais gate-a`도 실패합니다. nori가 없으면 카탈로그는 `standard` + `cjk_bigram` 분석기로 인덱스를 만듭니다.

## 설정

모든 값은 `.env`(`.env.example`에서 복사)로 넣고 api·worker·web이 같은 파일을 읽습니다. 아래 기본값은 `.env.example` 기준이며, 비밀 값은 적지 않았습니다.

**기본·DB·메시징**

| 변수 | 용도 | 기본값 |
|---|---|---|
| `NAIS_PUBLIC_BASE_URL` | 브라우저가 보는 기준 URL. presigned URL 서명 기준, Keycloak hostname | `http://localhost:21051` |
| `NAIS_GATEWAY_PORT` | gateway 공개 포트 | `21051` |
| `NAIS_EXTERNAL_HOST` | 개발 서버의 외부 주소(로컬 `.env`에만) | `localhost` |
| `DATABASE_URL` | 런타임 DB 접속(`nais_app`) | `postgres:5432/nais` |
| `MIGRATION_DATABASE_URL` | 마이그레이션 DB 접속(`nais_migrator`, schema owner, D-027) | `postgres:5432/nais` |
| `REDIS_URL` | Dramatiq broker | `redis:6379/0` |
| `LOG_LEVEL` | 로그 수준 | `INFO` |

**인증**

| 변수 | 용도 | 기본값 |
|---|---|---|
| `OIDC_ISSUER`, `OIDC_INTERNAL_JWKS_URL`, `OIDC_AUDIENCE` | API의 JWT 검증(발급자, 내부 JWKS, audience) | `.../auth/realms/nais`, `nais-api` |
| `KEYCLOAK_ADMIN_URL`, `KEYCLOAK_ADMIN_USER`, `KEYCLOAK_ADMIN_PASSWORD` | 기관 이동 시 Keycloak `org_code` 갱신(admin REST) | `http://keycloak:8080/auth` |
| `AUTH_URL`, `AUTH_SECRET`, `AUTH_TRUST_HOST` | Auth.js (`AUTH_URL`은 `/web-auth`로 끝남) | `http://localhost:21051/web-auth` |
| `AUTH_KEYCLOAK_ISSUER`, `AUTH_KEYCLOAK_INTERNAL_URL`, `AUTH_KEYCLOAK_ID` | 웹의 Keycloak 클라이언트 | `nais-web` |
| `AUTH_ALLOWED_HOSTS` | 추가 허용 host(콤마 구분) | `localhost:21051` |
| `NAIS_INTERNAL_TOKEN` | 웹 서버 → `/api/v1/internal/*` 헤더 `X-NAIS-Internal-Token`. 비어 있으면 내부 API는 404 | (비어 있음) |

**스토리지** (기관 코드 → `STORAGE_<CODE>_*`, D-024)

| 변수 | 용도 | 기본값 |
|---|---|---|
| `STORAGE_ORG_CODES` | 버킷을 가진 기관 코드 | `nais,inst-a,inst-b` |
| `STORAGE_<CODE>_ENDPOINT`, `_BUCKET`, `_ACCESS_KEY`, `_SECRET_KEY` | 기관별 S3 | 예) `STORAGE_INST_A_BUCKET=nais-inst-a` |
| `STORAGE_PRESIGN_TTL_SECONDS` | 다운로드 presigned URL TTL | `300` |
| `STORAGE_MULTIPART_THRESHOLD_BYTES` | 멀티파트 업로드 기준 | `67108864` (64 MiB) |
| `UPLOAD_URL_TTL_SECONDS`, `UPLOAD_SESSION_TTL_SECONDS` | 업로드 URL·세션 수명 | `3600` |

**검색·정책**

| 변수 | 용도 | 기본값 |
|---|---|---|
| `OPENSEARCH_URL` | OpenSearch | `http://opensearch:9200` (위 설명 참고) |
| `CATALOG_INDEX_ALIAS` | 데이터셋 인덱스 alias | `nais-datasets` |
| `OPA_URL`, `OPA_TIMEOUT_MS` | OPA (실패 시 deny, D-022) | `http://opa:8181`, `500` |

**LLM·임베딩** (사설망 GPU 공유, 기본 꺼짐. 값은 `.env.example` 예시 참고)

| 변수 | 용도 | 기본값 |
|---|---|---|
| `NAIS_LLM_ENABLED` | LLM·임베딩·리랭커 전체 스위치 | `false` |
| `NAIS_LLM_BASE_URL`, `NAIS_LLM_MODEL`, `NAIS_LLM_TIMEOUT_S` | OpenAI 호환 chat(vLLM) | 모델 `llm`, `60` |
| `NAIS_EMBED_BASE_URL`, `NAIS_EMBED_MODEL` | 임베딩 | `bge-m3` |
| `NAIS_RERANK_BASE_URL`, `NAIS_RERANK_MODEL` | 리랭커 | `bge-reranker` |
| `NAIS_SEARCH_TIMEOUT_S` | 노트 검색 요청 경로의 임베딩·리랭크 제한 | `5` |

**노트북·작업 공간·워커**

| 변수 | 용도 | 기본값 |
|---|---|---|
| `NAIS_JUPYTER_URL`, `NAIS_JUPYTER_TOKEN` | 공유 JupyterLab contents API(api)와 "노트북 열기"(web). URL이 없으면 노트북 출처 없음 | `http://notebook:8888/notebooks`, 토큰 비어 있음 |
| `WORKSPACE_MAX_ROWS`, `WORKSPACE_MAX_INPUT_BYTES`, `WORKSPACE_RUN_TIMEOUT_SECONDS`, `WORKSPACE_WORKER_CONCURRENCY` | 레시피 실행 한도 | `5000000`, 1 GiB, `1800`, `1` |
| `READINESS_RUN_TIMEOUT_SECONDS`, `READINESS_FILE_TIMEOUT_SECONDS`, `READINESS_WORKER_CONCURRENCY` | AI-ready 검증 한도 | `1800`, `600`, `2` |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_FROM`, `NOTIFICATION_EMAIL_ENABLED`, `NOTIFICATION_RETENTION_DAYS` | 알림 메일 | `mailpit`, `1025`, `true`, `180` |

**웹 공개 변수** (`NEXT_PUBLIC_*`은 빌드 시 인라인되므로 바꾸면 다시 빌드)

| 변수 | 용도 | 기본값 |
|---|---|---|
| `WEB_API_MOCKING` | compose가 `NEXT_PUBLIC_API_MOCKING`으로 전달하는 웹 모드 | `enabled` |
| `NEXT_PUBLIC_API_BASE` | 브라우저가 보는 API base | `/api/v1` |
| `NEXT_PUBLIC_PARENT_SITE_URL` | 국가과학AI연구센터(상위 사이트) 링크. `apps/web/Dockerfile`의 빌드 인자이며 compose는 아직 넘기지 않음 | `src/shared/family-sites.ts`의 기본값 |

## 운영·배포

운영 반영 절차의 정본은 [`apps/api/README.md`](apps/api/README.md)("운영 반영 순서")입니다. 요약하면 다음과 같습니다.

1. **백업**: `docker compose exec -T postgres pg_dump -U nais -Fc nais > nais-$(date +%Y%m%d-%H%M).dump`
2. **되돌리기용 태그**: `docker tag nais/api:dev nais/api:pre-<변경명>` (web도 같게)
3. **빌드**: `docker compose build api worker web`
4. **마이그레이션 (재시작 전)**: `scripts/nais migrate`. 마이그레이션은 추가만 하도록 작성하며 downgrade는 쓰지 않습니다.
5. **재시작 (`down` 없이)**: `docker compose up -d --no-build api worker web`
6. **되돌리기**: 태그를 `:dev`로 되돌린 뒤 5번을 다시 실행

마이그레이션 사전 확인:

- SQL만 출력(CI와 같음): `docker compose run --rm --no-deps api python -m api.platform.cli migrate --sql > /dev/null`
- 실제 데이터로 확인하려면 백업을 별도 DB에 복원하고 그 DB에 먼저 적용합니다.

  ```bash
  docker compose exec -T postgres createdb -U nais nais_dryrun
  docker compose exec -T postgres pg_restore -U nais -d nais_dryrun < nais-<날짜>.dump
  docker compose run --rm --no-deps \
    -e MIGRATION_DATABASE_URL=postgresql+psycopg://nais_migrator:nais@postgres:5432/nais_dryrun \
    api python -m api.platform.cli migrate
  docker compose exec -T postgres dropdb -U nais nais_dryrun
  ```

기타 운영 작업:

| 작업 | 명령·위치 |
|---|---|
| 데이터셋 인덱스 전체 재구축(새 `nais-datasets-vN` + alias 교체) | `docker compose run --rm --no-deps api python -m api.modules.catalog.reindex` |
| 공개 프로젝트 인덱스(`nais-projects`) | worker가 5초마다 DB와 맞춤, 별도 명령 없음 |
| health | gateway `GET /healthz`, api `GET /api/v1/health/live`, `GET /api/v1/health/ready`(postgres·redis·opensearch·opa) |
| 로그 | `scripts/nais logs api worker` (`docker compose logs -f`). JupyterLab 경로와 `/notebooks-open`은 토큰 때문에 access log를 남기지 않음 |
| 워커 | 레플리카 1개만(`--scale worker=N` 금지). 전용 큐 `catalog_previews`(1), `readiness`, `workspace`(레시피 실행), `notes`(1, GPU 공유). 허브 공개 작업 `workspace_publish`는 일반 풀 |
| gateway 설정 변경 | `infra/nginx/nais.conf` 수정 후 `docker compose exec gateway nginx -s reload` |

백업 대상:

| 대상 | 위치 | 비고 |
|---|---|---|
| PostgreSQL | volume `pgdata` | `pg_dump -Fc` 권장. 모든 모듈 schema, 감사 로그, 연구노트 |
| 객체 스토리지 | volumes `storage-a`, `storage-b` | 데이터셋 파일, 산출물 |
| 노트북 작업 폴더 | volume `notebookwork` | 연구자·프로젝트별 `.ipynb`와 폴더별 Git 이력 |
| 설정 | `.env`, `infra/nginx/htpasswd`, `infra/nginx/opensearch-auth.conf` | 비밀 값 포함, 저장소 밖에 보관 |

OpenSearch 인덱스는 DB에서 다시 만들 수 있습니다(`reindex`). Keycloak은 `start-dev` 내장 DB를 쓰고 volume이 없어, 컨테이너를 다시 만들면 `infra/keycloak/import/realm-nais.json` 상태로 돌아갑니다.

`docker-compose.prod.yml`(`docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d`)은 개발 도구 포트를 닫고 웹을 real 모드로 빌드하며 Keycloak을 `start`로 실행합니다. 다만 realm import가 아직 개발 realm(seed 사용자, password grant 클라이언트 `nais-e2e`)이므로, 운영에 쓰기 전에 운영용 realm으로 바꾸고 모든 기본 계정을 교체해야 합니다.

## 개발

```bash
uv sync
scripts/nais test              # pytest: apps/api, tests/contract, tests/infra (Postgres는 testcontainers, Docker 필요)
scripts/nais lint              # ruff check + ruff format --check
scripts/nais typecheck         # mypy (strict)
scripts/nais contracts         # NAIS_PRD/contracts → packages/contracts 생성물 갱신
scripts/nais contracts-check   # 생성물이 최신인지 확인 (CI)
scripts/nais contract-test     # tests/contract 만
```

웹(`apps/web`, 저장소 루트에서 `corepack pnpm install` 후):

```bash
corepack pnpm --filter @nais/web dev              # :3000, mock 모드
corepack pnpm --filter @nais/web test             # Vitest (mock API가 openapi.yaml과 맞는지도 검사)
corepack pnpm --filter @nais/web lint
corepack pnpm --filter @nais/web typecheck
corepack pnpm --filter @nais/web contracts:check  # src/generated 와 계약 비교
corepack pnpm --filter @nais/web e2e              # Playwright
```

Playwright는 프로젝트 두 개로 돕니다: `chromium`(localhost)과 `chromium-insecure-origin`(`http://nais.test:<port>`, secure context가 아닌 HTTP origin에서 화면이 깨지지 않는지 확인). 실행 중인 포털을 대상으로 하려면 `PLAYWRIGHT_BASE_URL`을 씁니다. 자세한 내용은 [`apps/web/README.md`](apps/web/README.md)의 "E2E".

선택 테스트:

- 실제 GPU LLM 스모크: `NAIS_LIVE_LLM=1 ... uv run pytest apps/api/modules/notes/tests/test_live_llm.py -m live_llm` ([`apps/api/README.md`](apps/api/README.md))
- 실행 중인 스택 대상 identity 테스트: `NAIS_LIVE=1 uv run pytest apps/api/modules/identity/tests/test_live_stack.py`

CI([`.github/workflows/ci.yml`](.github/workflows/ci.yml)): python(lint, mypy, pytest, `migrate --sql`), contracts(`generate.py --check`), web(contracts·lint·typecheck·Vitest, `packages/ui`, real 모드 빌드), gate-a.

### 커밋 전 확인

- 서버 공인 IP는 어떤 파일에도 쓰지 않습니다. `.env`의 `NAIS_EXTERNAL_HOST`나 `<NAIS_EXTERNAL_HOST>` 같은 자리표시자를 씁니다. 커밋 전에 `scripts/check_no_public_ip.sh`를 실행합니다(추적 중인 파일에서 로컬 `.env`의 값을 찾음).
- 비밀 값(`.env`, `infra/nginx/opensearch-auth.conf`)은 커밋하지 않습니다.

### 브랜치

- 통합 브랜치는 `feat/wave15`입니다. 작업은 여기서 갈라진 브랜치에서 하고, 리뷰를 통과하면 `feat/wave15`에 병합한 뒤 브랜치를 지웁니다.
- `main`에는 저장소 소유자가 요청할 때만 병합합니다.
- 커밋 메시지는 `feat(<영역>): ...`, `fix(...)`, `docs(...)`, `test(...)`, `chore(...)` 형식을 씁니다.

### 모듈 추가

1. `apps/api/modules/<name>/__init__.py`에 `MODULE = ModuleSpec(...)`을 정의합니다(`api.platform.modules`).
   - `router`: `/api/v1` 아래에 마운트
   - `migrations_dir` + `db_schema`: `scripts/nais migrate`가 적용. 새 revision은 `scripts/nais new-migration <name> -m "..."`
   - `wire()`: `api.platform.ports.provide(...)`로 Port 제공
   - `register_worker(broker, scheduler)`: 주기 작업, `dedicated_queues`: 전용 큐
   - `seed(session)`: `10_SEED_DATA.md`의 행을 코드 안 데이터로 삽입(런타임에 `NAIS_PRD/*.md`를 읽지 않음, 이미지에 없음)
2. 다른 모듈이 쓸 Port Protocol과 DTO는 `public.py`에 둡니다(D-038). 소비자는 `from api.modules.<provider>.public import XPort` 후 `ports.get(XPort)`를 쓰고 Protocol을 복사하지 않습니다.
3. 새 schema는 `infra/docker/postgres/init.sql`에 추가하고, 기존 DB에는 배포 때 한 번 만듭니다([`apps/api/README.md`](apps/api/README.md) 2단계).
4. 계약(`openapi.yaml`, 이벤트)을 먼저 바꾸고 change request를 남긴 뒤 생성물을 갱신합니다. 소유 경로는 `module_ownership.json`에 추가합니다.

모듈 작성 점검표:

- **세션**: 엔드포인트는 `session: SessionDep`(`api.platform.db`)를 받습니다. 응답 전에 커밋하므로 커밋 실패는 2xx가 아니라 500 envelope입니다. 직접 `session.commit()`이나 `Depends(get_session)`을 쓰지 않습니다.
- **핸들러 등록**: 핸들러 모듈은 패키지 `__init__.py`에서 import합니다. 핸들러가 없는 이벤트도 relay는 dispatched로 표시합니다. worker 시작 로그의 `event subscriptions` 표를 확인합니다.
- **멱등성**(D-006): 모든 핸들러는 `if not claim_event(session, "<schema>", event): return`으로 시작합니다. 한 모듈의 여러 핸들러가 같은 이벤트를 받으면 `create_processed_events("<schema>", per_handler=True)`와 `handler="<name>"`을 씁니다.
- **마이그레이션**: 모든 `op.*` 호출에 `schema="<db_schema>"`를 줍니다. 다른 모듈의 schema는 건드리지 않습니다.
- **outbox**: 핸들러 안에서 `platform.outbox_events`를 수정하지 않습니다(relay가 행 잠금을 쥐고 있어 교착). 후속 이벤트는 `outbox.write(session, ...)`로만 발행합니다.
- **확장**: `pg_trgm`은 platform이 `public`에 한 번 설치합니다. 마이그레이션에서 `CREATE EXTENSION`을 하지 않고 `public.gin_trgm_ops`, `public.similarity(...)`를 참조합니다.
- **테스트 도구**: `api.platform.testing.app.create_test_app`, fixture `migrated_db`, `api.platform.testing.tokens.FakeIssuer`, `api.platform.testing.contracts.assert_matches_response` / `assert_valid_event`.

## 보안

- **인증과 역할**: Keycloak은 인증만, 사용자·기관·역할의 원본은 NAIS identity DB입니다(D-019). 모든 요청에서 상태와 역할을 다시 읽어 비활성 사용자·소속을 막습니다.
- **데이터 접근**: deny-by-default. 접근 등급은 `PUBLIC`, `INTERNAL`, `CONTROLLED`, `SENSITIVE`입니다. 볼 수 없는 데이터셋은 403이 아니라 404로 답해 존재를 드러내지 않습니다. 미리보기는 PLATFORM_ADMIN, 소유 기관 구성원, PUBLIC 데이터셋에만 허용되며, 기한부 권한(grant) 경로는 M04가 생기기 전까지 항상 거부입니다(fail-closed).
- **원본 값 보호**: AI-ready 검증 결과와 버전 비교는 통계·위치·열 프로파일만 쓰고 원본 값을 담지 않습니다(D-018). 연구노트 AI 초안은 활동 메타데이터와 노트북 셀 앞부분·출력 종류만 LLM에 보내고 파일 내용과 출력 값은 보내지 않습니다(D-045, D-049).
- **개인정보**(Ruling P23): 공개 메타데이터의 연락처 이메일은 데이터셋에서 `contact_email_public`을 켠 경우에만, 담당자가 여전히 소유 기관의 활성 구성원일 때만 채웁니다. 모듈 간 Port로 사용자 이메일을 읽는 것은 메일 발송(M09)과 이 공개 연락처(M03)에만 허용됩니다(`IdentityQueryPort.get_email`).
- **감사**: 감사 테이블은 `nais_app`에 INSERT·SELECT만 허용하고 트리거로 수정·삭제를 막습니다(D-027).
- **내부 API**: `/api/v1/internal/*`은 gateway에서 항상 404이며 docker 네트워크 안의 웹 서버만 `X-NAIS-Internal-Token`으로 부릅니다.
- **정책 엔진**: OPA 호출은 500ms 제한, 실패 시 거부(`POLICY_ENGINE_UNAVAILABLE`, D-022). 정책 초안은 [`NAIS_PRD/08_OPA_POLICY.md`](NAIS_PRD/08_OPA_POLICY.md)에 있고 배포된 정책은 아직 없습니다.
- **노트북**: 공유 토큰 하나로 운영하는 시연 수준 보안입니다(D-049). 토큰은 포털의 `/notebooks-open`이 세션과 프로젝트 구성원 확인 뒤에만 넘기며, 커널은 격리 네트워크에서 돕니다.
- **알려진 위험**: 개발 스택은 모든 포트와 단일 계정 `nais`/`nais`를 외부에 노출합니다(D-037, 소유자 수용). api·worker 컨테이너는 root로 실행되며 미리보기 하위 프로세스의 잔여 위험은 [catalog README](apps/api/modules/catalog/README.md)에 적혀 있습니다.

보안 문제는 공개 이슈로 올리지 말고 저장소 소유자에게 비공개로 알려 주세요(GitHub 프로필의 연락처 또는 GitHub Security Advisory).

## 문서

| 문서 | 내용 |
|---|---|
| [`NAIS_PRD/README.md`](NAIS_PRD/README.md) | PRD 색인과 읽는 순서 |
| [`NAIS_PRD/11_DECISION_LOG.md`](NAIS_PRD/11_DECISION_LOG.md) | 결정 기록 D-001~D-049 |
| [`NAIS_PRD/07_RUNTIME_ENVIRONMENT.md`](NAIS_PRD/07_RUNTIME_ENVIRONMENT.md) | 포트, gateway 라우팅, compose |
| [`NAIS_PRD/modules/`](NAIS_PRD/modules) | 모듈별 명세 |
| [`NAIS_PRD/contracts/`](NAIS_PRD/contracts) | API·이벤트·오류 코드 계약 |
| [`docs/adr/`](docs/adr) | ADR과 계약 변경 요청 |
| [`docs/superpowers/specs/`](docs/superpowers/specs) | 기능 설계(데이터 포털, 허브·작업 공간·노트, 노트북, 연구 동향, UI) |
| [`docs/superpowers/plans/`](docs/superpowers/plans) | 구현 계획 |
| [`apps/api/README.md`](apps/api/README.md) | api·worker 운영 메모 |
| [`apps/web/README.md`](apps/web/README.md) | 웹 실행, 환경 변수, mock/real 모드, e2e |
| `apps/api/modules/*/README.md` | [identity](apps/api/modules/identity/README.md), [project](apps/api/modules/project/README.md), [catalog](apps/api/modules/catalog/README.md), [readiness](apps/api/modules/readiness/README.md), [audit](apps/api/modules/audit/README.md), [workspace](apps/api/modules/workspace/README.md) |

`NAIS_PRD_COMBINED.md`는 `NAIS_PRD/`를 합친 생성물이므로 직접 고치지 않습니다.

## 현재 상태와 로드맵

완료:

| 단계 | 내용 | 계약 |
|---|---|---|
| Wave 0 | 플랫폼 기반: compose, gateway, 모듈 플러그인, outbox, 마이그레이션, CI | |
| Wave 1 | M01 identity, M02 project, M03 catalog, M05 readiness, M09 audit, M10 web(mock 모드) | 1.2 |
| Wave 1.5 Stage 1 | Data Card, Data Explorer 미리보기, 연구 메타데이터·어휘, JSON-LD, 기관 이동, NTIS 번호 | 1.3 |
| Wave 1.5 Stage 2 | lakeFS식 버전 관리: rebase, 비교, 파일 이력, 인용 (D-041) | 1.4 |
| 허브·작업 공간·연구노트 | M13 workspace, M14 notes, 로컬 LLM 초안 (D-043~D-047) | 1.6, 1.7 |
| M07-lite | 공유 JupyterLab, 프로젝트별 작업 공간, 저장 시 Git 이력 (D-049) | 1.8 |
| 하이브리드 검색 | 데이터셋 인덱스 v3(bge-m3), 공개 프로젝트 인덱스, mock 모드 검색 브리지 | 1.9 |

남은 일:

- **M04 접근 거버넌스**: 접근 요청·승인·grant·OPA 정책 백엔드. 이것이 있어야 real 모드 웹을 기본으로 전환할 수 있습니다(Wave 2).
- **Stage 3**: 파일 역할(raw/processed), 처리 단계와 계보 탭.
- **Stage 4**: 데이터셋 1:1 문의, 담당자 부재 알림.
- **연구 동향**(논문·학회): 설계만 있음([`2026-10-01-research-trends-design.md`](docs/superpowers/specs/2026-10-01-research-trends-design.md)). 설계 문서의 모듈 번호 M13은 이후 workspace가 사용하므로 구현 시 번호를 다시 정해야 합니다.
- **discovery 인덱스**: 업로드마다 자동 적재되는 검색·연결 지도(OpenSearch + 그래프 DB), 설계 중.
- **전체 M07**: 사용자별 노트북 서버(계약 1.5.0 예약, [`2026-10-01-m07-notebooks.md`](docs/superpowers/plans/2026-10-01-m07-notebooks.md)).
- **운영 준비**: 운영 Keycloak realm, 기본 계정 교체, 스크립트 nonce 기반 CSP.

## 라이선스

라이선스 미정입니다. 저장소에 `LICENSE` 파일이 없으며, 사용·재배포 조건은 저장소 소유자에게 문의하세요.
