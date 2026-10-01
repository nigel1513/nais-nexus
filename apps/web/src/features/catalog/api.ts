"use client";
import { keepPreviousData, useInfiniteQuery, useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocale } from "next-intl";
import { useAuthReady } from "@/features/auth/use-auth-ready";
import { api, unwrap } from "@/shared/api/client";
import { nextCursor } from "@/shared/api/pagination";
import { ApiError } from "@/shared/api/errors";
import type {
  Dataset, DatasetContributor, DatasetContributorsPut, DatasetPolicyView, DatasetVersion, FilePreview, FileProfile, Query, Schemas, SearchPage,
  VocabularyScheme, VocabularyTerm,
} from "@/shared/api/types";

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

const SCHEMES: VocabularyScheme[] = ["SUBJECT", "METHOD", "MATERIAL"];

export function useListVocabulary(scheme: VocabularyScheme) {
  const ready = useAuthReady();
  return useQuery({
    queryKey: ["listVocabulary", { scheme }],
    enabled: ready,
    staleTime: 10 * 60_000,
    queryFn: async () => (await unwrap(api.GET("/vocabulary/{scheme}", { params: { path: { scheme } } }))) as { items: VocabularyTerm[] },
  });
}

/** `(scheme, code) => label` in the active locale; falls back to the code while loading or for unknown codes. */
export function useVocabularyLabels(): (scheme: VocabularyScheme, code: string) => string {
  const ready = useAuthReady();
  const locale = useLocale();
  const results = useQueries({
    queries: SCHEMES.map((scheme) => ({
      queryKey: ["listVocabulary", { scheme }],
      enabled: ready,
      staleTime: 10 * 60_000,
      queryFn: async () => (await unwrap(api.GET("/vocabulary/{scheme}", { params: { path: { scheme } } }))) as { items: VocabularyTerm[] },
    })),
  });
  return (scheme, code) => {
    const term = results[SCHEMES.indexOf(scheme)]?.data?.items.find((x) => x.code === code);
    return term ? (locale === "en" ? term.label_en : term.label_ko) : code;
  };
}

export function useListDatasetContributors(datasetId: string) {
  const ready = useAuthReady();
  return useQuery({
    queryKey: ["listDatasetContributors", { datasetId }],
    enabled: ready && !!datasetId,
    queryFn: async () =>
      (await unwrap(api.GET("/datasets/{dataset_id}/contributors", { params: { path: { dataset_id: datasetId } } }))) as { items: DatasetContributor[] },
  });
}

export function usePutDatasetContributors(datasetId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: DatasetContributorsPut) =>
      (await unwrap(api.PUT("/datasets/{dataset_id}/contributors", { params: { path: { dataset_id: datasetId } }, body }))) as { items: DatasetContributor[] },
    onSuccess: (data) => {
      qc.setQueryData(["listDatasetContributors", { datasetId }], data);
      void qc.invalidateQueries({ queryKey: ["getDataset", { datasetId }] });
    },
  });
}

export function useGetFileProfile(fileId: string) {
  const ready = useAuthReady();
  return useQuery({
    queryKey: ["getFileProfile", { fileId }],
    enabled: ready && !!fileId,
    queryFn: async () => (await unwrap(api.GET("/dataset-files/{file_id}/profile", { params: { path: { file_id: fileId } } }))) as FileProfile,
  });
}

/** 403 DOWNLOAD_PERMISSION_REQUIRED is an expected answer, not worth retrying. */
export function useGetFilePreview(fileId: string) {
  const ready = useAuthReady();
  return useQuery({
    queryKey: ["getFilePreview", { fileId }],
    enabled: ready && !!fileId,
    retry: (count, error) => !(error instanceof ApiError && error.status === 403) && count < 1,
    queryFn: async () => (await unwrap(api.GET("/dataset-files/{file_id}/preview", { params: { path: { file_id: fileId } } }))) as FilePreview,
  });
}

/** Not a query: fetches the JSON-LD with the shared client and saves it as a file (no secure-context-only APIs). */
export async function downloadJsonLd(datasetId: string, title: string) {
  const doc = await unwrap(api.GET("/datasets/{dataset_id}/metadata.jsonld", { params: { path: { dataset_id: datasetId } } }));
  const url = URL.createObjectURL(new Blob([JSON.stringify(doc, null, 2)], { type: "application/ld+json" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: `${title.replace(/[^\w.-]+/g, "_")}.jsonld` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
