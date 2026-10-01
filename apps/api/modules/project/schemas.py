"""Request bodies (openapi ProjectCreate, ProjectUpdate, member add/role bodies). Responses are built in views.py."""

from datetime import date
from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, field_validator, model_validator

RoleName = Literal["PROJECT_OWNER", "PROJECT_ADMIN", "RESEARCHER", "VIEWER"]
Visibility = Literal["PRIVATE", "PUBLIC"]
ProjectName = Annotated[str, StringConstraints(strip_whitespace=True, min_length=2, max_length=200)]
Description = Annotated[str, StringConstraints(max_length=10000)]
Keyword = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=50)]
Keywords = Annotated[list[Keyword], Field(max_length=20)]

_NOT_NULLABLE = ("name", "description", "visibility", "keywords")


class ProjectCreateIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: ProjectName
    description: Description
    visibility: Visibility = "PRIVATE"
    keywords: Keywords = Field(default_factory=list)
    start_date: date | None = None
    end_date: date | None = None


class ProjectUpdateIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: ProjectName | None = None
    description: Description | None = None
    visibility: Visibility | None = None
    keywords: Keywords | None = None
    start_date: date | None = None  # explicit null clears the date
    end_date: date | None = None

    @field_validator(*_NOT_NULLABLE, mode="before")
    @classmethod
    def _not_null(cls, value: object) -> object:
        if value is None:
            raise ValueError("must not be null")
        return value

    @model_validator(mode="after")
    def _at_least_one_field(self) -> "ProjectUpdateIn":
        if not self.model_fields_set:
            raise ValueError("at least one field is required")
        return self


class MemberAddIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    user_id: UUID
    role: RoleName


class MemberRoleIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    role: RoleName
