"use client";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuthReady } from "@/features/auth/use-auth-ready";
import { api, unwrap } from "@/shared/api/client";
import { nextCursor } from "@/shared/api/pagination";
import type { Page, Schemas } from "@/shared/api/types";

export type Thread = Schemas["Thread"];
export type Comment = Schemas["Comment"];
export type ThreadScope = Schemas["ThreadScope"];

/** One target's threads (scope + target_id), or every PROJECT/OUTPUT/RECIPE thread of a project. */
export type ThreadSelector = { scope: ThreadScope; targetId: string } | { projectId: string };

const selectorQuery = (s: ThreadSelector) => ("projectId" in s ? { project_id: s.projectId } : { scope: s.scope, target_id: s.targetId });

export function useThreads(selector: ThreadSelector) {
  const ready = useAuthReady();
  const query = selectorQuery(selector);
  return useInfiniteQuery({
    queryKey: ["listThreads", query],
    enabled: ready,
    queryFn: async ({ pageParam }) => (await unwrap(api.GET("/threads", { params: { query: { ...query, cursor: pageParam } } }))) as Page<Thread>,
    initialPageParam: undefined as string | undefined,
    getNextPageParam: nextCursor,
  });
}

export function useComments(threadId: string) {
  const ready = useAuthReady();
  return useInfiniteQuery({
    queryKey: ["listComments", { threadId }],
    enabled: ready,
    queryFn: async ({ pageParam }) =>
      (await unwrap(api.GET("/threads/{thread_id}/comments", { params: { path: { thread_id: threadId }, query: { cursor: pageParam, limit: 100 } } }))) as Page<Comment>,
    initialPageParam: undefined as string | undefined,
    getNextPageParam: nextCursor,
  });
}

function useInvalidateThreads() {
  const qc = useQueryClient();
  return (thread: Pick<Thread, "scope" | "target_id">) => {
    void qc.invalidateQueries({ queryKey: ["listThreads"] });
    if (thread.scope === "DATASET") void qc.invalidateQueries({ queryKey: ["listDatasetActivity", { datasetId: thread.target_id }] });
  };
}

export function useCreateThread() {
  const invalidate = useInvalidateThreads();
  return useMutation({
    mutationFn: async (body: Schemas["ThreadCreate"]) => (await unwrap(api.POST("/threads", { body }))) as Thread,
    onSuccess: invalidate,
  });
}

export function useUpdateThread(thread: Thread) {
  const invalidate = useInvalidateThreads();
  return useMutation({
    mutationFn: async (body: Schemas["ThreadUpdate"]) => (await unwrap(api.PATCH("/threads/{thread_id}", { params: { path: { thread_id: thread.thread_id } }, body }))) as Thread,
    onSuccess: invalidate,
  });
}

export function useAddComment(thread: Thread) {
  const qc = useQueryClient();
  const invalidate = useInvalidateThreads();
  return useMutation({
    mutationFn: async (body: Schemas["CommentCreate"]) =>
      (await unwrap(api.POST("/threads/{thread_id}/comments", { params: { path: { thread_id: thread.thread_id } }, body }))) as Comment,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["listComments", { threadId: thread.thread_id }] });
      invalidate(thread);
    },
  });
}
