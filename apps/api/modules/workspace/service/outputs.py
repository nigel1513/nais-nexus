"""Project outputs (spec §5.4; openapi listOutputs/createOutputUpload/completeOutputUpload/getOutput/getOutputDownload).

FILE outputs are uploaded in two steps. createOutputUpload records an upload session (status UPLOADING) with the
declared files and a lineage snapshot of the project's live inputs, and presigns one PUT per file (15 min) into the
project lead organization's bucket under workspace/{project_id}/outputs/{output_id}/. completeOutputUpload (the
uploader, before the session expires) re-checks every object's size (HEAD) and sha256 (streamed server-side) and
turns the session into a READY output, emitting workspace.output.created.v1. Readers never see sessions.

Access level: never looser than the strictest lineage input (PUBLIC < INTERNAL < CONTROLLED < SENSITIVE); with no
inputs the floor is INTERNAL (an upload without lineage is not public by default).
Download: an ACTIVE member (any role, any project status) whose access to every lineage input is still live
(else 409 INPUT_ACCESS_LAPSED with details.input_ids); presigned GETs live 300 s.
"""

import logging
from collections.abc import Sequence
from datetime import timedelta
from typing import Any
from uuid import UUID

from sqlalchemy.engine import RowMapping
from sqlalchemy.orm import Session

from api.modules.workspace import repo
from api.modules.workspace.access import has_dataset_access, require_open_writer, require_reader
from api.modules.workspace.deps import WorkspaceDeps
from api.modules.workspace.errors import forbidden, not_found
from api.modules.workspace.paging import keyset_page, sort_key
from api.modules.workspace.schemas import Output, OutputDownload, OutputUploadIn, OutputUploadSession
from api.platform import clock
from api.platform.auth import CurrentUser
from api.platform.errors import ApiError
from api.platform.events import EventActor
from api.platform.generated.error_codes import ErrorCode
from api.platform.generated.event_types import EventType
from api.platform.ids import new_id
from api.platform.outbox import outbox
from api.platform.pagination import Page, PageParams

logger = logging.getLogger("nais.workspace")

STRICTNESS: tuple[str, ...] = ("PUBLIC", "INTERNAL", "CONTROLLED", "SENSITIVE")  # loosest -> strictest
NO_INPUTS_FLOOR = "INTERNAL"
UPLOAD_TTL_S = 15 * 60
DOWNLOAD_TTL_S = 300
FILE = "FILE"
UPLOADING = "UPLOADING"


def object_key(project_id: UUID, output_id: UUID, name: str) -> str:
    return f"workspace/{project_id}/outputs/{output_id}/{name}"


# ---------------------------------------------------------------- reads


def list_outputs(
    session: Session,
    deps: WorkspaceDeps,
    user: CurrentUser,
    project_id: UUID,
    *,
    kind: str | None,
    params: PageParams,
) -> Page[Output]:
    after = sort_key(params)
    require_reader(deps, project_id, user)
    rows = repo.list_ready_outputs(session, project_id, kind=kind, after=after, limit=params.limit + 1)
    return keyset_page(rows, params.limit, ("created_at", "output_id"), lambda shown: _views(session, shown))


def get_output(
    session: Session, deps: WorkspaceDeps, user: CurrentUser, project_id: UUID, output_id: UUID
) -> Output:
    require_reader(deps, project_id, user)
    return _view(session, _ready(session, project_id, output_id))


def _ready(session: Session, project_id: UUID, output_id: UUID) -> RowMapping:
    row = repo.load_output(session, project_id, output_id)
    if row is None or row["status"] != repo.READY:
        raise not_found("Output")
    return row


def _views(session: Session, rows: Sequence[RowMapping]) -> list[Output]:
    ids = [r["output_id"] for r in rows]
    files = repo.files_of(session, ids)
    lineage = repo.lineage_of(session, ids)
    return [
        Output.model_validate(
            {
                "output_id": r["output_id"],
                "project_id": r["project_id"],
                "kind": r["kind"],
                "title": r["title"],
                "access_level": r["access_level"],
                "files": [
                    {k: f[k] for k in ("name", "size_bytes", "sha256", "media_type")}
                    for f in files[r["output_id"]]
                ],
                "produced_by_run_id": r["produced_by_run_id"],
                "lineage": {
                    "inputs": [
                        {
                            k: i[k]
                            for k in ("dataset_id", "dataset_title", "dataset_version_id", "version_label")
                        }
                        for i in lineage[r["output_id"]]
                    ],
                    "recipe_id": r["recipe_id"],
                    "recipe_version": r["recipe_version"],
                    "run_id": r["produced_by_run_id"],
                },
                "publish_status": r["publish_status"],
                "created_by": r["created_by"],
                "created_at": r["created_at"],
            }
        )
        for r in rows
    ]


def _view(session: Session, row: RowMapping) -> Output:
    [view] = _views(session, [row])
    return view


# ---------------------------------------------------------------- upload session


def create_upload(
    session: Session, deps: WorkspaceDeps, user: CurrentUser, project_id: UUID, body: OutputUploadIn
) -> OutputUploadSession:
    require_open_writer(deps, project_id, user)
    lineage, floor = _lineage_snapshot(session, deps, project_id)
    requested = body.access_level.value
    if STRICTNESS.index(requested) < STRICTNESS.index(floor):
        raise ApiError(
            ErrorCode.VALIDATION_FAILED,
            f"access_level may not be looser than {floor}, the strictest level of the project's inputs.",
            {"field": "access_level", "minimum": floor},
        )
    org_code = _lead_org_code(deps, project_id)
    output_id = new_id()
    now = clock.now()
    expires_at = now + timedelta(seconds=UPLOAD_TTL_S)
    declared = [
        {
            "name": f.name,
            "size_bytes": f.size_bytes,
            "sha256": f.sha256,
            "media_type": f.media_type,
            "object_key": object_key(project_id, output_id, f.name),
        }
        for f in body.files
    ]
    repo.insert_output(
        session,
        {
            "output_id": output_id,
            "project_id": project_id,
            "kind": FILE,
            "title": body.title,
            "access_level": requested,
            "status": UPLOADING,
            "storage_org_code": org_code,
            "created_by": user.user_id,
            "started_at": now,
            "upload_expires_at": expires_at,
        },
        declared,
        lineage,
    )
    uploads = []
    for f in body.files:
        key = object_key(project_id, output_id, f.name)
        url, headers = deps.storage.presign_put(org_code, key, f.media_type, f.sha256, UPLOAD_TTL_S)
        uploads.append({"name": f.name, "upload": {"method": "PUT", "url": url, "headers": headers}})
    return OutputUploadSession.model_validate(
        {"output_id": output_id, "expires_at": expires_at, "files": uploads}
    )


def _lineage_snapshot(
    session: Session, deps: WorkspaceDeps, project_id: UUID
) -> tuple[list[dict[str, Any]], str]:
    """The project's live inputs as lineage rows, and the strictest of their current access levels."""
    catalog = deps.catalog
    lineage: list[dict[str, Any]] = []
    floor = NO_INPUTS_FLOOR if not (rows := repo.live_inputs(session, project_id)) else STRICTNESS[0]
    for row in rows:
        policy = catalog.get_policy_view(row["dataset_id"])
        version = catalog.get_version(row["dataset_version_id"])
        if policy is None or version is None:  # catalog never deletes datasets or published versions
            logger.error(
                "pinned input references a missing dataset/version", extra={"input_id": row["input_id"]}
            )
            floor = STRICTNESS[-1]  # fail closed
            title, label = "", ""
        else:
            floor = max(floor, policy.access_level, key=STRICTNESS.index)
            title, label = policy.title, version.version_label
        lineage.append(
            {
                "input_id": row["input_id"],
                "dataset_id": row["dataset_id"],
                "dataset_version_id": row["dataset_version_id"],
                "dataset_title": title,
                "version_label": label,
            }
        )
    return lineage, floor


def _lead_org_code(deps: WorkspaceDeps, project_id: UUID) -> str:
    summary = deps.projects.get_summary(project_id)
    code = deps.people.get_organization_code(summary.lead_organization_id.root) if summary else None
    if code is None:
        raise ApiError(ErrorCode.DEPENDENCY_UNAVAILABLE, "The project's lead organization has no storage.")
    return code


# ---------------------------------------------------------------- completion


def complete_upload(
    session: Session, deps: WorkspaceDeps, user: CurrentUser, project_id: UUID, output_id: UUID
) -> Output:
    require_reader(deps, project_id, user)
    row = repo.load_output(session, project_id, output_id, for_update=True)
    if row is None:
        raise not_found("Output")
    if row["created_by"] != user.user_id:
        raise forbidden("Only the uploader can complete this upload.")
    if row["status"] == repo.READY:  # repeated completion: the same output, no second event
        return _view(session, row)
    require_open_writer(deps, project_id, user)
    now = clock.now()
    if now > row["upload_expires_at"]:
        raise ApiError(ErrorCode.UPLOAD_SESSION_EXPIRED, "The upload session expired; start a new upload.")
    _verify(deps, row["storage_org_code"], repo.files_of(session, [output_id])[output_id])
    row = repo.update_output(session, output_id, status=repo.READY, created_at=now)
    lineage = repo.lineage_of(session, [output_id])[output_id]
    outbox.write(
        session,
        EventType.WORKSPACE_OUTPUT_CREATED_V1,
        {
            "project_id": str(project_id),
            "actor_id": str(user.user_id),
            "occurred_at": now.isoformat(),
            "output_id": str(output_id),
            "output_title": row["title"],
            "kind": row["kind"],
            "access_level": row["access_level"],
            "run_id": str(row["produced_by_run_id"]) if row["produced_by_run_id"] else None,
            "lineage_dataset_version_ids": [str(i["dataset_version_id"]) for i in lineage],
        },
        EventActor.for_user(user),
    )
    return _view(session, row)


def _verify(deps: WorkspaceDeps, org_code: str, files: Sequence[RowMapping]) -> None:
    """Every declared file is stored with the declared size and sha256 (size first: HEAD is cheap)."""
    problems: list[dict[str, str]] = []
    for f in files:
        size = deps.storage.head(org_code, f["object_key"])
        if size is None:
            problems.append({"name": f["name"], "reason": "MISSING"})
        elif size != f["size_bytes"]:
            problems.append({"name": f["name"], "reason": "SIZE_MISMATCH"})
        elif deps.storage.sha256(org_code, f["object_key"]) != f["sha256"]:
            problems.append({"name": f["name"], "reason": "SHA256_MISMATCH"})
    if problems:
        raise ApiError(
            ErrorCode.UPLOAD_CHECKSUM_MISMATCH,
            "Stored files do not match the declared size or sha256; upload them again.",
            {"files": problems},
        )


# ---------------------------------------------------------------- download


def download(
    session: Session, deps: WorkspaceDeps, user: CurrentUser, project_id: UUID, output_id: UUID
) -> OutputDownload:
    if deps.projects.get_member_role(project_id, user.user_id) is None:
        raise forbidden("Only project members can download outputs.")
    row = _ready(session, project_id, output_id)
    lapsed = [
        str(i["input_id"])
        for i in repo.lineage_of(session, [output_id])[output_id]
        if not _accessible(deps, user, i["dataset_id"])
    ]
    if lapsed:
        raise ApiError(
            ErrorCode.INPUT_ACCESS_LAPSED,
            "Access to an input this output derives from was revoked or expired.",
            {"input_ids": lapsed},
        )
    expires_at = clock.now() + timedelta(seconds=DOWNLOAD_TTL_S)
    files = [
        {
            "name": f["name"],
            "url": deps.storage.presign_get(
                row["storage_org_code"], f["object_key"], f["name"], DOWNLOAD_TTL_S
            ),
            "size_bytes": f["size_bytes"],
            "sha256": f["sha256"],
        }
        for f in repo.files_of(session, [output_id])[output_id]
    ]
    return OutputDownload.model_validate({"output_id": output_id, "expires_at": expires_at, "files": files})


def _accessible(deps: WorkspaceDeps, user: CurrentUser, dataset_id: UUID) -> bool:
    policy = deps.catalog.get_policy_view(dataset_id)
    return policy is not None and has_dataset_access(deps, user, policy)
