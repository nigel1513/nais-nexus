import { getDb } from "@/mocks/db";
import { DATASET, USER, VERSION } from "@/mocks/fixtures";
import type { StoredFile, StoredVersion } from "@/mocks/types";

/** Test-only mock-db scenarios for the version screens (spec §3.3b). Never imported by app code. */
export const LATEST_V21 = "00000000-0000-7000-8000-000000002114";

/**
 * Two drafts branched from v2.0 both changed data/measurements.csv; the other one was published as v2.1 since. The seed
 * draft (VERSION.batteryDraft, base v2.0) is now stale, and rebasing it conflicts on that path.
 */
export function seedStaleDraftWithConflict() {
  const db = getDb();
  const v20 = db.versions.find((v) => v.dataset_version_id === VERSION.battery)!;
  const theirs: StoredFile = {
    file_id: "00000000-0000-7000-8000-0000000f2114",
    path: "data/measurements.csv",
    size_bytes: 31_744,
    sha256: "c0ffee12".repeat(8),
    media_type: "text/csv",
    status: "VERIFIED",
  };
  const inherited = v20.files
    .filter((f) => f.path !== theirs.path)
    .map((f, i): StoredFile => ({
      ...f,
      file_id: `00000000-0000-7000-8000-0000000f21${String(20 + i)}`,
      inherited_from: f.file_id,
    }));
  const files = [...inherited, theirs];
  const now = new Date().toISOString();
  const v21: StoredVersion = {
    dataset_version_id: LATEST_V21,
    dataset_id: DATASET.battery,
    version_label: "v2.1",
    status: "PUBLISHED",
    published_at: now,
    change_note: "측정값 단위 정리",
    files,
    file_count: files.length,
    total_bytes: files.reduce((n, f) => n + f.size_bytes, 0),
    manifest_sha256: "d".repeat(64),
    created_at: now,
    created_by: USER.bSteward,
    base_version_id: VERSION.battery,
    source_version_id: VERSION.battery,
    previous_version_id: VERSION.battery,
  };
  db.versions.push(v21);
  return { draftId: VERSION.batteryDraft, latestId: LATEST_V21 };
}
