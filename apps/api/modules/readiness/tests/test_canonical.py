import hashlib
import math
import uuid

import pytest

from api.modules.catalog.domain import manifest_sha256 as m03_manifest_sha256
from api.modules.readiness.catalog_port import FileRef
from api.modules.readiness.engine.canonical import (
    EVIDENCE_MAX_BYTES,
    bound_evidence,
    canonical_json,
    input_fingerprint,
    manifest_sha256,
    metadata_snapshot_sha256,
    ratio,
)


def test_canonical_json_sorts_keys_keeps_unicode_and_array_order() -> None:
    assert canonical_json({"b": [3, 1], "a": "측정"}) == '{"a":"측정","b":[3,1]}'


def test_canonical_json_rejects_nan() -> None:
    with pytest.raises(ValueError):
        canonical_json({"x": math.nan})


def test_ratio_rounds_to_six_places_and_handles_zero_denominator() -> None:
    assert ratio(1, 3) == 0.333333
    assert ratio(3, 990) == 0.00303
    assert ratio(5, 0) == 0.0


def test_bound_evidence_leaves_small_evidence_untouched() -> None:
    evidence = {"fields": [{"path": "a.csv"}]}
    assert bound_evidence(evidence) is evidence


def test_bound_evidence_truncates_largest_array_and_marks_it() -> None:
    evidence = {
        "fields": [{"path": f"data/{i:06d}.csv", "field": "x" * 50} for i in range(5000)],
        "count": 5000,
    }
    bounded = bound_evidence(evidence)
    assert bounded["truncated"] is True
    assert bounded["count"] == 5000
    assert 0 < len(bounded["fields"]) < 5000
    assert bounded["fields"][0] == evidence["fields"][0]  # keeps the sorted prefix
    assert len(canonical_json(bounded).encode()) <= EVIDENCE_MAX_BYTES
    assert len(evidence["fields"]) == 5000  # input not mutated


def test_input_fingerprint_is_d029_joined_with_pipes() -> None:
    snapshot = {"title": "t", "license": "MIT"}
    snap_sha = hashlib.sha256(canonical_json(snapshot).encode()).hexdigest()
    assert metadata_snapshot_sha256(snapshot) == snap_sha
    expected = hashlib.sha256(f"{'a' * 64}|{snap_sha}|GENERIC_BASIC|1.0.0|1.0.0".encode()).hexdigest()
    assert input_fingerprint("a" * 64, snapshot, "GENERIC_BASIC", "1.0.0", "1.0.0") == expected


def test_fingerprint_changes_with_snapshot_and_versions() -> None:
    base = input_fingerprint("a" * 64, {"title": "t"}, "GENERIC_BASIC", "1.0.0", "1.0.0")
    assert input_fingerprint("a" * 64, {"title": "u"}, "GENERIC_BASIC", "1.0.0", "1.0.0") != base
    assert input_fingerprint("a" * 64, {"title": "t"}, "GENERIC_BASIC", "1.0.0", "1.0.1") != base
    assert input_fingerprint("a" * 64, {"title": "t"}, "TABULAR_ML_BASIC", "1.0.0", "1.0.0") != base


def test_manifest_sha256_matches_m03_definition() -> None:
    def ref(path: str, size: int, sha: str) -> FileRef:
        return FileRef(uuid.uuid4(), path, size, sha, "text/csv", "VERIFIED", "b", f"k/{path}")

    files = [ref("b.csv", 2, "2" * 64), ref("README.md", 1, "1" * 64), ref("a/z.csv", 3, "3" * 64)]
    text = f"README.md\t1\t{'1' * 64}\na/z.csv\t3\t{'3' * 64}\nb.csv\t2\t{'2' * 64}\n"
    assert manifest_sha256(files) == hashlib.sha256(text.encode()).hexdigest()


def test_manifest_sha256_equals_m03_function_on_non_trivial_paths() -> None:
    # UTF-8 byte order differs from str order for non-BMP vs BMP-high chars and case.
    paths = [
        "b.csv",
        "B.csv",
        "a/z.csv",
        "a.csv",
        "한글/데이터.csv",
        "\U0001f600.csv",
        "￮.csv",
        "é.csv",
        "_x.csv",
    ]
    entries = [(p, i * 7 + 1, f"{i:064x}") for i, p in enumerate(paths)]
    refs = [FileRef(uuid.uuid4(), p, s, h, "text/csv", "VERIFIED", "b", f"k/{p}") for p, s, h in entries]
    assert manifest_sha256(refs) == m03_manifest_sha256(entries)
    assert manifest_sha256(reversed(refs)) == m03_manifest_sha256(entries)
