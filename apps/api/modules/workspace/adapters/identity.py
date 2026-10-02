"""DisplayNameLookup over M01's public IdentityQueryPort (api.modules.identity.public)."""

from collections.abc import Sequence
from uuid import UUID

from api.modules.identity.public import IdentityQueryPort
from api.platform import ports
from api.platform.errors import ApiError
from api.platform.generated.error_codes import ErrorCode


def _identity() -> IdentityQueryPort:
    try:
        return ports.get(IdentityQueryPort)
    except ports.PortNotProvided as exc:
        raise ApiError(ErrorCode.DEPENDENCY_UNAVAILABLE, "Identity module is not wired.") from exc


class IdentityDisplayNames:
    """Looks the identity port up per call (wiring order does not matter); unwired -> 503 (fail closed)."""

    def get_display_names(self, user_ids: Sequence[UUID]) -> dict[UUID, str]:
        if not user_ids:
            return {}
        profiles = _identity().get_public_profiles(list(dict.fromkeys(user_ids)))
        return {user_id: profile.display_name for user_id, profile in profiles.items()}

    def get_organization_names(self, organization_ids: Sequence[UUID]) -> dict[UUID, str]:
        """One lookup per distinct organization (a handful per page: project lead organizations)."""
        if not organization_ids:
            return {}
        identity = _identity()
        names: dict[UUID, str] = {}
        for organization_id in dict.fromkeys(organization_ids):
            summary = identity.get_organization_summary(organization_id)
            if summary is not None:
                names[organization_id] = summary.name
        return names
