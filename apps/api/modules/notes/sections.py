"""The standard research-note template (openapi NoteSection), in display, hash and export order."""

from collections.abc import Mapping, Sequence
from typing import Any

SECTIONS: tuple[str, ...] = (
    "OBJECTIVE",
    "METHOD",
    "PROCEDURE",
    "RESULTS",
    "DISCUSSION",
    "NEXT",
    "REFERENCES",
)
LABELS: dict[str, str] = {
    "OBJECTIVE": "연구 목표",
    "METHOD": "연구 방법·재료",
    "PROCEDURE": "수행 내용",
    "RESULTS": "결과 및 관찰",
    "DISCUSSION": "고찰·문제점",
    "NEXT": "향후 계획",
    "REFERENCES": "참고 자료",
}
_INDEX = {section: index for index, section in enumerate(SECTIONS)}


def in_template_order[B: Mapping[Any, Any]](blocks: Sequence[B]) -> list[B]:
    """Blocks grouped by section in template order; within a section they keep the given (position) order."""
    return sorted(blocks, key=lambda b: _INDEX.get(str(b["section"]), len(SECTIONS)))
