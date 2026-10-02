"""Hub publication of project outputs through owner review (spec §5.4; openapi requestOutputPublish /
listPublishRequests / decidePublishRequest).

Request: an ACTIVE member other than VIEWER of an ACTIVE project, for a READY output whose publish_status is NONE or
REJECTED (else 409 OUTPUT_PUBLISH_PENDING). The requester's access to every lineage input must still be live (409
INPUT_ACCESS_LAPSED), the output may not be looser than its inputs' current levels (422), and its files must pass the
catalog upload rules (422, CatalogPublishPort.output_file_problems). Approval slots (D-013): one per owner organization
of the lineage inputs in lineage order (kind INPUT_OWNER), then the project lead organization — the new dataset's
owner — when it owns none of them (kind LEAD_ORGANIZATION; the only slot of an output without inputs). Every slot is
decided by a DATA_STEWARD of its organization. Emits workspace.publish.requested.v1.

Decision: a DATA_STEWARD of a slot organization (CurrentUser organization + roles), never the requester (403,
separation of duties), once per slot (409 when decided or when the request is no longer PENDING). REJECT needs a
comment (422). Any REJECT -> request and output REJECTED; every slot APPROVE -> request APPROVED, output APPROVED, the
lead organization's approving steward recorded as the publishing actor, and the publication job queued after commit.
Emits workspace.publish.decided.v1 (published_dataset_id is null: the catalog dataset does not exist yet).
Others: 404 when the caller can neither decide nor is a project member or a slot organization's user, else 403.

Publication (publish_approved, Dramatiq actor workspace.publish_output + a one-minute re-send sweep): under a
30-minute lease, CatalogPublishPort.create_dataset_from_output with the planned dataset id fixed at approval
(idempotency key). The dataset is owned by the project lead organization (whose bucket holds the output objects), at
the stricter of the output's level and its inputs' current levels, purposes = those every input allows (ACADEMIC_
RESEARCH when none or no inputs), created by the requester and published by the lead organization's approving
steward, provenance = a lineage note (source datasets @ versions, recipe @ version, run, the approval; no data
values). The catalog copies, verifies and publishes v1 through its own rules (and refuses a resume whose level became
stricter than the dataset it created); the request records the dataset id as soon as it exists, and only when the
catalog reports the version PUBLISHED does the output become PUBLISHED, with a dataset_activity OUTPUT_PUBLISHED row.
DRAFT (files still verifying) releases the lease for the sweep; an outage too, up to MAX_FAILURES. A terminal failure
(catalog refusal, failed file verification, MAX_FAILURES outages) rejects the request: status REJECTED with a
human-readable failure_reason, output REJECTED (it may be requested again with a fresh planned dataset id), and a
system workspace.publish.decided.v1 (REJECT by the lead organization slot, failure_reason set) for the requester.
"""

import logging
from collections.abc import Sequence
from datetime import timedelta
from typing import Any
from uuid import UUID

from sqlalchemy.engine import RowMapping
from sqlalchemy.exc import InterfaceError, OperationalError
from sqlalchemy.orm import Session

from api.modules.catalog.public import (
    CatalogPublishRejected,
    OutputDatasetState,
    OutputFileSource,
    StorageUnavailable,
)
from api.modules.workspace import jobs, repo
from api.modules.workspace.access import (
    STRICTNESS,
    accessible,
    require_not_looser,
    require_reader,
    require_writer,
)
from api.modules.workspace.deps import WorkspaceDeps
from api.modules.workspace.errors import forbidden, not_found
from api.modules.workspace.paging import keyset_page, sort_key
from api.modules.workspace.schemas import PublishDecisionIn, PublishRequest, PublishRequestIn
from api.modules.workspace.service.outputs import current_floor
from api.platform import clock, ports
from api.platform.auth import CurrentUser
from api.platform.errors import ApiError
from api.platform.events import EventActor
from api.platform.generated.error_codes import ErrorCode
from api.platform.generated.event_types import EventType
from api.platform.ids import new_id
from api.platform.outbox import outbox
from api.platform.pagination import Page, PageParams

logger = logging.getLogger("nais.workspace")

DATA_STEWARD = "DATA_STEWARD"
INPUT_OWNER = "INPUT_OWNER"
LEAD_ORGANIZATION = "LEAD_ORGANIZATION"
MAX_FAILURES = (
    5  # retryable publication failures (storage/database/port outages) before the request is rejected
)
OPEN_TO_REQUEST = ("NONE", "REJECTED")
DEFAULT_PURPOSE = "ACADEMIC_RESEARCH"
LEASE = timedelta(minutes=30)
MAX_NOTE = 10_000


# ---------------------------------------------------------------- views


def _views(session: Session, deps: WorkspaceDeps, rows: Sequence[RowMapping]) -> list[PublishRequest]:
    ids = [r["request_id"] for r in rows]
    approvals = repo.approvals_of(session, ids)
    org_names = deps.people.get_organization_names(
        [a["organization_id"] for slots in approvals.values() for a in slots]
    )
    titles = repo.output_titles(session, [r["output_id"] for r in rows])
    project_names: dict[UUID, str | None] = {}
    for r in rows:
        if r["project_id"] not in project_names:
            summary = deps.projects.get_summary(r["project_id"])
            project_names[r["project_id"]] = summary.name if summary else None
    views: list[PublishRequest] = []
    for r in rows:
        body: dict[str, Any] = {
            "request_id": r["request_id"],
            "output_id": r["output_id"],
            "project_id": r["project_id"],
            "status": r["status"],
            "approvals": [
                {
                    "organization_id": a["organization_id"],
                    "decided_by": a["decided_by"],
                    "decision": a["decision"],
                    "comment": a["comment"],
                    "decided_at": a["decided_at"],
                }
                | (
                    {"organization_name": org_names[a["organization_id"]]}
                    if a["organization_id"] in org_names
                    else {}
                )
                for a in approvals[r["request_id"]]
            ],
            "created_by": r["created_by"],
            "created_at": r["created_at"],
            "output_title": titles.get(r["output_id"], ""),
            "published_dataset_id": r["published_dataset_id"],
            "failure_reason": _failure_reason(r),
        }
        if project_names[r["project_id"]] is not None:
            body["project_name"] = project_names[r["project_id"]]
        views.append(PublishRequest.model_validate(body))
    return views


def _failure_reason(r: RowMapping) -> str | None:
    return r["publication_error"] if r["publication_status"] == "FAILED" else None


def _view(session: Session, deps: WorkspaceDeps, row: RowMapping) -> PublishRequest:
    [view] = _views(session, deps, [row])
    return view


# ---------------------------------------------------------------- request


def request_publish(
    session: Session,
    deps: WorkspaceDeps,
    user: CurrentUser,
    project_id: UUID,
    output_id: UUID,
    body: PublishRequestIn | None,
) -> PublishRequest:
    require_reader(deps, project_id, user)
    require_writer(deps, project_id, user)
    output = repo.load_output(session, project_id, output_id, for_update=True)
    if output is None or output["status"] != repo.READY:
        raise not_found("Output")
    if output["publish_status"] not in OPEN_TO_REQUEST:
        raise ApiError(
            ErrorCode.OUTPUT_PUBLISH_PENDING, "The output already has a pending or approved publish request."
        )
    lineage = repo.lineage_of(session, [output_id])[output_id]
    lapsed = [str(i["input_id"]) for i in lineage if not accessible(deps, user, i["dataset_id"])]
    if lapsed:
        raise ApiError(
            ErrorCode.INPUT_ACCESS_LAPSED,
            "Access to an input this output derives from was revoked or expired.",
            {"input_ids": lapsed},
        )
    require_not_looser(output["access_level"], current_floor(deps, [i["dataset_id"] for i in lineage]))
    title = body.title if body is not None and body.title is not None else output["title"]
    if len(title.strip()) < 3:
        raise ApiError(
            ErrorCode.VALIDATION_FAILED,
            "A dataset title needs at least 3 characters; give a title.",
            {"fields": [{"field": "title", "reason": "TOO_SHORT"}]},
        )
    problems = deps.publisher.output_file_problems(
        _sources(output, repo.files_of(session, [output_id])[output_id])
    )
    if problems:
        raise ApiError(
            ErrorCode.VALIDATION_FAILED,
            "The output's files cannot become a catalog dataset (file name, type or size).",
            {"files": problems},
        )
    lead = _lead_organization(deps, project_id)
    slots = _slots(deps, lead, lineage)
    now = clock.now()
    row = repo.insert_publish_request(
        session,
        {
            "request_id": new_id(),
            "output_id": output_id,
            "project_id": project_id,
            "status": "PENDING",
            "title": title,
            "description": (body.description if body is not None else None) or "",
            "created_by": user.user_id,
            "created_at": now,
            "lead_organization_id": lead,
        },
        [{"organization_id": org, "kind": kind} for org, kind in slots],
    )
    repo.update_output(session, output_id, publish_status="PENDING")
    summary = deps.projects.get_summary(project_id)
    outbox.write(
        session,
        EventType.WORKSPACE_PUBLISH_REQUESTED_V1,
        {
            "project_id": str(project_id),
            "actor_id": str(user.user_id),
            "occurred_at": now.isoformat(),
            "request_id": str(row["request_id"]),
            "output_id": str(output_id),
            "output_title": output["title"],
            "project_name": summary.name if summary else "",
            "approver_organization_ids": [str(org) for org, _ in slots],
        },
        EventActor.for_user(user),
    )
    return _view(session, deps, row)


def _slots(deps: WorkspaceDeps, lead: UUID, lineage: Sequence[RowMapping]) -> list[tuple[UUID, str]]:
    """Input owners in lineage order, then the lead organization (the new dataset's owner, D-013) unless it is one."""
    owners: dict[UUID, None] = {}
    for entry in lineage:
        policy = deps.catalog.get_policy_view(entry["dataset_id"])
        if policy is not None:  # a missing dataset already failed the access check
            owners.setdefault(policy.owner_organization_id, None)
    slots = [(org, INPUT_OWNER) for org in owners]
    if lead not in owners:
        slots.append((lead, LEAD_ORGANIZATION))
    return slots


def _lead_organization(deps: WorkspaceDeps, project_id: UUID) -> UUID:
    summary = deps.projects.get_summary(project_id)
    if summary is None:
        raise ApiError(ErrorCode.DEPENDENCY_UNAVAILABLE, "The project could not be read.")
    return summary.lead_organization_id.root


def _sources(output: RowMapping, files: Sequence[RowMapping]) -> list[OutputFileSource]:
    return [
        OutputFileSource(
            path=f["name"],
            size_bytes=int(f["size_bytes"]),
            sha256=f["sha256"],
            media_type=f["media_type"],
            storage_org_code=output["storage_org_code"] or "",
            storage_key=f["object_key"],
        )
        for f in files
    ]


# ---------------------------------------------------------------- decision


def _may_decide(user: CurrentUser, slot: RowMapping) -> bool:
    return user.organization_id == slot["organization_id"] and DATA_STEWARD in user.org_roles


def decide(
    session: Session, deps: WorkspaceDeps, user: CurrentUser, request_id: UUID, body: PublishDecisionIn
) -> PublishRequest:
    row = repo.load_publish_request(session, request_id, for_update=True)
    if row is None:
        raise not_found("Publish request")
    slots = repo.approvals_of(session, [request_id])[request_id]
    slot = next((s for s in slots if _may_decide(user, s)), None)
    if slot is None:
        involved = any(s["organization_id"] == user.organization_id for s in slots)
        if involved or deps.projects.get_member_role(row["project_id"], user.user_id) is not None:
            raise forbidden("Only a DATA_STEWARD of an organization with an approval slot can decide.")
        raise not_found("Publish request")
    if user.user_id == row["created_by"]:  # separation of duties
        raise forbidden("The requester cannot decide their own publish request.")
    decision = body.decision.value
    comment = body.comment if body.comment is not None and body.comment.strip() else None
    if decision == "REJECT" and comment is None:
        raise ApiError(
            ErrorCode.VALIDATION_FAILED,
            "A rejection needs a comment.",
            {"fields": [{"field": "comment", "reason": "REQUIRED"}]},
        )
    if row["status"] != "PENDING" or slot["decision"] is not None:
        raise ApiError(ErrorCode.CONFLICT, "This approval slot or request is already decided.")
    now = clock.now()
    repo.decide_slot(
        session,
        request_id,
        slot["organization_id"],
        decided_by=user.user_id,
        decision=decision,
        comment=comment,
        decided_at=now,
    )
    others_approved = all(s["decision"] == "APPROVE" for s in slots if s is not slot)
    if decision == "REJECT":
        row = repo.update_publish_request(session, request_id, status="REJECTED", decided_at=now)
        repo.update_output(session, row["output_id"], publish_status="REJECTED")
    elif others_approved:
        # the publishing actor: the lead organization's approving steward (its slot is always among the slots)
        lead_slot = next((s for s in slots if s["organization_id"] == row["lead_organization_id"]), slot)
        publisher = user.user_id if lead_slot is slot else lead_slot["decided_by"]
        row = repo.update_publish_request(
            session,
            request_id,
            status="APPROVED",
            decided_at=now,
            approved_by=publisher,
            approved_by_organization_id=lead_slot["organization_id"],
            planned_dataset_id=new_id(),
            publication_status="PENDING",
        )
        repo.update_output(session, row["output_id"], publish_status="APPROVED")
        jobs.enqueue_publication_after_commit(session, request_id)
    outbox.write(
        session,
        EventType.WORKSPACE_PUBLISH_DECIDED_V1,
        {
            "project_id": str(row["project_id"]),
            "actor_id": str(user.user_id),
            "occurred_at": now.isoformat(),
            "request_id": str(request_id),
            "output_id": str(row["output_id"]),
            "output_title": repo.output_titles(session, [row["output_id"]]).get(row["output_id"], ""),
            "organization_id": str(slot["organization_id"]),
            "decision": decision,
            "request_status": row["status"],
            "requested_by": str(row["created_by"]),
            "published_dataset_id": None,
            "failure_reason": None,
        },
        EventActor.for_user(user),
    )
    return _view(session, deps, row)


# ---------------------------------------------------------------- list


def list_requests(
    session: Session,
    deps: WorkspaceDeps,
    user: CurrentUser,
    *,
    role: str,
    statuses: Sequence[str] | None,
    project_id: UUID | None,
    params: PageParams,
) -> Page[PublishRequest]:
    after = sort_key(params)
    project_ids: list[UUID] | None = None
    reviewer: tuple[UUID, list[str]] | None = None
    if role == "reviewer":
        if DATA_STEWARD not in user.org_roles:
            return keyset_page([], params.limit, ("created_at", "request_id"), lambda _: [])
        reviewer = (user.organization_id, [INPUT_OWNER, LEAD_ORGANIZATION])
    else:
        project_ids = deps.projects.list_project_ids_for_member(user.user_id)
    rows = repo.list_publish_requests(
        session,
        project_ids=project_ids,
        reviewer=reviewer,
        statuses=statuses,
        project_id=project_id,
        after=after,
        limit=params.limit + 1,
    )
    return keyset_page(
        rows, params.limit, ("created_at", "request_id"), lambda shown: _views(session, deps, shown)
    )


# ---------------------------------------------------------------- publication (worker)


def claim_publication(request_id: UUID) -> RowMapping | None:
    now = clock.now()
    with jobs.job_session() as session, session.begin():
        return repo.claim_publication(session, request_id, now=now, until=now + LEASE)


def _release(request_id: UUID, **values: Any) -> None:
    with jobs.job_session() as session, session.begin():
        repo.update_publish_request(session, request_id, publication_claimed_until=None, **values)


def publish_approved(request_id: UUID) -> str:
    """One attempt. Returns PUBLISHED / DRAFT / FAILED / RETRY, or SKIPPED (not pending, or leased elsewhere)."""
    try:
        claimed = claim_publication(request_id)
    except (OperationalError, InterfaceError):
        logger.warning("publication claim failed; the sweeper retries", extra={"request_id": str(request_id)})
        return "RETRY"
    if claimed is None:
        return "SKIPPED"
    try:
        state = _create_in_catalog(claimed)
    except CatalogPublishRejected as exc:
        logger.error(
            "catalog refused the publication", extra={"request_id": str(request_id), "reason": str(exc)[:300]}
        )
        _fail(claimed, f"카탈로그가 공개를 거부했습니다: {exc}", None)
        return "FAILED"
    except (StorageUnavailable, ports.PortNotProvided, OperationalError, InterfaceError) as exc:
        return _retry(claimed, type(exc).__name__)
    except ApiError as exc:
        if exc.code != ErrorCode.DEPENDENCY_UNAVAILABLE:
            raise
        return _retry(claimed, type(exc).__name__)
    if state.status == "PUBLISHED":
        _published(claimed, state.dataset_id)
    elif state.status == "FAILED":
        _fail(
            claimed,
            "카탈로그 파일 검증에 실패했습니다(verification failed): 산출물 파일을 확인한 뒤 다시 요청하세요.",
            state.dataset_id,
        )
    else:
        _release(claimed["request_id"], published_dataset_id=state.dataset_id)
    return state.status


def _retry(req: RowMapping, error_type: str) -> str:
    """A retryable outage: release the lease for the sweep, or reject after MAX_FAILURES of them."""
    failures = req["publication_failures"] + 1
    logger.warning(
        "publication deferred",
        extra={"request_id": str(req["request_id"]), "error_type": error_type, "failures": failures},
    )
    if failures >= MAX_FAILURES:
        _fail(
            req,
            f"카탈로그 공개를 {failures}번 시도했지만 저장소·서비스 장애로 실패했습니다(attempts exhausted).",
            None,
        )
        return "FAILED"
    _release(req["request_id"], publication_failures=failures)
    return "RETRY"


def _fail(req: RowMapping, reason: str, dataset_id: UUID | None) -> None:
    """Terminal failure: the request and the output become REJECTED (the output may be requested again; the partial
    unique index no longer holds the output), with the reason as failure_reason and a system decided event. Guarded:
    only while the request is APPROVED with its publication PENDING under this worker's lease, so a worker that
    stalled past its lease cannot reject a request another worker has since published or re-leased."""
    now = clock.now()
    values: dict[str, Any] = {
        "status": "REJECTED",
        "decided_at": now,
        "publication_claimed_until": None,
        "publication_status": "FAILED",
        "publication_error": reason[:500],
    }
    if dataset_id is not None:
        values["published_dataset_id"] = dataset_id
    with jobs.job_session() as session, session.begin():
        row = repo.fail_pending_publication(
            session, req["request_id"], lease_until=req["publication_claimed_until"], **values
        )
        if row is None:  # a stale worker: the request was published, failed or re-leased meanwhile
            logger.warning("stale publication failure ignored", extra={"request_id": str(req["request_id"])})
            return
        repo.update_output(session, row["output_id"], publish_status="REJECTED")
        outbox.write(
            session,
            EventType.WORKSPACE_PUBLISH_DECIDED_V1,
            {
                "project_id": str(row["project_id"]),
                "actor_id": str(row["approved_by"]),  # the publishing actor; the envelope actor is SYSTEM
                "occurred_at": now.isoformat(),
                "request_id": str(row["request_id"]),
                "output_id": str(row["output_id"]),
                "output_title": repo.output_titles(session, [row["output_id"]]).get(row["output_id"], ""),
                "organization_id": str(row["lead_organization_id"]),
                "decision": "REJECT",
                "request_status": "REJECTED",
                "requested_by": str(row["created_by"]),
                "published_dataset_id": str(dataset_id) if dataset_id is not None else None,
                "failure_reason": row["publication_error"],
            },
            EventActor.system(),
        )


def _create_in_catalog(req: RowMapping) -> OutputDatasetState:
    deps = ports.get(WorkspaceDeps)
    output_id = req["output_id"]
    with jobs.job_session() as session:
        output = repo.load_output(session, req["project_id"], output_id)
        files = repo.files_of(session, [output_id])[output_id]
        lineage = repo.lineage_of(session, [output_id])[output_id]
    if output is None:  # outputs are never deleted
        raise CatalogPublishRejected("the output no longer exists")
    dataset_ids = [i["dataset_id"] for i in lineage]
    level = max(output["access_level"], current_floor(deps, dataset_ids), key=STRICTNESS.index)
    return deps.publisher.create_dataset_from_output(
        dataset_id=req["planned_dataset_id"],
        owner_organization_id=_lead_organization(deps, req["project_id"]),
        title=req["title"],
        description=req["description"],
        access_level=level,
        allowed_purposes=_purposes(deps, dataset_ids),
        files=_sources(output, files),
        lineage_note=_lineage_note(output, lineage, req),
        created_by=req["created_by"],
        published_by=req["approved_by"],
        publisher_organization_id=req["approved_by_organization_id"],
    )


def _purposes(deps: WorkspaceDeps, dataset_ids: Sequence[UUID]) -> list[str]:
    """Purposes every input allows (catalog order of the first); ACADEMIC_RESEARCH when none remain or no inputs."""
    common: list[str] | None = None
    for dataset_id in dataset_ids:
        policy = deps.catalog.get_policy_view(dataset_id)
        allowed = list(policy.allowed_purposes) if policy is not None else []
        common = allowed if common is None else [p for p in common if p in allowed]
    return common or [DEFAULT_PURPOSE]


def _lineage_note(output: RowMapping, lineage: Sequence[RowMapping], req: RowMapping) -> str:
    """Entity labels and ids only (dataset titles @ version labels, recipe @ version, run) — never data values."""
    lines = [
        f"NAIS 프로젝트 산출물(output {output['output_id']})에서 소유 기관 검토를 거쳐 공개된 파생 데이터셋."
    ]
    if lineage:
        lines.append("원본 데이터셋:")
        lines += [
            f"- {i['dataset_title']}@{i['version_label']}"
            f" (dataset {i['dataset_id']}, version {i['dataset_version_id']})"
            for i in lineage
        ]
    else:
        lines.append("원본 데이터셋: 없음 (업로드 산출물)")
    if output["recipe_id"] is not None:
        lines.append(
            f"레시피 {output['recipe_id']} v{output['recipe_version']}, 실행 {output['produced_by_run_id']}"
        )
    lines.append(
        f"공개 승인: 주관 기관(organization {req['approved_by_organization_id']}) 데이터 관리자"
        f" {req['approved_by']} 및 입력 소유 기관 검토 (publish request {req['request_id']})."
    )
    return "\n".join(lines)[:MAX_NOTE]


def _published(req: RowMapping, dataset_id: UUID) -> None:
    now = clock.now()
    with jobs.job_session() as session, session.begin():
        repo.update_publish_request(
            session,
            req["request_id"],
            publication_claimed_until=None,
            published_dataset_id=dataset_id,
            publication_status="PUBLISHED",
            publication_error=None,
        )
        repo.update_output(session, req["output_id"], publish_status="PUBLISHED")
        repo.record_activity(
            session,
            activity_id=new_id(),
            dataset_id=dataset_id,
            type="OUTPUT_PUBLISHED",
            label=None,
            ref_id=req["output_id"],
            actor_id=req["approved_by"],
            project_id=req["project_id"],
            occurred_at=now,
            source_event_id=req["request_id"],  # one row per request (unique, idempotent)
        )
