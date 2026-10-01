"""integrity.file_checksum (09 §3.8). A missing object is a run failure (M05 §5), not a check verdict."""

import hashlib

from api.modules.readiness.catalog_port import FileRef
from api.modules.readiness.engine.canonical import manifest_sha256
from api.modules.readiness.engine.context import CheckOutcome, EvaluationContext
from api.modules.readiness.engine.parsing import Deadline

CHUNK = 1024 * 1024


def _recompute(ctx: EvaluationContext, ref: FileRef, deadline: Deadline) -> str:
    digest = hashlib.sha256()
    with ctx.reader.open_stream(ref) as stream:
        while True:
            deadline()
            chunk = stream.read(CHUNK)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()


def check(ctx: EvaluationContext) -> CheckOutcome:
    budget = ctx.params.checksum_max_total_bytes
    cumulative = recomputed = catalog_verified = 0
    mismatched: list[str] = []
    not_verified: list[str] = []
    for ref in sorted(ctx.files, key=lambda f: f.path):
        cumulative += ref.size_bytes
        if cumulative <= budget:
            recomputed += 1
            if _recompute(ctx, ref, ctx.new_deadline()) != ref.sha256.lower():
                mismatched.append(ref.path)
        else:
            catalog_verified += 1
            if ref.status != "VERIFIED":
                not_verified.append(ref.path)
    manifest_match = (
        ctx.manifest_sha256 is not None and manifest_sha256(ctx.files).lower() == ctx.manifest_sha256.lower()
    )
    evidence = {
        "files_total": len(ctx.files),
        "recomputed": recomputed,
        "catalog_verified": catalog_verified,
        "mismatched": mismatched,
        "not_verified": not_verified,
        "missing": [],
        "manifest_match": manifest_match,
    }
    if mismatched or not_verified or not manifest_match:
        problems = len(mismatched) + len(not_verified) + (0 if manifest_match else 1)
        return CheckOutcome("FAIL", f"파일 무결성 검증에서 불일치 {problems}건이 발견되었습니다.", evidence)
    return CheckOutcome("PASS", f"파일 {len(ctx.files)}개의 checksum과 manifest가 일치합니다.", evidence)
