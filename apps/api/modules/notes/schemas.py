"""Request/response bodies. Responses reuse the generated contract models (nais_contracts.api_models); request bodies
mirror the contract request schemas with plain UUIDs plus what the generated models cannot express: no explicit nulls,
minProperties: 1, unique ids, and text PostgreSQL can store (no NUL characters)."""

from typing import Annotated, Any, ClassVar
from uuid import UUID

from nais_contracts.api_models import (
    NoteSearchHit,
    NoteSection,
    NoteSettings,
    NoteStatus,
    NoteVerification,
    ResearchNote,
    ResearchNoteSummary,
)
from pydantic import AfterValidator, BaseModel, ConfigDict, Field, StringConstraints, model_validator


def no_nul(value: str) -> str:
    if "\x00" in value:
        raise ValueError("must not contain NUL characters")
    return value


def not_blank(value: str) -> str:
    if not value.strip():
        raise ValueError("must not be blank")
    return value


def _unique[T](values: list[T]) -> list[T]:
    if len(set(values)) != len(values):
        raise ValueError("items must be unique")
    return values


BlockText = Annotated[str, StringConstraints(min_length=1, max_length=4000), AfterValidator(no_nul)]
Reason = Annotated[
    str, StringConstraints(min_length=1, max_length=2000), AfterValidator(no_nul), AfterValidator(not_blank)
]
WitnessIds = Annotated[list[UUID], Field(max_length=20), AfterValidator(_unique)]


class StrictIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    NULLABLE: ClassVar[frozenset[str]] = frozenset()

    @model_validator(mode="before")
    @classmethod
    def _no_nulls(cls, data: Any) -> Any:
        if isinstance(data, dict):
            nulls = sorted(k for k, v in data.items() if v is None and k not in cls.NULLABLE)
            if nulls:
                raise ValueError(f"must not be null: {', '.join(nulls)}")
        return data


class NoteBlockIn(StrictIn):
    """openapi NoteBlockWrite: origin and evidence are server-owned (extra fields are refused)."""

    block_id: UUID | None = None
    section: NoteSection
    text: BlockText
    accepted: bool | None = None


class NoteBlocksIn(StrictIn):
    """openapi NoteBlocksPut."""

    blocks: Annotated[list[NoteBlockIn], Field(max_length=500)]

    @model_validator(mode="after")
    def _unique_ids(self) -> "NoteBlocksIn":
        ids = [b.block_id for b in self.blocks if b.block_id is not None]
        if len(set(ids)) != len(ids):
            raise ValueError("block_id must be unique")
        return self


class RejectIn(StrictIn):
    reason: Reason


class NoteSettingsIn(StrictIn):
    """openapi NoteSettingsUpdate (minProperties: 1)."""

    witness_required: bool | None = None
    witness_user_ids: WitnessIds | None = None

    @model_validator(mode="after")
    def _not_empty(self) -> "NoteSettingsIn":
        if not self.model_fields_set:
            raise ValueError("at least one property is required")
        return self


__all__ = [
    "NoteBlockIn",
    "NoteBlocksIn",
    "NoteSettings",
    "NoteSettingsIn",
    "NoteStatus",
    "NoteVerification",
    "RejectIn",
    "ResearchNote",
    "ResearchNoteSummary",
]


class NoteSearchResult(BaseModel):
    """searchNotes 200 (openapi inline object): hits, best first."""

    items: list[NoteSearchHit] = Field(max_length=20)
