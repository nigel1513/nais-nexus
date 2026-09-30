# M02 Project Collaboration

> 기준 계약: `contracts/openapi.yaml`(tag `projects`), `contracts/events/p0_events.schema.json`, `11_DECISION_LOG.md`(D-007, D-023)

## 1. Goal / Scope

### Goal
기관 간 공동 연구 Project와 참여자·역할을 관리한다.

### P0
- Project create/update/archive
- lead organization (생성자 기관)
- partner organizations (멤버 소속 기관에서 자동 파생)
- member add/remove, role 변경 (P0는 **직접 추가** + 초대 알림, D-007)
- project roles: `PROJECT_OWNER`, `PROJECT_ADMIN`, `RESEARCHER`, `VIEWER`
- visibility: `PRIVATE`(기본) / `PUBLIC` (D-023)
- activity event emit (M09 audit/notification 소비)

### Rules (v1.0 유지)
- PROJECT_OWNER는 1명 이상이어야 한다.
- 외부기관 member가 가능하다.
- project member가 아니면 private project detail을 볼 수 없다.
- dataset 권한과 project membership은 별개다. 멤버가 되었다고 데이터 접근이 생기지 않는다.

### Out of scope
- 초대 수락/거절 플로우 (P1)
- Project Resource 연결 (Dataset/Model/GPU를 Project에 붙이는 것, P1 M06/M07)
- 산출물(Output) 관리 (P1)
- 프로젝트 삭제 (archive만 가능)

### 후속 단계
- P1: invitation 수락, Project Resource, Output 등록
- P3: Experiment workflow 연결 (M12)

## 2. Ownership

| 항목 | 값 |
|---|---|
| Owner | Agent 2 — Project |
| Paths | `apps/api/modules/project` |
| DB schema | `project` |
| Migration | `apps/api/modules/project/migrations` (version_table `project.alembic_version`) |

## 3. Dependencies

### Ports consumed
```python
class IdentityQueryPort(Protocol):  # M01
    def get_public_profile(self, user_id: UUID) -> IdentityPublicProfile | None: ...
    def get_public_profiles(self, user_ids: list[UUID]) -> dict[UUID, IdentityPublicProfile]: ...
    def get_organization_summary(self, organization_id: UUID) -> OrganizationSummary | None: ...
    def is_active_user(self, user_id: UUID) -> bool: ...
```
Wave 1에서는 seed 사용자 목록을 가진 `FakeIdentityQueryPort`를 사용한다.

`CurrentUser`는 platform auth dependency로 받는다.

### Events consumed
해당 없음. 기관 membership이 DISABLED가 되어도 project 멤버 행은 유지된다. 해당 사용자는 M01에서 요청 자체가 차단되고, grant 회수는 M04가 처리한다.

## 4. Data Model (`project.*`)

### `project.projects`
| column | type | null | default | constraint |
|---|---|---|---|---|
| project_id | uuid | N | uuidv7 | PK |
| name | varchar(200) | N | | CHECK length ≥ 2 |
| description | text | N | `''` | ≤ 10000 |
| visibility | varchar(16) | N | `'PRIVATE'` | CHECK in (`PRIVATE`,`PUBLIC`) |
| status | varchar(16) | N | `'ACTIVE'` | CHECK in (`ACTIVE`,`ARCHIVED`) |
| lead_organization_id | uuid | N | | (identity 참조, FK 없음) |
| keywords | text[] | N | `'{}'` | ≤ 20개, 각 ≤ 50자 |
| start_date | date | Y | | |
| end_date | date | Y | | CHECK `end_date IS NULL OR start_date IS NULL OR end_date >= start_date` |
| created_by | uuid | N | | |
| created_at | timestamptz | N | now() | |
| updated_at | timestamptz | N | now() | |
| archived_at | timestamptz | Y | | |

Index: `ix_projects_visibility_status (visibility, status)`, `ix_projects_name_trgm` (GIN trgm, `q` 검색).

### `project.project_members`
| column | type | null | default | constraint |
|---|---|---|---|---|
| project_member_id | uuid | N | uuidv7 | PK |
| project_id | uuid | N | | FK → `project.projects` |
| user_id | uuid | N | | |
| organization_id | uuid | N | | 추가 시점 사용자 소속 기관 (IdentityQueryPort로 조회해 복사) |
| role | varchar(16) | N | | CHECK in (`PROJECT_OWNER`,`PROJECT_ADMIN`,`RESEARCHER`,`VIEWER`) |
| status | varchar(16) | N | `'ACTIVE'` | CHECK in (`ACTIVE`,`REMOVED`) |
| joined_at | timestamptz | N | now() | |
| added_by | uuid | N | | |
| removed_at | timestamptz | Y | | |
| removed_by | uuid | Y | | |
| removal_reason | text | Y | | |

Unique: `ux_project_members_active (project_id, user_id) WHERE status = 'ACTIVE'`.
Index: `ix_project_members_user (user_id, status)`. "내 프로젝트" 조회용이다 (한 사용자가 여러 프로젝트에 소속 가능).

제거는 soft delete(`REMOVED`)로 처리해 이력을 남긴다. 다시 추가하면 새 행을 만든다.

### `project.project_organizations`
멤버 구성으로부터 파생되는 참여기관 테이블. 멤버 변경과 **같은 트랜잭션**에서 갱신한다.

| column | type | null | default | constraint |
|---|---|---|---|---|
| project_id | uuid | N | | PK part, FK → `project.projects` |
| organization_id | uuid | N | | PK part |
| role | varchar(8) | N | | CHECK in (`LEAD`,`PARTNER`) |
| active_member_count | int | N | 0 | CHECK ≥ 0 |

규칙:
- 생성 시 lead 기관 행(`LEAD`)을 만든다.
- 다른 기관 멤버가 처음 추가되면 `PARTNER` 행을 insert한다.
- `PARTNER`의 `active_member_count`가 0이 되면 행을 삭제한다. `LEAD` 행은 삭제하지 않는다.

`project.processed_events`: 해당 없음.

## 5. State machine

### Project
| from | to | 주체 | 조건 |
|---|---|---|---|
| (없음) | ACTIVE | 인증 사용자 | 생성자 = PROJECT_OWNER |
| ACTIVE | ARCHIVED | PROJECT_OWNER | `project.archived.v1` → M04가 project-scoped grant 전부 회수 (`PROJECT_ARCHIVED`) |
| ARCHIVED | (변경 불가) | | P0에 unarchive 없음. 모든 mutation은 409 `PROJECT_ARCHIVED` |

### Member
| from | to | 주체 |
|---|---|---|
| (없음) | ACTIVE | OWNER/ADMIN 추가, 생성자 자동 |
| ACTIVE | ACTIVE(role 변경) | 아래 role 규칙 |
| ACTIVE | REMOVED | OWNER/ADMIN 제거, 본인 탈퇴 → M04가 해당 사용자의 이 project grant 회수 (`PROJECT_MEMBER_REMOVED`) |

### Role 변경 규칙
- `PROJECT_OWNER` 역할의 부여·박탈·OWNER 멤버 제거는 **OWNER만** 할 수 있다.
- `PROJECT_ADMIN`은 `RESEARCHER`, `VIEWER` 멤버의 추가·제거·역할 변경만 할 수 있다. 다른 ADMIN의 부여·박탈은 OWNER만 할 수 있다.
- **ACTIVE OWNER가 0명이 되는 변경**(마지막 OWNER의 강등·제거·탈퇴)은 409 `PROJECT_LAST_OWNER`다.
- 불변식 `count(ACTIVE members where role=OWNER) >= 1`은 트랜잭션 안에서 `SELECT ... FOR UPDATE`(projects 행 잠금)로 보장한다.

## 6. API

| operationId | 호출 가능 | 규칙 | Side effect | Error |
|---|---|---|---|---|
| `listProjects` | 인증 사용자 | `scope=mine`(기본): 내가 ACTIVE 멤버인 프로젝트 (ARCHIVED 포함, `status`로 필터). `scope=discover`: `PUBLIC` + `ACTIVE` 프로젝트 요약. `my_role`은 비멤버면 null. `q`는 name 부분일치. 정렬 `updated_at desc` | 없음 | 401 |
| `createProject` | 인증 사용자 | lead = 호출자 기관, 호출자 = OWNER. visibility 기본 PRIVATE. start/end 검증 | `project.created.v1`, 생성자 `project.member.added.v1`은 발행하지 않음 (created 이벤트에 owner 포함) | 422 `VALIDATION_FAILED` |
| `getProject` | ACTIVE 멤버, PLATFORM_ADMIN(읽기) | 비멤버: PRIVATE → 404 `NOT_FOUND`, PUBLIC → 403 `FORBIDDEN` | 없음 | 403, 404 |
| `updateProject` | OWNER, ADMIN | ARCHIVED면 거부. `visibility` 변경은 OWNER만 | 없음 (P0 이벤트 없음) | 403 `FORBIDDEN`, 409 `PROJECT_ARCHIVED`, 422 |
| `archiveProject` | OWNER | 이미 ARCHIVED면 409 | `project.archived.v1` | 403, 409 `PROJECT_ARCHIVED` |
| `listProjectMembers` | ACTIVE 멤버, PLATFORM_ADMIN | ACTIVE 멤버만. display_name/organization_name은 IdentityQueryPort batch 조회 | 없음 | 404 (비멤버, visibility 무관) |
| `addProjectMember` | OWNER, ADMIN(RESEARCHER/VIEWER만) | 대상이 `is_active_user` 아니면 422 `VALIDATION_FAILED`(`details.fields=["user_id"]`). 이미 ACTIVE 멤버면 409 `PROJECT_MEMBER_EXISTS`. 타 기관 사용자 허용. `project_organizations` 갱신 | `project.member.added.v1` (M09가 PROJECT_INVITATION 알림) | 403, 409 `PROJECT_MEMBER_EXISTS`/`PROJECT_ARCHIVED`, 422 |
| `updateProjectMemberRole` | 위 role 규칙 | 동일 role이면 이벤트 없이 200 | `project.member.role_changed.v1` | 403, 404 `PROJECT_MEMBER_NOT_FOUND`, 409 `PROJECT_LAST_OWNER`/`PROJECT_ARCHIVED` |
| `removeProjectMember` | OWNER, ADMIN(RESEARCHER/VIEWER 대상), 본인(탈퇴) | soft delete, `project_organizations` 갱신 | `project.member.removed.v1` (`removed_by`=호출자, 탈퇴면 본인) | 403, 404 `PROJECT_MEMBER_NOT_FOUND`, 409 `PROJECT_LAST_OWNER`/`PROJECT_ARCHIVED` |

ARCHIVED 프로젝트에서의 탈퇴는 허용한다 (grant는 이미 회수된 상태). 마지막 OWNER 규칙은 동일하게 적용한다.

## 7. Events

### Produced (모두 도메인 변경과 같은 트랜잭션에서 outbox write)
| event_type | 시점 | payload 주의 |
|---|---|---|
| `project.created.v1` | 생성 | `owner_user_id` = 생성자 |
| `project.archived.v1` | archive | |
| `project.member.added.v1` | 멤버 추가 | `project_name`, `organization_id`(대상 기관), `added_by` |
| `project.member.removed.v1` | 제거/탈퇴 | `reason` = 요청 본문 없음 → null (P0) |
| `project.member.role_changed.v1` | role 변경 | `previous_role`, `role`, `changed_by` |

### Consumed
해당 없음.

## 8. Public Service Interface

```python
class ProjectQueryPort(Protocol):
    def is_active_member(self, project_id: UUID, user_id: UUID) -> bool:
        ...
        # project.status == ACTIVE 이고 member.status == ACTIVE 일 때만 True
        # (ARCHIVED 프로젝트는 False — governance 다운로드 검사에 사용)

    def get_member_role(self, project_id: UUID, user_id: UUID) -> str | None: ...
    def get_summary(
        self, project_id: UUID
    ) -> ProjectSummary | None: ...  # openapi ProjectSummary, my_role=None
    def list_active_member_ids(self, project_id: UUID) -> list[UUID]: ...  # M09 audit 가시성용
    def list_project_ids_for_member(
        self, user_id: UUID
    ) -> list[UUID]: ...  # M09 audit 가시성용 (ACTIVE 멤버십)
```

## 9. Authorization matrix

| Action | 비멤버 | VIEWER | RESEARCHER | PROJECT_ADMIN | PROJECT_OWNER | PLATFORM_ADMIN |
|---|---|---|---|---|---|---|
| Project 생성 | O | O | O | O | O | O |
| 조회 (PRIVATE) | X (404) | O | O | O | O | O (읽기) |
| 조회 (PUBLIC) 요약 | O (discover) | O | O | O | O | O |
| 조회 (PUBLIC) 상세 | X (403) | O | O | O | O | O |
| 멤버 목록 | X | O | O | O | O | O |
| 정보 수정 | X | X | X | O | O | X |
| visibility 변경 | X | X | X | X | O | X |
| RESEARCHER/VIEWER 추가·제거·변경 | X | X | X | O | O | X |
| ADMIN 부여·박탈·제거 | X | X | X | X | O | X |
| OWNER 부여·박탈·제거 | X | X | X | X | O | X |
| 본인 탈퇴 | - | O | O | O | O (마지막 OWNER 불가) | - |
| Archive | X | X | X | X | O | X |

## 10. Background jobs
해당 없음.

## 11. Config / env vars

| 변수 | 기본값 | 용도 |
|---|---|---|
| `PROJECT_MAX_MEMBERS` | `200` | 초과 시 422 `VALIDATION_FAILED` |

## 12. Acceptance tests

| ID | Given | When | Then |
|---|---|---|---|
| M02-AT-01 | a.researcher | `POST /projects` | 201, lead = inst-a, members = [a.researcher OWNER], `project.created.v1` |
| M02-AT-02 | M02-AT-01 프로젝트 | a.researcher가 b.researcher를 RESEARCHER로 추가 | 201, `organizations`에 inst-b PARTNER, `project.member.added.v1`, b.researcher 알림 생성 (M09) |
| M02-AT-03 | M02-AT-02 | b.researcher `GET /projects/{id}` | 200, `my_role=RESEARCHER` |
| M02-AT-04 | PRIVATE 프로젝트 | b.steward(비멤버) `GET /projects/{id}` | 404 `NOT_FOUND` |
| M02-AT-05 | PUBLIC 프로젝트 | 비멤버 `GET /projects?scope=discover` / `GET /projects/{id}` | 목록 포함 / 403 `FORBIDDEN` |
| M02-AT-06 | 멤버 1명(OWNER) | 본인 탈퇴 | 409 `PROJECT_LAST_OWNER` |
| M02-AT-07 | OWNER 2명 | 한 명 강등 | 200. 이후 남은 1명 강등 → 409 `PROJECT_LAST_OWNER` |
| M02-AT-08 | PROJECT_ADMIN | 다른 멤버를 OWNER로 변경 | 403 `FORBIDDEN` |
| M02-AT-09 | RESEARCHER | 멤버 추가 | 403 `FORBIDDEN` |
| M02-AT-10 | 이미 ACTIVE 멤버 | 다시 추가 | 409 `PROJECT_MEMBER_EXISTS` |
| M02-AT-11 | b.disabled | 추가 대상으로 지정 | 422 `VALIDATION_FAILED` |
| M02-AT-12 | b.researcher 제거 | inst-b 멤버가 더 없음 | inst-b PARTNER 행 삭제, `project.member.removed.v1`, M04 grant 회수 트리거 |
| M02-AT-13 | 프로젝트 archive | 멤버 추가/수정 시도 | 409 `PROJECT_ARCHIVED`, `is_active_member`는 False |
| M02-AT-14 | 동시 요청 2건 | 두 OWNER가 서로를 동시에 강등 | 하나만 성공, OWNER ≥ 1 유지 |
| M02-AT-15 | b.researcher가 inst-a CONTROLLED 데이터셋에 대한 grant 없이 프로젝트 멤버 | 해당 버전 `download-session` 요청 | 403 `ACCESS_GRANT_REQUIRED` (membership ≠ dataset 권한) |

## 13. Deliverables & Known limitations

### Deliverables
- README, FastAPI router, `ProjectQueryPort` 구현
- Alembic migration (`project` schema)
- Seed: `10_SEED_DATA.md`의 데모 프로젝트 (없으면 golden E2E에서 생성)
- Unit/contract tests
- Integration notes: `is_active_member`는 ARCHIVED 프로젝트에서 False를 반환한다. governance는 이 값만 신뢰한다.

### Known limitations
- 초대는 수락 없이 즉시 멤버가 된다 (D-007).
- 멤버 `organization_id`는 추가 시점 값으로 고정된다 (P0 1인 1기관이라 문제 없음).
- 프로젝트 삭제·unarchive는 없다.
- `updateProject` 변경 이력(감사)은 P0 범위 밖이다.
