"""10_SEED_DATA §5 datasets as Python data (docs are not in the image). Fixed UUIDs keep seeding idempotent."""

import uuid
from dataclasses import dataclass
from datetime import date
from typing import Any
from uuid import UUID

from api.modules.catalog.domain import PURPOSES


def sid(suffix: str) -> UUID:
    return UUID(f"00000000-0000-7000-8000-00000000{suffix}")


ORG_A = UUID("00000000-0000-7000-8000-00000000000a")
ORG_B = UUID("00000000-0000-7000-8000-00000000000b")
ORG_CODES = {ORG_A: "inst-a", ORG_B: "inst-b"}
STEWARDS = {ORG_A: sid("0a03"), ORG_B: sid("0b03")}
SEED_NAMESPACE = uuid.UUID("5b7d0a52-1f4e-4c55-9f5e-6e41c3a1d203")

# 09_AI_READY_RULES §5.2 clean_tabular dataset.json (title comes from 10_SEED_DATA instead).
CLEAN_METADATA: dict[str, Any] = {
    "description": (
        "연료전지용 고분자 전해질 막 시편 1,000개에 대해 온도와 압력을 측정한 표 형식 데이터셋이다."
        " 재료 코드는 codebook에 정의되어 있다."
    ),
    "keywords": ["fuel-cell", "membrane", "temperature", "pressure"],
    "domain": "materials",
    "license": "CC-BY-4.0",
    "usage_policy": "학술 연구 및 AI 학습 목적에 한해 사용한다. 재배포 금지. 결과 공개 시 출처를 표기한다.",
    "contact_email": "steward@inst-b.example",
    "provenance": (
        "Institute B 연료전지 실험실의 환경 챔버(모델 EC-200)에서 2026년 1월 1일 1분 간격으로 자동 수집한 측정값."
    ),
}


@dataclass(frozen=True)
class SeedDataset:
    dataset_id: UUID
    version_id: UUID
    session_id: UUID
    owner: UUID
    title: str
    access_level: str
    allowed_purposes: tuple[str, ...]
    max_grant_days: int
    fixture: str | None
    publish: bool

    @property
    def steward(self) -> UUID:
        return STEWARDS[self.owner]


SEED_DATASETS: tuple[SeedDataset, ...] = (
    SeedDataset(
        sid("2001"),
        sid("2101"),
        sid("2201"),
        ORG_B,
        "Battery Cycling Measurements",
        "CONTROLLED",
        ("ACADEMIC_RESEARCH", "AI_TRAINING"),
        180,
        "clean_tabular",
        True,
    ),
    SeedDataset(
        sid("2002"),
        sid("2102"),
        sid("2202"),
        ORG_B,
        "Open Materials Properties",
        "PUBLIC",
        PURPOSES,
        365,
        "missing_provenance",
        True,
    ),
    SeedDataset(
        sid("2003"),
        sid("2103"),
        sid("2203"),
        ORG_B,
        "Inst-B Internal QC Logs",
        "INTERNAL",
        ("ACADEMIC_RESEARCH",),
        90,
        "invalid_units",
        True,
    ),
    SeedDataset(
        sid("2004"),
        sid("2104"),
        sid("2204"),
        ORG_A,
        "Facility Sensor Streams",
        "SENSITIVE",
        ("ACADEMIC_RESEARCH",),
        30,
        "missing_metadata",
        True,
    ),
    SeedDataset(
        sid("2005"),
        sid("2105"),
        sid("2205"),
        ORG_A,
        "Electrolyte Screening (draft)",
        "CONTROLLED",
        ("AI_TRAINING",),
        90,
        None,
        False,
    ),
)


def metadata_for(fixture: str | None) -> dict[str, Any]:
    metadata = dict(CLEAN_METADATA)
    if fixture == "missing_metadata":
        metadata.update(description="측정 데이터", keywords=[], domain=None, contact_email=None)
    if fixture == "missing_provenance":
        metadata["provenance"] = None
    return metadata


def file_id(version_id: UUID, path: str) -> UUID:
    return uuid.uuid5(SEED_NAMESPACE, f"{version_id}/{path}")


PEOPLE = {ORG_A: (sid("0a02"), sid("0a03")), ORG_B: (sid("0b02"), sid("0b03"))}  # (PI, steward contact)

RESEARCH: dict[UUID, dict[str, Any]] = {
    sid("2001"): {
        "subtitle": "연료전지 고분자 막 시편 1,000개의 온도·압력 측정",
        "subject_codes": ["ENERGY", "MATERIALS"],
        "material_codes": ["POLYMER_MEMBRANE", "ELECTROLYTE"],
        "method_codes": ["SENSOR_LOGGING"],
        "method_detail": "환경 챔버 EC-200, 1분 간격 자동 계측",
        "temporal_start": date(2026, 1, 1),
        "temporal_end": date(2026, 1, 1),
        "collecting_organization_id": ORG_B,
        "project_title": "연료전지 막 내구성 평가",
        "project_code": "NST-2026-0001",
        "funding_agency": "국가과학기술연구회",
        "update_frequency": "ONCE",
        "contact_email_public": True,
    },
    sid("2002"): {
        "subtitle": "공개 재료 물성 측정값 (2024–2025)",
        "subject_codes": ["MATERIALS"],
        "material_codes": ["METAL_ALLOY", "CERAMIC"],
        "method_codes": ["XRD"],
        "temporal_start": date(2024, 1, 1),
        "temporal_end": date(2025, 12, 31),
        "collecting_organization_id": ORG_B,
        "update_frequency": "YEARLY",
    },
    sid("2003"): {
        "subject_codes": ["MATERIALS"],
        "method_codes": ["SENSOR_LOGGING"],
        "temporal_start": date(2025, 7, 1),
        "collecting_organization_id": ORG_B,
        "update_frequency": "MONTHLY",
    },
    sid("2004"): {},  # the missing_metadata fixture stays sparse on purpose
    sid("2005"): {
        "subject_codes": ["ENERGY", "CHEMISTRY"],
        "material_codes": ["ELECTROLYTE"],
        "method_codes": ["ELECTROCHEM_CYCLING"],
        "temporal_start": date(2026, 3, 1),
        "temporal_end": date(2026, 6, 30),
        "collecting_organization_name": "외부 위탁분석기관 K-Lab",
        "update_frequency": "IRREGULAR",
    },
}


def research_for(item: SeedDataset) -> dict[str, Any]:
    pi, steward = PEOPLE[item.owner]
    return {
        "principal_investigator_id": pi,
        "principal_investigator_org_id": item.owner,
        "data_steward_contact_id": steward,
        "data_steward_contact_org_id": item.owner,
        **RESEARCH[item.dataset_id],
    }
