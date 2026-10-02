"""Profile generation in a child process (controller ruling P24).

Why a child: pyarrow allocates in C++ from sizes inside the file (e.g. a small zstd data page declaring a huge
uncompressed size). The profiler bounds what it can see, but only an address-space limit bounds every allocation.
RLIMIT_AS cannot be applied to one thread of the worker, so each file is profiled by a fresh interpreter started
with `python -P -c BOOTSTRAP` (fork+exec, so it is safe in a threaded Dramatiq worker; no preexec_fn), which sets
RLIMIT_AS on itself before importing pyarrow and uses the system allocator with one CPU/IO thread so virtual
size tracks real use.

Why ranged reads through a pipe (not storage access in the child): the child gets no credentials, no environment
secrets, no DB connection and no network client; the parent keeps the storage adapter (with its socket timeouts)
and its exception mapping, and the same code path works for every ObjectStore (S3 and the in-memory test store).
The child asks for byte ranges, so parquet random access and CSV streaming both work, and only the bytes the
profiler reads ever cross the pipe.

Frame: 1-byte op + 4-byte big-endian length + payload.
  parent -> child: J (job JSON) | o (stream id >I) | d (data, empty = EOF) | e (error code)
  child -> parent: O (>QQ start, end) | R (>II stream id, max bytes) | C (>I stream id) | F (outcome JSON)

The parent never decodes anything: it relays bytes, enforces a wall-clock deadline (timeout + startup margin) with
poll(), and kills the child on any exit path. A child that dies (RLIMIT_AS, signal, crash, protocol violation)
gives GENERATION_FAILED; the wall clock gives TIMEOUT; storage errors in the parent propagate (lease retry).

The child's output is untrusted (it processes hostile bytes): the parent re-validates the result against the
contract shapes and bounds (validate.py), caps child stderr at STDERR_CAP bytes (the rest is discarded; the child
also runs under RLIMIT_FSIZE), and caps the child's requests (REQUEST_BUDGET frames, byte_budget() bytes served).
The child also gets RLIMIT_CPU (timeout + margin) and PR_SET_PDEATHSIG(SIGKILL), so it cannot outlive the worker
thread that started it."""

import contextlib
import json
import logging
import math
import os
import select
import struct
import subprocess
import sys
import time
from collections.abc import Callable
from dataclasses import asdict
from functools import partial
from pathlib import Path
from typing import Any, BinaryIO

from api.modules.catalog.objects import ObjectMissing, StorageUnavailable
from api.modules.catalog.previews.profile import FieldHint, PreviewLimits
from api.modules.catalog.previews.validate import InvalidOutcome, validate_result

logger = logging.getLogger("nais.catalog.previews")

HEADER = struct.Struct(">cI")
STARTUP_MARGIN_S = 15.0  # interpreter + pyarrow import, on top of the profiler's own deadline
MAX_STREAMS = 64
MAX_READ = 1 << 20
MAX_REQUEST = 32
EXIT_GRACE_S = 5.0
STDERR_CAP = 64 << 10  # bytes of child stderr kept for the log; the rest is read and discarded
REQUEST_BUDGET = 50_000  # O + R frames per profile (each RangeReader read is one O + one R + one C)
APPS_ROOT = str(Path(__file__).resolve().parents[4])  # .../apps (contains the api package)

BOOTSTRAP = """
import sys, types
root = sys.argv[4]
sys.path.insert(0, root)
for name in ("api.modules.catalog", "api.modules.catalog.previews"):
    module = types.ModuleType(name)
    module.__path__ = [root + "/" + name.replace(".", "/")]
    sys.modules[name] = module
from api.modules.catalog.previews.child import main
main()
"""


PR_SET_DUMPABLE = 4


def protect_worker_environ() -> bool:
    """prctl(PR_SET_DUMPABLE, 0) on the worker (Linux, best effort): its /proc/<pid>/environ, mem and fds become
    unreadable to other processes of the same uid, i.e. to profiling children that would otherwise read the
    worker's storage/DB secrets. Children re-gain dumpability at exec, which is fine: they hold no secrets.
    Returns whether the call succeeded."""
    if not sys.platform.startswith("linux"):
        return False
    try:
        import ctypes

        libc = ctypes.CDLL(None, use_errno=True)
        return bool(libc.prctl(PR_SET_DUMPABLE, 0, 0, 0, 0) == 0)
    except (OSError, AttributeError):
        return False


def byte_budget(limits: PreviewLimits) -> int:
    """Bytes the parent serves to one child. The profiler itself stops at 2 x max_bytes of parquet data pages
    (checked before each <= 1 MiB read), max_bytes of page-header peeks and the footer, or max_bytes plus one
    capped record for CSV/TSV; 3 x max_bytes + 16 MiB covers all of those, so only a misbehaving child hits it."""
    return 3 * limits.max_bytes + (16 << 20)


def child_command(memory_limit: int, cpu_seconds: int) -> list[str]:
    return [
        sys.executable,
        "-P",
        "-c",
        BOOTSTRAP,
        str(memory_limit),
        str(cpu_seconds),
        str(os.getpid()),
        APPS_ROOT,
    ]


def child_env() -> dict[str, str]:
    """Nothing from the worker's environment: PATH, the locale and non-secret allocator tuning only (no
    PYTHONPATH either: the bootstrap gets the source root as an argument)."""
    return {
        "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
        "LANG": "C.UTF-8",
        "ARROW_DEFAULT_MEMORY_POOL": "system",
        "MALLOC_ARENA_MAX": "2",
        "OMP_NUM_THREADS": "1",
        "PYTHONDONTWRITEBYTECODE": "1",
    }


class _WallClock(Exception):
    pass


class _ChildGone(Exception):
    pass


class _Stderr:
    """Non-blocking drain of the child's stderr: keeps the first STDERR_CAP bytes, discards the rest."""

    def __init__(self, fd: int) -> None:
        self.fd = fd
        os.set_blocking(fd, False)
        self.kept = bytearray()
        self.discarded = 0
        self.open = True

    def drain(self, max_reads: int = 64) -> None:
        for _ in range(max_reads):
            if not self.open:
                return
            try:
                chunk = os.read(self.fd, 1 << 16)
            except BlockingIOError:
                return
            except OSError:
                self.open = False
                return
            if not chunk:
                self.open = False
                return
            room = STDERR_CAP - len(self.kept)
            self.kept += chunk[:room]
            self.discarded += max(0, len(chunk) - room)

    def text(self) -> str:
        tail = self.kept[-2048:].decode(errors="replace")
        return tail + (f" [+{self.discarded} bytes discarded]" if self.discarded else "")


class _Conn:
    def __init__(self, proc: subprocess.Popen[bytes], deadline: float, stderr: _Stderr) -> None:
        assert proc.stdin is not None and proc.stdout is not None
        self.r, self.w = proc.stdout.fileno(), proc.stdin.fileno()
        os.set_blocking(self.r, False)
        os.set_blocking(self.w, False)
        self.deadline = deadline
        self.stderr = stderr
        self.buf = bytearray()

    def check_deadline(self) -> None:
        if time.monotonic() >= self.deadline:
            raise _WallClock

    def _wait(self, fd: int, event: int) -> None:
        while True:
            left = self.deadline - time.monotonic()
            if left <= 0:
                raise _WallClock
            poller = select.poll()
            poller.register(fd, event)
            if self.stderr.open:
                poller.register(self.stderr.fd, select.POLLIN)
            ready = poller.poll(max(1, int(left * 1000)))
            if not ready:
                raise _WallClock
            if any(f == self.stderr.fd for f, _ in ready):
                self.stderr.drain()
            if any(f == fd for f, _ in ready):
                return

    def _fill(self, n: int) -> None:
        while len(self.buf) < n:
            self._wait(self.r, select.POLLIN)
            try:
                chunk = os.read(self.r, max(1 << 16, n - len(self.buf)))
            except BlockingIOError:
                continue
            if not chunk:
                raise _ChildGone("child closed its pipe")
            self.buf += chunk

    def recv(self, max_result: int) -> tuple[bytes, bytes]:
        self._fill(HEADER.size)
        op, length = HEADER.unpack(bytes(self.buf[: HEADER.size]))
        if length > (max_result if op == b"F" else MAX_REQUEST):
            raise _ChildGone(f"frame {op!r} of {length} bytes")
        self._fill(HEADER.size + length)
        payload = bytes(self.buf[HEADER.size : HEADER.size + length])
        del self.buf[: HEADER.size + length]
        return op, payload

    def send(self, op: bytes, payload: bytes = b"") -> None:
        view = memoryview(HEADER.pack(op, len(payload)) + payload)
        while view:
            self._wait(self.w, select.POLLOUT)
            try:
                view = view[os.write(self.w, view) :]
            except BlockingIOError:
                continue
            except BrokenPipeError as exc:
                raise _ChildGone("child closed its pipe") from exc


def _storage(conn: _Conn, call: Callable[[], Any]) -> Any:
    """Storage calls in the parent: the wall clock is checked first (a single call is bounded by the S3 socket
    timeouts and botocore's retries). Typed storage errors propagate; anything else (a read timeout or reset
    inside a streaming body) is StorageUnavailable (the lease retries)."""
    conn.check_deadline()
    try:
        return call()
    except (StorageUnavailable, ObjectMissing):
        raise
    except Exception as exc:
        raise StorageUnavailable(f"{type(exc).__name__}: {exc}") from exc


def _serve(
    conn: _Conn, open_range: Callable[[int, int], BinaryIO], size: int, max_result: int, budget: int
) -> Any:
    streams: dict[int, BinaryIO] = {}
    next_id = requests = served = 0
    try:
        while True:
            op, payload = conn.recv(max_result)
            if op in (b"O", b"R"):
                requests += 1
                if requests > REQUEST_BUDGET:
                    raise _ChildGone(f"more than {REQUEST_BUDGET} requests")
            if op == b"O" and len(payload) == 16:
                start, end = struct.unpack(">QQ", payload)
                if not 0 <= start <= end < size or len(streams) >= MAX_STREAMS:
                    conn.send(b"e", b"INVALID")
                    continue
                stream = _storage(conn, partial(open_range, start, end))
                next_id += 1
                streams[next_id] = stream
                conn.send(b"o", struct.pack(">I", next_id))
            elif op == b"R" and len(payload) == 8:
                sid, n = struct.unpack(">II", payload)
                found = streams.get(sid)
                if found is None:
                    conn.send(b"e", b"INVALID")
                    continue
                want = min(n, MAX_READ, budget - served)
                if want <= 0:
                    raise _ChildGone(f"more than {budget} bytes requested")
                data = bytes(_storage(conn, partial(found.read, want)))[:want]
                served += len(data)
                conn.send(b"d", data)
            elif op == b"C" and len(payload) == 4:
                closing = streams.pop(struct.unpack(">I", payload)[0], None)
                if closing is not None:
                    closing.close()
            elif op == b"F":
                try:
                    return json.loads(payload)
                except Exception as exc:  # ValueError, RecursionError, ...: an undecodable outcome
                    raise _ChildGone(f"undecodable outcome: {type(exc).__name__}") from None
            else:
                raise _ChildGone(f"unexpected frame {op!r}")
    finally:
        for stream in streams.values():
            try:
                stream.close()
            except Exception:
                logger.debug("closing a preview source stream failed", exc_info=True)


def _checked(outcome: Any, limits: PreviewLimits) -> dict[str, Any] | None:
    """The outcome if it is one the parent accepts, else None (GENERATION_FAILED)."""
    if not isinstance(outcome, dict):
        return None
    if set(outcome) == {"result"}:
        try:
            return {"result": validate_result(outcome["result"], limits)}
        except InvalidOutcome as exc:
            logger.warning("preview child returned an invalid result", extra={"reason": str(exc)})
            return None
    if set(outcome) == {"failure"} and outcome["failure"] in ("UNPARSEABLE", "TIMEOUT"):
        return {"failure": outcome["failure"]}
    return None


def run_profile(
    open_range: Callable[[int, int], BinaryIO],
    size: int,
    *,
    path: str,
    hints: dict[str, FieldHint],
    limits: PreviewLimits,
    timeout_s: float,
    memory_limit: int,
    startup_margin_s: float = STARTUP_MARGIN_S,
    command: list[str] | None = None,
) -> dict[str, Any]:
    """{"result": {...}} (validated) or {"failure": UNPARSEABLE | TIMEOUT | GENERATION_FAILED}; storage errors
    raise."""
    job = {
        "size": size,
        "path": path,
        "hints": {name: asdict(hint) for name, hint in hints.items()},
        "limits": asdict(limits),
        "timeout": timeout_s,
    }
    max_result = limits.preview_bytes + limits.profile_bytes + (1 << 20)
    cpu_seconds = math.ceil(timeout_s + startup_margin_s)
    proc = subprocess.Popen(
        command or child_command(memory_limit, cpu_seconds),
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=child_env(),
        close_fds=True,
    )
    assert proc.stderr is not None
    stderr = _Stderr(proc.stderr.fileno())
    failure: str
    try:
        conn = _Conn(proc, time.monotonic() + timeout_s + startup_margin_s, stderr)
        conn.send(b"J", json.dumps(job).encode())
        outcome = _checked(_serve(conn, open_range, size, max_result, byte_budget(limits)), limits)
        if outcome is not None:
            return outcome
        # includes a child "storage" outcome: real storage errors raise in the parent, so that one can only come
        # from an INVALID reply to an out-of-range or excess request
        failure = "GENERATION_FAILED"
    except _WallClock:
        proc.kill()
        failure = "TIMEOUT"
    except _ChildGone:
        proc.kill()
        failure = "GENERATION_FAILED"
    except BaseException:  # storage error in the parent, or the actor's time limit: never leave the child
        proc.kill()
        raise
    finally:
        _reap(proc, stderr)
    logger.warning(
        "preview generation failed in the sandbox",
        extra={
            "path": path,
            "failure_code": failure,
            "returncode": proc.returncode,
            "stderr_tail": stderr.text(),
        },
    )
    return {"failure": failure}


def _reap(proc: subprocess.Popen[bytes], stderr: _Stderr) -> None:
    """Wait for the child (it exits by itself after its outcome frame), draining its stderr meanwhile so a
    chatty child cannot block on a full pipe; kill it after EXIT_GRACE_S. Always closes the pipes."""
    end = time.monotonic() + EXIT_GRACE_S
    while proc.poll() is None and time.monotonic() < end:
        stderr.drain()
        time.sleep(0.01)
    if proc.poll() is None:
        proc.kill()
    proc.wait()
    stderr.drain()
    for pipe in (proc.stdin, proc.stdout, proc.stderr):
        if pipe is not None:
            with contextlib.suppress(OSError):
                pipe.close()
