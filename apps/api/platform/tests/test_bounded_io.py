import io

import pytest

from api.platform.bounded_io import BoundedLines, CappedRaw, RangeReader


def test_capped_raw_never_reads_more_than_a_chunk() -> None:
    calls: list[int] = []
    source = io.BytesIO(b"x" * 200_000)
    raw = CappedRaw(source, lambda: calls.append(1))
    buf = bytearray(150_000)
    assert raw.readinto(buf) == 1 << 16
    assert calls == [1]


def test_bounded_lines_flags_overflow() -> None:
    text = io.TextIOWrapper(io.BytesIO(b"a" * 50 + b"\n"), encoding="utf-8")
    lines = BoundedLines(text, 10)
    assert list(lines) == [] and lines.overflow


def test_range_reader_caps_each_read() -> None:
    data = b"0123456789" * 10
    seen: list[tuple[int, int]] = []

    def open_range(start: int, end: int) -> io.BytesIO:
        seen.append((start, end))
        return io.BytesIO(data[start : end + 1])

    reader = RangeReader(open_range, len(data), deadline=lambda: None, max_read=16)
    assert reader.read(40) == data[:16]
    assert seen == [(0, 15)]
    with pytest.raises(ValueError):
        reader.seek(-1)
