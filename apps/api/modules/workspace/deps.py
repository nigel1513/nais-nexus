"""Everything the workspace talks to, in one container registered in api.platform.ports by wiring.install()."""

from dataclasses import dataclass
from typing import Annotated

from fastapi import Depends

from api.modules.catalog.public import CatalogQueryPort
from api.modules.project.public import ProjectQueryPort
from api.modules.workspace.interfaces import DisplayNameLookup, GrantQueryPort, OutputStorage
from api.modules.workspace.settings import WorkspaceSettings
from api.platform import ports
from api.platform.errors import ApiError
from api.platform.generated.error_codes import ErrorCode


def _provider[T](port: type[T], module: str) -> T:
    try:
        return ports.get(port)
    except ports.PortNotProvided as exc:
        raise ApiError(ErrorCode.DEPENDENCY_UNAVAILABLE, f"{module} module is not wired.") from exc


@dataclass(frozen=True)
class WorkspaceDeps:
    settings: WorkspaceSettings
    grants: GrantQueryPort
    people: DisplayNameLookup
    storage: OutputStorage

    @property
    def projects(self) -> ProjectQueryPort:
        """M02 port, resolved per call (module wiring order does not matter); unwired -> 503."""
        return _provider(ProjectQueryPort, "Project")

    @property
    def catalog(self) -> CatalogQueryPort:
        """M03 port, resolved per call; unwired -> 503."""
        return _provider(CatalogQueryPort, "Catalog")


def get_deps() -> WorkspaceDeps:
    try:
        return ports.get(WorkspaceDeps)
    except ports.PortNotProvided as exc:
        raise ApiError(ErrorCode.DEPENDENCY_UNAVAILABLE, "Workspace module is not wired.") from exc


WorkspaceDepsDep = Annotated[WorkspaceDeps, Depends(get_deps)]
