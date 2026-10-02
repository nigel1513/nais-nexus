"use client";
import { useQueries } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
import { useListAuditEvents } from "@/features/audit/api";
import { useAuthReady } from "@/features/auth/use-auth-ready";
import { useGetFileProfiles } from "@/features/catalog/api";
import { isTabular } from "@/features/catalog/lib/tabular";
import { api, unwrap } from "@/shared/api/client";
import { flattenPages } from "@/shared/api/pagination";
import type { Dataset, DatasetVersion, ReadinessOverall, ReadinessValidation, Schemas } from "@/shared/api/types";

type FilePreviewStatus = Schemas["FilePreviewStatus"];

/** Audit pages fetched for the 30-day window (100 rows each). Beyond this the chart says it is partial. */
const MAX_AUDIT_PAGES = 10;

/** Every audit event since `from`, following cursors up to MAX_AUDIT_PAGES. Same listAuditEvents operation as the activity screen. */
export function useAuditWindow(from: string) {
  const q = useListAuditEvents({ from, limit: 100 });
  const pages = q.data?.pages.length ?? 0;
  const { hasNextPage, isFetchingNextPage, fetchNextPage, isError } = q;
  useEffect(() => {
    if (hasNextPage && !isFetchingNextPage && !isError && pages < MAX_AUDIT_PAGES) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, isError, pages, fetchNextPage]);
  const events = useMemo(() => flattenPages(q.data), [q.data]);
  const settled = !!q.data && (!hasNextPage || pages >= MAX_AUDIT_PAGES);
  return { query: q, events, settled, partial: settled && !!hasNextPage };
}

type Hit = Schemas["DatasetSearchHit"];
export type HealthRow = {
  hit: Hit;
  versionId: string | null;
  publishedAt: string | null;
  readiness: ReadinessOverall | null;
  /** Checks of the primary profile (TABULAR_ML_BASIC, else GENERIC_BASIC): passed / applicable. */
  score: { pass: number; total: number } | null;
  /** Worst state over the version's table files; "NONE" = no table file to preview; null = not known yet. */
  preview: FilePreviewStatus | "NONE" | null;
  loading: boolean;
};

const PREVIEW_RANK: Record<FilePreviewStatus, number> = { FAILED: 3, PENDING: 2, READY: 1, UNSUPPORTED: 0 };
const isDataTable = (path: string) => isTabular(path) && !(path.split("/").pop() ?? "").startsWith("_");

function primaryScore(items: ReadinessValidation[] | undefined): HealthRow["score"] {
  const done = (items ?? []).filter((v) => v.run_status === "COMPLETED" && v.summary);
  const latest = (profile: string) => done.filter((v) => v.profile_id === profile).sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
  const v = latest("TABULAR_ML_BASIC") ?? latest("GENERIC_BASIC");
  if (!v?.summary) return null;
  const pass = v.summary.pass ?? 0;
  return { pass, total: pass + (v.summary.warning ?? 0) + (v.summary.fail ?? 0) };
}

/**
 * Health of the institute's datasets: latest published version (getDataset), its readiness checks (getReadiness) and
 * the preview state of its table files (getDatasetVersion + getFileProfile). Shares cache keys with the data card.
 */
export function useHealthRows(hits: Hit[]): HealthRow[] {
  const ready = useAuthReady();
  const datasets = useQueries({
    queries: hits.map((h) => ({
      queryKey: ["getDataset", { datasetId: h.dataset_id }],
      enabled: ready,
      queryFn: async () => (await unwrap(api.GET("/datasets/{dataset_id}", { params: { path: { dataset_id: h.dataset_id } } }))) as Dataset,
    })),
  });
  const versionIds = datasets.map((d) => d.data?.latest_published_version?.dataset_version_id ?? null);
  // One query per distinct published version (drafts have none), so no two observers share a key.
  const ids = [...new Set(versionIds.filter((id): id is string => !!id))];
  const readinessList = useQueries({
    queries: ids.map((id) => ({
      queryKey: ["getReadiness", { versionId: id }],
      enabled: ready,
      queryFn: async () => (await unwrap(api.GET("/dataset-versions/{version_id}/readiness", { params: { path: { version_id: id } } }))) as { items: ReadinessValidation[] },
    })),
  });
  const versionList = useQueries({
    queries: ids.map((id) => ({
      queryKey: ["getDatasetVersion", { versionId: id }],
      enabled: ready,
      queryFn: async () => (await unwrap(api.GET("/dataset-versions/{version_id}", { params: { path: { version_id: id } } }))) as DatasetVersion,
    })),
  });
  const readiness = versionIds.map((id) => (id ? readinessList[ids.indexOf(id)] : undefined));
  const versions = versionIds.map((id) => (id ? versionList[ids.indexOf(id)] : undefined));
  const tableFiles = versions.map((v) => (v?.data?.files ?? []).filter((f) => isDataTable(f.path)).map((f) => f.file_id));
  const profiles = useGetFileProfiles([...new Set(tableFiles.flat())]);
  const statusOf = new Map(profiles.map((p) => [p.data?.file_id, p.data?.status]));

  return hits.map((hit, i) => {
    const latest = datasets[i]?.data?.latest_published_version ?? null;
    const files = tableFiles[i] ?? [];
    const statuses = files.map((id) => statusOf.get(id)).filter((s): s is FilePreviewStatus => !!s);
    const known = !!versions[i]?.data && statuses.length === files.length;
    const preview = !known ? null : files.length === 0 ? "NONE" : statuses.reduce((a, b) => (PREVIEW_RANK[b] > PREVIEW_RANK[a] ? b : a));
    return {
      hit,
      versionId: latest?.dataset_version_id ?? null,
      publishedAt: latest?.published_at ?? null,
      readiness: latest?.readiness_overall ?? hit.readiness_overall ?? null,
      score: primaryScore(readiness[i]?.data?.items),
      preview,
      loading: !!datasets[i]?.isPending || (!!latest && (!!readiness[i]?.isPending || !!versions[i]?.isPending)),
    };
  });
}
