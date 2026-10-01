"""Implementations of the catalog public ports (registered by wiring.install)."""

import io
from collections.abc import Callable, Iterator, Mapping, Sequence
from contextlib import contextmanager
from datetime import timedelta
from typing import Any, BinaryIO, TypeVar, cast
from uuid import UUID

from botocore.exceptions import BotoCoreError
from sqlalchemy import select
from urllib3.exceptions import HTTPError as Urllib3Error

from api.modules.catalog.access import can_see_dataset
from api.modules.catalog.deps import CatalogDeps
from api.modules.catalog.domain import basename
from api.modules.catalog.objects import ObjectMissing as InternalObjectMissing
from api.modules.catalog.objects import StorageUnavailable as InternalStorageUnavailable
from api.modules.catalog.public import (
    CatalogNotFound,
    DatasetPolicyView,
    FileRef,
    ObjectMissing,
    PresignedGet,
    StorageUnavailable,
    VersionView,
)
from api.modules.catalog.repo import files_of_versions, load_dataset, load_version, must
from api.modules.catalog.tables import dataset_files, dataset_versions
from api.platform import clock
from api.platform.auth import CurrentUser
from api.platform.storage import StorageNotConfigured


def _file_ref(f: Mapping[Any, Any]) -> FileRef:
    return FileRef(
        file_id=f["file_id"],
        path=f["path"],
        size_bytes=int(f["size_bytes"]),
        sha256=f["sha256"].strip(),
        media_type=f["media_type"],
        status=f["status"],
        storage_bucket=f["storage_bucket"],
        storage_key=f["storage_key"],
    )


class CatalogQueryService:
    def __init__(self, deps: CatalogDeps) -> None:
        self._deps = deps

    def get_policy_view(self, dataset_id: UUID) -> DatasetPolicyView | None:
        with self._deps.session_factory() as session:
            ds = load_dataset(session, dataset_id)
        if ds is None:
            return None
        return DatasetPolicyView(
            dataset_id=ds["dataset_id"],
            owner_organization_id=ds["owner_organization_id"],
            access_level=ds["access_level"],
            allowed_purposes=tuple(ds["allowed_purposes"]),
            approval_required=ds["approval_required"],
            max_grant_days=ds["max_grant_days"],
            status=ds["status"],
            title=ds["title"],
        )

    def get_version(self, dataset_version_id: UUID) -> VersionView | None:
        with self._deps.session_factory() as session:
            version = load_version(session, dataset_version_id)
            if version is None:
                return None
            ds = must(load_dataset(session, version["dataset_id"]), "dataset")
            files = files_of_versions(session, [dataset_version_id])[dataset_version_id]
        return VersionView(
            dataset_version_id=version["dataset_version_id"],
            dataset_id=version["dataset_id"],
            owner_organization_id=ds["owner_organization_id"],
            version_label=version["version_label"],
            status=version["status"],
            manifest_sha256=version["manifest_sha256"].strip() if version["manifest_sha256"] else None,
            metadata_snapshot=version["metadata_snapshot"],
            files=tuple(_file_ref(f) for f in files),
        )

    def is_visible(self, ctx: CurrentUser, dataset_id: UUID) -> bool:
        with self._deps.session_factory() as session:
            ds = load_dataset(session, dataset_id)
        return ds is not None and can_see_dataset(ctx, ds)


class CatalogStorageService:
    def __init__(self, deps: CatalogDeps) -> None:
        self._deps = deps

    def presign_get(
        self, dataset_version_id: UUID, file_ids: Sequence[UUID] | None, ttl_seconds: int
    ) -> list[PresignedGet]:
        if ttl_seconds <= 0:
            raise ValueError("ttl_seconds must be positive")
        with self._deps.session_factory() as session:
            version = load_version(session, dataset_version_id)
            if (
                version is None or version["status"] != "PUBLISHED"
            ):  # AT-23: only published versions are downloadable
                raise CatalogNotFound(f"dataset version {dataset_version_id}")
            files = [
                f
                for f in files_of_versions(session, [dataset_version_id])[dataset_version_id]
                if f["status"] == "VERIFIED"
            ]
        by_id = {f["file_id"]: f for f in files}
        if file_ids is None:
            chosen = files
        else:
            unknown = [str(file_id) for file_id in file_ids if file_id not in by_id]
            if unknown:
                raise CatalogNotFound(f"files not in version {dataset_version_id}: {', '.join(unknown)}")
            chosen = [by_id[file_id] for file_id in dict.fromkeys(file_ids)]
        expires_at = clock.now() + timedelta(seconds=ttl_seconds)
        signed: list[PresignedGet] = []
        for f in chosen:
            with _public_errors(f["path"]):
                store = self._deps.storage.for_bucket(f["storage_bucket"])
                url = store.presign_get(f["storage_key"], basename(f["path"]), ttl_seconds)
            signed.append(
                PresignedGet(
                    file_id=f["file_id"],
                    path=f["path"],
                    url=url,
                    size_bytes=int(f["size_bytes"]),
                    sha256=f["sha256"].strip(),
                    expires_at=expires_at,
                )
            )
        return signed


_T = TypeVar("_T")


@contextmanager
def _public_errors(path: str) -> Iterator[None]:
    """Internal storage errors -> public ones (consumers never import catalog.objects). Mid-read failures of a
    botocore StreamingBody surface as BotoCoreError (ReadTimeout, IncompleteRead, ResponseStreamingError) or raw
    urllib3 errors; both are infrastructure errors, i.e. StorageUnavailable."""
    try:
        yield
    except InternalObjectMissing as exc:
        raise ObjectMissing(path) from exc  # the path, never the storage key (M05 echoes args[0])
    except (InternalStorageUnavailable, StorageNotConfigured, BotoCoreError, Urllib3Error) as exc:
        raise StorageUnavailable(str(exc)) from exc


class _PublicErrorStream(io.BufferedIOBase):
    """Read-only BinaryIO over a storage stream that raises only the public exceptions, also mid-read."""

    def __init__(self, inner: BinaryIO, path: str) -> None:
        self._inner = inner
        self._path = path

    def _call(self, fn: Callable[[], _T]) -> _T:
        with _public_errors(self._path):
            return fn()

    def readable(self) -> bool:
        return True

    def read(self, size: int | None = -1) -> bytes:
        return self._call(lambda: self._inner.read(-1 if size is None else size))

    def read1(self, size: int = -1) -> bytes:
        return self.read(size)

    def readinto(self, buffer: Any) -> int:
        data = self.read(len(memoryview(buffer)))
        memoryview(buffer)[: len(data)] = data
        return len(data)

    def readline(self, size: int | None = -1) -> bytes:
        return self._call(lambda: self._inner.readline(-1 if size is None else size))

    def close(self) -> None:
        try:
            self._call(self._inner.close)
        finally:
            super().close()


class CatalogReader:
    def __init__(self, deps: CatalogDeps) -> None:
        self._deps = deps

    def open_stream(self, file: FileRef, byte_range: tuple[int, int] | None = None) -> BinaryIO:
        if byte_range is not None and not 0 <= byte_range[0] <= byte_range[1]:
            raise ValueError("byte_range must satisfy 0 <= start <= end")
        # never trust the caller's FileRef: only VERIFIED files of PUBLISHED versions, with the stored location
        with self._deps.session_factory() as session:
            row = session.execute(
                select(dataset_files.c.storage_bucket, dataset_files.c.storage_key, dataset_files.c.status)
                .select_from(
                    dataset_files.join(
                        dataset_versions,
                        dataset_files.c.dataset_version_id == dataset_versions.c.dataset_version_id,
                    )
                )
                .where(dataset_files.c.file_id == file.file_id, dataset_versions.c.status == "PUBLISHED")
            ).first()
        if (
            row is None
            or row.status != "VERIFIED"
            or (row.storage_bucket, row.storage_key) != (file.storage_bucket, file.storage_key)
        ):
            raise ObjectMissing(file.path)
        with _public_errors(file.path):
            inner = self._deps.storage.for_bucket(file.storage_bucket).open_stream(
                file.storage_key, byte_range
            )
        return cast(BinaryIO, _PublicErrorStream(inner, file.path))
