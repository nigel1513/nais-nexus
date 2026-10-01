"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuthReady } from "@/features/auth/use-auth-ready";
import { api, unwrap } from "@/shared/api/client";
import type { ReadinessProfile, ReadinessValidation } from "@/shared/api/types";

type Items<T> = { items: T[] };
const MAX_EMPTY_POLLS = 12;
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
    refetchInterval: (query) => {
      if (query.state.status === "error") return false;
      const data = query.state.data;
      if (pending(data)) return intervalMs;
      if (data && data.items.length === 0) {
        // Runs may not exist yet right after publish: back off to 30 s, give up after ~12 empty polls.
        const empty = query.state.dataUpdateCount;
        return empty > MAX_EMPTY_POLLS ? false : empty > 3 ? Math.max(intervalMs, 30_000) : intervalMs;
      }
      return false;
    },
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
