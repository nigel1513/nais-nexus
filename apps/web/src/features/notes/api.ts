"use client";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuthReady } from "@/features/auth/use-auth-ready";
import { api, unwrap } from "@/shared/api/client";
import { networkError, toApiError } from "@/shared/api/errors";
import { nextCursor } from "@/shared/api/pagination";
import type { Page, Query, Schemas } from "@/shared/api/types";

export type ResearchNote = Schemas["ResearchNote"];
export type NoteSummary = Schemas["ResearchNoteSummary"];
export type NoteBlock = Schemas["NoteBlock"];
export type NoteBlockWrite = Schemas["NoteBlockWrite"];
export type NoteSection = Schemas["NoteSection"];
export type NoteSettings = Schemas["NoteSettings"];
export type NoteSearchHit = Schemas["NoteSearchHit"];
export type NoteVerification = Schemas["NoteVerification"];

/** Standard research-note template, in display / hash / export order (openapi NoteSection). */
export const NOTE_SECTIONS: readonly NoteSection[] = ["OBJECTIVE", "METHOD", "PROCEDURE", "RESULTS", "DISCUSSION", "NEXT", "REFERENCES"];

/** Poll a note every 2 s while its AI draft is QUEUED or RUNNING. */
export const DRAFT_POLL_MS = 2000;
export const draftPending = (n: Pick<ResearchNote, "draft_status">) => n.draft_status === "QUEUED" || n.draft_status === "RUNNING";

export const noteKey = (noteId: string) => ["getNote", { noteId }] as const;
const notesKey = ["listNotes"] as const;

/** Everything a note change can move: lists (status, AI count), searches, the note itself. */
function useNoteInvalidation() {
  const qc = useQueryClient();
  return (note: ResearchNote) => {
    qc.setQueryData(noteKey(note.note_id), note);
    void qc.invalidateQueries({ queryKey: notesKey });
    void qc.invalidateQueries({ queryKey: ["searchNotes"] });
  };
}

// ---------------------------------------------------------------- lists and search

export type NotesQuery = Omit<Query<"listNotes">, "cursor">;

export function useNotes(query: NotesQuery) {
  const ready = useAuthReady();
  return useInfiniteQuery({
    queryKey: [...notesKey, query],
    enabled: ready,
    queryFn: async ({ pageParam }) => (await unwrap(api.GET("/notes", { params: { query: { ...query, cursor: pageParam } } }))) as Page<NoteSummary>,
    initialPageParam: undefined as string | undefined,
    getNextPageParam: nextCursor,
  });
}

/**
 * Semantic search (keyword fallback). Hits come best first; a numeric score only re-orders them (scores are null in the
 * fallback and on different scales between rerank and cosine), and it is never shown.
 */
export function useNoteSearch(q: string, projectId?: string) {
  const ready = useAuthReady();
  const text = q.trim();
  return useQuery({
    queryKey: ["searchNotes", { q: text, projectId }],
    enabled: ready && text.length > 0,
    queryFn: async () => {
      const res = (await unwrap(api.GET("/notes/search", { params: { query: { q: text, project_id: projectId } } }))) as { items: NoteSearchHit[] };
      return orderHits(res.items);
    },
  });
}

/** Stable order: hits with a score by score (desc), hits without keep the server's order after them. */
export function orderHits(items: NoteSearchHit[]): NoteSearchHit[] {
  return items
    .map((h, i) => ({ h, i }))
    .sort((a, b) => {
      const sa = typeof a.h.score === "number" ? a.h.score : null;
      const sb = typeof b.h.score === "number" ? b.h.score : null;
      if (sa !== null && sb !== null && sa !== sb) return sb - sa;
      if (sa !== null && sb === null) return -1;
      if (sa === null && sb !== null) return 1;
      return a.i - b.i;
    })
    .map(({ h }) => h);
}

// ---------------------------------------------------------------- one note

export function useNote(noteId: string) {
  const ready = useAuthReady();
  return useQuery({
    queryKey: noteKey(noteId),
    enabled: ready,
    queryFn: async () => (await unwrap(api.GET("/notes/{note_id}", { params: { path: { note_id: noteId } } }))) as ResearchNote,
    refetchInterval: (q) => (q.state.data && draftPending(q.state.data) ? DRAFT_POLL_MS : false),
  });
}

export function useTodayNote() {
  const invalidate = useNoteInvalidation();
  return useMutation({
    mutationFn: async (projectId: string) =>
      (await unwrap(api.POST("/projects/{project_id}/notes/today", { params: { path: { project_id: projectId } } }))) as ResearchNote,
    onSuccess: invalidate,
  });
}

/** Replaces the block list; `revision` is the one the editor holds (If-Match), so a save over a newer one is a 409. */
export function useSaveBlocks(noteId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ revision, blocks }: { revision: number; blocks: NoteBlockWrite[] }) =>
      (await unwrap(
        api.PUT("/notes/{note_id}/blocks", { params: { path: { note_id: noteId }, header: { "If-Match": `"${revision}"` } }, body: { blocks } }),
      )) as ResearchNote,
    onSuccess: (note) => {
      qc.setQueryData(noteKey(noteId), note);
      void qc.invalidateQueries({ queryKey: notesKey });
    },
  });
}

function useNoteAction(path: "/notes/{note_id}/draft" | "/notes/{note_id}/submit" | "/notes/{note_id}/sign", noteId: string) {
  const invalidate = useNoteInvalidation();
  return useMutation({
    mutationFn: async () => (await unwrap(api.POST(path, { params: { path: { note_id: noteId } } }))) as ResearchNote,
    onSuccess: invalidate,
  });
}

export const useDraftNote = (noteId: string) => useNoteAction("/notes/{note_id}/draft", noteId);
export const useSubmitNote = (noteId: string) => useNoteAction("/notes/{note_id}/submit", noteId);
export const useSignNote = (noteId: string) => useNoteAction("/notes/{note_id}/sign", noteId);

export function useRejectNote(noteId: string) {
  const invalidate = useNoteInvalidation();
  return useMutation({
    mutationFn: async (reason: string) => (await unwrap(api.POST("/notes/{note_id}/reject", { params: { path: { note_id: noteId } }, body: { reason } }))) as ResearchNote,
    onSuccess: invalidate,
  });
}

export function useReviseNote(noteId: string) {
  const invalidate = useNoteInvalidation();
  return useMutation({
    mutationFn: async () => (await unwrap(api.POST("/notes/{note_id}/revise", { params: { path: { note_id: noteId } } }))) as ResearchNote,
    onSuccess: invalidate,
  });
}

/** Recomputes the content hash and the project × organization chain on the server (fetched on demand, never cached). */
export function useVerifyNote(noteId: string) {
  return useMutation({
    mutationFn: async () => (await unwrap(api.GET("/notes/{note_id}/verify", { params: { path: { note_id: noteId } } }))) as NoteVerification,
  });
}

// ---------------------------------------------------------------- settings

const settingsKey = (projectId: string) => ["getNoteSettings", { projectId }] as const;

export function useNoteSettings(projectId: string | undefined) {
  const ready = useAuthReady();
  return useQuery({
    queryKey: settingsKey(projectId ?? ""),
    enabled: ready && !!projectId,
    queryFn: async () => (await unwrap(api.GET("/projects/{project_id}/note-settings", { params: { path: { project_id: projectId! } } }))) as NoteSettings,
    staleTime: 60_000,
  });
}

export function useUpdateNoteSettings(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: Schemas["NoteSettingsUpdate"]) =>
      (await unwrap(api.PATCH("/projects/{project_id}/note-settings", { params: { path: { project_id: projectId } }, body }))) as NoteSettings,
    onSuccess: (s) => qc.setQueryData(settingsKey(projectId), s),
  });
}

// ---------------------------------------------------------------- export

/** ZIP of notes (JSON + readable HTML + hashes.csv), as the browser should save it. */
export async function fetchNotesExport(query: Query<"exportNotes">): Promise<{ blob: Blob; filename: string }> {
  let result;
  try {
    result = await api.GET("/notes/export", { params: { query }, parseAs: "blob" });
  } catch (cause) {
    throw networkError(cause);
  }
  const { data, response } = result;
  // openapi-fetch reads an error body as JSON whatever parseAs says.
  if (!response.ok || !data) throw toApiError(response.status, result.error ?? null, response.headers.get("X-Request-Id"));
  const disposition = response.headers.get("Content-Disposition") ?? "";
  const filename = /filename="?([^";]+)"?/.exec(disposition)?.[1] ?? `research-notes-${query.project_id}.zip`;
  return { blob: data as Blob, filename };
}
