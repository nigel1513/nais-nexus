"""In-module fake of M03's CatalogQueryPort + CatalogReadPort (api.modules.catalog.public; mock-first, 02 §4).

Serves versions built from files on disk (tests/fixtures/readiness/<fixture>/files) or from in-memory bytes.
Used by the readiness tests and by `python -m api.modules.readiness.selfcheck`. Never wired in production.
"""

import hashlib
import io
import json
import uuid
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any, BinaryIO
from uuid import UUID

from api.modules.catalog.public import DatasetPolicyView, DatasetSummary
from api.modules.readiness.catalog_port import FileRef, ObjectMissing, VersionView
from api.modules.readiness.engine.canonical import manifest_sha256
from api.platform.auth import CurrentUser
from api.platform.settings import REPO_ROOT

FIXTURES_ROOT = REPO_ROOT / "tests" / "fixtures" / "readiness"
_MEDIA_TYPES = {
    ".csv": "text/csv",
    ".tsv": "text/tab-separated-values",
    ".parquet": "application/vnd.apache.parquet",
    ".json": "application/json",
    ".md": "text/markdown",
}


def _sha256_of(source: Path | bytes) -> tuple[str, int]:
    if isinstance(source, bytes):
        return hashlib.sha256(source).hexdigest(), len(source)
    digest = hashlib.sha256()
    size = 0
    with source.open("rb") as fh:
        while chunk := fh.read(1 << 20):
            digest.update(chunk)
            size += len(chunk)
    return digest.hexdigest(), size


_ID_NAMESPACE = uuid.UUID("5f0c5a52-0000-5000-8000-000000000005")


@dataclass
class _Dataset:
    owner_organization_id: UUID
    access_level: str
    status: str = "ACTIVE"


@dataclass
class _Entry:
    view: VersionView
    sources: dict[str, Path | bytes]  # storage_key -> content


@dataclass
class FixtureCatalog:
    """Implements CatalogQueryPort and CatalogReadPort. `fail_reads` simulates a storage outage."""

    fail_reads: Exception | None = None
    reads: list[str] = field(default_factory=list)
    live_metadata: dict[UUID, dict[str, Any]] = field(default_factory=dict)  # dataset_id -> live metadata
    _versions: dict[UUID, _Entry] = field(default_factory=dict)
    _datasets: dict[UUID, _Dataset] = field(default_factory=dict)
    _counter: int = 0

    def _next_id(self, kind: str) -> UUID:
        self._counter += 1
        return uuid.uuid5(_ID_NAMESPACE, f"{kind}-{self._counter}")

    def withdraw_dataset(self, dataset_id: UUID) -> None:
        self._datasets[dataset_id].status = "WITHDRAWN"

    def add_version(
        self,
        files: dict[str, Path | bytes],
        snapshot: dict[str, Any] | None,
        *,
        owner_organization_id: UUID,
        status: str = "PUBLISHED",
        dataset_id: UUID | None = None,
        dataset_version_id: UUID | None = None,
        access_level: str | None = None,
        dataset_status: str | None = None,
    ) -> VersionView:
        dataset_id = dataset_id or self._next_id("dataset")
        version_id = dataset_version_id or self._next_id("version")
        refs: list[FileRef] = []
        sources: dict[str, Path | bytes] = {}
        for path in sorted(files, key=lambda p: p.encode("utf-8")):
            sha, size = _sha256_of(files[path])
            key = f"datasets/{dataset_id}/{version_id}/{path}"
            sources[key] = files[path]
            refs.append(
                FileRef(
                    file_id=uuid.uuid5(version_id, path),
                    path=path,
                    size_bytes=size,
                    sha256=sha,
                    media_type=_MEDIA_TYPES.get(Path(path).suffix.lower(), "application/octet-stream"),
                    status="VERIFIED",
                    storage_bucket="nais-fake",
                    storage_key=key,
                )
            )
        has_content = status != "DRAFT"  # PUBLISHED and WITHDRAWN versions carry snapshot and manifest
        level = access_level or (snapshot or {}).get("access_level") or "INTERNAL"
        snap = {**(snapshot or {}), "access_level": level} if has_content else None
        view = VersionView(
            dataset_version_id=version_id,
            dataset_id=dataset_id,
            owner_organization_id=owner_organization_id,
            version_label="v1",
            status=status,  # type: ignore[arg-type]
            manifest_sha256=manifest_sha256(refs) if has_content else None,
            metadata_snapshot=snap,
            files=tuple(refs),
        )
        dataset = self._datasets.setdefault(dataset_id, _Dataset(owner_organization_id, level))
        if dataset_status is not None:
            dataset.status = dataset_status
        self._versions[version_id] = _Entry(view, sources)
        self.live_metadata[dataset_id] = dict(snap or snapshot or {})
        return view

    def add_fixture(self, name: str, *, owner_organization_id: UUID, **kwargs: Any) -> VersionView:
        base = FIXTURES_ROOT / name
        snapshot = json.loads((base / "dataset.json").read_text(encoding="utf-8"))
        files: dict[str, Path | bytes] = {
            p.relative_to(base / "files").as_posix(): p for p in (base / "files").rglob("*") if p.is_file()
        }
        return self.add_version(files, snapshot, owner_organization_id=owner_organization_id, **kwargs)

    def replace_view(self, view: VersionView) -> None:
        """Swap the served view (e.g. to fake a tampered sha256 or manifest)."""
        self._versions[view.dataset_version_id] = replace(self._versions[view.dataset_version_id], view=view)

    def delete_object(self, dataset_version_id: UUID, path: str) -> None:
        entry = self._versions[dataset_version_id]
        [ref] = [f for f in entry.view.files if f.path == path]
        del entry.sources[ref.storage_key]

    # ---- CatalogQueryPort (full M03 Protocol, so it can be provided under the M03 key)
    def get_policy_view(self, dataset_id: UUID) -> DatasetPolicyView | None:
        dataset = self._datasets.get(dataset_id)
        if dataset is None:
            return None
        meta = self.live_metadata.get(dataset_id, {})
        return DatasetPolicyView(
            dataset_id=dataset_id,
            owner_organization_id=dataset.owner_organization_id,
            access_level=dataset.access_level,  # type: ignore[arg-type]
            allowed_purposes=tuple(meta.get("allowed_purposes") or ()),
            approval_required=dataset.access_level in ("CONTROLLED", "SENSITIVE"),
            max_grant_days=int(meta.get("max_grant_days") or 180),
            status=dataset.status,  # type: ignore[arg-type]
            title=str(meta.get("title") or ""),
        )

    def get_version(self, dataset_version_id: UUID) -> VersionView | None:
        entry = self._versions.get(dataset_version_id)
        return entry.view if entry else None

    def get_latest_published_version(self, dataset_id: UUID) -> VersionView | None:
        """Last PUBLISHED version added (insertion order stands in for published_at)."""
        published = [
            e.view
            for e in self._versions.values()
            if e.view.dataset_id == dataset_id and e.view.status == "PUBLISHED"
        ]
        return published[-1] if published else None

    def is_visible(self, ctx: CurrentUser, dataset_id: UUID) -> bool:
        """Same rule as M03 access.can_see_dataset (D-012 + R3)."""
        dataset = self._datasets.get(dataset_id)
        if dataset is None:
            return False
        if ctx.is_platform_admin or ctx.organization_id == dataset.owner_organization_id:
            return True
        has_published = any(
            e.view.dataset_id == dataset_id and e.view.status == "PUBLISHED" for e in self._versions.values()
        )
        return dataset.status == "ACTIVE" and dataset.access_level != "INTERNAL" and has_published

    def list_visible_dataset_summaries(self, ctx: CurrentUser) -> list[DatasetSummary]:
        raise NotImplementedError  # M05 never lists datasets

    # ---- CatalogReadPort
    def open_stream(self, file: FileRef, byte_range: tuple[int, int] | None = None) -> BinaryIO:
        """Mirrors M03: only a VERIFIED file of a PUBLISHED version with the served bucket/key is readable."""
        if byte_range is not None and not 0 <= byte_range[0] <= byte_range[1]:
            raise ValueError("byte_range must satisfy 0 <= start <= end")
        if self.fail_reads is not None:
            raise self.fail_reads
        for entry in self._versions.values():
            if entry.view.status != "PUBLISHED":
                continue
            served = [
                f
                for f in entry.view.files
                if f.storage_key == file.storage_key and f.storage_bucket == file.storage_bucket
            ]
            source = entry.sources.get(file.storage_key)
            if source is None or not served or served[0].status != "VERIFIED":
                continue
            self.reads.append(file.path)
            data = source if isinstance(source, bytes) else source.read_bytes()
            if byte_range is not None:
                data = data[byte_range[0] : byte_range[1] + 1]
            return io.BytesIO(data)
        raise ObjectMissing(file.path)
