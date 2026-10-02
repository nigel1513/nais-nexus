"""DisplayNameLookup over M01's public IdentityQueryPort (api.modules.identity.public)."""

from collections.abc import Sequence
from uuid import UUID

from api.modules.identity.public import IdentityQueryPort
from api.platform import ports
from api.platform.errors import ApiError
from api.platform.generated.error_codes import ErrorCode


class IdentityDisplayNames:
    """Looks the identity port up per call (wiring order does not matter); unwired -> 503 (fail closed)."""

    def get_display_names(self, user_ids: Sequence[UUID]) -> dict[UUID, str]:
        if not user_ids:
            return {}
        try:
            identity = ports.get(IdentityQueryPort)
        except ports.PortNotProvided as exc:
            raise ApiError(ErrorCode.DEPENDENCY_UNAVAILABLE, "Identity module is not wired.") from exc
        profiles = identity.get_public_profiles(list(dict.fromkeys(user_ids)))
        return {user_id: profile.display_name for user_id, profile in profiles.items()}
