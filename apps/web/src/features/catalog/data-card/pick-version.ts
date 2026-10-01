import type { DatasetVersion } from "@/shared/api/types";

type V = Pick<DatasetVersion, "dataset_version_id" | "status" | "published_at">;

/** `?v=` wins when it names a visible version; otherwise the latest PUBLISHED, else the first visible one. */
export function pickVersion<T extends V>(items: T[], param: string | null, seesDrafts: boolean): T | undefined {
  const visible = items.filter((v) => v.status !== "DRAFT" || seesDrafts);
  const asked = param ? visible.find((v) => v.dataset_version_id === param) : undefined;
  if (asked) return asked;
  const published = visible.filter((v) => v.status === "PUBLISHED").sort((a, b) => (b.published_at ?? "").localeCompare(a.published_at ?? ""));
  return published[0] ?? visible[0];
}
