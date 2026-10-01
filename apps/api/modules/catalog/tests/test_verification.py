import hashlib
import io
import stat
import zipfile
from uuid import UUID

import pytest

from api.modules.catalog import verification
from api.modules.catalog.interfaces import ScanResult
from api.modules.catalog.testing import MemoryObjectStore
from api.modules.catalog.tests.support import insert_dataset, insert_file, insert_version, rows
from api.modules.catalog.verification import Outcome, RangeReader, apply_outcome, evaluate_object
from api.platform.db import session_factory
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


def test_apply_outcome_only_touches_uploaded_rows(db: PgUrls) -> None:
    version_id = insert_version(db, insert_dataset(db))
    uploaded = insert_file(db, version_id, path="a.csv", status="UPLOADED")
    failed = insert_file(db, version_id, path="b.csv", status="FAILED")
    with session_factory(db.app)() as session, session.begin():
        assert apply_outcome(session, uploaded, Outcome("VERIFIED", None, "SKIPPED")) is True
        assert apply_outcome(session, uploaded, Outcome("FAILED", "CHECKSUM_MISMATCH")) is False
        assert apply_outcome(session, failed, Outcome("VERIFIED")) is False
    [row] = rows(db, "SELECT status, verified_at FROM catalog.dataset_files WHERE file_id = :id", id=uploaded)
    assert row["status"] == "VERIFIED" and row["verified_at"] is not None
    assert isinstance(uploaded, UUID)
