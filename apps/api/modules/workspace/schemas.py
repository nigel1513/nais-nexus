"""Request/response bodies. Responses reuse the generated contract models (nais_contracts.api_models); request
bodies mirror the contract request schemas with plain UUIDs and the rules the generated models cannot express: explicit
null only where the contract type is nullable, minProperties: 1, and text PostgreSQL can store (no NUL characters;
titles and bodies not blank)."""

from typing import Annotated, Any, ClassVar
from uuid import UUID

from nais_contracts.api_models import (
    AccessLevel,
    Comment,
    DatasetActivity,
    DatasetProjectsResult,
    HubOverview,
    Output,
    OutputDownload,
    OutputKind,
    OutputUploadSession,
    ProjectInput,
    PublishDecision,
    PublishRequest,
    PublishRequestStatus,
    Recipe,
    RecipePreview,
    Run,
    RunStatus,
    Thread,
    ThreadScope,
)
from pydantic import AfterValidator, BaseModel, ConfigDict, Field, StringConstraints, model_validator

from api.modules.workspace.recipes.model import Step


def _no_nul(value: str) -> str:
    if "\x00" in value:
        raise ValueError("must not contain NUL characters")
    return value


def _not_blank(value: str) -> str:
    if not value.strip():
        raise ValueError("must not be blank")
    return value


def _not_only_dots(value: str) -> str:
    if set(value) == {"."}:
        raise ValueError("must not consist of dots only")
    return value


Note = Annotated[str, StringConstraints(max_length=2000), AfterValidator(_no_nul)]
Title = Annotated[
    str, StringConstraints(min_length=1, max_length=200), AfterValidator(_no_nul), AfterValidator(_not_blank)
]
Markdown = Annotated[
    str,
    StringConstraints(min_length=1, max_length=10_000),
    AfterValidator(_no_nul),
    AfterValidator(_not_blank),
]
OutputTitle = Annotated[
    str, StringConstraints(min_length=1, max_length=300), AfterValidator(_no_nul), AfterValidator(_not_blank)
]
MAX_FILE_BYTES = 5 * 1024**3  # single presigned PUT


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


class ThreadCreateIn(StrictIn):
    """openapi ThreadCreate (body: Markdown, at most 10,000 characters)."""

    scope: ThreadScope
    target_id: UUID
    title: Title
    body: Markdown


class ThreadUpdateIn(StrictIn):
    """openapi ThreadUpdate (minProperties: 1)."""

    resolved: bool | None = None
    title: Title | None = None

    @model_validator(mode="after")
    def _not_empty(self) -> "ThreadUpdateIn":
        if not self.model_fields_set:
            raise ValueError("at least one property is required")
        return self


class CommentCreateIn(StrictIn):
    """openapi CommentCreate."""

    body: Markdown


class OutputFileIn(StrictIn):
    """One file of openapi OutputUploadCreate. media_type is additionally bounded (it becomes a signed header)."""

    name: Annotated[
        str, StringConstraints(pattern=r"^[A-Za-z0-9._-]{1,255}$"), AfterValidator(_not_only_dots)
    ]
    size_bytes: Annotated[int, Field(ge=1, le=MAX_FILE_BYTES, strict=True)]
    sha256: Annotated[str, StringConstraints(pattern=r"^[a-f0-9]{64}$")]
    media_type: Annotated[str, StringConstraints(pattern=r"^[\x20-\x7e]{1,255}$")]


class OutputUploadIn(StrictIn):
    """openapi OutputUploadCreate; file names are unique within one output (they become object keys)."""

    title: OutputTitle
    access_level: AccessLevel
    files: Annotated[list[OutputFileIn], Field(min_length=1, max_length=20)]

    @model_validator(mode="after")
    def _unique_names(self) -> "OutputUploadIn":
        names = [f.name for f in self.files]
        if len(set(names)) != len(names):
            raise ValueError("file names must be unique")
        return self


DatasetTitle = Annotated[
    str, StringConstraints(min_length=3, max_length=300), AfterValidator(_no_nul), AfterValidator(_not_blank)
]


class PublishRequestIn(StrictIn):
    """openapi PublishRequestCreate (title: the new dataset's title, default = the output title)."""

    title: DatasetTitle | None = None
    description: Annotated[str, StringConstraints(max_length=20000), AfterValidator(_no_nul)] | None = None


class PublishDecisionIn(StrictIn):
    """openapi PublishDecisionCreate. The comment a REJECT requires is enforced by the service (422)."""

    decision: PublishDecision
    comment: Annotated[str, StringConstraints(max_length=2000), AfterValidator(_no_nul)] | None = None


def _unique_ids(values: list[UUID]) -> list[UUID]:
    if len(set(values)) != len(values):
        raise ValueError("input ids must be unique")
    return values


InputIds = Annotated[list[UUID], Field(min_length=1, max_length=10), AfterValidator(_unique_ids)]
RecipeName = Title  # 1..200 characters, no NUL, not blank
Steps = Annotated[list[Step], Field(max_length=50)]


class RecipeWriteIn(StrictIn):
    """openapi RecipeWrite (input_ids: project input ids, the first is the base table)."""

    name: RecipeName
    input_ids: InputIds
    steps: Steps


class RecipePreviewIn(StrictIn):
    """openapi RecipePreviewRequest: omitted fields use the saved recipe."""

    input_ids: InputIds | None = None
    steps: Steps | None = None


class RecipeList(BaseModel):
    items: list[Recipe]


__all__ = [
    "AccessLevel",
    "Comment",
    "CommentCreateIn",
    "DatasetActivity",
    "DatasetProjectsResult",
    "HubOverview",
    "InputCreateIn",
    "InputUpdateIn",
    "Output",
    "OutputDownload",
    "OutputFileIn",
    "OutputKind",
    "OutputUploadIn",
    "OutputUploadSession",
    "ProjectInput",
    "ProjectInputList",
    "PublishDecision",
    "PublishDecisionIn",
    "PublishRequest",
    "PublishRequestIn",
    "PublishRequestStatus",
    "Recipe",
    "RecipeList",
    "RecipePreview",
    "RecipePreviewIn",
    "RecipeWriteIn",
    "Run",
    "RunStatus",
    "Thread",
    "ThreadCreateIn",
    "ThreadScope",
    "ThreadUpdateIn",
]
