"use client";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuthReady } from "@/features/auth/use-auth-ready";
import { api, unwrap } from "@/shared/api/client";
import { nextCursor } from "@/shared/api/pagination";
import type { Page, Schemas } from "@/shared/api/types";

export type HubOverview = Schemas["HubOverview"];
export type HubCard = Schemas["HubCard"];
export type HubOrganizationStat = Schemas["HubOrganizationStat"];
export type DatasetProjectsResult = Schemas["DatasetProjectsResult"];
export type DatasetActivity = Schemas["DatasetActivity"];
export type ProjectInput = Schemas["ProjectInput"];

export function useHubOverview() {
  const ready = useAuthReady();
  return useQuery({
    queryKey: ["getHubOverview"],
    enabled: ready,
    queryFn: async () => (await unwrap(api.GET("/hub/overview"))) as HubOverview,
  });
}

/** Projects using the dataset as an input: the ones I am in, plus a count of the rest. */
export function useDatasetProjects(datasetId: string) {
  const ready = useAuthReady();
  return useQuery({
    queryKey: ["listDatasetProjects", { datasetId }],
    enabled: ready,
    queryFn: async () => (await unwrap(api.GET("/datasets/{dataset_id}/projects", { params: { path: { dataset_id: datasetId } } }))) as DatasetProjectsResult,
  });
}

export function useDatasetActivity(datasetId: string) {
  const ready = useAuthReady();
  return useInfiniteQuery({
    queryKey: ["listDatasetActivity", { datasetId }],
    enabled: ready,
    queryFn: async ({ pageParam }) =>
      (await unwrap(api.GET("/datasets/{dataset_id}/activity", { params: { path: { dataset_id: datasetId }, query: { cursor: pageParam, limit: 20 } } }))) as Page<DatasetActivity>,
    initialPageParam: undefined as string | undefined,
    getNextPageParam: nextCursor,
  });
}

/** Pins a dataset version as a project input (default: the latest published version). */
export function useAddProjectInput() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ projectId, ...body }: { projectId: string } & Schemas["ProjectInputCreate"]) =>
      (await unwrap(api.POST("/projects/{project_id}/inputs", { params: { path: { project_id: projectId } }, body }))) as ProjectInput,
    onSuccess: (input) => {
      void qc.invalidateQueries({ queryKey: ["listDatasetProjects", { datasetId: input.dataset_id }] });
      void qc.invalidateQueries({ queryKey: ["listDatasetActivity", { datasetId: input.dataset_id }] });
      void qc.invalidateQueries({ queryKey: ["listProjectInputs", { projectId: input.project_id }] });
      void qc.invalidateQueries({ queryKey: ["getHubOverview"] });
    },
  });
}
