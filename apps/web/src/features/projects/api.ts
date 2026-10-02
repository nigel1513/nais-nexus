"use client";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuthReady } from "@/features/auth/use-auth-ready";
import { api, unwrap } from "@/shared/api/client";
import { nextCursor } from "@/shared/api/pagination";
import type { Page, Project, ProjectMember, ProjectRole, ProjectSummary, Query, Schemas } from "@/shared/api/types";

export function useListProjects(query: Query<"listProjects">, { enabled = true }: { enabled?: boolean } = {}) {
  const ready = useAuthReady();
  return useInfiniteQuery({
    queryKey: ["listProjects", query],
    enabled: ready && enabled,
    queryFn: async ({ pageParam }) => (await unwrap(api.GET("/projects", { params: { query: { ...query, cursor: pageParam } } }))) as Page<ProjectSummary>,
    initialPageParam: undefined as string | undefined,
    getNextPageParam: nextCursor,
  });
}

export function useGetProject(projectId: string) {
  const ready = useAuthReady();
  return useQuery({
    queryKey: ["getProject", { projectId }],
    enabled: ready,
    queryFn: async () => (await unwrap(api.GET("/projects/{project_id}", { params: { path: { project_id: projectId } } }))) as Project,
  });
}

export function useCreateProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: Schemas["ProjectCreate"]) => (await unwrap(api.POST("/projects", { body }))) as Project,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["listProjects"] }),
  });
}

export function useUpdateProject(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: Schemas["ProjectUpdate"]) =>
      (await unwrap(api.PATCH("/projects/{project_id}", { params: { path: { project_id: projectId } }, body }))) as Project,
    onSuccess: (project) => {
      qc.setQueryData(["getProject", { projectId }], project);
      void qc.invalidateQueries({ queryKey: ["listProjects"] });
    },
  });
}

export function useArchiveProject(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => (await unwrap(api.POST("/projects/{project_id}/archive", { params: { path: { project_id: projectId } } }))) as Project,
    onSuccess: (project) => {
      qc.setQueryData(["getProject", { projectId }], project);
      void qc.invalidateQueries({ queryKey: ["listProjects"] });
      void qc.invalidateQueries({ queryKey: ["listAccessGrants"] });
    },
  });
}

export function useListProjectMembers(projectId: string) {
  const ready = useAuthReady();
  return useQuery({
    queryKey: ["listProjectMembers", { projectId }],
    enabled: ready,
    queryFn: async () => (await unwrap(api.GET("/projects/{project_id}/members", { params: { path: { project_id: projectId } } }))) as { items: ProjectMember[] },
  });
}

function useMemberInvalidation(projectId: string) {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ["listProjectMembers", { projectId }] });
    void qc.invalidateQueries({ queryKey: ["getProject", { projectId }] });
    void qc.invalidateQueries({ queryKey: ["listProjects"] });
  };
}

export function useAddProjectMember(projectId: string) {
  const invalidate = useMemberInvalidation(projectId);
  return useMutation({
    mutationFn: (body: { user_id: string; role: ProjectRole }) =>
      unwrap(api.POST("/projects/{project_id}/members", { params: { path: { project_id: projectId } }, body })),
    onSuccess: invalidate,
  });
}

export function useUpdateProjectMemberRole(projectId: string) {
  const invalidate = useMemberInvalidation(projectId);
  return useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: ProjectRole }) =>
      unwrap(api.PATCH("/projects/{project_id}/members/{user_id}", { params: { path: { project_id: projectId, user_id: userId } }, body: { role } })),
    onSuccess: invalidate,
  });
}

export function useRemoveProjectMember(projectId: string) {
  const invalidate = useMemberInvalidation(projectId);
  return useMutation({
    mutationFn: (userId: string) => unwrap(api.DELETE("/projects/{project_id}/members/{user_id}", { params: { path: { project_id: projectId, user_id: userId } } })),
    onSuccess: invalidate,
  });
}
