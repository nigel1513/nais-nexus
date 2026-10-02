"""Hostile-input-safe readers shared by M05 readiness and M03 previews: every read is capped and checks a deadline (moved from readiness/engine/parsing.py)."""

import errno
import io
from collections.abc import Callable
from typing import Any, BinaryIO

READ_CHUNK = 1 << 16  # every single read of a stream is at most this

Deadline = Callable[[], None]  # raises the caller's timeout exception when the per-file budget is spent


class CappedRaw(io.RawIOBase):
    """Binary source for the CSV text layer: every read is capped and checks the deadline."""

    def __init__(self, source: BinaryIO, deadline: Deadline) -> None:
        self._source = source
        self._deadline = deadline
        self.failure: BaseException | None = None

    def readable(self) -> bool:
        return True

    def readinto(self, b: Any) -> int:
        self._deadline()
        try:
            chunk = self._source.read(min(len(b), READ_CHUNK))
        except Exception as exc:
            self.failure = exc
            raise
        n = len(chunk)
        b[:n] = chunk
        return n


class BoundedLines:
    """Bounded physical-line iterator for csv.reader; counts the bytes of every line it hands out."""

    def __init__(self, text: io.TextIOWrapper, cap: int) -> None:
        self._text = text
        self._cap = cap
        self.bytes = 0
        self.overflow = False

    def __iter__(self) -> "BoundedLines":
        return self

    def __next__(self) -> str:
        line = self._text.readline(self._cap + 1)
        if not line:
            raise StopIteration
        if len(line) > self._cap:
            self.overflow = True
            raise StopIteration
        self.bytes += len(line.encode("utf-8"))
        return line


class RangeReader(io.RawIOBase):
    """Seekable read-only view over a ranged source (`CatalogReadPort.open_stream(file, byte_range=...)`).

    `open_range(start, end)` returns a stream of the inclusive byte range. Every single read is capped at
    `max_read` bytes and checks the deadline, so a parquet file is never pulled whole.
    """

    def __init__(
        self,
        open_range: Callable[[int, int], BinaryIO],
        size: int,
        *,
        deadline: Deadline,
        max_read: int = 1 << 20,
    ) -> None:
        self._open_range = open_range
        self._size = size
        self._deadline = deadline
        self._max_read = max_read
        self._pos = 0
        self.failure: BaseException | None = None

    def readable(self) -> bool:
        return True

    def seekable(self) -> bool:
        return True

    def tell(self) -> int:
        return self._pos

    def seek(self, offset: int, whence: int = io.SEEK_SET) -> int:
        if whence not in (io.SEEK_SET, io.SEEK_CUR, io.SEEK_END):
            raise ValueError(f"invalid whence: {whence}")
        base = {io.SEEK_SET: 0, io.SEEK_CUR: self._pos, io.SEEK_END: self._size}[whence]
        if base + offset < 0:
            raise ValueError("negative seek position")
        self._pos = base + offset
        return self._pos

    def readinto(self, b: Any) -> int:
        n = min(len(b), self._max_read, self._size - self._pos)
        if n <= 0:
            return 0
        self._deadline()
        try:
            source = self._open_range(self._pos, self._pos + n - 1)
            try:
                data = source.read(n)
            finally:
                source.close()
            if not data:  # the object ended before its recorded size
                raise OSError(errno.EIO, "short read: range returned no bytes before end of file")
        except Exception as exc:
            self.failure = exc
            raise
        got = len(data[:n])
        b[:got] = data[:got]
        self._pos += got
        return got


def open_parquet_range(
    open_range: Callable[[int, int], BinaryIO], size: int, *, deadline: Deadline, max_read: int = 1 << 20
) -> BinaryIO:
    """Buffered RangeReader, ready for profile_parquet."""
    reader = RangeReader(open_range, size, deadline=deadline, max_read=max_read)
    return io.BufferedReader(reader, buffer_size=max_read)
