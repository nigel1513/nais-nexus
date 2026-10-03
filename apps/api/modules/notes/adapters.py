"""DisplayNameLookup over M01's public IdentityQueryPort (api.modules.identity.public) and the default (empty)
NotebookActivityPort."""

from collections.abc import Sequence
from datetime import date
from uuid import UUID

from api.modules.identity.public import IdentityPublicProfile, IdentityQueryPort
from api.modules.notes.interfaces import NotebookActivity
from api.platform import ports
from api.platform.errors import ApiError
from api.platform.generated.error_codes import ErrorCode


class IdentityDisplayNames:
    """Looks the identity port up per call (wiring order does not matter); unwired -> 503 (fail closed)."""

    @staticmethod
    def _identity() -> IdentityQueryPort:
        try:
            return ports.get(IdentityQueryPort)
        except ports.PortNotProvided as exc:
            raise ApiError(ErrorCode.DEPENDENCY_UNAVAILABLE, "Identity module is not wired.") from exc

    def _profiles(self, user_ids: Sequence[UUID]) -> dict[UUID, IdentityPublicProfile]:
        return self._identity().get_public_profiles(list(dict.fromkeys(user_ids)))

    def get_display_names(self, user_ids: Sequence[UUID]) -> dict[UUID, str]:
        if not user_ids:
            return {}
        return {user_id: p.display_name for user_id, p in self._profiles(user_ids).items()}

    def get_organization_ids(self, user_ids: Sequence[UUID]) -> dict[UUID, UUID]:
        if not user_ids:
            return {}
        return {user_id: p.organization_id for user_id, p in self._profiles(user_ids).items()}

    def get_organization_names(self, organization_ids: Sequence[UUID]) -> dict[UUID, str]:
        if not organization_ids:
            return {}
        identity = self._identity()
        names: dict[UUID, str] = {}
        for organization_id in dict.fromkeys(organization_ids):
            summary = identity.get_organization_summary(organization_id)
            if summary is not None:
                names[organization_id] = summary.name
        return names


class NoNotebooks:
    """NotebookActivityPort until M07 (Jupyter) provides the real one: nobody saved any notebook."""

    def list_notebook_activity(
        self, user_id: UUID, project_id: UUID | None, day: date
    ) -> list[NotebookActivity]:
        return []

    def list_notebook_authors(self, day: date) -> list[tuple[UUID, UUID]]:
        return []
