"""Request/response bodies. Responses reuse the generated contract models (nais_contracts.api_models); request
bodies mirror ProjectInputCreate/ProjectInputUpdate with plain UUIDs and the two rules the generated models
cannot express: explicit null only where the contract type is nullable, and ProjectInputUpdate minProperties: 1."""

from typing import Annotated, Any, ClassVar
from uuid import UUID

from nais_contracts.api_models import ProjectInput
from pydantic import BaseModel, ConfigDict, StringConstraints, model_validator

Note = Annotated[str, StringConstraints(max_length=2000)]


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


class InputCreateIn(StrictIn):
    """openapi ProjectInputCreate."""

    dataset_id: UUID
    dataset_version_id: UUID | None = None  # omitted -> latest PUBLISHED version
    note: Note | None = None


class InputUpdateIn(StrictIn):
    """openapi ProjectInputUpdate (minProperties: 1; note null clears it)."""

    NULLABLE: ClassVar[frozenset[str]] = frozenset({"note"})

    dataset_version_id: UUID | None = None
    note: Note | None = None

    @model_validator(mode="after")
    def _not_empty(self) -> "InputUpdateIn":
        if not self.model_fields_set:
            raise ValueError("at least one property is required")
        return self


class ProjectInputList(BaseModel):
    items: list[ProjectInput]


__all__ = ["InputCreateIn", "InputUpdateIn", "ProjectInput", "ProjectInputList"]
