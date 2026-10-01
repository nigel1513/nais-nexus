"""UCUM case-sensitive syntax check against the bundled atom/prefix dictionaries (09 §3.5).

Grammar (UCUM §2.1 subset): main := ['/'] term ; term := component (('.'|'/') component)* ;
component := '(' term ')' | annotation | factor [annotation] | [prefix] atom [exponent] [annotation].
"""

import csv
import re
from functools import lru_cache
from pathlib import Path

DICT_DIR = Path(__file__).resolve().parents[1] / "dictionaries"
_WORD_STOP = frozenset(".()/{}")
_FACTOR = re.compile(r"[0-9]+")
MAX_UNIT_LENGTH = 256  # hostile-input bounds: parsing is linear in the (capped) length
MAX_NESTING = 16


def _lines(name: str) -> list[str]:
    text = (DICT_DIR / name).read_text(encoding="utf-8")
    return [line for line in text.splitlines() if line and not line.startswith("#")]


@lru_cache(maxsize=1)
def atoms() -> dict[str, bool]:
    """symbol -> metric (only metric atoms take a prefix)."""
    return {sym: metric == "1" for sym, metric in (line.split("\t") for line in _lines("ucum_atoms_v1.txt"))}


@lru_cache(maxsize=1)
def prefixes() -> tuple[str, ...]:
    return tuple(sorted(_lines("ucum_prefixes_v1.txt"), key=lambda p: (-len(p), p)))


@lru_cache(maxsize=1)
def aliases() -> dict[str, str]:
    with (DICT_DIR / "unit_aliases_v1.csv").open(encoding="utf-8", newline="") as fh:
        return {row["alias"]: row["ucum"] for row in csv.DictReader(fh)}


class UnitError(Exception):
    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


class _Parser:
    def __init__(self, text: str) -> None:
        self.text = text
        self.i = 0
        self.depth = 0

    def peek(self) -> str:
        return self.text[self.i] if self.i < len(self.text) else ""

    def parse(self) -> None:
        if self.peek() == "/":
            self.i += 1
        self.term()
        if self.i != len(self.text):
            raise UnitError("SYNTAX_ERROR")

    def term(self) -> None:
        self.component()
        while self.peek() in (".", "/"):
            self.i += 1
            self.component()

    def component(self) -> None:
        char = self.peek()
        if char == "(":
            self.depth += 1
            if self.depth > MAX_NESTING:
                raise UnitError("SYNTAX_ERROR")
            self.i += 1
            self.term()
            if self.peek() != ")":
                raise UnitError("SYNTAX_ERROR")
            self.i += 1
            self.depth -= 1
            return
        if char == "{":
            self.annotation()
            return
        start = self.i
        while self.i < len(self.text) and self.text[self.i] not in _WORD_STOP:
            self.i += 1
        word = self.text[start : self.i]
        if not word:
            raise UnitError("SYNTAX_ERROR")
        if _FACTOR.fullmatch(word) is None:
            self.simple_unit(word)
        if self.peek() == "{":
            self.annotation()

    def annotation(self) -> None:
        end = self.text.find("}", self.i)
        if end == -1 or "{" in self.text[self.i + 1 : end]:
            raise UnitError("SYNTAX_ERROR")
        self.i = end + 1

    @staticmethod
    def simple_unit(word: str) -> None:
        symbol = word.rstrip("0123456789")
        if symbol != word and symbol[-1:] in ("+", "-"):
            symbol = symbol[:-1]
        if not symbol:
            raise UnitError("SYNTAX_ERROR")
        table = atoms()
        if symbol in table:
            return
        for prefix in prefixes():
            rest = symbol[len(prefix) :]
            if symbol.startswith(prefix) and rest in table:
                if not table[rest]:
                    raise UnitError("PREFIX_NOT_ALLOWED")
                return
        raise UnitError("UNKNOWN_ATOM")


def unit_error(unit: str) -> str | None:
    """None when `unit` is a valid UCUM expression, else SYNTAX_ERROR | UNKNOWN_ATOM | PREFIX_NOT_ALLOWED."""
    if unit == "" or len(unit) > MAX_UNIT_LENGTH or any(ch.isspace() for ch in unit):
        return "SYNTAX_ERROR"
    try:
        _Parser(unit).parse()
    except UnitError as exc:
        return exc.code
    return None


def suggestion(unit: str) -> str | None:
    """Deterministic correction hint from unit_aliases_v1.csv only."""
    return aliases().get(unit)
