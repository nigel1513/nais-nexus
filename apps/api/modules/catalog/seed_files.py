"""Readiness fixture files generated from the 09_AI_READY_RULES §1.2/§5 formulas (no randomness, no clock).

Source of truth for the 09 §5 fixture bytes (W1-D5): M05's tests/fixtures/readiness/generate.py imports
fixture_files() from here, so the catalog seed and the readiness golden fixtures are byte-identical by construction.
Public, deterministic API: FIXTURES, fixture_files(), measurements_csv(), schema_json(), codebook_csv(), readme_md().
"""

import csv
import io
import json
from datetime import UTC, datetime, timedelta

FIXTURES: tuple[str, ...] = ("clean_tabular", "missing_metadata", "invalid_units", "missing_provenance")

README_OVERVIEW = (
    "# 고분자 전해질 막 온도-압력 측정\n"
    "\n"
    "연료전지용 고분자 전해질 막 시편 1,000개의 온도와 압력 측정값을 담은 표 형식 데이터셋이다.\n"
    "파일 구성: `data/measurements.csv`, 스키마 `_schema.json`, 코드북 `_codebook.csv`.\n"
)
README_PROVENANCE = (
    "\n"
    "## Provenance\n"
    "\n"
    "Institute B 연료전지 실험실의 환경 챔버(모델 EC-200)에서 2026년 1월 1일 00:01부터 1분 간격으로 "
    "자동 수집한 원시 측정값이며, 보정이나 후처리를 하지 않았다.\n"
)

CONCEPTS = {
    "sample_id": "https://schema.org/identifier",
    "material": "https://w3id.org/emmo#Material",
    "temperature_c": "http://qudt.org/vocab/quantitykind/Temperature",
    "pressure_kpa": "http://qudt.org/vocab/quantitykind/Pressure",
    "measured_at": "http://www.w3.org/2006/time#Instant",
}


def measurements_csv() -> bytes:
    out = io.StringIO()
    writer = csv.writer(out, lineterminator="\n")
    writer.writerow(["sample_id", "material", "temperature_c", "pressure_kpa", "measured_at"])
    start = datetime(2026, 1, 1, tzinfo=UTC)
    for i in range(1, 1001):
        pressure = "" if i % 100 == 0 else f"{101.325 + (i % 10):.3f}"
        measured = (start + timedelta(minutes=i)).strftime("%Y-%m-%dT%H:%M:%SZ")
        material = ["AL", "CU", "FE"][i % 3]
        writer.writerow([f"S{i:04d}", material, f"{20.0 + (i % 50) * 0.5:.1f}", pressure, measured])
    return out.getvalue().encode("utf-8")


def schema_json(temperature_unit: str, pressure_unit: str) -> bytes:
    fields: list[dict[str, object]] = [
        {"name": "sample_id", "type": "string", "description": "시편 식별자"},
        {
            "name": "material",
            "type": "string",
            "description": "재료 코드",
            "constraints": {"enum": ["AL", "CU", "FE"]},
        },
        {
            "name": "temperature_c",
            "type": "number",
            "unit": temperature_unit,
            "description": "시편 온도",
            "constraints": {"required": True},
        },
        {"name": "pressure_kpa", "type": "number", "unit": pressure_unit, "description": "챔버 압력"},
        {"name": "measured_at", "type": "datetime", "description": "측정 시각"},
    ]
    for field in fields:
        field["x-nais-concept"] = CONCEPTS[str(field["name"])]
    doc = {
        "resources": [
            {
                "path": "data/measurements.csv",
                "schema": {"fields": fields, "primaryKey": "sample_id", "missingValues": ["", "NA"]},
            }
        ]
    }
    return (json.dumps(doc, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


def codebook_csv() -> bytes:
    rows = [
        ["path", "field", "code", "label", "unit", "description"],
        ["data/measurements.csv", "material", "AL", "Aluminium", "", ""],
        ["data/measurements.csv", "material", "CU", "Copper", "", ""],
        ["data/measurements.csv", "material", "FE", "Iron", "", ""],
    ]
    out = io.StringIO()
    csv.writer(out, lineterminator="\n").writerows(rows)
    return out.getvalue().encode("utf-8")


def readme_md(fixture: str) -> bytes:
    text = README_OVERVIEW if fixture == "missing_provenance" else README_OVERVIEW + README_PROVENANCE
    return text.encode("utf-8")


def fixture_files(fixture: str) -> dict[str, bytes]:
    """path -> bytes of one 09 §5 fixture (README.md, _codebook.csv, _schema.json, data/measurements.csv)."""
    if fixture not in FIXTURES:
        raise ValueError(f"unknown readiness fixture {fixture!r}")
    temperature_unit, pressure_unit = ("degC", "kilopascal") if fixture == "invalid_units" else ("Cel", "kPa")
    return {
        "README.md": readme_md(fixture),
        "_codebook.csv": codebook_csv(),
        "_schema.json": schema_json(temperature_unit, pressure_unit),
        "data/measurements.csv": measurements_csv(),
    }
