"""Everything a validator may look at for one run: snapshot, manifest, convention files, lazily parsed tables."""

import csv
import io
import json
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from functools import cached_property, lru_cache
from pathlib import Path
from typing import Any, Literal

from jsonschema import Draft202012Validator

from api.modules.readiness.catalog_port import CatalogReadPort, FileRef
from api.modules.readiness.engine.parsing import (
    DEFAULT_MISSING,
    ColumnPlan,
    FilePlan,
    FileStats,
    FileTimeout,
    FileTooLarge,
    open_parquet_range,
    profile_csv,
    profile_parquet,
)
from api.modules.readiness.profile_registry import ProfileParams

CheckStatus = Literal["PASS", "WARNING", "FAIL", "NOT_APPLICABLE"]
TABULAR_SUFFIXES = (".csv", ".tsv", ".parquet")
SCHEMA_FILE = "_schema.json"
CODEBOOK_FILE = "_codebook.csv"
README_FILE = "README.md"
CONVENTION_MAX_BYTES = 16 * 1024 * 1024
SUBSET_SCHEMA_PATH = Path(__file__).resolve().parents[1] / "schemas" / "table_schema_subset_v1.json"


@dataclass(frozen=True)
class CheckOutcome:
    status: CheckStatus
    message: str  # Korean, 1-2 sentences, never a cell value
    evidence: dict[str, Any]  # counts, ratios, paths, field names, declared units, row numbers only (D-018)


def is_tabular(path: str) -> bool:
    """T membership (09 §1.3): .csv/.tsv/.parquet whose file name does not start with '_'."""
    return path.lower().endswith(TABULAR_SUFFIXES) and not path.rsplit("/", 1)[-1].startswith("_")


@lru_cache(maxsize=1)
def subset_validator() -> Draft202012Validator:
    return Draft202012Validator(json.loads(SUBSET_SCHEMA_PATH.read_text(encoding="utf-8")))


@dataclass(frozen=True)
class FieldSchema:
    name: str
    type: str
    unit: str | None
    required: bool
    concept: str | None


@dataclass(frozen=True)
class ResourceSchema:
    path: str
    fields: tuple[FieldSchema, ...]
    primary_key: tuple[str, ...]
    missing_values: frozenset[str]


@dataclass(frozen=True)
class SchemaDoc:
    present: bool
    valid: bool
    errors: tuple[dict[str, str], ...] = ()
    resources: dict[str, ResourceSchema] = field(default_factory=dict)


@dataclass(frozen=True)
class Codebook:
    present: bool
    units: dict[tuple[str, str], str] = field(
        default_factory=dict
    )  # (path, field) -> unit, rows with code ""
    codes: dict[tuple[str, str], frozenset[str]] = field(default_factory=dict)


def parse_schema_doc(raw: bytes) -> SchemaDoc:
    try:
        doc = json.loads(raw.decode("utf-8-sig"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return SchemaDoc(present=True, valid=False, errors=({"pointer": "", "error": "json_parse"},))
    errors = sorted(
        {
            ("".join(f"/{p}" for p in e.absolute_path), str(e.validator))
            for e in subset_validator().iter_errors(doc)
        }
    )
    if errors:
        return SchemaDoc(
            present=True, valid=False, errors=tuple({"pointer": p, "error": v} for p, v in errors)
        )
    resources: dict[str, ResourceSchema] = {}
    for res in doc["resources"]:
        schema = res["schema"]
        pk = schema.get("primaryKey", [])
        fields = tuple(
            FieldSchema(
                name=f["name"],
                type=f["type"],
                unit=f.get("unit"),
                required=bool(f.get("constraints", {}).get("required", False)),
                concept=f.get("x-nais-concept"),
            )
            for f in schema["fields"]
        )
        missing = frozenset(schema["missingValues"]) if "missingValues" in schema else DEFAULT_MISSING
        resources.setdefault(  # first description of a path wins
            res["path"],
            ResourceSchema(
                path=res["path"],
                fields=fields,
                primary_key=(pk,) if isinstance(pk, str) else tuple(pk),
                missing_values=missing,
            ),
        )
    return SchemaDoc(present=True, valid=True, resources=resources)


def parse_codebook(raw: bytes) -> Codebook:
    units: dict[tuple[str, str], str] = {}
    codes: dict[tuple[str, str], set[str]] = {}
    try:
        for row in csv.DictReader(io.StringIO(raw.decode("utf-8-sig"), newline="")):
            key = ((row.get("path") or "").strip(), (row.get("field") or "").strip())
            code = row.get("code") or ""
            if code == "":
                if row.get("unit"):
                    units.setdefault(key, row["unit"])
            else:
                codes.setdefault(key, set()).add(code)
    except (UnicodeDecodeError, csv.Error):
        return Codebook(present=True)
    return Codebook(present=True, units=units, codes={k: frozenset(v) for k, v in codes.items()})


@dataclass
class EvaluationContext:
    snapshot: dict[str, Any]
    files: tuple[FileRef, ...]
    manifest_sha256: str | None
    reader: CatalogReadPort
    params: ProfileParams
    file_timeout_s: float | None = None
    monotonic: Callable[[], float] = time.monotonic  # only to abort slow parses, never for verdicts
    _stats: dict[str, FileStats] = field(default_factory=dict)
    _failures: dict[str, FileTooLarge | FileTimeout] = field(default_factory=dict)

    @cached_property
    def by_path(self) -> dict[str, FileRef]:
        return {f.path: f for f in self.files}

    @cached_property
    def all_tabular(self) -> list[FileRef]:
        return sorted((f for f in self.files if is_tabular(f.path)), key=lambda f: f.path)

    @property
    def tabular(self) -> list[FileRef]:
        """T, capped at max_tabular_files (path order)."""
        return self.all_tabular[: self.params.max_tabular_files]

    @property
    def skipped_tabular(self) -> list[str]:
        return [f.path for f in self.all_tabular[self.params.max_tabular_files :]]

    def read_small(self, path: str) -> bytes | None:
        """A convention file's bytes; None when absent or larger than CONVENTION_MAX_BYTES."""
        ref = self.by_path.get(path)
        if ref is None:
            return None
        limit = CONVENTION_MAX_BYTES + 1
        parts: list[bytes] = []
        total = 0
        with self.reader.open_stream(ref) as stream:
            while total < limit:
                chunk = stream.read(min(1024 * 1024, limit - total))
                if not chunk:
                    break
                parts.append(chunk)
                total += len(chunk)
        data = b"".join(parts)
        return data if len(data) <= CONVENTION_MAX_BYTES else None

    @property
    def readme_present(self) -> bool:
        return README_FILE in self.by_path

    @cached_property
    def readme_text(self) -> str | None:
        raw = self.read_small(README_FILE)
        return None if raw is None else raw.decode("utf-8-sig", errors="replace")

    @cached_property
    def schema_doc(self) -> SchemaDoc:
        if SCHEMA_FILE not in self.by_path:
            return SchemaDoc(present=False, valid=False)
        raw = self.read_small(SCHEMA_FILE)
        if raw is None:
            return SchemaDoc(present=True, valid=False, errors=({"pointer": "", "error": "too_large"},))
        return parse_schema_doc(raw)

    @cached_property
    def codebook(self) -> Codebook:
        if CODEBOOK_FILE not in self.by_path:
            return Codebook(present=False)
        raw = self.read_small(CODEBOOK_FILE)
        return Codebook(present=True) if raw is None else parse_codebook(raw)

    def resource(self, path: str) -> ResourceSchema | None:
        return self.schema_doc.resources.get(path) if self.schema_doc.valid else None

    def plan_for(self, path: str) -> FilePlan:
        resource = self.resource(path)
        codes = {f: c for (p, f), c in self.codebook.codes.items() if p == path}
        columns: dict[str, ColumnPlan] = {name: ColumnPlan(codes=c) for name, c in codes.items()}
        if resource is not None:
            for fld in resource.fields:
                columns[fld.name] = ColumnPlan(declared_type=fld.type, codes=codes.get(fld.name))
        missing = resource.missing_values if resource is not None else DEFAULT_MISSING
        return FilePlan(missing_tokens=missing, columns=columns)

    def _deadline(self) -> Callable[[], None]:
        if self.file_timeout_s is None:
            return lambda: None
        limit = self.monotonic() + self.file_timeout_s

        def check() -> None:
            if self.monotonic() > limit:
                raise FileTimeout()

        return check

    def file_stats(self, path: str) -> FileStats:
        """Parsed once per run and shared by the schema / datatype / missing / units checks (M05 §10).
        FileTooLarge / FileTimeout are cached and re-raised; storage errors are not (the run retries)."""
        if path in self._failures:
            raise self._failures[path]
        if path not in self._stats:
            try:
                self._stats[path] = self._profile(path)
            except (FileTooLarge, FileTimeout) as exc:
                self._failures[path] = exc
                raise
        return self._stats[path]

    def _profile(self, path: str) -> FileStats:
        p = self.params
        ref = self.by_path[path]
        deadline = self._deadline()  # one budget per file
        if path.lower().endswith(".parquet"):
            stream = open_parquet_range(
                lambda start, end: self.reader.open_stream(ref, (start, end)),
                ref.size_bytes,
                deadline=deadline,
            )
            try:
                return profile_parquet(
                    stream,
                    path=path,
                    plan=self.plan_for(path),
                    max_rows=p.sample_max_rows,
                    max_bytes=p.sample_max_bytes,
                    deadline=deadline,
                )
            finally:
                stream.close()
        with self.reader.open_stream(ref) as csv_stream:
            return profile_csv(
                csv_stream,
                path=path,
                delimiter="\t" if path.lower().endswith(".tsv") else ",",
                plan=self.plan_for(path),
                max_rows=p.sample_max_rows,
                max_bytes=p.sample_max_bytes,
                deadline=deadline,
            )
