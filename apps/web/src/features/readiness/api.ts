"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuthReady } from "@/features/auth/use-auth-ready";
import { api, unwrap } from "@/shared/api/client";
import type { ReadinessProfile, ReadinessValidation } from "@/shared/api/types";

type Items<T> = { items: T[] };
const pending = (data?: Items<ReadinessValidation>) => !!data?.items.some((v) => v.run_status === "QUEUED" || v.run_status === "RUNNING");

export function useListReadinessProfiles() {
  const ready = useAuthReady();
  return useQuery({
    queryKey: ["listReadinessProfiles", {}],
    enabled: ready,
    queryFn: async () => (await unwrap(api.GET("/readiness-profiles"))) as Items<ReadinessProfile>,
    staleTime: 10 * 60_000,
  });
}

/** Polls every 5s while a run is QUEUED/RUNNING and stops once all are finished (M10 §7.7). */
export function useGetReadiness(versionId: string, { enabled = true, intervalMs = 5000 }: { enabled?: boolean; intervalMs?: number } = {}) {
  const ready = useAuthReady();
  return useQuery({
    queryKey: ["getReadiness", { versionId }],
    queryFn: async () =>
      (await unwrap(api.GET("/dataset-versions/{version_id}/readiness", { params: { path: { version_id: versionId } } }))) as Items<ReadinessValidation>,
    enabled: ready && enabled,
    refetchInterval: (query) => (pending(query.state.data) || !query.state.data?.items.length ? intervalMs : false),
  });
}

export function useStartReadinessValidation(versionId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (profileId: string) =>
      (await unwrap(
        api.POST("/dataset-versions/{version_id}/readiness-validations", { params: { path: { version_id: versionId } }, body: { profile_id: profileId } }),
      )) as ReadinessValidation,
    onSettled: () => qc.invalidateQueries({ queryKey: ["getReadiness", { versionId }] }),
  });
}
