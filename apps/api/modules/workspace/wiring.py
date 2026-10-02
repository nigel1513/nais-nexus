"""ModuleSpec.wire(): build the default WorkspaceDeps and register the workspace's ports."""

from api.modules.workspace.adapters.grants import NoGrants
from api.modules.workspace.adapters.identity import IdentityDisplayNames
from api.modules.workspace.deps import WorkspaceDeps
from api.modules.workspace.public import WorkspaceQueryPort
from api.modules.workspace.public_impl import SqlWorkspaceQuery
from api.modules.workspace.settings import WorkspaceSettings, get_workspace_settings
from api.platform import ports


def build_default_deps(settings: WorkspaceSettings | None = None) -> WorkspaceDeps:
    return WorkspaceDeps(
        settings=settings or get_workspace_settings(),
        grants=NoGrants(),  # TODO(M04): adapter over governance's public grant port
        people=IdentityDisplayNames(),
    )


def install(deps: WorkspaceDeps) -> None:
    ports.provide(WorkspaceDeps, deps)
    ports.provide(WorkspaceQueryPort, SqlWorkspaceQuery())


def wire() -> None:
    install(build_default_deps())
