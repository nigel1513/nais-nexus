"""The profiling child process (controller ruling P24): limits, crashes, wall clock, storage errors."""

import io
import struct
import sys
import time
from typing import BinaryIO

import pyarrow as pa
import pyarrow.parquet as pq
import pytest

from api.modules.catalog.objects import ObjectMissing, StorageUnavailable
from api.modules.catalog.previews.profile import FieldHint, PreviewLimits
from api.modules.catalog.previews.sandbox import child_env, run_profile

CSV = b"a,b\n" + b"".join(f"{i},{i % 3}\n".encode() for i in range(500))
GIB = 1 << 30


def _source(data: bytes):  # type: ignore[no-untyped-def]
    return lambda start, end: io.BytesIO(data[start : end + 1])


def _run(data: bytes, path: str = "m.csv", **kwargs):  # type: ignore[no-untyped-def]
    options = {"timeout_s": 30.0, "memory_limit": 3 * GIB // 2, **kwargs}
    return run_profile(
        kwargs.pop("open_range", _source(data)),
        len(data),
        path=path,
        hints={"a": FieldHint(unit="m")},
        limits=PreviewLimits(),
        **{k: v for k, v in options.items() if k != "open_range"},
    )


def test_child_profiles_csv_and_parquet() -> None:
    out = _run(CSV)
    assert out["result"]["rows_sampled"] == 500
    assert out["result"]["column_profile"][0]["unit"] == "m"
    sink = io.BytesIO()
    pq.write_table(pa.table({"x": list(range(50_000)), "s": [str(i % 7) for i in range(50_000)]}), sink)
    out = _run(sink.getvalue(), path="m.parquet")
    assert [c["kind"] for c in out["result"]["preview"]["columns"]] == ["numeric", "categorical"]


def test_child_reports_unparseable_and_its_own_timeout() -> None:
    assert _run(b"a\n" + b"x" * (2 << 20) + b"\n") == {"failure": "UNPARSEABLE"}
    assert _run(b"PAR1garbagePAR1", path="m.parquet") == {"failure": "UNPARSEABLE"}

    def slow(start: int, end: int) -> BinaryIO:
        time.sleep(0.4)
        return io.BytesIO(CSV[start : end + 1])

    big = CSV * 50
    started = time.monotonic()
    out = _run(big, open_range=slow, timeout_s=0.2, startup_margin_s=10.0)
    assert out == {"failure": "TIMEOUT"} and time.monotonic() - started < 10


def test_child_crash_is_generation_failed() -> None:
    for code in ("import os; os.abort()", "import sys; sys.exit(3)", "import os; os.kill(os.getpid(), 9)"):
        assert _run(CSV, command=[sys.executable, "-c", code]) == {"failure": "GENERATION_FAILED"}
    # protocol violation: garbage on stdout instead of frames
    garbage = "import sys; sys.stdout.buffer.write(b'Z' + b'\\xff' * 4); sys.stdout.flush(); import time; time.sleep(30)"
    started = time.monotonic()
    assert _run(CSV, command=[sys.executable, "-c", garbage]) == {"failure": "GENERATION_FAILED"}
    assert time.monotonic() - started < 10


def test_wall_clock_kills_a_hung_child() -> None:
    hung = [sys.executable, "-c", "import time; time.sleep(60)"]
    started = time.monotonic()
    assert _run(CSV, command=hung, timeout_s=0.3, startup_margin_s=0.3) == {"failure": "TIMEOUT"}
    assert time.monotonic() - started < 5


def _zz(n: int) -> bytes:
    n, out = (n << 1) ^ (n >> 63), b""
    while n >= 0x80:
        out, n = out + bytes([n & 0x7F | 0x80]), n >> 7
    return out + bytes([n])


def plain_page_bomb(declared: int) -> bytes:
    """A PLAIN int64 zstd data page whose header declares `declared` uncompressed bytes (ruling P24's residual
    case: not header-checked by the profiler; pyarrow allocates the declared size before decompressing)."""
    sink = io.BytesIO()
    table = pa.table({"n": pa.array(range(1000), pa.int64())})
    pq.write_table(
        table, sink, use_dictionary=False, compression="zstd", store_schema=False, write_statistics=False
    )
    data = sink.getvalue()
    meta = pq.ParquetFile(io.BytesIO(data)).metadata.row_group(0).column(0)
    start, total = meta.data_page_offset, meta.total_compressed_size
    head = data[start : start + 3]
    assert head == b"\x15\x00\x15"
    size_end = start + 3
    while data[size_end] & 0x80:
        size_end += 1
    new = head + _zz(declared)
    shift = len(new) - (size_end + 1 - start)
    body = data[:start] + new + data[size_end + 1 :]
    footer_at = len(data) - 8 - struct.unpack("<i", data[-8:-4])[0]
    footer = data[footer_at : len(data) - 8]
    old = b"\x16" + _zz(total) + b"\x26" + _zz(start)
    assert footer.count(old) == 1
    footer = footer.replace(old, b"\x16" + _zz(total + shift) + b"\x26" + _zz(start))
    return body[: footer_at + shift] + footer + struct.pack("<i", len(footer)) + b"PAR1"


def test_memory_limit_is_what_refuses_the_hostile_allocation() -> None:
    bomb = plain_page_bomb(2_000_000_000)
    # within a generous limit pyarrow gets its 2 GB buffer (untouched) and then reports corrupt zstd data
    assert _run(bomb, path="m.parquet", memory_limit=8 * GIB) == {"failure": "UNPARSEABLE"}
    # under the limit the allocation itself is refused inside the child
    assert _run(bomb, path="m.parquet", memory_limit=GIB) == {"failure": "GENERATION_FAILED"}


@pytest.mark.parametrize("error", [StorageUnavailable("down"), ObjectMissing("k")])
def test_storage_errors_in_the_parent_propagate_and_kill_the_child(error: Exception) -> None:
    def failing(start: int, end: int) -> BinaryIO:
        raise error

    with pytest.raises(type(error)):
        _run(CSV, open_range=failing)


def test_read_errors_inside_a_stream_are_storage_unavailable() -> None:
    class Broken(io.RawIOBase):
        def readable(self) -> bool:
            return True

        def readinto(self, b) -> int:  # type: ignore[no-untyped-def]
            raise ConnectionResetError("reset")

    with pytest.raises(StorageUnavailable):
        _run(CSV, open_range=lambda start, end: Broken())


def test_child_environment_has_no_secrets(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("STORAGE_INST_A_SECRET_KEY", "s3cret")
    monkeypatch.setenv("DATABASE_URL", "postgresql://u:p@h/db")
    env = child_env()
    assert not any("SECRET" in k or "DATABASE" in k or "STORAGE" in k for k in env)
    assert env["ARROW_DEFAULT_MEMORY_POOL"] == "system"


def test_out_of_range_requests_are_refused() -> None:
    script = """
import json, os, struct, sys
H = struct.Struct(">cI")
def recv():
    op, n = H.unpack(os.read(0, 5)); data = b""
    while len(data) < n: data += os.read(0, n - len(data))
    return op, data
def send(op, payload): os.write(1, H.pack(op, len(payload)) + payload)
recv()
send(b"O", struct.pack(">QQ", 10, 1 << 40))
op, data = recv()
send(b"F", json.dumps({"storage": data.decode(), "op": op.decode()}).encode())
"""
    assert _run(CSV, command=[sys.executable, "-c", script]) == {"failure": "GENERATION_FAILED"}
