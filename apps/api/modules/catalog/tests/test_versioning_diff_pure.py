"""Three-layer comparison, pure part (spec §3.3 "변경 내역 보기"; mirrored by apps/web/src/mocks/versioning.ts)."""

from api.modules.catalog.versioning.diff import (
    FileEntry,
    diff_files,
    diff_metadata,
    diff_schema,
    flatten,
    profile_view,
    summarize,
)

A, B, C = "a" * 64, "b" * 64, "c" * 64


def test_file_layer_statuses_and_order() -> None:
    before = {
        "x.csv": FileEntry("x.csv", 10, A),
        "gone.csv": FileEntry("gone.csv", 5, B),
        "same.md": FileEntry("same.md", 1, C),
    }
    after = {
        "x.csv": FileEntry("x.csv", 12, B),
        "new.csv": FileEntry("new.csv", 3, A),
        "same.md": FileEntry("same.md", 1, C),
    }
    changes = diff_files(before, after)
    assert [(c["path"], c["status"], c["size_delta"]) for c in changes] == [
        ("gone.csv", "REMOVED", -5),
        ("new.csv", "ADDED", 3),
        ("same.md", "UNCHANGED", 0),
        ("x.csv", "CHANGED", 2),
    ]
    assert changes[0]["before"] == {"size_bytes": 5, "sha256": B} and changes[0]["after"] is None
    assert changes[1]["before"] is None and changes[1]["after"] == {"size_bytes": 3, "sha256": A}
    assert summarize(changes) == {"added": 1, "removed": 1, "changed": 1, "unchanged": 1}


def test_paths_sort_by_bytes() -> None:
    files = {p: FileEntry(p, 1, A) for p in ("b.csv", "B.csv", "a/z.csv", "a.csv")}
    assert [c["path"] for c in diff_files({}, files)] == ["B.csv", "a.csv", "a/z.csv", "b.csv"]


def test_reupload_with_same_content_is_unchanged() -> None:
    assert diff_files({"a": FileEntry("a", 1, A)}, {"a": FileEntry("a", 1, A)})[0]["status"] == "UNCHANGED"


def test_no_target_means_everything_added() -> None:
    assert summarize(diff_files({}, {"a": FileEntry("a", 1, A)})) == {
        "added": 1,
        "removed": 0,
        "changed": 0,
        "unchanged": 0,
    }


def test_schema_layer_reports_structure_only() -> None:
    before = {
        "total_rows": 10,
        "columns": [
            {"name": "x", "type": "integer", "unit": None, "missing_ratio": 0.0, "distinct_count": 10},
            {"name": "old", "type": "string", "unit": None, "missing_ratio": 0.0, "distinct_count": 2},
        ],
    }
    after = {
        "total_rows": 9,
        "columns": [
            {
                "name": "x",
                "type": "number",
                "unit": "Cel",
                "missing_ratio": 0.1,
                "distinct_count": 9,
                "min": 1,
                "top_values": [{"value": "secret", "count": 3}],
            },
            {"name": "z", "type": "string", "unit": None, "missing_ratio": 0.0, "distinct_count": 1},
        ],
    }
    got = diff_schema("d.csv", before, after)
    assert got == {
        "path": "d.csv",
        "status": "COMPARED",
        "rows": [10, 9],
        "columns_added": ["z"],
        "columns_removed": ["old"],
        "columns_changed": [
            {"name": "x", "type": ["integer", "number"], "unit": [None, "Cel"], "missing_ratio": [0.0, 0.1]}
        ],
    }
    assert "secret" not in repr(got) and "min" not in repr(got)


def test_tiny_missing_ratio_change_is_ignored_and_missing_profile_is_flagged() -> None:
    col = {"name": "x", "type": "integer", "unit": None, "missing_ratio": 0.10001, "distinct_count": 1}
    same = diff_schema(
        "d.csv",
        {"total_rows": 1, "columns": [col]},
        {"total_rows": 1, "columns": [{**col, "missing_ratio": 0.1}]},
    )
    assert same["columns_changed"] == []
    assert diff_schema("d.csv", None, {"columns": []}) == {"path": "d.csv", "status": "PROFILE_MISSING"}
    assert diff_schema("d.csv", {"columns": []}, None) == {"path": "d.csv", "status": "PROFILE_MISSING"}


def test_profile_view_keeps_structure_only_and_derives_total_rows() -> None:
    stored = {
        "format": "csv",
        "rows_sampled": 4,
        "truncated": False,
        "columns_truncated": False,
        "columns": [
            {
                "name": "x",
                "type": "string",
                "unit": None,
                "missing_ratio": 0.0,
                "distinct_count": 1,
                "min": "S",
            }
        ],
    }
    view = profile_view(stored)
    assert view == {
        "total_rows": 4,  # a pre-Stage-2 profile: a complete read counts every row
        "columns": [{"name": "x", "type": "string", "unit": None, "missing_ratio": 0.0}],
    }
    assert profile_view({**stored, "truncated": True})["total_rows"] is None
    assert profile_view({**stored, "total_rows": 9})["total_rows"] == 9
    assert profile_view(None) is None


def test_metadata_layer_flattens_and_treats_missing_as_null() -> None:
    old = {"license": "CC-BY-4.0", "keywords": ["a"], "title": "T"}
    new = {
        "license": "CC0-1.0",
        "keywords": ["a"],
        "title": "T",
        "people": {"principal_investigator": {"display_name": "B", "affiliation": {"name": "Institute B"}}},
    }
    assert flatten(new)["people.principal_investigator"] == {
        "display_name": "B",
        "affiliation": {"name": "Institute B"},
    }
    assert diff_metadata(old, new) == [
        {"field": "license", "before": "CC-BY-4.0", "after": "CC0-1.0"},
        {
            "field": "people.principal_investigator",
            "before": None,
            "after": {"display_name": "B", "affiliation": {"name": "Institute B"}},
        },
    ]


def test_metadata_people_lists_are_compared_whole_and_none_snapshot_is_empty() -> None:
    people = {"contributors": [{"display_name": "A"}], "steward_contact": {"display_name": "S"}}
    moved = {
        "contributors": [{"display_name": "A"}, {"display_name": "C"}],
        "steward_contact": {"display_name": "S"},
    }
    assert diff_metadata({"people": people}, {"people": moved}) == [
        {"field": "people.contributors", "before": people["contributors"], "after": moved["contributors"]}
    ]
    assert diff_metadata(None, {"title": "T"}) == [{"field": "title", "before": None, "after": "T"}]
    assert diff_metadata({"title": "T"}, {"title": "T"}) == []


def test_unknown_missing_ratio_is_not_a_change() -> None:
    col = {"name": "x", "type": "integer", "unit": None, "missing_ratio": 0.5}
    for b_ratio, a_ratio in ((None, 0.5), (0.5, None), (None, None)):
        got = diff_schema(
            "d.csv",
            {"columns": [{**col, "missing_ratio": b_ratio}]},
            {"columns": [{**col, "missing_ratio": a_ratio}]},
        )
        assert got["columns_changed"] == []
    no_key = {k: v for k, v in col.items() if k != "missing_ratio"}
    assert diff_schema("d.csv", {"columns": [no_key]}, {"columns": [{**no_key, "type": "number"}]})[
        "columns_changed"
    ] == [{"name": "x", "type": ["integer", "number"], "unit": None, "missing_ratio": None}]
