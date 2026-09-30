# Architecture & Technology Specification

## 1. Recommended Stack

### Frontend
- **Next.js**
- **TypeScript**
- Tailwind CSS
- shadcn/ui
- TanStack Query
- React Hook Form
- Zod

### Backend
- **Python + FastAPI**
- Pydantic
- SQLAlchemy
- Alembic

### Identity
- **Keycloak**
- OIDC first
- SAML-ready
- 장기적으로 KAFE/Federated IdP 연계 가능한 구조

### Authorization
- **Open Policy Agent (OPA)**
- RBAC + ABAC

### System of Record
- **PostgreSQL**
- 단일 instance, 모듈별 schema

### Search
- **OpenSearch**
- P0: keyword + faceted search
- P1+: vector/hybrid 가능

### Object Storage
- **SeaweedFS** (S3 API) for local/dev — MinIO 공식 이미지 배포 중단으로 대체 (D-034)
- Production: S3-compatible / institutional storage

### Async
- Redis
- Dramatiq 권장 (Celery도 허용)
- P0에서는 event bus를 별도 도입하지 않고 Transactional Outbox 사용

### Observability
- OpenTelemetry
- Prometheus
- Grafana
- Sentry

### Infra
- Docker
- Docker Compose
- Nginx
- GitHub Actions
- P0에서 Kubernetes 사용하지 않음

---

## 2. Architecture Style

### P0: Modular Monolith + Separate Data Node
빠른 개발과 병렬성을 동시에 확보하기 위해 backend는 **Modular Monolith**로 시작한다.

```text
apps/api
  modules/
    identity
    project
    catalog
    governance
    readiness
    marketplace
    compute
    audit
```

단, M08 Data Node는 별도 서비스로 분리한다.

이점:
- 배포 복잡도 최소화
- DB transaction 단순
- 모듈 ownership 명확
- 향후 필요 모듈만 service 분리 가능

---

## 3. Repository Structure

```text
nais-ai-os/
│
├── apps/
│   ├── web/                     # Next.js
│   └── api/                     # FastAPI modular monolith
│
├── services/
│   └── data-node/               # P2 separate service
│
├── packages/
│   ├── contracts/               # OpenAPI generated types / JSON schema
│   ├── ui/
│   └── config/
│
├── infra/
│   ├── docker/
│   ├── keycloak/
│   ├── opa/
│   ├── opensearch/
│   └── nginx/
│
├── docs/
│   ├── adr/
│   ├── api/
│   └── runbooks/
│
└── tests/
    ├── contract/
    ├── e2e/
    └── security/
```

---

## 4. PostgreSQL Schema Ownership

```text
identity
project
catalog
governance
readiness
marketplace
compute
audit
knowledge   # P1 (M11)
autonomy    # P3 (M12)
platform    # M00 (outbox_events 등)
```

각 모듈은 자신의 schema migration만 소유한다.

### 금지
`governance` 코드에서 `catalog.datasets` ORM entity import.

### 허용
`CatalogQueryPort.get_dataset_summary(dataset_id)`

또는 API/contract read model.

---

## 5. Transactional Outbox

모듈 간 이벤트는 P0에서 별도 Kafka를 두지 않는다.

```text
Business Transaction
    ↓
Domain row update
+
outbox_event insert
    ↓
Worker
    ↓
Event Handler
```

P1/P2에서 필요해질 경우 NATS/Kafka로 교체 가능하도록 Event Envelope을 고정한다.

---

## 6. File Transfer

대용량 파일은 API 서버를 경유하지 않는다.

```text
Browser
  │ request upload
  ▼
API
  │ permission check
  │ presigned URL
  ▼
Browser ───── direct ─────> S3 (dev: SeaweedFS)
```

Download도 동일.

---

## 7. Security Boundary

```text
Authentication
   ↓
Identity claims
   ↓
Application permission pre-check
   ↓
OPA decision
   ↓
Resource access
   ↓
Audit
```

Dataset file access는 반드시:
1. active grant 확인
2. operation 확인
3. expiration 확인
4. policy decision
5. signed URL 발급

순으로 처리한다.

---

## 8. API Conventions

Base:
```text
/api/v1
```

ID:
- UUIDv7 권장

Time:
- UTC ISO 8601

Error:
```json
{
  "error": {
    "code": "ACCESS_GRANT_EXPIRED",
    "message": "The access grant has expired.",
    "trace_id": "..."
  }
}
```

Pagination:
```json
{
  "items": [],
  "page": {
    "next_cursor": "...",
    "has_more": true
  }
}
```

---

## 9. Frontend Architecture

```text
app/
  (public)/
  (platform)/
    commons/
    marketplace/
    compute/

features/
  auth/
  organizations/
  projects/
  catalog/
  governance/
  readiness/
  marketplace/
  compute/
  audit/

shared/
  api/
  ui/
  hooks/
```

Frontend agent는 backend internal model을 직접 추측하지 않고 generated client 또는 contract type만 사용한다.

---

## 10. Environment

Local:
```text
web
api
postgres
redis
opensearch
keycloak
opa
storage-a
storage-b
worker
mailpit
```

P0 integration demo는 `Institute A`, `Institute B` 두 조직과 두 bucket을 seed한다 (`10_SEED_DATA.md`).

**서비스 포트는 `21051` 하나다.** Nginx gateway가 `/`(web), `/api/`(api), `/auth/`(keycloak), `/nais-inst-a/`·`/nais-inst-b/`(presigned 스토리지)를 path로 라우팅한다. 상세는 `07_RUNTIME_ENVIRONMENT.md`.
