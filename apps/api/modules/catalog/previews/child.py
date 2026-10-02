"""Child side of the preview sandbox (controller ruling P24). Runs in its own interpreter, started by sandbox.py,
under RLIMIT_AS; it holds no credentials, no DB connection and no storage client. Every byte of the object comes
from the parent through range requests on a private pipe protocol (see sandbox.py for the frame format).

Imported only through sandbox.BOOTSTRAP, which registers the catalog packages without running their __init__
(importing api.modules.catalog would pull in FastAPI, SQLAlchemy and Dramatiq)."""

import io
import json
import os
import resource
import signal
import struct
import sys
import threading
from typing import Any, BinaryIO

HEADER = struct.Struct(">cI")
MAX_READ = 1 << 20


class _Pipe:
    def __init__(self, rfd: int, wfd: int) -> None:
        self.rfd, self.wfd = rfd, wfd
        self.lock = threading.Lock()  # pyarrow may read from its IO thread: one request/reply at a time

    def call(self, op: bytes, payload: bytes) -> tuple[bytes, bytes]:
        with self.lock:
            self.send(op, payload)
            return self.recv()

    def send(self, op: bytes, payload: bytes = b"") -> None:
        data = HEADER.pack(op, len(payload)) + payload
        view = memoryview(data)
        while view:
            view = view[os.write(self.wfd, view) :]

    def _exact(self, n: int) -> bytes:
        parts, left = [], n
        while left:
            chunk = os.read(self.rfd, left)
            if not chunk:
                raise EOFError("parent closed the pipe")
            parts.append(chunk)
            left -= len(chunk)
        return b"".join(parts)

    def recv(self) -> tuple[bytes, bytes]:
        op, length = HEADER.unpack(self._exact(HEADER.size))
        return op, self._exact(length)


class RemoteStorageError(Exception):
    """The parent could not read the object (code: MISSING / UNAVAILABLE)."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


class _RemoteRaw(io.RawIOBase):
    def __init__(self, pipe: _Pipe, stream_id: int) -> None:
        self._pipe, self._id = pipe, stream_id

    def readable(self) -> bool:
        return True

    def readinto(self, b: Any) -> int:
        op, data = self._pipe.call(b"R", struct.pack(">II", self._id, min(len(b), MAX_READ)))
        if op == b"e":
            raise RemoteStorageError(data.decode())
        n = len(data)
        b[:n] = data
        return n

    def close(self) -> None:
        if not self.closed:
            try:
                with self._pipe.lock:
                    self._pipe.send(b"C", struct.pack(">I", self._id))
            finally:
                super().close()


def _open_range(pipe: _Pipe, start: int, end: int) -> BinaryIO:
    op, data = pipe.call(b"O", struct.pack(">QQ", start, end))
    if op == b"e":
        raise RemoteStorageError(data.decode())
    return io.BufferedReader(_RemoteRaw(pipe, struct.unpack(">I", data)[0]), buffer_size=1 << 16)


def _run(pipe: _Pipe, job: dict[str, Any]) -> dict[str, Any]:
    from api.modules.catalog.previews.profile import (
        FieldHint,
        PreviewLimits,
        PreviewTimeout,
        Unparseable,
        make_deadline,
        profile_table,
    )

    try:
        import pyarrow as pa

        pa.set_cpu_count(1)
        pa.set_io_thread_count(1)
    except ImportError:  # pragma: no cover - pyarrow is a hard dependency
        pass
    try:
        result = profile_table(
            lambda start, end: _open_range(pipe, start, end),
            int(job["size"]),
            path=str(job["path"]),
            hints={name: FieldHint(**hint) for name, hint in job["hints"].items()},
            limits=PreviewLimits(**job["limits"]),
            deadline=make_deadline(float(job["timeout"])),
        )
    except RemoteStorageError as exc:
        return {"storage": exc.code}
    except Unparseable:
        return {"failure": "UNPARSEABLE"}
    except PreviewTimeout:
        return {"failure": "TIMEOUT"}
    except MemoryError:  # includes pyarrow.ArrowMemoryError: RLIMIT_AS refused an allocation
        return {"failure": "GENERATION_FAILED", "detail": "memory limit"}
    return {
        "result": {
            "format": result.format,
            "rows_sampled": result.rows_sampled,
            "truncated": result.truncated,
            "columns_truncated": result.columns_truncated,
            "column_profile": result.column_profile,
            "preview": result.preview,
        }
    }


FSIZE_LIMIT = 64 << 10  # the child writes no files; stderr is a pipe the parent caps
PR_SET_PDEATHSIG = 1


def _die_with_parent(parent_pid: int) -> None:
    """PR_SET_PDEATHSIG(SIGKILL), best effort (Linux): the child cannot outlive the worker thread that started
    it. If the parent is already gone (re-parented before the call), exit now."""
    try:
        import ctypes

        libc = ctypes.CDLL(None, use_errno=True)
        libc.prctl(PR_SET_PDEATHSIG, signal.SIGKILL, 0, 0, 0)
    except (OSError, AttributeError):  # pragma: no cover - non-Linux
        pass
    if os.getppid() != parent_pid:
        raise SystemExit(3)


def apply_limits(memory_limit: int, cpu_seconds: int, parent_pid: int) -> None:
    """Before anything heavy is imported: die with the parent, then cap address space, CPU, file size, core."""
    _die_with_parent(parent_pid)
    resource.setrlimit(resource.RLIMIT_AS, (memory_limit, memory_limit))
    resource.setrlimit(resource.RLIMIT_CPU, (cpu_seconds, cpu_seconds))
    resource.setrlimit(resource.RLIMIT_FSIZE, (FSIZE_LIMIT, FSIZE_LIMIT))
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))


def main() -> None:
    apply_limits(int(sys.argv[1]), int(sys.argv[2]), int(sys.argv[3]))
    # private copies of the protocol fds; fd 0/1 are pointed away so stray C-level prints cannot corrupt frames
    pipe = _Pipe(os.dup(0), os.dup(1))
    devnull = os.open(os.devnull, os.O_RDWR)
    os.dup2(devnull, 0)
    os.dup2(2, 1)
    op, payload = pipe.recv()
    if op != b"J":
        raise SystemExit(2)
    try:
        outcome = _run(pipe, json.loads(payload))
    except MemoryError:
        outcome = {"failure": "GENERATION_FAILED", "detail": "memory limit"}
    pipe.send(b"F", json.dumps(outcome, allow_nan=False, default=str).encode())
