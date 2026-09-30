# Decision Log (PRD v1.1 보완 결정)

PRD v1.0에서 비어 있거나 모호했던 부분을 v1.1에서 확정한 기록이다.
각 결정은 `contracts/`와 모듈 명세에 반영되어 있으며, 변경하려면 contract change request를 거친다.

| ID | 주제 | 결정 | 근거 / 비고 |
|---|---|---|---|
| D-001 | 외부 포트 | 시스템 단일 진입점은 **Nginx `:21051`**. web, api, keycloak, 객체 스토리지 presigned 경로 모두 21051 아래 path로 라우팅 | 요청자 지정. 상세 `07_RUNTIME_ENVIRONMENT.md` |
| D-002 | 개발 도구 포트 | Mailpit UI, MinIO console 등 개발 도구는 `127.0.0.1:21052~21059`에만 bind. 운영 배포에서는 노출하지 않음 | 21051은 서비스 포트로만 사용 |
| D-003 | OPA 소유 경로 | M04가 `infra/opa` 전체 소유. Rego는 `infra/opa/policies/data_access/` | v1.0 문서 간 경로 불일치 해소 |
| D-004 | 추가 schema | PostgreSQL schema 목록에 `knowledge`(M11), `autonomy`(M12), `platform`(M00) 추가 | v1.0 누락 |
| D-005 | Outbox 위치 | 단일 `platform.outbox_events` 테이블(M00 소유). 각 모듈은 `platform.outbox.OutboxWriter`로 **자기 트랜잭션 안에서** insert | 같은 PG instance이므로 cross-schema 트랜잭션 가능. 모듈 테이블 직접 접근 금지 원칙과 별개인 플랫폼 인프라 |
| D-006 | Event 소비 | Worker의 outbox relay가 in-process handler registry로 전달. **At-least-once**. 각 consumer는 `<schema>.processed_events(event_id)`로 멱등 처리 | Kafka/NATS 교체 시 envelope 불변 |
| D-007 | 멤버 초대 | P0는 **직접 추가**(status ACTIVE) + 초대 알림. 수락/거절 플로우는 P1 | Golden E2E 단순화 |
| D-008 | Grant 주체 | P0 Grant subject는 **요청한 사용자 1명** (`subject_type=USER`). 같은 Project의 다른 멤버는 각자 요청 | 최소권한. Project 단위 grant는 P1 검토 |
| D-009 | Grant operation | `READ`(파일 목록·다운로드), `COMPUTE`(P2 compute-to-data, P0에서 요청 불가), `WRITE`(예약, 요청 불가) | 보안 테스트 "READ만 가진 사용자의 WRITE 불가" 충족 |
| D-010 | 만료 enforcement | 만료는 **검사 시점 비교**(`expires_at <= now` → deny)로 강제. Worker의 1분 주기 sweeper는 상태를 `EXPIRED`로 바꾸고 이벤트만 발행 | sweeper 지연이 있어도 접근 차단 100% |
| D-011 | 접근 등급별 규칙 | PUBLIC: 인증 사용자 누구나 다운로드. INTERNAL: 소유기관 ACTIVE 멤버만. CONTROLLED: active grant 필수. SENSITIVE: active grant 필수 + `max_grant_days ≤ 30` | 소유기관 `DATA_STEWARD`/`ORG_ADMIN`은 자기 기관 데이터에 grant 없이 접근 |
| D-012 | 메타데이터 공개 | PUBLIC/CONTROLLED/SENSITIVE 메타데이터는 모든 인증 사용자 검색 가능. INTERNAL은 소유기관 멤버에게만 검색 노출 | "metadata centrally discoverable" |
| D-013 | Dataset 생성 권한 | 소유기관의 `DATA_STEWARD`만 Dataset 생성·Version publish·정책 변경 가능 | Seed에 기관별 steward 계정 포함 |
| D-014 | Upload 완료 | 기존 surface에 `POST /api/v1/upload-sessions/{id}/complete` 추가. 64 MiB 초과 파일은 multipart | checksum 검증 지점 필요 |
| D-015 | Access Request 생성 | `POST /access-requests`는 바로 `SUBMITTED`로 생성. `DRAFT`는 enum에만 예약 | P0 UI 단순화 |
| D-016 | 추가 endpoint | `resubmit`, `withdraw`, `GET /access-grants`, `GET /users`, 기관 멤버 관리, notifications, readiness profiles 추가 | `contracts/openapi.yaml`이 최종 |
| D-017 | 다운로드 감사 | `FILE_DOWNLOADED`는 **다운로드 URL 발급 시점** 기준으로 기록 (`governance.download.authorized.v1`). 거부도 `governance.download.denied.v1`로 기록 | 스토리지 access log 연동은 P1 |
| D-018 | Readiness 파일 접근 | Readiness worker는 사용자 grant가 아니라 **서비스 계정**으로 스토리지 읽기. 결과에는 원본 값이 아닌 통계·위치만 evidence로 기록 | 검증 결과가 데이터 유출 경로가 되지 않도록 |
| D-019 | 인증 방식 | Web은 Auth.js(Keycloak provider, Authorization Code + PKCE). API는 Bearer JWT를 JWKS로 검증. 기관은 토큰 claim `org_code`로 식별 | 역할의 source of truth는 NAIS identity DB, Keycloak은 인증만 |
| D-020 | 로그인 감사 | 첫 인증 요청 시 identity가 세션당 1회 `identity.user.logged_in.v1` 발행 | Audit `LOGIN` 충족 |
| D-021 | Migration | Alembic 멀티 version location. 모듈별 `apps/api/modules/<m>/migrations`, `version_table`도 모듈 schema 안 | 모듈이 자기 migration만 소유 |
| D-022 | OPA 장애 | OPA 호출 timeout 500ms, 실패 시 deny + `POLICY_ENGINE_UNAVAILABLE`(503) | fail-closed |
| D-023 | 프로젝트 공개범위 | `PRIVATE`(기본, 멤버만 조회) / `PUBLIC`(요약만 전체 인증 사용자 조회, 상세는 멤버만) | |
| D-024 | 스토리지 매핑·Port | 기관 스토리지는 기관 `code`에서 env prefix를 유도(`inst-b` → `STORAGE_INST_B_*`). identity는 스토리지를 모른다. `StoragePort`/`CatalogQueryPort`의 구현과 타입 정본은 M03 §8. Governance는 권한만 판정하고 `presign_get(version_id, file_ids, ttl)`을 호출 | storage key는 catalog 내부 정보 |
| D-025 | 검토 시작 | `GET /access-requests/{id}`는 상태를 바꾸지 않는다. `POST /access-requests/{id}/start-review`로 SUBMITTED → UNDER_REVIEW, `governance.access.review_started.v1` 발행. 승인·거절·수정요청은 SUBMITTED에서도 가능 | 부수효과 있는 GET은 prefetch/캐시에서 오작동 |
| D-026 | Web 인증 경로 | Auth.js `basePath=/web-auth` | gateway가 `/api/`를 FastAPI로 보냄 |
| D-027 | DB role 분리 | `nais_migrator`(schema owner) / `nais_app`(런타임). audit 테이블은 `nais_app`에 INSERT/SELECT만 | audit 불변성 |
| D-028 | readiness_overall 기준 | 검색·목록의 `readiness_overall`은 TABULAR_ML_BASIC 최신 COMPLETED 결과, 없으면 GENERIC_BASIC | 표시 기준 단일화 |
| D-029 | input_fingerprint | `sha256(manifest_sha256 + metadata_snapshot_sha256 + profile_id + profile_version + validator_version)`. publish 시 dataset metadata를 동결(`metadata_snapshot`) | metadata 변경이 결과 재사용에 반영되도록 |
| D-030 | Governance 이벤트 payload | 모든 governance 이벤트에 `owner_organization_id` 포함, `requested`에 `dataset_title`/`project_name` 포함 | M09가 추가 조회 없이 audit/알림 생성 |
| D-031 | VIEWER 접근 요청 | project `VIEWER`는 access request 불가(`FORBIDDEN`) | 최소권한 |

## P1 이후로 미룬 항목 (v1.1 검토 중 식별)
- Dataset version withdraw API 및 `catalog.dataset.version_withdrawn.v1` (enum `WITHDRAWN`만 예약)
- Dataset 일반 메타데이터 변경 이벤트 (P0는 검색 색인이 catalog 내부라 불필요)
- PLATFORM_ADMIN 긴급 grant 회수 (break-glass) — 현재는 소유기관 steward/ORG_ADMIN만 회수
- Project 단위 grant (D-008), 멤버 초대 수락 플로우 (D-007)
- 스토리지 access log 기반 실제 다운로드 감사 (D-017)
