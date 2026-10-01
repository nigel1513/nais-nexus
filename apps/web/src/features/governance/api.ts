"use client";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuthReady } from "@/features/auth/use-auth-ready";
import { api, unwrap } from "@/shared/api/client";
import { nextCursor } from "@/shared/api/pagination";
import type { AccessDecisionResult, AccessGrant, AccessRequest, DownloadSession, Page, Query, Schemas } from "@/shared/api/types";

export function useListAccessRequests(query: Query<"listAccessRequests">, { enabled = true }: { enabled?: boolean } = {}) {
  const ready = useAuthReady();
  return useInfiniteQuery({
    queryKey: ["listAccessRequests", query],
    queryFn: async ({ pageParam }) => (await unwrap(api.GET("/access-requests", { params: { query: { ...query, cursor: pageParam } } }))) as Page<AccessRequest>,
    initialPageParam: undefined as string | undefined,
    getNextPageParam: nextCursor,
    enabled: ready && enabled,
  });
}

export function useGetAccessRequest(accessRequestId: string) {
  const ready = useAuthReady();
  return useQuery({
    queryKey: ["getAccessRequest", { accessRequestId }],
    enabled: ready,
    queryFn: async () =>
      (await unwrap(api.GET("/access-requests/{access_request_id}", { params: { path: { access_request_id: accessRequestId } } }))) as AccessRequest,
  });
}

function useRequestChanged(accessRequestId: string, { grants = false }: { grants?: boolean } = {}) {
  const qc = useQueryClient();
  return (request?: AccessRequest) => {
    if (request) qc.setQueryData(["getAccessRequest", { accessRequestId }], request);
    else void qc.invalidateQueries({ queryKey: ["getAccessRequest", { accessRequestId }] });
    void qc.invalidateQueries({ queryKey: ["listAccessRequests"] });
    if (grants) void qc.invalidateQueries({ queryKey: ["listAccessGrants"] });
  };
}

export function useCreateAccessRequest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: Schemas["AccessRequestCreate"]) => (await unwrap(api.POST("/access-requests", { body }))) as AccessRequest,
    onSuccess: (_request, body) => {
      void qc.invalidateQueries({ queryKey: ["listAccessRequests"] });
      void qc.invalidateQueries({ queryKey: ["getDataset", { datasetId: body.dataset_id }] });
    },
  });
}

const path = (id: string) => ({ params: { path: { access_request_id: id } } });

export function useStartAccessReview(accessRequestId: string) {
  const changed = useRequestChanged(accessRequestId);
  return useMutation({
    mutationFn: async () => (await unwrap(api.POST("/access-requests/{access_request_id}/start-review", path(accessRequestId)))) as AccessRequest,
    onSuccess: changed,
  });
}

export function useApproveAccessRequest(accessRequestId: string) {
  const changed = useRequestChanged(accessRequestId, { grants: true });
  return useMutation({
    mutationFn: async (body: Schemas["AccessApprove"]) =>
      (await unwrap(api.POST("/access-requests/{access_request_id}/approve", { ...path(accessRequestId), body }))) as AccessDecisionResult,
    onSuccess: (r) => changed(r.access_request),
  });
}

export function useRejectAccessRequest(accessRequestId: string) {
  const changed = useRequestChanged(accessRequestId);
  return useMutation({
    mutationFn: async (body: { reason: string }) =>
      (await unwrap(api.POST("/access-requests/{access_request_id}/reject", { ...path(accessRequestId), body }))) as AccessDecisionResult,
    onSuccess: (r) => changed(r.access_request),
  });
}

export function useRequestAccessChanges(accessRequestId: string) {
  const changed = useRequestChanged(accessRequestId);
  return useMutation({
    mutationFn: async (body: { comment: string }) =>
      (await unwrap(api.POST("/access-requests/{access_request_id}/request-changes", { ...path(accessRequestId), body }))) as AccessDecisionResult,
    onSuccess: (r) => changed(r.access_request),
  });
}

export function useResubmitAccessRequest(accessRequestId: string) {
  const changed = useRequestChanged(accessRequestId);
  return useMutation({
    mutationFn: async (body: Partial<Pick<Schemas["AccessRequestCreate"], "purpose" | "purpose_detail" | "operations" | "requested_days">>) =>
      (await unwrap(api.POST("/access-requests/{access_request_id}/resubmit", { ...path(accessRequestId), body }))) as AccessRequest,
    onSuccess: changed,
  });
}

export function useWithdrawAccessRequest(accessRequestId: string) {
  const changed = useRequestChanged(accessRequestId);
  return useMutation({
    mutationFn: async () => (await unwrap(api.POST("/access-requests/{access_request_id}/withdraw", path(accessRequestId)))) as AccessRequest,
    onSuccess: changed,
  });
}

export function useListAccessGrants(query: Query<"listAccessGrants">, { enabled = true }: { enabled?: boolean } = {}) {
  const ready = useAuthReady();
  return useInfiniteQuery({
    queryKey: ["listAccessGrants", query],
    queryFn: async ({ pageParam }) => (await unwrap(api.GET("/access-grants", { params: { query: { ...query, cursor: pageParam } } }))) as Page<AccessGrant>,
    initialPageParam: undefined as string | undefined,
    getNextPageParam: nextCursor,
    enabled: ready && enabled,
  });
}

export function useRevokeAccessGrant() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ grantId, reason }: { grantId: string; reason: string }) =>
      (await unwrap(api.POST("/access-grants/{access_grant_id}/revoke", { params: { path: { access_grant_id: grantId } }, body: { reason } }))) as AccessGrant,
    onSettled: () => qc.invalidateQueries({ queryKey: ["listAccessGrants"] }),
  });
}

export function useCreateDownloadSession(versionId: string) {
  return useMutation({
    mutationFn: async (body: Schemas["DownloadSessionCreate"]) =>
      (await unwrap(api.POST("/dataset-versions/{version_id}/download-session", { params: { path: { version_id: versionId } }, body }))) as DownloadSession,
  });
}
