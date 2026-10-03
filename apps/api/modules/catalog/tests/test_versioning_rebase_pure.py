"""3-way rebase plan (spec §3.3b): one row per (base, mine, theirs) combination."""

import pytest

from api.modules.catalog.versioning.rebase import Conflict, three_way

B, M, T, X = "b" * 64, "m" * 64, "t" * 64, "x" * 64


@pytest.mark.parametrize(
    ("base", "mine", "theirs", "expected"),
    [
        (B, B, B, "noop"),  # untouched everywhere
        (B, B, T, "theirs"),  # only latest changed
        (B, B, None, "theirs"),  # latest removed, draft untouched -> remove
        (None, None, T, "theirs"),  # latest added
        (B, M, B, "mine"),  # only draft changed
        (B, None, B, "mine"),  # draft removed
        (None, M, None, "mine"),  # draft added
        (B, M, M, "mine"),  # identical change both sides
        (B, None, None, "mine"),  # both removed
        (None, M, M, "mine"),  # both added the same content
        (B, M, T, "conflict"),
        (B, M, None, "conflict"),  # draft changed, latest removed
        (B, None, T, "conflict"),  # draft removed, latest changed
        (None, M, X, "conflict"),  # both added different content (also: NULL base)
    ],
)
def test_three_way_table(base: str | None, mine: str | None, theirs: str | None, expected: str) -> None:
    def side(v: str | None) -> dict[str, str]:
        return {} if v is None else {"p": v}

    plan = three_way(side(base), side(mine), side(theirs), {})
    got = (
        "theirs"
        if "p" in plan.take_theirs
        else "mine"
        if "p" in plan.keep_mine
        else ("conflict" if plan.conflicts else "noop")
    )
    assert got == expected
    if expected == "conflict":
        assert plan.conflicts == (Conflict("p", base, mine, theirs),)


def test_resolutions_settle_conflicts() -> None:
    plan = three_way({"p": B}, {"p": M}, {"p": T}, {"p": "THEIRS"})
    assert plan.take_theirs == ("p",) and plan.conflicts == ()
    plan = three_way({"p": B}, {"p": M}, {"p": T}, {"p": "MINE"})
    assert plan.keep_mine == ("p",) and plan.conflicts == ()


def test_resolution_for_non_conflict_is_rejected() -> None:
    with pytest.raises(ValueError, match="UNKNOWN_PATH: q"):
        three_way({"p": B}, {"p": M}, {"p": T}, {"p": "MINE", "q": "THEIRS"})


def test_unknown_paths_are_all_named_in_byte_order() -> None:
    with pytest.raises(ValueError, match="UNKNOWN_PATH: Z.csv, a.csv"):
        three_way({}, {}, {}, {"a.csv": "MINE", "Z.csv": "THEIRS"})


def test_paths_come_out_in_byte_order() -> None:
    plan = three_way({}, {}, {"b.csv": T, "B.csv": T, "a/x.csv": T}, {})
    assert plan.take_theirs == ("B.csv", "a/x.csv", "b.csv")
