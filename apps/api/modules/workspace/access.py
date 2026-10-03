"""Who may read and change a project's workspace (openapi M13 descriptions).

Read: an ACTIVE member of the project in any project status (else 404, the project is not revealed).
Write: an ACTIVE member other than VIEWER (else 403 FORBIDDEN) of an ACTIVE project (else 409 PROJECT_ARCHIVED).
Dataset use: PUBLIC, the caller's own organization's dataset, or an ACTIVE grant (GrantQueryPort).
"""

from uuid import UUID

from api.modules.catalog.public import DatasetPolicyView
from api.modules.workspace.deps import WorkspaceDeps
from api.modules.workspace.errors import forbidden, not_found
from api.platform.auth import CurrentUser
from api.platform.errors import ApiError
from api.platform.generated.error_codes import ErrorCode

VIEWER = "VIEWER"
STRICTNESS: tuple[str, ...] = ("PUBLIC", "INTERNAL", "CONTROLLED", "SENSITIVE")  # loosest -> strictest


def require_reader(deps: WorkspaceDeps, project_id: UUID, user: CurrentUser) -> None:
    if deps.projects.get_member_role(project_id, user.user_id) is None:
        raise not_found("Project")


def require_writer(deps: WorkspaceDeps, project_id: UUID, user: CurrentUser) -> None:
    projects = deps.projects
    role = projects.get_member_role(project_id, user.user_id)
    if role is None or role == VIEWER:
        raise forbidden("Only project members other than VIEWER can change the workspace.")
    if not projects.is_active_member(project_id, user.user_id):  # member, so the project is ARCHIVED
        raise ApiError(ErrorCode.PROJECT_ARCHIVED, "The project is archived.")


def require_open_writer(deps: WorkspaceDeps, project_id: UUID, user: CurrentUser) -> None:
    """require_writer for operations whose contract lists no 409: an ARCHIVED project is 403 FORBIDDEN."""
    projects = deps.projects
    role = projects.get_member_role(project_id, user.user_id)
    if role is None or role == VIEWER:
        raise forbidden("Only project members other than VIEWER can change the workspace.")
    if not projects.is_active_member(project_id, user.user_id):
        raise forbidden("The project is archived; its workspace is read-only.")


def has_dataset_access(deps: WorkspaceDeps, user: CurrentUser, policy: DatasetPolicyView) -> bool:
    """Same rule as the catalog preview gate (catalog.service.previews.can_preview) minus the platform-admin
    bypass: an operator account is not a researcher pinning data."""
    return dataset_access(deps, user.user_id, user.organization_id, policy)


def dataset_access(
    deps: WorkspaceDeps, user_id: UUID, organization_id: UUID, policy: DatasetPolicyView
) -> bool:
    """has_dataset_access without a request (the run worker re-checks the run's starter)."""
    return (
        policy.access_level == "PUBLIC"
        or organization_id == policy.owner_organization_id
        or deps.grants.has_active_grant(user_id, policy.dataset_id)
    )


def accessible(deps: WorkspaceDeps, user: CurrentUser, dataset_id: UUID) -> bool:
    """The user's access to the dataset is live (a dataset missing from the catalog is not accessible)."""
    policy = deps.catalog.get_policy_view(dataset_id)
    return policy is not None and has_dataset_access(deps, user, policy)


def require_not_looser(requested: str, floor: str) -> None:
    """422 VALIDATION_FAILED when the access level `requested` is looser than `floor` (details.minimum)."""
    if STRICTNESS.index(requested) < STRICTNESS.index(floor):
        raise ApiError(
            ErrorCode.VALIDATION_FAILED,
            f"access_level may not be looser than {floor}, the strictest level of the project's inputs.",
            {"field": "access_level", "minimum": floor},
        )
