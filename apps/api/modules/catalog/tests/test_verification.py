import hashlib
import io
import stat
import struct
import zipfile
from types import SimpleNamespace
from typing import BinaryIO
from uuid import UUID

import pytest

from api.modules.catalog import verification
from api.modules.catalog.interfaces import ScanResult
from api.modules.catalog.objects import ObjectMissing
from api.modules.catalog.testing import MemoryObjectStore
from api.modules.catalog.tests.support import execute, insert_dataset, insert_file, insert_version, rows
from api.modules.catalog.verification import (
    Outcome,
    RangeReader,
    apply_outcome,
    evaluate_object,
    verify_in_session,
)
from api.platform.db import session_factory
from api.platform.ids import new_id
from api.platform.testing.fixtures import PgUrls

HDF5 = b"\x89HDF\r\n\x1a\n"


class Scanner:
    def __init__(self, status: str = "CLEAN") -> None:
        self.status = status

    def scan(self, bucket: str, key: str) -> ScanResult:
        return ScanResult(self.status)  # type: ignore[arg-type]


def run(
    path: str,
    data: bytes,
    *,
    declared: bytes | None = None,
    size: int | None = None,
    scanner: Scanner | None = None,
) -> Outcome:
    store = MemoryObjectStore("nais-inst-b")
    store.put("k", data, "application/octet-stream")
    reference = data if declared is None else declared
    return evaluate_object(
        store,
        key="k",
        size=len(reference) if size is None else size,
        sha256=hashlib.sha256(reference).hexdigest(),
        path=path,
        scanner=scanner or Scanner("SKIPPED"),
    )


def make_zip(entries: dict[str, bytes], *, compression: int = zipfile.ZIP_STORED) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", compression=compression) as archive:
        for name, content in entries.items():
            archive.writestr(zipfile.ZipInfo(name), content, compress_type=compression)
    return buffer.getvalue()


@pytest.mark.parametrize(
    ("path", "data"),
    [
        ("a.csv", b"a,b\n1,2\n"),
        ("a.csv", b"\xef\xbb\xbfa,b\n"),
        ("a.tsv", "이름\t값\n".encode()),
        ("a.json", b'  \n {"a": 1}'),
        ("a.json", b"[1, 2]"),
        ("a.jsonl", b'{"a":1}\n{"a":2}\n'),
        ("a.txt", b"hello"),
        ("README.md", "# 제목\n".encode()),
        ("t.parquet", b"PAR1" + b"\x00" * 16 + b"PAR1"),
        ("x.h5", HDF5 + b"rest"),
        ("x.hdf5", HDF5 + b"rest"),
        ("x.nc", b"CDF\x01rest"),
        ("x.nc", b"CDF\x02rest"),
        ("x.nc", HDF5 + b"rest"),
    ],
)
def test_valid_files_are_verified(path: str, data: bytes) -> None:
    assert run(path, data) == Outcome("VERIFIED", None, "SKIPPED")


def test_utf8_character_split_at_the_sniff_boundary_is_fine() -> None:
    assert run("a.txt", "가".encode() * 5000).status == "VERIFIED"


@pytest.mark.parametrize(
    ("path", "data"),
    [
        ("a.csv", b"a,b\x00\n"),
        ("a.csv", b"\xff\xfe\xfa"),
        ("a.json", b"hello"),
        ("a.json", b"   "),
        ("t.parquet", b"PAR1" + b"\x00" * 16 + b"XXXX"),
        ("t.parquet", b"PAR1"),
        ("x.h5", b"not hdf5 at all"),
        ("x.nc", b"CDF\x05rest"),
        ("a.zip", b"not a zip file"),
    ],
)
def test_type_mismatch(path: str, data: bytes) -> None:
    assert run(path, data) == Outcome("FAILED", "TYPE_MISMATCH")


def test_checksum_size_and_missing_object() -> None:
    assert run("a.csv", b"a,b\n", declared=b"x,y\n") == Outcome("FAILED", "CHECKSUM_MISMATCH")
    assert run("a.csv", b"a,b\n", size=99) == Outcome("FAILED", "SIZE_MISMATCH")
    empty = MemoryObjectStore("b")
    outcome = evaluate_object(empty, key="gone", size=1, sha256="0" * 64, path="a.csv", scanner=Scanner())
    assert outcome == Outcome("FAILED", "OBJECT_MISSING")


def test_malware_hook() -> None:
    assert run("a.csv", b"a,b\n", scanner=Scanner("INFECTED")) == Outcome(
        "FAILED", "MALWARE_DETECTED", "INFECTED"
    )
    assert run("a.csv", b"a,b\n", scanner=Scanner("CLEAN")) == Outcome("VERIFIED", None, "CLEAN")


def test_safe_zip_is_verified() -> None:
    assert (
        run("bundle.zip", make_zip({"data/a.csv": b"a,b\n1,2\n", "README.md": b"# x"})).status == "VERIFIED"
    )


def test_at09_compression_ratio_of_1000_is_archive_unsafe() -> None:
    bomb = make_zip({"zeros.bin": b"\x00" * (10 * 1024 * 1024)}, compression=zipfile.ZIP_DEFLATED)
    assert run("bomb.zip", bomb) == Outcome("FAILED", "ARCHIVE_UNSAFE")


@pytest.mark.parametrize(
    "name", ["../evil.txt", "a/../../evil.txt", "/etc/passwd", "C:/windows/x", "a\\..\\b"]
)
def test_dangerous_entry_names(name: str) -> None:
    assert run("a.zip", make_zip({name: b"x"})) == Outcome("FAILED", "ARCHIVE_UNSAFE")


def test_symlink_entries_are_unsafe() -> None:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        info = zipfile.ZipInfo("link")
        info.create_system = 3
        info.external_attr = (stat.S_IFLNK | 0o777) << 16
        archive.writestr(info, "target")
    assert run("a.zip", buffer.getvalue()) == Outcome("FAILED", "ARCHIVE_UNSAFE")


def test_too_many_entries_and_too_much_data(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(verification, "ZIP_MAX_ENTRIES", 3)
    assert run("a.zip", make_zip({f"f{i}.txt": b"x" for i in range(5)})) == Outcome(
        "FAILED", "ARCHIVE_UNSAFE"
    )
    monkeypatch.setattr(verification, "ZIP_MAX_ENTRIES", 10_000)
    monkeypatch.setattr(verification, "ZIP_MAX_UNCOMPRESSED", 10)
    assert run("a.zip", make_zip({"a.txt": b"x" * 6, "b.txt": b"y" * 6})) == Outcome(
        "FAILED", "ARCHIVE_UNSAFE"
    )


def test_truncated_zip_is_unsafe() -> None:
    data = make_zip({"a.txt": b"hello"})
    assert run("a.zip", data[:-10]) == Outcome("FAILED", "ARCHIVE_UNSAFE")


def test_range_reader_seeks_and_reads() -> None:
    store = MemoryObjectStore("b")
    store.put("k", b"0123456789", "x")
    reader = io.BufferedReader(RangeReader(store, "k", 10), 4)
    reader.seek(-3, io.SEEK_END)
    assert reader.read() == b"789"
    reader.seek(2)
    assert reader.read(3) == b"234"
    assert reader.tell() == 5


def _session_of(db: PgUrls, file_id: UUID) -> UUID:
    row = rows(db, "SELECT upload_session_id FROM catalog.dataset_files WHERE file_id = :id", id=file_id)[0]
    return UUID(str(row["upload_session_id"]))


def test_apply_outcome_ignores_a_row_reused_by_a_newer_session(db: PgUrls) -> None:  # ABA guard
    version_id = insert_version(db, insert_dataset(db))
    file_id = insert_file(db, version_id, path="a.csv", status="UPLOADED")
    read_session = _session_of(db, file_id)
    new_session = new_id()
    execute(
        db,
        "INSERT INTO catalog.upload_sessions (upload_session_id, dataset_version_id, status, created_by,"
        " expires_at) VALUES (:s, :v, 'OPEN', :v, now() + interval '1 hour')",
        s=new_session,
        v=version_id,
    )
    execute(
        db,
        "UPDATE catalog.dataset_files SET upload_session_id = :s, status = 'UPLOADED' WHERE file_id = :f",
        s=new_session,
        f=file_id,
    )
    with session_factory(db.app)() as session, session.begin():
        assert apply_outcome(session, file_id, read_session, Outcome("FAILED", "CHECKSUM_MISMATCH")) is False
    assert rows(db, "SELECT status FROM catalog.dataset_files WHERE file_id = :f", f=file_id) == [
        {"status": "UPLOADED"}
    ]


def test_apply_outcome_only_touches_uploaded_rows(db: PgUrls) -> None:
    version_id = insert_version(db, insert_dataset(db))
    uploaded = insert_file(db, version_id, path="a.csv", status="UPLOADED")
    failed = insert_file(db, version_id, path="b.csv", status="FAILED")
    up_session = _session_of(db, uploaded)
    with session_factory(db.app)() as session, session.begin():
        assert apply_outcome(session, uploaded, up_session, Outcome("VERIFIED", None, "SKIPPED")) is True
        assert apply_outcome(session, uploaded, up_session, Outcome("FAILED", "CHECKSUM_MISMATCH")) is False
        assert apply_outcome(session, failed, up_session, Outcome("VERIFIED")) is False
    [row] = rows(db, "SELECT status, verified_at FROM catalog.dataset_files WHERE file_id = :id", id=uploaded)
    assert row["status"] == "VERIFIED" and row["verified_at"] is not None
    assert isinstance(uploaded, UUID)


class RecordingStore(MemoryObjectStore):
    def __init__(self, bucket: str) -> None:
        super().__init__(bucket)
        self.max_range = 0

    def read_range(self, key: str, start: int, end: int) -> bytes:
        self.max_range = max(self.max_range, end - start + 1)
        return super().read_range(key, start, end)


def _zip64_eocd(entries: int, directory_size: int, record_offset: int) -> bytes:
    record = struct.pack("<4sQHHIIQQQQ", b"PK\x06\x06", 44, 45, 45, 0, 0, entries, entries, directory_size, 0)
    locator = struct.pack("<4sIQI", b"PK\x06\x07", 0, record_offset, 1)
    eocd = struct.pack("<4sHHHHIIH", b"PK\x05\x06", 0, 0, 0xFFFF, 0xFFFF, 0xFFFFFFFF, 0xFFFFFFFF, 0)
    return record + locator + eocd


def test_zip64_huge_central_directory_is_unsafe_without_a_large_read() -> None:
    body = b"PK\x03\x04" + b"\x00" * (40 * 1024 * 1024)
    data = body + _zip64_eocd(1, 40 * 1024 * 1024, len(body))
    store = RecordingStore("b")
    store.put("k", data, "x")
    outcome = evaluate_object(
        store,
        key="k",
        size=len(data),
        sha256=hashlib.sha256(data).hexdigest(),
        path="a.zip",
        scanner=Scanner("SKIPPED"),
    )
    assert outcome == Outcome("FAILED", "ARCHIVE_UNSAFE")
    assert store.max_range <= verification.ZIP_MAX_CENTRAL_DIRECTORY


def _plain_eocd(entries: int = 1, directory_size: int = 10) -> bytes:
    return struct.pack("<4sHHHHIIH", b"PK\x05\x06", 0, 0, entries, entries, directory_size, 0, 0)


def _hostile_blob(directory: int) -> bytes:
    """Non-sentinel EOCD preceded by a zip64 record+locator declaring a huge directory (zipfile honours these)."""
    body = b"PK\x03\x04" + b"\x00" * directory
    record = struct.pack(
        "<4sQHHIIQQQQ", b"PK\x06\x06", 44, 45, 45, 0, 0, 1, 1, directory, len(body) - directory
    )
    locator = struct.pack("<4sIQI", b"PK\x06\x07", 0, len(body), 1)
    return body + record + locator + _plain_eocd()


def _run_recorded(data: bytes) -> tuple[Outcome, int]:
    store = RecordingStore("b")
    store.put("k", data, "x")
    outcome = evaluate_object(
        store,
        key="k",
        size=len(data),
        sha256=hashlib.sha256(data).hexdigest(),
        path="a.zip",
        scanner=Scanner("SKIPPED"),
    )
    return outcome, store.max_range


def test_zip64_too_many_entries_and_missing_locator_are_unsafe() -> None:
    body = b"PK\x03\x04" + b"\x00" * 100
    outcome, max_range = _run_recorded(body + _zip64_eocd(10**9, 100, len(body)))
    assert outcome == Outcome("FAILED", "ARCHIVE_UNSAFE")
    assert max_range <= verification.ZIP_MAX_CENTRAL_DIRECTORY
    eocd = struct.pack("<4sHHHHIIH", b"PK\x05\x06", 0, 0, 0xFFFF, 0xFFFF, 0xFFFFFFFF, 0xFFFFFFFF, 0)
    outcome, max_range = _run_recorded(body + eocd)
    assert outcome == Outcome("FAILED", "ARCHIVE_UNSAFE")
    assert max_range <= verification.ZIP_MAX_CENTRAL_DIRECTORY


def test_non_sentinel_eocd_with_hostile_zip64_record_is_unsafe() -> None:
    outcome, max_range = _run_recorded(_hostile_blob(40 * 1024 * 1024))
    assert outcome == Outcome("FAILED", "ARCHIVE_UNSAFE")
    assert max_range <= verification.ZIP_MAX_CENTRAL_DIRECTORY


def test_range_reader_cap_holds_even_if_eocd_check_is_bypassed(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(verification, "_eocd_ok", lambda store, key, size: True)
    outcome, max_range = _run_recorded(_hostile_blob(40 * 1024 * 1024))
    assert outcome == Outcome("FAILED", "ARCHIVE_UNSAFE")
    assert max_range <= verification.ZIP_MAX_CENTRAL_DIRECTORY + verification.ZIP_READ_SLACK


def test_legitimate_zip64_archive_is_verified(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(zipfile, "ZIP_FILECOUNT_LIMIT", 1)
    raw = make_zip({"a.txt": b"hello", "b.txt": b"world"})
    monkeypatch.undo()
    assert b"PK\x06\x06" in raw  # zip64 end of central directory was written
    index = raw.rfind(b"PK\x05\x06")
    patched = raw[:index] + struct.pack(
        "<4sHHHHIIH", b"PK\x05\x06", 0, 0, 0xFFFF, 0xFFFF, 0xFFFFFFFF, 0xFFFFFFFF, 0
    )
    assert run("z.zip", patched).status == "VERIFIED"


def test_oversized_object_stops_streaming_early() -> None:
    class CountingStore(MemoryObjectStore):
        read_bytes = 0

        def open_stream(self, key: str, byte_range: tuple[int, int] | None = None) -> BinaryIO:
            inner = super().open_stream(key, byte_range)
            outer = self

            class Body(io.BytesIO):
                def read(self, n: int | None = -1) -> bytes:
                    chunk = inner.read(n)
                    outer.read_bytes += len(chunk)
                    return chunk

            return Body()

    store = CountingStore("b")
    store.put("k", b"x" * (4 * verification.HASH_CHUNK), "x")
    outcome = evaluate_object(store, key="k", size=10, sha256="0" * 64, path="a.txt", scanner=Scanner())
    assert outcome == Outcome("FAILED", "SIZE_MISMATCH")
    assert store.read_bytes == verification.HASH_CHUNK


def test_object_vanishing_during_sniff_or_zip_pass_is_object_missing(monkeypatch: pytest.MonkeyPatch) -> None:
    def vanish(store: object, key: str, size: int) -> bool:
        raise ObjectMissing(key)

    monkeypatch.setattr(verification, "zip_is_safe", vanish)
    assert run("a.zip", make_zip({"a.txt": b"x"})) == Outcome("FAILED", "OBJECT_MISSING")


def test_unexpected_scan_status_fails_closed() -> None:
    assert run("a.csv", b"a,b\n", scanner=Scanner("ERROR")) == Outcome(
        "FAILED", "MALWARE_DETECTED", "SKIPPED"
    )


def _verify(
    db: PgUrls, outcome_data: bytes, *, declared: bytes, status: str = "UPLOADED", pre_apply: bool = False
) -> tuple[Outcome, bool]:
    version_id = insert_version(db, insert_dataset(db))
    file_id = insert_file(
        db,
        version_id,
        path="a.csv",
        size=len(declared),
        sha=hashlib.sha256(declared).hexdigest(),
        status=status,
    )
    f = rows(db, "SELECT * FROM catalog.dataset_files WHERE file_id = :id", id=file_id)[0]
    store = MemoryObjectStore(f["storage_bucket"])
    store.put(f["storage_key"], outcome_data, "text/csv")
    deps = SimpleNamespace(
        storage=SimpleNamespace(for_bucket=lambda bucket: store), scanner=Scanner("SKIPPED")
    )
    with session_factory(db.app)() as session, session.begin():
        outcome = verify_in_session(session, deps, f)  # type: ignore[arg-type]
    return outcome, f["storage_key"] in store.objects


def test_verify_in_session_deletes_object_on_failure(db: PgUrls) -> None:
    outcome, present = _verify(db, b"zzzz", declared=b"a,b\n")
    assert outcome == Outcome("FAILED", "CHECKSUM_MISMATCH")
    assert present is False


def test_verify_in_session_keeps_verified_object(db: PgUrls) -> None:
    outcome, present = _verify(db, b"a,b\n", declared=b"a,b\n")
    assert outcome.status == "VERIFIED"
    assert present is True


def test_verify_in_session_keeps_object_when_row_is_no_longer_uploaded(db: PgUrls) -> None:
    outcome, present = _verify(db, b"zzzz", declared=b"a,b\n", status="VERIFIED")
    assert outcome.failed
    assert present is True


def test_zipfile_native_zip64_archive_is_verified(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(zipfile, "ZIP_FILECOUNT_LIMIT", 1)
    raw = make_zip({"a.txt": b"hello", "b.txt": b"world"})
    monkeypatch.undo()
    assert b"PK\x06\x06" in raw and b"PK\x06\x07" in raw
    assert run("z.zip", raw).status == "VERIFIED"
