# Runtime Environment & Ports

## 1. 단일 진입점: `:21051`

NAIS AI-OS는 호스트에 **21051 포트 하나만** 서비스 포트로 노출한다.
모든 트래픽은 Nginx(`gateway`)가 path 기준으로 내부 컨테이너에 전달한다.

```text
http://localhost:21051
│
├── /                     → web:3000        (Next.js, Auth.js는 /web-auth/*)
├── /api/                 → api:8000        (FastAPI, /api/v1/*)
├── /auth/                → keycloak:8080   (KC_HTTP_RELATIVE_PATH=/auth)
├── /nais-inst-a/         → storage-a:8333  (Institute A bucket, presigned URL 전용)
├── /nais-inst-b/         → storage-b:8333  (Institute B bucket, presigned URL 전용)
└── /healthz              → gateway 자체 health (200 "ok")
```

### Presigned URL 규칙
- API는 presigned URL을 **public endpoint `NAIS_PUBLIC_BASE_URL`(기본 `http://localhost:21051`)** 기준, **path-style**로 서명한다.
  - 예: `http://localhost:21051/nais-inst-b/datasets/{dataset_id}/{version_id}/data.csv?X-Amz-...`
- Nginx는 bucket 경로를 해당 S3 스토리지(SeaweedFS)로 그대로 전달하며, 서명 검증을 위해 `Host` 헤더를 보존한다 (`proxy_set_header Host $http_host;`).
- bucket 이름은 전역 유일해야 한다: `nais-inst-a`, `nais-inst-b`, (readiness 산출물) `nais-platform`.
- 업로드 본문 크기 제한은 bucket 경로에서만 해제한다 (`client_max_body_size 0;`). `/api/`는 `10m`.

### Nginx 설정
정본은 `infra/nginx/nais.conf`다 (Agent 0). 규칙:
- `resolver 127.0.0.11` + 변수 upstream: web/keycloak가 아직 없어도 gateway가 기동한다. web이 없으면 `/`는 503.
- 스토리지 경로는 정규식 `location ~ ^/nais-inst-a(/|$)`. `location /nais-inst-a/`만 두면 `/nais-inst-a` 요청이 301 되어 S3 클라이언트가 무한 리다이렉트에 빠진다.
- 스토리지·keycloak 경로는 `Host $http_host`를 보존한다 (presigned 서명 검증).

## 2. 개발 포트 (외부 공개, D-037)

| 포트 | 서비스 | 용도 |
|---:|---|---|
| 21051 | gateway (nginx) | **서비스 포트 (유일한 공개 포트)** |
| 21052 | mailpit UI | 개발용 메일 확인 |
| 21053 | storage-a S3 | Institute A 스토리지 S3 endpoint (디버깅) |
| 21054 | storage-b S3 | Institute B 스토리지 S3 endpoint (디버깅) |
| 21055 | postgres | 로컬 디버깅 (psql) |
| 21056 | opensearch | OpenSearch (gateway Basic 인증 nais/nais) |
| 21057 | opa | OPA (gateway Basic 인증 nais/nais) |
| 21058 | redis | 로컬 디버깅 |
| 21059 | 예약 | P1 이후 (예: grafana) |

운영 배포(`docker-compose.prod.yml`)에서는 21052~21059를 publish하지 않는다.

## 3. Compose 서비스 목록

| 서비스 | 이미지/빌드 | 내부 포트 | 소유 Agent | 비고 |
|---|---|---:|---|---|
| gateway | nginx:1.27 | 21051 | Agent 0 | 호스트 21051:21051 |
| web | apps/web | 3000 | Agent 7 | |
| api | apps/api | 8000 | Agent 0 (entry) | 모듈 코드는 각 Agent |
| worker | apps/api (`python -m api.worker`) | - | Agent 0 (entry) | outbox relay, readiness job, grant expiry sweeper |
| postgres | postgres:16 | 5432 | Agent 0 | DB `nais`, schema 모듈별 |
| redis | redis:7 | 6379 | Agent 0 | Dramatiq broker |
| opensearch | opensearch:2 | 9200 | Agent 3 | single-node, security plugin off (dev) |
| keycloak | keycloak:26 | 8080 | Agent 1 | realm `nais`, relative path `/auth` |
| opa | openpolicyagent/opa | 8181 | Agent 4 | bundle: `infra/opa/policies` |
| storage-a | chrislusf/seaweedfs:4.48 | 8333 | Agent 0 | Institute A storage (S3), `nais-platform` bucket도 여기 |
| storage-b | chrislusf/seaweedfs:4.48 | 8333 | Agent 0 | Institute B storage (S3) |
| mailpit | axllent/mailpit | 1025/8025 | Agent 6 | SMTP 1025 |

## 4. 환경 변수 (공통 `.env.example`, Agent 0 소유)

모듈 전용 변수(예: `GOVERNANCE_*`, `READINESS_*`, `NOTIFICATION_*`)는 각 `modules/Mxx_*.md` §11에 정의하고, Agent 0가 `.env.example`에 모은다.

```dotenv
NAIS_PUBLIC_BASE_URL=http://localhost:21051
NAIS_GATEWAY_PORT=21051

# API
DATABASE_URL=postgresql+psycopg://nais_app:nais@postgres:5432/nais          # 런타임 role (D-027)
MIGRATION_DATABASE_URL=postgresql+psycopg://nais_migrator:nais@postgres:5432/nais  # schema owner, migrate 전용
REDIS_URL=redis://nais:nais@redis:6379/0
OPENSEARCH_URL=http://opensearch:9200
OPA_URL=http://opa:8181
OPA_TIMEOUT_MS=500
OIDC_ISSUER=http://localhost:21051/auth/realms/nais
OIDC_INTERNAL_JWKS_URL=http://keycloak:8080/auth/realms/nais/protocol/openid-connect/certs
OIDC_AUDIENCE=nais-api
SMTP_HOST=mailpit
SMTP_PORT=1025

# Storage (기관별 스토리지를 organization code로 매핑)
# 기관 code → prefix: 대문자화, '-'→'_' (inst-a → STORAGE_INST_A_*, D-024)
STORAGE_INST_A_ENDPOINT=http://storage-a:8333
STORAGE_INST_A_BUCKET=nais-inst-a
STORAGE_INST_A_ACCESS_KEY=nais
STORAGE_INST_A_SECRET_KEY=nais
STORAGE_INST_B_ENDPOINT=http://storage-b:8333
STORAGE_INST_B_BUCKET=nais-inst-b
STORAGE_INST_B_ACCESS_KEY=nais
STORAGE_INST_B_SECRET_KEY=nais
STORAGE_NAIS_ENDPOINT=http://storage-a:8333
STORAGE_NAIS_BUCKET=nais-platform
STORAGE_NAIS_ACCESS_KEY=nais
STORAGE_NAIS_SECRET_KEY=nais
STORAGE_ORG_CODES=nais,inst-a,inst-b
STORAGE_PRESIGN_TTL_SECONDS=300
STORAGE_MULTIPART_THRESHOLD_BYTES=67108864

# Web
# Auth.js basePath는 /web-auth (/api/는 FastAPI 전용, D-026)
AUTH_URL=http://localhost:21051/web-auth
AUTH_SECRET=change-me-32-bytes
AUTH_KEYCLOAK_ISSUER=http://localhost:21051/auth/realms/nais
AUTH_KEYCLOAK_INTERNAL_URL=http://keycloak:8080/auth/realms/nais
AUTH_KEYCLOAK_ID=nais-web
NEXT_PUBLIC_API_BASE=/api/v1
API_INTERNAL_BASE=http://api:8000/api/v1
NEXT_PUBLIC_API_MOCKING=disabled
```

## 5. Database roles (D-027)

| role | 권한 | 사용처 |
|---|---|---|
| `nais_migrator` | 모든 모듈 schema owner | `make migrate`, `make seed`의 DDL |
| `nais_app` | 각 schema 테이블 DML. 단 `audit.audit_events`는 `INSERT, SELECT`만 | api, worker 런타임 |

Postgres init 스크립트(`infra/docker/postgres/init.sql`, Agent 0)가 두 role과 schema를 만든다. M09 migration이 audit 테이블 권한을 REVOKE한다.

## 6. Health / Readiness

| 경로 | 설명 |
|---|---|
| `GET /healthz` | gateway liveness |
| `GET /api/v1/health/live` | api process liveness |
| `GET /api/v1/health/ready` | postgres, redis, opensearch, opa 연결 확인. 하나라도 실패 시 503 |

Gate A(Compile/Boot) 판정: `docker compose up -d` 후 120초 이내 위 3개가 모두 200.

## 7. 로컬 실행 규약

```bash
scripts/nais up            # .env 없으면 .env.example 복사 후 docker compose up -d --build
scripts/nais migrate       # platform + 모든 모듈 migration (nais_migrator)
scripts/nais storage-init  # 기관 bucket 생성
scripts/nais seed          # 10_SEED_DATA.md 기준 데이터 적재
scripts/nais gate-a        # Gate A 판정
```
`make <target>`도 같은 명령으로 위임된다 (make가 설치된 환경).
