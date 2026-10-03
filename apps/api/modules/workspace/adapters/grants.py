"""Default GrantQueryPort until M04 governance provides ACTIVE grants (mirrors catalog.adapters.grants.NoGrants)."""

from uuid import UUID


class NoGrants:
    """Fail closed: nobody holds a grant. Replaced by an M04 adapter in wiring.build_default_deps()."""

    def has_active_grant(self, user_id: UUID, dataset_id: UUID) -> bool:
        return False
