"""File verification (M03 §6.6): streaming sha256, type sniff (first 8 KiB / last 4 bytes), zip central-directory
checks (never decompresses), malware scan hook. Used synchronously by completeUploadSession for small sessions and
by the catalog.verify_file actor otherwise."""

import codecs
import hashlib
import io
import logging
import stat
import struct
import zipfile
from collections.abc import Mapping
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Literal
from uuid import UUID

from botocore.exceptions import BotoCoreError
from sqlalchemy import update
from sqlalchemy.orm import Session

from api.modules.catalog.domain import extension
from api.modules.catalog.interfaces import MalwareScannerPort
from api.modules.catalog.objects import ObjectMissing, ObjectStore, StorageUnavailable
from api.modules.catalog.repo import rowcount
from api.modules.catalog.tables import dataset_files
from api.platform import clock

if TYPE_CHECKING:
    from api.modules.catalog.deps import CatalogDeps

logger = logging.getLogger("nais.catalog.verification")

SNIFF_BYTES = 8 * 1024
HASH_CHUNK = 1024 * 1024
ZIP_MAX_ENTRIES = 10_000
ZIP_MAX_UNCOMPRESSED = 20 * 1024**3
ZIP_MAX_RATIO = 100
ZIP_MAX_CENTRAL_DIRECTORY = 32 * 1024 * 1024
ZIP_READ_SLACK = 64 * 1024
HDF5_SIGNATURE = b"\x89HDF\r\n\x1a\n"
TEXT_EXTENSIONS = frozenset({".csv", ".tsv", ".json", ".jsonl", ".txt", ".md"})


@dataclass(frozen=True)
class Outcome:
    status: Literal["VERIFIED", "FAILED"]
    failure_code: str | None = None
    scan_status: str = "SKIPPED"

    @property
    def failed(self) -> bool:
        return self.status == "FAILED"


def _text_ok(head: bytes, *, complete: bool, json_start: bool) -> bool:
    if b"\x00" in head:
        return False
    if head.startswith(codecs.BOM_UTF8):
        head = head[len(codecs.BOM_UTF8) :]
    try:
        text = codecs.getincrementaldecoder("utf-8")().decode(head, final=complete)
    except UnicodeDecodeError:
        return False
    if json_start:
        stripped = text.lstrip()
        return bool(stripped) and stripped[0] in "{["
    return True


def sniff(ext: str, head: bytes, tail: bytes, size: int) -> bool:
    if ext in TEXT_EXTENSIONS:
        return _text_ok(head, complete=size <= SNIFF_BYTES, json_start=ext == ".json")
    if ext == ".parquet":
        return size >= 8 and head[:4] == b"PAR1" and tail[-4:] == b"PAR1"
    if ext in (".h5", ".hdf5"):
        return head.startswith(HDF5_SIGNATURE)
    if ext == ".nc":
        return head[:4] in (b"CDF\x01", b"CDF\x02") or head.startswith(HDF5_SIGNATURE)
    if ext == ".zip":
        return head[:4] == b"PK\x03\x04"
    return False


class RangeTooLarge(Exception):
    """A single ranged read exceeded the configured bound (memory defence while zipfile locates the directory)."""


class RangeReader(io.RawIOBase):
    """Seekable read-only view of an object through ranged GETs (zipfile needs seek/tell)."""

    def __init__(self, store: ObjectStore, key: str, size: int, max_read: int | None = None) -> None:
        super().__init__()
        self._max_read = max_read
        self._store = store
        self._key = key
        self._size = size
        self._pos = 0

    def readable(self) -> bool:
        return True

    def seekable(self) -> bool:
        return True

    def tell(self) -> int:
        return self._pos

    def seek(self, offset: int, whence: int = io.SEEK_SET) -> int:
        base = {io.SEEK_SET: 0, io.SEEK_CUR: self._pos, io.SEEK_END: self._size}[whence]
        if base + offset < 0:
            raise ValueError("negative seek position")
        self._pos = base + offset
        return self._pos

    def readinto(self, buffer: Any) -> int:
        view = memoryview(buffer).cast("B")
        if self._pos >= self._size or len(view) == 0:
            return 0
        end = min(self._pos + len(view), self._size) - 1
        if self._max_read is not None and end - self._pos + 1 > self._max_read:
            raise RangeTooLarge(end - self._pos + 1)
        data = self._store.read_range(self._key, self._pos, end)
        view[: len(data)] = data
        self._pos += len(data)
        return len(data)


def _eocd_ok(store: ObjectStore, key: str, size: int) -> bool:
    """Reject archives whose (zip64) end-of-central-directory declares too many entries or a huge directory,
    before zipfile loads the directory into memory. Mirrors zipfile's lookup: a zip64 locator immediately before the
    EOCD means the 56-byte zip64 record immediately before the locator overrides the EOCD values."""
    tail_len = min(size, 22 + 65535 + 20 + 56)
    tail = store.read_range(key, size - tail_len, size - 1)
    index = tail.rfind(b"PK\x05\x06")
    if index < 0 or len(tail) - index < 22:
        return False
    entries = int(struct.unpack("<H", tail[index + 10 : index + 12])[0])
    directory_size = int(struct.unpack("<I", tail[index + 12 : index + 16])[0])
    offset = int(struct.unpack("<I", tail[index + 16 : index + 20])[0])
    sentinel = entries == 0xFFFF or directory_size == 0xFFFFFFFF or offset == 0xFFFFFFFF
    has_locator = index >= 20 and tail[index - 20 : index - 16] == b"PK\x06\x07"
    if has_locator or sentinel:
        if not has_locator or index < 76:
            return False
        record = tail[index - 76 : index - 20]
        if record[:4] != b"PK\x06\x06":
            return False
        entries = int(struct.unpack("<Q", record[32:40])[0])
        directory_size = int(struct.unpack("<Q", record[40:48])[0])
    return entries <= ZIP_MAX_ENTRIES and directory_size <= ZIP_MAX_CENTRAL_DIRECTORY


def _entry_name_unsafe(name: str) -> bool:
    normalized = name.replace("\\", "/")
    if normalized.startswith("/") or (len(normalized) > 1 and normalized[1] == ":"):
        return True
    return any(part == ".." for part in normalized.split("/"))


def zip_is_safe(store: ObjectStore, key: str, size: int) -> bool:
    try:
        if not _eocd_ok(store, key, size):
            return False
        with zipfile.ZipFile(
            io.BufferedReader(
                RangeReader(store, key, size, ZIP_MAX_CENTRAL_DIRECTORY + ZIP_READ_SLACK), 64 * 1024
            )
        ) as archive:
            infos = archive.infolist()
    except (
        RangeTooLarge,
        zipfile.BadZipFile,
        zipfile.LargeZipFile,
        ValueError,
        struct.error,
        EOFError,
        NotImplementedError,
    ):
        return False
    if len(infos) > ZIP_MAX_ENTRIES:
        return False
    total = 0
    for info in infos:
        if _entry_name_unsafe(info.filename) or stat.S_ISLNK(info.external_attr >> 16):
            return False
        total += info.file_size
        if total > ZIP_MAX_UNCOMPRESSED:
            return False
        if info.file_size > ZIP_MAX_RATIO * max(info.compress_size, 1):
            return False
    return True


def _hash_and_head(store: ObjectStore, key: str, size: int) -> tuple[str, bytes, bytes, int]:
    digest = hashlib.sha256()
    head = b""
    tail = b""
    seen = 0
    body = store.open_stream(key)
    try:
        while chunk := body.read(HASH_CHUNK):
            digest.update(chunk)
            if len(head) < SNIFF_BYTES:
                head += chunk[: SNIFF_BYTES - len(head)]
            tail = (tail + chunk)[-4:]
            seen += len(chunk)
            if seen > size:
                break  # already a size mismatch; do not stream the rest of an oversized object
    finally:
        body.close()
    return digest.hexdigest(), head, tail, seen


def evaluate_object(
    store: ObjectStore, *, key: str, size: int, sha256: str, path: str, scanner: MalwareScannerPort
) -> Outcome:
    ext = extension(path)
    try:
        hexdigest, head, tail, seen = _hash_and_head(store, key, size)
        if seen != size:
            return Outcome("FAILED", "SIZE_MISMATCH")
        if hexdigest != sha256.strip():
            return Outcome("FAILED", "CHECKSUM_MISMATCH")
        if not sniff(ext, head, tail, size):
            return Outcome("FAILED", "TYPE_MISMATCH")
        if ext == ".zip" and not zip_is_safe(store, key, size):
            return Outcome("FAILED", "ARCHIVE_UNSAFE")
    except ObjectMissing:
        return Outcome("FAILED", "OBJECT_MISSING")
    except BotoCoreError as exc:
        raise StorageUnavailable(str(exc)) from exc
    scan = scanner.scan(store.bucket, key)
    if scan.status == "INFECTED":
        return Outcome("FAILED", "MALWARE_DETECTED", "INFECTED")
    if scan.status not in ("CLEAN", "SKIPPED"):
        # Unknown scanner verdict: fail closed. No dedicated failure code exists, so MALWARE_DETECTED is used and
        # scan_status stays SKIPPED (the DB CHECK only allows CLEAN/INFECTED/SKIPPED).
        logger.error("catalog scanner returned unexpected status", extra={"status": str(scan.status)})
        return Outcome("FAILED", "MALWARE_DETECTED", "SKIPPED")
    return Outcome("VERIFIED", None, scan.status)


def apply_outcome(session: Session, file_id: UUID, upload_session_id: UUID, outcome: Outcome) -> bool:
    """Guarded by the upload session the verify run read: a duplicate message for a re-used file row (ABA) is a no-op."""
    now = clock.now()
    values: dict[str, Any] = {
        "status": outcome.status,
        "failure_code": outcome.failure_code,
        "scan_status": outcome.scan_status,
        "updated_at": now,
    }
    if outcome.status == "VERIFIED":
        values["verified_at"] = now
    result = session.execute(
        update(dataset_files)
        .where(
            dataset_files.c.file_id == file_id,
            dataset_files.c.status == "UPLOADED",
            dataset_files.c.upload_session_id == upload_session_id,
        )
        .values(**values)
    )
    return rowcount(result) == 1


def verify_in_session(session: Session, deps: "CatalogDeps", f: Mapping[Any, Any]) -> Outcome:
    store = deps.storage.for_bucket(f["storage_bucket"])
    outcome = evaluate_object(
        store,
        key=f["storage_key"],
        size=int(f["size_bytes"]),
        sha256=f["sha256"],
        path=f["path"],
        scanner=deps.scanner,
    )
    if apply_outcome(session, f["file_id"], f["upload_session_id"], outcome) and outcome.failed:
        # The delete precedes the caller's commit. If the tx rolls back, a retry finds the object missing and ends
        # FAILED/OBJECT_MISSING, the same terminal outcome.
        # M03 §5.2: a file that fails verification is removed from storage.
        store.delete(f["storage_key"])  # session-owned key (D-039): never shared with an inherited row
    logger.info(
        "catalog file verified",
        extra={"file_id": str(f["file_id"]), "status": outcome.status, "failure_code": outcome.failure_code},
    )
    return outcome
