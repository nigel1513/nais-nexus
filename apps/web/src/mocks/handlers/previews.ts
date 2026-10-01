import { http, HttpResponse } from "msw";
import { getDb } from "../db";
import { API, currentUser, fail } from "../http";
import type { MockDb, MockUser, StoredDataset } from "../types";
import { isTabular, visibleVersion } from "./catalog";

/**
 * Preview permission (ruling P6, mirrors backend NoGrants until M04): PLATFORM_ADMIN, a current member of the owner
 * organization, or a PUBLIC dataset. Grants are deliberately ignored (unlike downloads).
 */
function canPreview(user: MockUser, ds: StoredDataset): boolean {
  if (user.platform_roles.includes("PLATFORM_ADMIN")) return true;
  if (user.status === "ACTIVE" && user.membership_status === "ACTIVE" && user.organization_id === ds.owner_organization_id) return true;
  return ds.access_level === "PUBLIC";
}

function load(request: Request, fileId: string) {
  const db: MockDb = getDb();
  const user = currentUser(request);
  const version = db.versions.find((v) => v.files.some((f) => f.file_id === fileId));
  if (!version) fail("NOT_FOUND");
  const { ds } = visibleVersion(db, version.dataset_version_id, user);
  const file = version.files.find((f) => f.file_id === fileId)!;
  const row = isTabular(file.path) ? db.previews[fileId] : undefined;
  return { user, ds, file, row, status: row?.status ?? ("UNSUPPORTED" as const) };
}

export const previewHandlers = [
  // Column summary only: never raw values (D-018).
  http.get(`${API}/dataset-files/:file_id/profile`, ({ request, params }) => {
    const { file, row, status } = load(request, String(params.file_id));
    const base = { file_id: file.file_id, path: file.path, status, columns: [] as unknown[], ...(row ? { failure_code: row.failure_code ?? null, generated_at: row.generated_at ?? null } : {}) };
    return HttpResponse.json(status === "READY" ? { ...base, ...row!.column_profile } : base);
  }),
  http.get(`${API}/dataset-files/:file_id/preview`, ({ request, params }) => {
    const { user, ds, file, row, status } = load(request, String(params.file_id));
    if (!canPreview(user, ds)) fail("FORBIDDEN", "접근 승인 후 미리보기를 볼 수 있습니다.", { reason: "DOWNLOAD_PERMISSION_REQUIRED" });
    return HttpResponse.json({ file_id: file.file_id, status, header: [], rows: [], rows_truncated: false, columns: [], ...(status === "READY" ? row!.preview : {}) });
  }),
];
