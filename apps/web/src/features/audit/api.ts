"use client";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useAuthReady } from "@/features/auth/use-auth-ready";
import { api, unwrap } from "@/shared/api/client";
import { nextCursor } from "@/shared/api/pagination";
import type { AuditEvent, Page, Query } from "@/shared/api/types";

export function useListAuditEvents(query: Query<"listAuditEvents">, { enabled = true }: { enabled?: boolean } = {}) {
  const ready = useAuthReady();
  return useInfiniteQuery({
    queryKey: ["listAuditEvents", query],
    queryFn: async ({ pageParam }) => (await unwrap(api.GET("/audit-events", { params: { query: { ...query, cursor: pageParam } } }))) as Page<AuditEvent>,
    initialPageParam: undefined as string | undefined,
    getNextPageParam: nextCursor,
    enabled: ready && enabled,
  });
}
