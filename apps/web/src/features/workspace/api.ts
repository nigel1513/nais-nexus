"use client";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuthReady } from "@/features/auth/use-auth-ready";
import { api, unwrap } from "@/shared/api/client";
import { nextCursor } from "@/shared/api/pagination";
import type { Page, Query, Schemas } from "@/shared/api/types";
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

/** Columns of one input as read by the server (a preview without steps): suggestions for the step forms. */
export function useInputColumns(projectId: string, recipeId: string, inputId: string | undefined, { enabled = true }: { enabled?: boolean } = {}) {
  const ready = useAuthReady();
  return useQuery({
    queryKey: ["inputColumns", { projectId, recipeId, inputId }],
    enabled: ready && enabled && !!inputId,
    staleTime: 5 * 60_000,
    retry: false,
    queryFn: async () =>
      (
        (await unwrap(
          api.POST("/projects/{project_id}/recipes/{recipe_id}/preview", {
            params: { path: { project_id: projectId, recipe_id: recipeId } },
            body: { input_ids: [inputId!], steps: [] },
          }),
        )) as RecipePreview
      ).header,
  });
}

// ---------------------------------------------------------------- runs

export function useStartRun(projectId: string, recipeId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => (await unwrap(api.POST("/projects/{project_id}/recipes/{recipe_id}/runs", { params: { path: { project_id: projectId, recipe_id: recipeId } } }))) as Run,
    onSuccess: () => void qc.invalidateQueries({ queryKey: runsKey(projectId) }),
  });
}

/** Runs newest first; polls every 2 s while one on the loaded pages is QUEUED/RUNNING, and refreshes outputs when one finishes. */
export function useRuns(projectId: string, query: Omit<Query<"listRuns">, "cursor"> = {}) {
  const ready = useAuthReady();
  const qc = useQueryClient();
  const queryKey = [...runsKey(projectId), query] as const;
  return useInfiniteQuery({
    queryKey,
    enabled: ready,
    queryFn: async ({ pageParam }) => {
      const page = (await unwrap(api.GET("/projects/{project_id}/runs", { params: { path: { project_id: projectId }, query: { ...query, cursor: pageParam } } }))) as Page<Run>;
      // A run that was pending and has finished: its derived output (or failure) shows up elsewhere in the workspace.
      const before = qc.getQueryData<{ pages: Page<Run>[] }>(queryKey)?.pages.flatMap((p) => p.items) ?? [];
      const wasPending = new Set(before.filter(pending).map((r) => r.run_id));
      if (page.items.some((r) => wasPending.has(r.run_id) && !pending(r))) {
        void qc.invalidateQueries({ queryKey: outputsKey(projectId) });
        void qc.invalidateQueries({ queryKey: ["listAuditEvents"] });
      }
      return page;
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: nextCursor,
    refetchInterval: (q) => (q.state.data?.pages.some((p) => p.items.some(pending)) ? RUN_POLL_MS : false),
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
