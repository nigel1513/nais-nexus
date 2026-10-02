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
APPS = str(__import__("pathlib").Path(__file__).resolve().parents[4])


def _source(data: bytes):  # type: ignore[no-untyped-def]
    return lambda start, end: io.BytesIO(data[start : end + 1])


def _run(data: bytes, path: str = "m.csv", **kwargs):  # type: ignore[no-untyped-def]
    options = {"timeout_s": 30.0, "memory_limit": 3 * GIB // 2, "limits": PreviewLimits(), **kwargs}
    return run_profile(
        kwargs.pop("open_range", _source(data)),
        len(data),
        path=path,
        hints={"a": FieldHint(unit="m")},
        **{k: v for k, v in options.items() if k != "open_range"},
    )


_PROTOCOL = """
import json, os, struct, sys
H = struct.Struct(">cI")
def rd(n):
    b = b""
    while len(b) < n:
        c = os.read(0, n - len(b))
        if not c:
            sys.exit(0)
        b += c
    return b
def recv():
    op, n = H.unpack(rd(5))
    return op, rd(n)
def send(op, payload=b""):
    os.write(1, H.pack(op, len(payload)) + payload)
recv()
"""


def _hostile(code: str) -> list[str]:
    """A child that speaks the frame protocol and then runs `code` (a compromised or buggy child)."""
    return [sys.executable, "-c", _PROTOCOL + code]


def _valid_result() -> dict:  # type: ignore[type-arg]
    out = _run(CSV)
    assert "result" in out
    return out["result"]  # type: ignore[no-any-return]


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


@pytest.mark.parametrize(
    "mutate",
    [
        lambda r: r.clear(),  # {"result": {}}
        lambda r: r["column_profile"][0].update(name="S" * 6000),  # raw text in the profile
        lambda r: r["column_profile"][0].update(sample=["S1", "S2"]),  # an extra (raw-value) field
        lambda r: r["column_profile"][0].update(top_values=[{"value": "AL", "count": 1}]),
        lambda r: r["preview"]["rows"][0].__setitem__(0, "x" * 100_000),  # an over-long cell
        lambda r: r["preview"]["header"].__setitem__(0, "h" * 201),
        lambda r: r["preview"].update(rows=r["preview"]["rows"] * 2),  # 200 rows
        lambda r: r["preview"]["columns"][0].update(histogram=[{"lower": 0, "upper": 1, "count": 1}] * 21),
        lambda r: r["column_profile"][0].update(missing_ratio=1.5),
        lambda r: r["column_profile"][0].update(distinct_capped="yes"),  # strict types
        lambda r: r.update(rows_sampled=-1),
        lambda r: r.update(format="xlsx"),
        lambda r: r["preview"].update(distributions_truncated=True),  # ruling P17: no such field
        lambda r: r["column_profile"].extend(
            [dict(r["column_profile"][0], description="d" * 200) for _ in range(199)]
        ),  # 200 columns but > 256 KiB
    ],
    ids=[
        "empty",
        "raw-name",
        "extra-field",
        "top-values-in-profile",
        "long-cell",
        "long-header",
        "rows",
        "bins",
        "ratio",
        "strict-bool",
        "negative",
        "format",
        "p17",
        "profile-bytes",
    ],
)
def test_parent_rejects_invalid_child_results(mutate) -> None:  # type: ignore[no-untyped-def]
    import json

    result = _valid_result()
    mutate(result)
    command = _hostile(f"send(b'F', {json.dumps({'result': result}).encode()!r})")
    assert _run(CSV, command=command) == {"failure": "GENERATION_FAILED"}


def test_parent_accepts_a_valid_result_relayed_by_a_child() -> None:
    import json

    result = _valid_result()
    command = _hostile(f"send(b'F', {json.dumps({'result': result}).encode()!r})")
    assert _run(CSV, command=command) == {"result": result}


def test_undecodable_and_unknown_outcomes_are_generation_failed() -> None:
    payloads = ["b'[' * 200_000"] + [
        repr(p) for p in (b"{", b'"x"', b'{"failure": "NOPE"}', b'{"result": {}, "failure": "TIMEOUT"}')
    ]
    for payload in payloads:  # [[[[... raises RecursionError in json.loads
        assert _run(CSV, command=_hostile(f"send(b'F', {payload})")) == {"failure": "GENERATION_FAILED"}


def test_stderr_flood_is_capped_and_does_not_block() -> None:
    code = (
        "import time\nchunk = b'x' * (1 << 20)\nfor _ in range(64):\n    os.write(2, chunk)\n"
        "send(b'F', b'{\"failure\": \"UNPARSEABLE\"}')\nfor _ in range(64):\n    os.write(2, chunk)\n"
    )
    started = time.monotonic()
    assert _run(CSV, command=_hostile(code)) == {"failure": "UNPARSEABLE"}
    assert time.monotonic() - started < 10


def test_request_and_byte_budgets_stop_a_greedy_child() -> None:
    reopen = "while True:\n    send(b'O', struct.pack('>QQ', 0, 9)); op, p = recv(); send(b'C', p)\n"
    started = time.monotonic()
    assert _run(CSV, command=_hostile(reopen)) == {"failure": "GENERATION_FAILED"}
    assert time.monotonic() - started < 20
    data = b"z" * (1 << 20)
    reread = (
        f"while True:\n    send(b'O', struct.pack('>QQ', 0, {len(data) - 1})); op, sid = recv()\n"
        "    while True:\n        send(b'R', sid + struct.pack('>I', 1 << 20)); op, d = recv()\n"
        "        if op != b'd' or not d: break\n    send(b'C', sid)\n"
    )
    small = PreviewLimits(max_bytes=1 << 10)  # budget = 3 KiB + 16 MiB: about 17 passes over 1 MiB
    served: list[int] = []

    def counting(start: int, end: int) -> BinaryIO:
        served.append(end - start + 1)
        return io.BytesIO(data[start : end + 1])

    assert _run(data, command=_hostile(reread), limits=small, open_range=counting) == {
        "failure": "GENERATION_FAILED"
    }
    assert len(served) <= 18


def test_child_applies_its_limits() -> None:
    import os
    import subprocess

    from api.modules.catalog.previews.sandbox import BOOTSTRAP, child_command, child_env

    command = child_command(GIB, 45)
    assert command[4:7] == [str(GIB), "45", str(os.getpid())]
    probe = BOOTSTRAP.replace(
        "from api.modules.catalog.previews.child import main\nmain()",
        "from api.modules.catalog.previews.child import apply_limits\n"
        "apply_limits(int(sys.argv[1]), int(sys.argv[2]), int(sys.argv[3]))\n"
        "import resource\n"
        "print([resource.getrlimit(r)[0] for r in (resource.RLIMIT_AS, resource.RLIMIT_CPU, resource.RLIMIT_FSIZE,"
        " resource.RLIMIT_CORE)])\n"
        "print('pyarrow' in sys.modules, 'sqlalchemy' in sys.modules)",
    )
    out = subprocess.run(
        [*command[:3], probe, *command[4:]], env=child_env(), capture_output=True, text=True, check=True
    ).stdout.split("\n")
    assert out[0] == str([GIB, 45, 64 << 10, 0])
    assert out[1] == "False False"
    # a child whose parent is not the expected one exits at once (PR_SET_PDEATHSIG race guard)
    wrong = [*command[:3], probe, str(GIB), "45", "1", command[-1]]
    assert subprocess.run(wrong, env=child_env(), capture_output=True).returncode == 3


def test_worker_environ_is_unreadable_to_children_after_protection() -> None:
    import os
    import subprocess

    code = (
        "import sys, time\n"
        f"sys.path.insert(0, {APPS!r})\n"
        "from api.modules.catalog.previews.sandbox import protect_worker_environ\n"
        "print(protect_worker_environ(), flush=True)\n"
        "time.sleep(30)\n"
    )
    env = dict(os.environ, NAIS_SECRET_PROBE="s3cret")
    proc = subprocess.Popen([sys.executable, "-c", code], env=env, stdout=subprocess.PIPE, text=True)
    try:
        assert proc.stdout is not None and proc.stdout.readline().strip() == "True"
        with pytest.raises(PermissionError), open(f"/proc/{proc.pid}/environ", "rb") as environ:
            environ.read()
    finally:
        proc.kill()
        proc.wait()


def test_register_worker_protects_the_worker(monkeypatch: pytest.MonkeyPatch) -> None:
    from dramatiq.brokers.stub import StubBroker

    from api.modules.catalog import jobs
    from api.platform.scheduler import Scheduler

    calls: list[bool] = []
    monkeypatch.setattr(jobs, "protect_worker_environ", lambda: calls.append(True) or True)
    jobs.register_worker(StubBroker(), Scheduler())
    assert calls == [True]
