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
gives GENERATION_FAILED; the wall clock gives TIMEOUT; storage errors in the parent propagate (lease retry)."""

import contextlib
import json
import logging
import os
import select
import struct
import subprocess
import sys
import tempfile
import time
from collections.abc import Callable
from dataclasses import asdict
from functools import partial
from pathlib import Path
from typing import Any, BinaryIO

from api.modules.catalog.objects import ObjectMissing, StorageUnavailable
from api.modules.catalog.previews.profile import FieldHint, PreviewLimits

logger = logging.getLogger("nais.catalog.previews")

HEADER = struct.Struct(">cI")
STARTUP_MARGIN_S = 15.0  # interpreter + pyarrow import, on top of the profiler's own deadline
MAX_STREAMS = 64
MAX_READ = 1 << 20
MAX_REQUEST = 32
EXIT_GRACE_S = 5.0
APPS_ROOT = str(Path(__file__).resolve().parents[4])  # .../apps (contains the api package)

BOOTSTRAP = """
import sys, types
root = sys.argv[2]
for name in ("api.modules.catalog", "api.modules.catalog.previews"):
    module = types.ModuleType(name)
    module.__path__ = [root + "/" + name.replace(".", "/")]
    sys.modules[name] = module
from api.modules.catalog.previews.child import main
main()
"""


def child_command(memory_limit: int) -> list[str]:
    return [sys.executable, "-P", "-c", BOOTSTRAP, str(memory_limit), APPS_ROOT]


def child_env() -> dict[str, str]:
    """Nothing from the worker's environment except what an interpreter needs (no storage/DB secrets)."""
    return {
        "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
        "PYTHONPATH": APPS_ROOT,
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


class _Conn:
    def __init__(self, proc: subprocess.Popen[bytes], deadline: float) -> None:
        assert proc.stdin is not None and proc.stdout is not None
        self.r, self.w = proc.stdout.fileno(), proc.stdin.fileno()
        os.set_blocking(self.r, False)
        os.set_blocking(self.w, False)
        self.deadline = deadline
        self.buf = bytearray()

    def _wait(self, fd: int, event: int) -> None:
        left = self.deadline - time.monotonic()
        if left <= 0:
            raise _WallClock
        poller = select.poll()
        poller.register(fd, event)
        if not poller.poll(max(1, int(left * 1000))):
            raise _WallClock

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


def _storage(call: Callable[[], Any]) -> Any:
    """Storage errors from the parent's own reads: the typed ones propagate, anything else (a read timeout or
    reset inside a streaming body) is StorageUnavailable (the lease retries)."""
    try:
        return call()
    except (StorageUnavailable, ObjectMissing):
        raise
    except Exception as exc:
        raise StorageUnavailable(f"{type(exc).__name__}: {exc}") from exc


def _serve(
    conn: _Conn, open_range: Callable[[int, int], BinaryIO], size: int, max_result: int
) -> dict[str, Any]:
    streams: dict[int, BinaryIO] = {}
    next_id = 0
    try:
        while True:
            op, payload = conn.recv(max_result)
            if op == b"O" and len(payload) == 16:
                start, end = struct.unpack(">QQ", payload)
                if not 0 <= start <= end < size or len(streams) >= MAX_STREAMS:
                    conn.send(b"e", b"INVALID")
                    continue
                stream = _storage(partial(open_range, start, end))
                next_id += 1
                streams[next_id] = stream
                conn.send(b"o", struct.pack(">I", next_id))
            elif op == b"R" and len(payload) == 8:
                sid, n = struct.unpack(">II", payload)
                found = streams.get(sid)
                if found is None:
                    conn.send(b"e", b"INVALID")
                    continue
                want = min(n, MAX_READ)
                data = _storage(partial(found.read, want))
                conn.send(b"d", bytes(data))
            elif op == b"C" and len(payload) == 4:
                closing = streams.pop(struct.unpack(">I", payload)[0], None)
                if closing is not None:
                    closing.close()
            elif op == b"F":
                outcome = json.loads(payload)
                if not isinstance(outcome, dict):
                    raise _ChildGone("outcome is not an object")
                return outcome
            else:
                raise _ChildGone(f"unexpected frame {op!r}")
    finally:
        for stream in streams.values():
            try:
                stream.close()
            except Exception:
                logger.debug("closing a preview source stream failed", exc_info=True)


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
    """{"result": {...}} or {"failure": UNPARSEABLE | TIMEOUT | GENERATION_FAILED}; storage errors raise."""
    job = {
        "size": size,
        "path": path,
        "hints": {name: asdict(hint) for name, hint in hints.items()},
        "limits": asdict(limits),
        "timeout": timeout_s,
    }
    max_result = limits.preview_bytes + limits.profile_bytes + (1 << 20)
    with tempfile.TemporaryFile() as stderr:
        proc = subprocess.Popen(
            command or child_command(memory_limit),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=stderr,
            env=child_env(),
            close_fds=True,
        )
        failure: str
        try:
            conn = _Conn(proc, time.monotonic() + timeout_s + startup_margin_s)
            conn.send(b"J", json.dumps(job).encode())
            outcome = _serve(conn, open_range, size, max_result)
            # real storage errors raise in the parent (above); a child "storage" outcome can only come from an
            # INVALID reply to an out-of-range or excess request, so it falls through to GENERATION_FAILED
            if "result" in outcome or outcome.get("failure") in ("UNPARSEABLE", "TIMEOUT"):
                return outcome
            failure = "GENERATION_FAILED"
        except _WallClock:
            proc.kill()
            failure = "TIMEOUT"
        except (_ChildGone, ValueError):  # ValueError: undecodable outcome JSON
            proc.kill()
            failure = "GENERATION_FAILED"
        except BaseException:  # storage error in the parent, or the actor's time limit: never leave the child
            proc.kill()
            raise
        finally:
            try:
                proc.wait(timeout=EXIT_GRACE_S)  # after its outcome frame the child exits by itself
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait()
            for pipe in (proc.stdin, proc.stdout):
                if pipe is not None:
                    with contextlib.suppress(OSError):
                        pipe.close()
        stderr.seek(0, os.SEEK_END)
        stderr.seek(max(0, stderr.tell() - 2048))
        logger.warning(
            "preview generation failed in the sandbox",
            extra={
                "path": path,
                "failure_code": failure,
                "returncode": proc.returncode,
                "stderr_tail": stderr.read().decode(errors="replace"),
            },
        )
        return {"failure": failure}
