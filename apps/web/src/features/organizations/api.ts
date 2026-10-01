"use client";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { api, unwrap } from "@/shared/api/client";
import { nextCursor } from "@/shared/api/pagination";
import type { ActiveStatus, IdentityPublicProfile, Me, Organization, OrganizationMembership, OrganizationSummary, OrgRole, Page } from "@/shared/api/types";

export function useListOrganizations() {
  const query = { limit: 100 };
  return useQuery({
    queryKey: ["listOrganizations", query],
    queryFn: async () => (await unwrap(api.GET("/organizations", { params: { query } }))) as Page<OrganizationSummary>,
    staleTime: 5 * 60_000,
  });
}

export function useOrgNames(): Record<string, string> {
  const { data } = useListOrganizations();
  return useMemo(() => Object.fromEntries((data?.items ?? []).map((o) => [o.organization_id, o.name])), [data]);
}

export function useGetOrganization(organizationId: string | undefined) {
  return useQuery({
    queryKey: ["getOrganization", { organizationId }],
    queryFn: async () => (await unwrap(api.GET("/organizations/{organization_id}", { params: { path: { organization_id: organizationId! } } }))) as Organization,
    enabled: !!organizationId,
  });
}

export function useListOrganizationMembers(organizationId: string | undefined) {
  return useInfiniteQuery({
    queryKey: ["listOrganizationMembers", { organizationId }],
    queryFn: async ({ pageParam }) =>
      (await unwrap(
        api.GET("/organizations/{organization_id}/members", { params: { path: { organization_id: organizationId! }, query: { cursor: pageParam, limit: 50 } } }),
      )) as Page<OrganizationMembership>,
    initialPageParam: undefined as string | undefined,
    getNextPageParam: nextCursor,
    enabled: !!organizationId,
  });
}

export function useUpdateOrganizationMember() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ organizationId, userId, patch }: { organizationId: string; userId: string; patch: { roles?: OrgRole[]; status?: ActiveStatus } }) =>
      unwrap(api.PATCH("/organizations/{organization_id}/members/{user_id}", { params: { path: { organization_id: organizationId, user_id: userId } }, body: patch })),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["listOrganizationMembers"] });
      void qc.invalidateQueries({ queryKey: ["getMe"] });
    },
  });
}

export function useListUsers(q: string, organizationId?: string) {
  const query = { q: q.trim(), organization_id: organizationId, limit: 10 };
  return useQuery({
    queryKey: ["listUsers", query],
    queryFn: async () => (await unwrap(api.GET("/users", { params: { query } }))) as Page<IdentityPublicProfile>,
    enabled: query.q.length >= 2,
  });
}

/** NTIS researcher number: `null` clears it ("" is a 422 per MeUpdate). */
export function useUpdateMe() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (national_researcher_number: string | null) => unwrap(api.PATCH("/me", { body: { national_researcher_number } })) as Promise<Me>,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["getMe"] }),
  });
}

/** PLATFORM_ADMIN only: move a user to another institute (previous roles end; the user signs in again). */
export function useTransferUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, organizationId }: { userId: string; organizationId: string }) =>
      unwrap(api.POST("/users/{user_id}/transfer", { params: { path: { user_id: userId } }, body: { organization_id: organizationId, roles: [] } })) as Promise<OrganizationMembership>,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["listOrganizationMembers"] });
      void qc.invalidateQueries({ queryKey: ["listUsers"] });
    },
  });
}
