"""Default PreviewGrantLookup until M04 (Wave 2) provides ACTIVE grants (controller ruling P6: mirror NoGrants)."""

from uuid import UUID


class NoGrants:
    def has_active_grant(self, user_id: UUID, dataset_id: UUID) -> bool:
        return False
