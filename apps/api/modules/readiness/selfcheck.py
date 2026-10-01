"""Golden self-check: evaluate the 4 fixtures with both profiles and compare with expected/*.json.

    python -m api.modules.readiness.selfcheck [FIXTURES_DIR] [--record]

--record writes result_sha256 into expected/*.json when the statuses match (first approved run, or after a
reviewed change that also bumped VALIDATOR_VERSION or a profile version, 09 §5.6). Exit 1 on any mismatch.
"""

import argparse
import json
import sys
import uuid
from collections.abc import Sequence
from pathlib import Path

from api.modules.readiness.engine.evaluate import ValidationResult, evaluate
from api.modules.readiness.fakes import FIXTURES_ROOT, FixtureCatalog
from api.modules.readiness.profile_registry import PROFILES

FIXTURES = ("clean_tabular", "missing_metadata", "invalid_units", "missing_provenance")


def run_fixture(root: Path, name: str, profile_id: str) -> ValidationResult:
    base = root / name
    snapshot = json.loads((base / "dataset.json").read_text(encoding="utf-8"))
    files: dict[str, Path | bytes] = {
        p.relative_to(base / "files").as_posix(): p
        for p in sorted((base / "files").rglob("*"))
        if p.is_file()
    }
    catalog = FixtureCatalog()
    view = catalog.add_version(files, snapshot, owner_organization_id=uuid.UUID(int=0xB))
    return evaluate(view, PROFILES[profile_id], catalog)


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m api.modules.readiness.selfcheck")
    parser.add_argument("root", nargs="?", type=Path, default=FIXTURES_ROOT)
    parser.add_argument("--record", action="store_true", help="write result_sha256 into expected/*.json")
    args = parser.parse_args(argv)
    failures = 0
    for name in FIXTURES:
        for profile_id in PROFILES:
            target = args.root / name / "expected" / f"{profile_id}.json"
            expected = json.loads(target.read_text(encoding="utf-8"))
            result = run_fixture(args.root, name, profile_id)
            statuses = {c.check_id: c.status for c in result.checks}
            ok = statuses == expected["checks"] and result.overall_status == expected["overall_status"]
            if args.record and ok:
                expected["result_sha256"] = result.result_sha256
                target.write_text(json.dumps(expected, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            ok = ok and expected["result_sha256"] == result.result_sha256
            failures += not ok
            status = "OK  " if ok else "FAIL"
            print(f"{status} {name:<20} {profile_id:<17} {result.overall_status:<8} {result.result_sha256}")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
