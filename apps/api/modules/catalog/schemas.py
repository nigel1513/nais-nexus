"""Request bodies (openapi components). Explicit null is rejected unless the contract type is nullable (NULLABLE)."""

from datetime import date
from typing import Annotated, Any, ClassVar, Literal
from uuid import UUID

from pydantic import (
    BaseModel,
    ConfigDict,
    EmailStr,
    Field,
    StrictInt,
    StringConstraints,
    field_validator,
    model_validator,
)

AccessLevelIn = Literal["PUBLIC", "INTERNAL", "CONTROLLED", "SENSITIVE"]
PurposeIn = Literal["ACADEMIC_RESEARCH", "AI_TRAINING", "COMMERCIAL_RESEARCH", "EDUCATION", "PUBLIC_INTEREST"]
ReadinessIn = Literal["PASS", "WARNING", "FAIL"]
SortIn = Literal["relevance", "updated_desc", "title_asc"]

Title = Annotated[str, StringConstraints(min_length=3, max_length=300)]
Description = Annotated[str, StringConstraints(max_length=20000)]
Keyword = Annotated[str, StringConstraints(min_length=1, max_length=50)]
Keywords = Annotated[list[Keyword], Field(max_length=30)]
LongText = Annotated[str, StringConstraints(max_length=10000)]
License = Annotated[str, StringConstraints(min_length=1, max_length=200)]
Purposes = Annotated[list[PurposeIn], Field(min_length=1)]
GrantDays = Annotated[StrictInt, Field(ge=1, le=365)]


class StrictIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    NULLABLE: ClassVar[frozenset[str]] = frozenset()

    @model_validator(mode="before")
    @classmethod
    def _no_nulls(cls, data: Any) -> Any:
        if isinstance(data, dict):
            nulls = sorted(key for key, value in data.items() if value is None and key not in cls.NULLABLE)
            if nulls:
                raise ValueError(f"null is not allowed for: {', '.join(nulls)}")
        return data


def _unique(values: list[str]) -> list[str]:
    if len(set(values)) != len(values):
        raise ValueError("allowed_purposes must be unique")
    return values


Code = Annotated[str, StringConstraints(pattern=r"^[A-Z0-9_]{2,64}$")]
FrequencyIn = Literal["ONCE", "MONTHLY", "QUARTERLY", "YEARLY", "IRREGULAR"]


class PublicationIn(StrictIn):
    title: Annotated[str, StringConstraints(min_length=1, max_length=300)]
    doi: Annotated[str, StringConstraints(pattern=r"^10\.\d{4,9}/\S+$")] | None = None
    url: Annotated[str, StringConstraints(pattern=r"^https?://\S+$", max_length=2000)] | None = None


class ResearchIn(StrictIn):
    """Wave 1.5 research metadata shared by DatasetCreate and DatasetUpdate (spec §3.2)."""

    subtitle: Annotated[str, StringConstraints(max_length=160)] | None = None
    contact_email_public: bool | None = None
    project_title: Annotated[str, StringConstraints(max_length=300)] | None = None
    project_code: Annotated[str, StringConstraints(max_length=64)] | None = None
    funding_agency: Annotated[str, StringConstraints(max_length=200)] | None = None
    subject_codes: Annotated[list[Code], Field(max_length=5)] | None = None
    method_codes: Annotated[list[Code], Field(max_length=10)] | None = None
    material_codes: Annotated[list[Code], Field(max_length=20)] | None = None
    method_detail: Annotated[str, StringConstraints(max_length=4000)] | None = None
    temporal_start: date | None = None
    temporal_end: date | None = None
    collecting_organization_id: UUID | None = None
    collecting_organization_name: Annotated[str, StringConstraints(min_length=1, max_length=200)] | None = (
        None
    )
    update_frequency: FrequencyIn | None = None
    related_publications: Annotated[list[PublicationIn], Field(max_length=20)] | None = None

    @field_validator("subject_codes", "method_codes", "material_codes")
    @classmethod
    def _unique_codes(cls, value: list[str] | None) -> list[str] | None:
        if value is not None and len(set(value)) != len(value):
            raise ValueError("codes must be unique")
        return value


class DatasetCreateIn(ResearchIn):
    owner_organization_id: UUID
    title: Title
    description: Description
    keywords: Keywords = Field(default_factory=list)
    domain: str | None = None
    access_level: AccessLevelIn
    license: License
    usage_policy: LongText | None = None
    allowed_purposes: Purposes
    max_grant_days: GrantDays | None = None
    contact_email: EmailStr | None = None
    provenance: LongText | None = None
    principal_investigator_id: UUID
    data_steward_contact_id: UUID

    @field_validator("allowed_purposes")
    @classmethod
    def _purposes_unique(cls, value: list[str]) -> list[str]:
        return _unique(value)


class DatasetUpdateIn(ResearchIn):
    NULLABLE: ClassVar[frozenset[str]] = frozenset(
        {
            "subtitle",
            "project_title",
            "project_code",
            "funding_agency",
            "method_detail",
            "temporal_start",
            "temporal_end",
            "collecting_organization_id",
            "collecting_organization_name",
        }
    )

    title: Title | None = None
    description: Description | None = None
    keywords: Keywords | None = None
    domain: str | None = None
    access_level: AccessLevelIn | None = None
    license: License | None = None
    usage_policy: LongText | None = None
    allowed_purposes: Purposes | None = None
    max_grant_days: GrantDays | None = None
    contact_email: EmailStr | None = None
    provenance: LongText | None = None
    status: Literal["ACTIVE", "WITHDRAWN"] | None = None
    principal_investigator_id: UUID | None = None
    data_steward_contact_id: UUID | None = None

    @field_validator("allowed_purposes")
    @classmethod
    def _purposes_unique(cls, value: list[str] | None) -> list[str] | None:
        return None if value is None else _unique(value)

    @model_validator(mode="after")
    def _not_empty(self) -> "DatasetUpdateIn":
        if not self.model_fields_set:
            raise ValueError("at least one field is required")
        return self


class VersionCreateIn(StrictIn):
    version_label: Annotated[str, StringConstraints(pattern=r"^[A-Za-z0-9._-]{1,32}$")]
    change_note: Annotated[str, StringConstraints(max_length=2000)] | None = None


class UploadFileIn(StrictIn):
    path: Annotated[str, StringConstraints(pattern=r"^[A-Za-z0-9._/-]{1,512}$")]
    size_bytes: Annotated[int, Field(ge=1)]  # the 50 GiB limit is FILE_TOO_LARGE, checked by the service
    sha256: Annotated[str, StringConstraints(pattern=r"^[a-f0-9]{64}$")]
    media_type: Annotated[str, StringConstraints(min_length=1, max_length=255)]


class UploadSessionCreateIn(StrictIn):
    files: Annotated[list[UploadFileIn], Field(min_length=1, max_length=500)]


class PartEtagIn(BaseModel):
    part_number: Annotated[int, Field(ge=1)]
    etag: Annotated[str, StringConstraints(min_length=1)]


class FilePartsIn(BaseModel):
    file_id: UUID
    etags: list[PartEtagIn]


class UploadCompleteIn(StrictIn):
    parts: list[FilePartsIn] = Field(default_factory=list)


SchemeIn = Literal["SUBJECT", "METHOD", "MATERIAL"]
Iri = Annotated[str, StringConstraints(pattern=r"^https?://\S+$", max_length=2000)]


class VocabularyTermIn(StrictIn):
    code: Code
    label_ko: Annotated[str, StringConstraints(min_length=1, max_length=200)]
    label_en: Annotated[str, StringConstraints(min_length=1, max_length=200)]
    iri: Iri | None = None
    parent_code: Code | None = None


ContributorRoleIn = Literal["CO_INVESTIGATOR", "DATA_COLLECTOR", "DATA_CURATOR"]


class ContributorIn(StrictIn):
    user_id: UUID
    role: ContributorRoleIn


class ContributorsPutIn(StrictIn):
    contributors: Annotated[list[ContributorIn], Field(max_length=50)]
