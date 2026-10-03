"use client";
import { useInfiniteQuery, useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuthReady } from "@/features/auth/use-auth-ready";
import { api, unwrap } from "@/shared/api/client";
import { nextCursor } from "@/shared/api/pagination";
import type { DatasetVersion, Page, Query, Schemas } from "@/shared/api/types";
import { listProjectInputsKey } from "./query-keys";

export type ProjectInput = Schemas["ProjectInput"];
export type Recipe = Schemas["Recipe"];
export type RecipeStep = Schemas["RecipeStep"];
export type RecipeWrite = Schemas["RecipeWrite"];
export type RecipePreview = Schemas["RecipePreview"];
export type Run = Schemas["Run"];
export type Output = Schemas["Output"];
export type PublishRequest = Schemas["PublishRequest"];
export type AccessLevel = Schemas["AccessLevel"];

/** Poll a run (or a list holding one) every 2 s while it is QUEUED or RUNNING; stop once every run is terminal. */
export const RUN_POLL_MS = 2000;
const pending = (r: Pick<Run, "status">) => r.status === "QUEUED" || r.status === "RUNNING";

const recipesKey = (projectId: string) => ["listRecipes", { projectId }] as const;
const recipeKey = (projectId: string, recipeId: string) => ["getRecipe", { projectId, recipeId }] as const;
const runsKey = (projectId: string) => ["listRuns", { projectId }] as const;
const outputsKey = (projectId: string) => ["listOutputs", { projectId }] as const;
const outputKey = (projectId: string, outputId: string) => ["getOutput", { projectId, outputId }] as const;

// ---------------------------------------------------------------- inputs

export function useProjectInputs(projectId: string) {
  const ready = useAuthReady();
  return useQuery({
    queryKey: listProjectInputsKey(projectId),
    enabled: ready,
    queryFn: async () => (await unwrap(api.GET("/projects/{project_id}/inputs", { params: { path: { project_id: projectId } } }))) as { items: ProjectInput[] },
  });
}

/** Input changes touch the project overview (counts, lapsed notices) and the recipes that read them. */
function useInputInvalidation(projectId: string) {
  const qc = useQueryClient();
  return (datasetId?: string) => {
    void qc.invalidateQueries({ queryKey: listProjectInputsKey(projectId) });
    void qc.invalidateQueries({ queryKey: recipesKey(projectId) });
    void qc.invalidateQueries({ queryKey: ["getHubOverview"] });
    if (datasetId) {
      void qc.invalidateQueries({ queryKey: ["listDatasetProjects", { datasetId }] });
      void qc.invalidateQueries({ queryKey: ["listDatasetActivity", { datasetId }] });
    }
  };
}

export function useUpdateProjectInput(projectId: string) {
  const invalidate = useInputInvalidation(projectId);
  return useMutation({
    mutationFn: async ({ inputId, ...body }: { inputId: string } & Schemas["ProjectInputUpdate"]) =>
      (await unwrap(api.PATCH("/projects/{project_id}/inputs/{input_id}", { params: { path: { project_id: projectId, input_id: inputId } }, body }))) as ProjectInput,
    onSuccess: (input) => invalidate(input.dataset_id),
  });
}

export function useRemoveProjectInput(projectId: string) {
  const invalidate = useInputInvalidation(projectId);
  return useMutation({
    mutationFn: async (input: ProjectInput) => {
      await unwrap(api.DELETE("/projects/{project_id}/inputs/{input_id}", { params: { path: { project_id: projectId, input_id: input.input_id } } }));
      return input;
    },
    onSuccess: (input) => invalidate(input.dataset_id),
  });
}

// ---------------------------------------------------------------- recipes

export function useRecipes(projectId: string) {
  const ready = useAuthReady();
  return useQuery({
    queryKey: recipesKey(projectId),
    enabled: ready,
    queryFn: async () => (await unwrap(api.GET("/projects/{project_id}/recipes", { params: { path: { project_id: projectId } } }))) as { items: Recipe[] },
  });
}

export function useRecipe(projectId: string, recipeId: string) {
  const ready = useAuthReady();
  return useQuery({
    queryKey: recipeKey(projectId, recipeId),
    enabled: ready,
    queryFn: async () =>
      (await unwrap(api.GET("/projects/{project_id}/recipes/{recipe_id}", { params: { path: { project_id: projectId, recipe_id: recipeId } } }))) as Recipe,
  });
}

export function useCreateRecipe(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: RecipeWrite) => (await unwrap(api.POST("/projects/{project_id}/recipes", { params: { path: { project_id: projectId } }, body }))) as Recipe,
    onSuccess: (recipe) => {
      qc.setQueryData(recipeKey(projectId, recipe.recipe_id), recipe);
      void qc.invalidateQueries({ queryKey: recipesKey(projectId) });
    },
  });
}

/** Saves a new version; `version` is the one the editor loaded (If-Match), so a save over someone else's is a 409. */
export function useUpdateRecipe(projectId: string, recipeId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ version, body }: { version: number; body: RecipeWrite }) =>
      (await unwrap(
        api.PUT("/projects/{project_id}/recipes/{recipe_id}", {
          params: { path: { project_id: projectId, recipe_id: recipeId }, header: { "If-Match": `"${version}"` } },
          body,
        }),
      )) as Recipe,
    onSuccess: (recipe) => {
      qc.setQueryData(recipeKey(projectId, recipeId), recipe);
      void qc.invalidateQueries({ queryKey: recipesKey(projectId) });
    },
  });
}

export function useDeleteRecipe(projectId: string, recipeId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => unwrap(api.DELETE("/projects/{project_id}/recipes/{recipe_id}", { params: { path: { project_id: projectId, recipe_id: recipeId } } })),
    onSuccess: () => {
      qc.removeQueries({ queryKey: recipeKey(projectId, recipeId) });
      void qc.invalidateQueries({ queryKey: recipesKey(projectId) });
    },
  });
}

/** Unsaved inputs and steps are sent as they are on screen; the server reads at most 10,000 rows per input. */
export function usePreviewRecipe(projectId: string, recipeId: string) {
  return useMutation({
    mutationFn: async (body: Schemas["RecipePreviewRequest"]) =>
      (await unwrap(api.POST("/projects/{project_id}/recipes/{recipe_id}/preview", { params: { path: { project_id: projectId, recipe_id: recipeId } }, body }))) as RecipePreview,
  });
}

export type ColumnInfo = { name: string; type: Schemas["ColumnProfile"]["type"] };

/**
 * The table a recipe reads from a dataset version, as the backend's reader.primary_file picks it: the largest VERIFIED
 * CSV/Parquet file (ties: path order); files whose basename starts with "_" (codebooks, schemas) are never the table.
 */
export function primaryTabularFile(files: Schemas["DatasetFile"][]): Schemas["DatasetFile"] | undefined {
  return files
    .filter((f) => f.status === "VERIFIED" && /\.(csv|parquet)$/i.test(f.path) && !(f.path.split("/").pop() ?? "").startsWith("_"))
    .sort((a, b) => b.size_bytes - a.size_bytes || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))[0];
}

/**
 * Column names and types of each input's table, from the catalog's value-free column profile (no data is read). An
 * input whose profile is missing, not computed yet or unreadable gives no columns: the step forms stay free text.
 */
export function useInputColumns(inputs: Pick<ProjectInput, "input_id" | "dataset_version_id">[]): Map<string, ColumnInfo[]> {
  const ready = useAuthReady();
  const versions = useQueries({
    queries: inputs.map((i) => ({
      // Same key and shape as the catalog's useGetDatasetVersion, so the cache is shared.
      queryKey: ["getDatasetVersion", { versionId: i.dataset_version_id }],
      enabled: ready,
      retry: false,
      queryFn: async () => (await unwrap(api.GET("/dataset-versions/{version_id}", { params: { path: { version_id: i.dataset_version_id } } }))) as DatasetVersion,
    })),
  });
  const fileIds = versions.map((v) => (v.data ? primaryTabularFile(v.data.files)?.file_id : undefined));
  const profiles = useQueries({
    queries: fileIds.map((fileId) => ({
      queryKey: ["workspaceColumns", { fileId }],
      enabled: ready && !!fileId,
      staleTime: Infinity,
      gcTime: 30 * 60_000,
      retry: false,
      queryFn: async (): Promise<ColumnInfo[]> => {
        const p = (await unwrap(api.GET("/dataset-files/{file_id}/profile", { params: { path: { file_id: fileId! } } }))) as Schemas["FileProfile"];
        return p.status === "READY" ? p.columns.map((c) => ({ name: c.name, type: c.type })) : [];
      },
    })),
  });
  return new Map(inputs.map((i, k) => [i.input_id, profiles[k]?.data ?? []]));
}

// ---------------------------------------------------------------- runs

export function useStartRun(projectId: string, recipeId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => (await unwrap(api.POST("/projects/{project_id}/recipes/{recipe_id}/runs", { params: { path: { project_id: projectId, recipe_id: recipeId } } }))) as Run,
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: runsKey(projectId) });
      void qc.invalidateQueries({ queryKey: outputsKey(projectId) });
    },
  });
}

/** Runs newest first (no polling of their own: usePendingRuns refreshes them while a run is in flight). */
export function useRuns(projectId: string, query: Omit<Query<"listRuns">, "cursor"> = {}) {
  const ready = useAuthReady();
  const qc = useQueryClient();
  const queryKey = [...runsKey(projectId), query] as const;
  return useInfiniteQuery({
    queryKey,
    enabled: ready,
    queryFn: async ({ pageParam }) => {
      const page = (await unwrap(api.GET("/projects/{project_id}/runs", { params: { path: { project_id: projectId }, query: { ...query, cursor: pageParam } } }))) as Page<Run>;
      // A run that finished since the last load (or is first seen already finished) may have made an output.
      const before = qc.getQueryData<{ pages: Page<Run>[] }>(queryKey)?.pages.flatMap((p) => p.items);
      if (before) {
        const known = new Map(before.map((r) => [r.run_id, r.status]));
        if (page.items.some((r) => !pending(r) && known.get(r.run_id) !== r.status)) {
          void qc.invalidateQueries({ queryKey: outputsKey(projectId) });
          void qc.invalidateQueries({ queryKey: ["listAuditEvents"] });
        }
      }
      return page;
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: nextCursor,
  });
}

/**
 * The QUEUED/RUNNING runs only, polled every 2 s while there are any, or while a run list on screen still shows one
 * (`listed`); nothing polls once every run is finished. When a listed run's status differs from what this query sees,
 * the run lists (not this query) are refreshed once.
 */
export function usePendingRuns(projectId: string, recipeId: string | undefined, { listed }: { listed: boolean }) {
  const ready = useAuthReady();
  const qc = useQueryClient();
  const lists = { queryKey: runsKey(projectId), predicate: (q: { queryKey: readonly unknown[] }) => q.queryKey[2] !== "pending" };
  return useQuery({
    queryKey: [...runsKey(projectId), "pending", recipeId ?? null],
    enabled: ready,
    queryFn: async () => {
      const page = (await unwrap(
        api.GET("/projects/{project_id}/runs", { params: { path: { project_id: projectId }, query: { status: ["QUEUED", "RUNNING"], ...(recipeId ? { recipe_id: recipeId } : {}), limit: 100 } } }),
      )) as Page<Run>;
      const now = new Map(page.items.map((r) => [r.run_id, r.status]));
      const shown = qc.getQueriesData<{ pages: Page<Run>[] }>(lists).flatMap(([, d]) => d?.pages.flatMap((p) => p.items) ?? []);
      const stale = shown.some((r) => (pending(r) && now.get(r.run_id) !== r.status) || (now.has(r.run_id) && now.get(r.run_id) !== r.status));
      if (stale) void qc.invalidateQueries(lists);
      return page.items;
    },
    refetchInterval: (q) => (q.state.data?.length || listed ? RUN_POLL_MS : false),
  });
}

// ---------------------------------------------------------------- outputs

export function useOutputs(projectId: string, kind?: Schemas["OutputKind"]) {
  const ready = useAuthReady();
  return useInfiniteQuery({
    queryKey: [...outputsKey(projectId), { kind: kind ?? null }],
    enabled: ready,
    queryFn: async ({ pageParam }) =>
      (await unwrap(api.GET("/projects/{project_id}/outputs", { params: { path: { project_id: projectId }, query: { kind, cursor: pageParam } } }))) as Page<Output>,
    initialPageParam: undefined as string | undefined,
    getNextPageParam: nextCursor,
  });
}

export function useOutput(projectId: string, outputId: string) {
  const ready = useAuthReady();
  return useQuery({
    queryKey: outputKey(projectId, outputId),
    enabled: ready,
    queryFn: async () =>
      (await unwrap(api.GET("/projects/{project_id}/outputs/{output_id}", { params: { path: { project_id: projectId, output_id: outputId } } }))) as Output,
  });
}

export async function createOutputUpload(projectId: string, body: Schemas["OutputUploadCreate"]) {
  return (await unwrap(api.POST("/projects/{project_id}/outputs", { params: { path: { project_id: projectId } }, body }))) as Schemas["OutputUploadSession"];
}

export async function completeOutputUpload(projectId: string, outputId: string) {
  return (await unwrap(api.POST("/projects/{project_id}/outputs/{output_id}/complete", { params: { path: { project_id: projectId, output_id: outputId } } }))) as Output;
}

export function useOutputDownload(projectId: string, outputId: string) {
  return useMutation({
    mutationFn: async () =>
      (await unwrap(api.POST("/projects/{project_id}/outputs/{output_id}/download", { params: { path: { project_id: projectId, output_id: outputId } } }))) as Schemas["OutputDownload"],
  });
}

// ---------------------------------------------------------------- publication

export function useRequestPublish(projectId: string, outputId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: Schemas["PublishRequestCreate"]) =>
      (await unwrap(
        api.POST("/projects/{project_id}/outputs/{output_id}/publish-requests", { params: { path: { project_id: projectId, output_id: outputId } }, body }),
      )) as PublishRequest,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: outputKey(projectId, outputId) });
      void qc.invalidateQueries({ queryKey: outputsKey(projectId) });
      void qc.invalidateQueries({ queryKey: ["listPublishRequests"] });
    },
  });
}

export function usePublishRequests(query: Omit<Query<"listPublishRequests">, "cursor">, { enabled = true }: { enabled?: boolean } = {}) {
  const ready = useAuthReady();
  return useInfiniteQuery({
    queryKey: ["listPublishRequests", query],
    enabled: ready && enabled,
    queryFn: async ({ pageParam }) => (await unwrap(api.GET("/publish-requests", { params: { query: { ...query, cursor: pageParam } } }))) as Page<PublishRequest>,
    initialPageParam: undefined as string | undefined,
    getNextPageParam: nextCursor,
  });
}

export function useDecidePublishRequest(requestId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: Schemas["PublishDecisionCreate"]) =>
      (await unwrap(api.POST("/publish-requests/{request_id}/decision", { params: { path: { request_id: requestId } }, body }))) as PublishRequest,
    onSuccess: (req) => {
      void qc.invalidateQueries({ queryKey: ["listPublishRequests"] });
      void qc.invalidateQueries({ queryKey: outputKey(req.project_id, req.output_id) });
      void qc.invalidateQueries({ queryKey: outputsKey(req.project_id) });
    },
  });
}
