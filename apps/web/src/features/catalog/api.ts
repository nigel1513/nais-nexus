"use client";
import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuthReady } from "@/features/auth/use-auth-ready";
import { api, unwrap } from "@/shared/api/client";
import { nextCursor } from "@/shared/api/pagination";
import type { Dataset, DatasetPolicyView, DatasetVersion, Query, Schemas, SearchPage } from "@/shared/api/types";

export type SearchQuery = Query<"searchDatasets">;

export function useSearchDatasets(query: SearchQuery) {
  const ready = useAuthReady();
  return useInfiniteQuery({
    queryKey: ["searchDatasets", query],
    enabled: ready,
    queryFn: async ({ pageParam }) => (await unwrap(api.GET("/datasets", { params: { query: { ...query, cursor: pageParam } } }))) as SearchPage,
    initialPageParam: undefined as string | undefined,
    getNextPageParam: nextCursor,
    placeholderData: keepPreviousData, // M10 §7.4: keep old results on slow responses
  });
}

export function useGetDataset(datasetId: string) {
  const ready = useAuthReady();
  return useQuery({
    queryKey: ["getDataset", { datasetId }],
    enabled: ready,
    queryFn: async () => (await unwrap(api.GET("/datasets/{dataset_id}", { params: { path: { dataset_id: datasetId } } }))) as Dataset,
  });
}

export function useGetDatasetPolicy(datasetId: string, { enabled = true }: { enabled?: boolean } = {}) {
  const ready = useAuthReady();
  return useQuery({
    queryKey: ["getDatasetPolicy", { datasetId }],
    queryFn: async () => (await unwrap(api.GET("/datasets/{dataset_id}/policy", { params: { path: { dataset_id: datasetId } } }))) as DatasetPolicyView,
    enabled: ready && enabled && !!datasetId,
  });
}

export function useListDatasetVersions(datasetId: string) {
  const ready = useAuthReady();
  return useQuery({
    queryKey: ["listDatasetVersions", { datasetId }],
    enabled: ready,
    queryFn: async () => (await unwrap(api.GET("/datasets/{dataset_id}/versions", { params: { path: { dataset_id: datasetId } } }))) as { items: DatasetVersion[] },
  });
}

/**
 * `pollMs`: refetch while the server is verifying files (UPLOADED → VERIFIED, M10 §9.6). PENDING rows only count while a
 * local upload is running (`pollPending`): PENDING rows of a cancelled/expired session never settle by themselves.
 */
export function useGetDatasetVersion(versionId: string, { pollMs, pollPending = false }: { pollMs?: number; pollPending?: boolean } = {}) {
  const ready = useAuthReady();
  return useQuery({
    queryKey: ["getDatasetVersion", { versionId }],
    enabled: ready,
    refetchInterval: pollMs
      ? (query) => (query.state.status !== "error" && query.state.data?.files.some((f) => f.status === "UPLOADED" || (pollPending && f.status === "PENDING")) ? pollMs : false)
      : false,
    queryFn: async () => (await unwrap(api.GET("/dataset-versions/{version_id}", { params: { path: { version_id: versionId } } }))) as DatasetVersion,
  });
}

export function useCreateDataset() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: Schemas["DatasetCreate"]) => (await unwrap(api.POST("/datasets", { body }))) as Dataset,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["searchDatasets"] }),
  });
}

export function useUpdateDataset(datasetId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: Schemas["DatasetUpdate"]) =>
      (await unwrap(api.PATCH("/datasets/{dataset_id}", { params: { path: { dataset_id: datasetId } }, body }))) as Dataset,
    onSuccess: (dataset) => {
      qc.setQueryData(["getDataset", { datasetId }], dataset);
      void qc.invalidateQueries({ queryKey: ["getDatasetPolicy", { datasetId }] });
      void qc.invalidateQueries({ queryKey: ["searchDatasets"] });
    },
  });
}

export function useCreateDatasetVersion(datasetId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: { version_label: string; change_note?: string }) =>
      (await unwrap(api.POST("/datasets/{dataset_id}/versions", { params: { path: { dataset_id: datasetId } }, body }))) as DatasetVersion,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["listDatasetVersions", { datasetId }] });
      void qc.invalidateQueries({ queryKey: ["getDataset", { datasetId }] });
    },
  });
}

export function usePublishDatasetVersion(versionId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => (await unwrap(api.POST("/dataset-versions/{version_id}/publish", { params: { path: { version_id: versionId } } }))) as DatasetVersion,
    onSuccess: (version) => {
      qc.setQueryData(["getDatasetVersion", { versionId }], version);
      const datasetId = version.dataset_id;
      void qc.invalidateQueries({ queryKey: ["listDatasetVersions", { datasetId }] });
      void qc.invalidateQueries({ queryKey: ["getDataset", { datasetId }] });
      void qc.invalidateQueries({ queryKey: ["getReadiness", { versionId }] });
      void qc.invalidateQueries({ queryKey: ["searchDatasets"] });
    },
  });
}
