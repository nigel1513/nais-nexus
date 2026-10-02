"use client";
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useAuthReady } from "@/features/auth/use-auth-ready";
import { api, unwrap } from "@/shared/api/client";
import type { DatasetVersion, Schemas } from "@/shared/api/types";

/**
 * Query hooks for the lakeFS-style version operations (spec §3.3b). Creating a draft and publishing stay on
 * `useCreateDatasetVersion` / `usePublishDatasetVersion` in ../api.ts (they carry `from_version_id` / `empty`).
 */
export type VersionDiff = Schemas["VersionDiff"];
export type FileHistory = Schemas["FileHistory"];
export type DatasetCitation = Schemas["DatasetCitation"];
export type CitationStyle = Schemas["CitationStyle"];
export type RebaseResolutions = Record<string, "MINE" | "THEIRS">;

/** What a version change touches: the list, the version itself, and every derived view (diffs, history, citations). */
export function invalidateVersionViews(qc: QueryClient, datasetId: string, versionId?: string) {
  void qc.invalidateQueries({ queryKey: ["listDatasetVersions", { datasetId }] });
  if (versionId) void qc.invalidateQueries({ queryKey: ["getDatasetVersion", { versionId }] });
  void qc.invalidateQueries({ queryKey: ["compareVersions"] });
  void qc.invalidateQueries({ queryKey: ["fileHistory", { datasetId }] });
}

export function useUpdateVersionNote(versionId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (change_note: string) =>
      (await unwrap(api.PATCH("/dataset-versions/{version_id}", { params: { path: { version_id: versionId } }, body: { change_note } }))) as DatasetVersion,
    onSuccess: (v) => {
      qc.setQueryData(["getDatasetVersion", { versionId }], v);
      invalidateVersionViews(qc, v.dataset_id);
    },
  });
}

/** Variable = the draft's version id (a dataset has several drafts). */
export function useDiscardDraft(datasetId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (versionId: string) => {
      await unwrap(api.DELETE("/dataset-versions/{version_id}", { params: { path: { version_id: versionId } } }));
      return versionId;
    },
    onSuccess: (versionId) => {
      qc.removeQueries({ queryKey: ["getDatasetVersion", { versionId }] });
      invalidateVersionViews(qc, datasetId);
    },
  });
}

/** 409 CONFLICT carries `details.conflicts` ({path, base, mine, theirs}) and `details.latest_version_id`; nothing changes then. */
export function useRebaseDraft(versionId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (resolutions?: RebaseResolutions) =>
      (await unwrap(api.POST("/dataset-versions/{version_id}/rebase", { params: { path: { version_id: versionId } }, body: { resolutions: resolutions ?? {} } }))) as DatasetVersion,
    onSuccess: (v) => {
      qc.setQueryData(["getDatasetVersion", { versionId }], v);
      invalidateVersionViews(qc, v.dataset_id);
    },
  });
}

/** `against` omitted: base for a DRAFT, previous version otherwise. */
export function useCompareVersions(versionId: string, against?: string, { enabled = true }: { enabled?: boolean } = {}) {
  const ready = useAuthReady();
  return useQuery({
    queryKey: ["compareVersions", { versionId, against }],
    enabled: ready && enabled && !!versionId,
    queryFn: async () =>
      (await unwrap(api.GET("/dataset-versions/{version_id}/diff", { params: { path: { version_id: versionId }, query: against ? { against } : {} } }))) as VersionDiff,
  });
}

export function useFileHistory(datasetId: string, path: string | null | undefined) {
  const ready = useAuthReady();
  return useQuery({
    queryKey: ["fileHistory", { datasetId, path }],
    enabled: ready && !!path,
    queryFn: async () => (await unwrap(api.GET("/datasets/{dataset_id}/file-history", { params: { path: { dataset_id: datasetId }, query: { path: path! } } }))) as FileHistory,
  });
}

export function useCitation(versionId: string | null | undefined, style: CitationStyle = "text") {
  const ready = useAuthReady();
  return useQuery({
    queryKey: ["citation", { versionId, style }],
    enabled: ready && !!versionId,
    queryFn: async () => (await unwrap(api.GET("/dataset-versions/{version_id}/citation", { params: { path: { version_id: versionId! }, query: { style } } }))) as DatasetCitation,
  });
}
