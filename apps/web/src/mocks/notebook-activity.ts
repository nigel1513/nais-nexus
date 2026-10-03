import type { Schemas } from "@/shared/api/types";
import { getDb } from "./db";
import { newId } from "./http";
import { SECTIONS } from "./note-hash";
import { sha256Hex } from "./sha256";
import type { NotebookActivity, StoredNote } from "./types";

/**
 * Stand-in for the backend NotebookActivityPort (apps/api/modules/notes/public.py) while the mock is not bridged to the
 * shared Jupyter (see bridgeConfig below): empty by default, so every note shows draft_source_count 0 and draftNote
 * answers 422 NO_NOTEBOOK_ACTIVITY. Tests seed saved notebooks with seedNotebookActivity(); the list lives in the mock
 * store and resets with it.
 */
export function seedNotebookActivity(entry: Omit<NotebookActivity, "notebook_id" | "version_id"> & { notebook_id?: string; version_id?: string | null }): NotebookActivity {
  const row: NotebookActivity = { ...entry, notebook_id: entry.notebook_id ?? newId(), version_id: entry.version_id === undefined ? newId() : entry.version_id };
  getDb().notebookActivity.push(row);
  return row;
}

export function listNotebookActivity(userId: string, projectId: string, day: string): NotebookActivity[] {
  return getDb().notebookActivity.filter((n) => n.user_id === userId && n.project_id === projectId && n.day === day);
}

type Sentence = { section: Schemas["NoteSection"]; text: string; evidence: Schemas["NoteEvidence"][] };

const firstLine = (text: string, max = 80) => {
  const line = (text.split("\n").find((l) => l.trim()) ?? "").replace(/^#+\s*/, "").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

/**
 * Deterministic stand-in for the local-LLM draft (jobs.draft_note + drafting/apply.py): sentences per template section
 * built only from the notebooks' cell heads and output kinds (never output values), each PROCEDURE/RESULTS sentence
 * citing its cell as NOTEBOOK evidence. No model is called from the mock.
 */
export function draftSentences(activity: NotebookActivity[]): Sentence[] {
  const out: Sentence[] = [];
  for (const nb of activity) {
    const ev = (k: number): Schemas["NoteEvidence"] => ({ type: "NOTEBOOK", ref_id: nb.version_id ?? nb.notebook_id, label: `${nb.title} · 셀 ${k}`, at: nb.saved_at });
    const cells = nb.cells.map((c, i) => ({ ...c, k: i + 1 }));
    const markdown = cells.filter((c) => c.type === "markdown" && c.source_head.trim());
    const code = cells.filter((c) => c.type === "code" && c.source_head.trim());
    if (markdown[0]) out.push({ section: "OBJECTIVE", text: `${firstLine(markdown[0].source_head)}을(를) 목표로 ${nb.title} 노트북 작업을 진행했다.`, evidence: [ev(markdown[0].k)] });
    if (code.length) out.push({ section: "METHOD", text: `${nb.title} 노트북에서 코드 셀 ${code.length}개로 분석을 수행했다.`, evidence: [] });
    for (const c of code.slice(0, 5)) out.push({ section: "PROCEDURE", text: `셀 ${c.k}에서 \`${firstLine(c.source_head, 60)}\`을(를) 실행했다.`, evidence: [ev(c.k)] });
    for (const c of code.filter((x) => x.output_count > 0 && !x.has_error).slice(0, 5)) {
      out.push({ section: "RESULTS", text: `셀 ${c.k} 실행 결과로 ${c.output_kinds.join(", ") || "출력"} ${c.output_count}건을 확인했다.`, evidence: [ev(c.k)] });
    }
    for (const c of code.filter((x) => x.has_error)) out.push({ section: "DISCUSSION", text: `셀 ${c.k} 실행 중 오류가 발생해 원인 확인이 필요하다.`, evidence: [ev(c.k)] });
    const last = markdown.length > 1 ? markdown[markdown.length - 1] : undefined;
    if (last) out.push({ section: "NEXT", text: `${firstLine(last.source_head)} 작업을 이어서 진행한다.`, evidence: [ev(last.k)] });
    out.push({ section: "REFERENCES", text: `Jupyter 노트북 「${nb.title}」`, evidence: [] });
  }
  return out;
}

/** drafting/apply.new_blocks: append AI blocks (accepted=false), skipping sentences already drafted. */
export function appendDraftBlocks(note: StoredNote, sentences: Sentence[]): number {
  const key = (section: string, evidence: Schemas["NoteEvidence"][]) => `${section}|${evidence.map((e) => `${e.type}:${e.ref_id}:${e.label}`).sort().join("|")}`;
  const ai = note.blocks.filter((b) => b.origin === "AI");
  const seenSets = new Set(ai.filter((b) => b.evidence.length).map((b) => key(b.section, b.evidence)));
  const seenTexts = new Set(ai.filter((b) => !b.evidence.length).map((b) => `${b.section}|${b.text}`));
  let added = 0;
  for (const s of sentences) {
    if (s.evidence.length) {
      if (seenSets.has(key(s.section, s.evidence))) continue;
      seenSets.add(key(s.section, s.evidence));
    } else {
      if (seenTexts.has(`${s.section}|${s.text}`)) continue;
      seenTexts.add(`${s.section}|${s.text}`);
    }
    note.blocks.push({ block_id: newId(), section: s.section, text: s.text, origin: "AI", accepted: false, evidence: s.evidence.slice(0, 20) });
    added += 1;
  }
  return added;
}

// ---------------------------------------------------------------- bridge to the real drafting service (M07-lite, D-049)

/**
 * When the web server runs in mock mode next to a real api (NAIS_INTERNAL_API_URL and NAIS_INTERNAL_TOKEN set), the mock
 * reads the researcher's real notebooks of the day from the shared Jupyter and drafts through the real local LLM via the
 * api's internal endpoints. Unset: the seeded behaviour above stays (deterministic, no network).
 */
export type BridgeConfig = { url: string; token: string };

export function bridgeConfig(env: Record<string, string | undefined> = process.env): BridgeConfig | null {
  const url = env.NAIS_INTERNAL_API_URL?.trim();
  const token = env.NAIS_INTERNAL_TOKEN?.trim();
  return url && token ? { url: url.replace(/\/+$/, ""), token } : null;
}

export const COUNT_TIMEOUT_MS = 2_000;
export const COUNT_TTL_MS = 10_000;
export const DRAFT_TIMEOUT_MS = 90_000;

/** The api's error code (and details.reason) for a failed internal call; a network failure or timeout counts as DEPENDENCY_UNAVAILABLE. */
export class BridgeError extends Error {
  constructor(
    public code: string,
    public reason: string | null = null,
  ) {
    super(reason ? `${code}:${reason}` : code);
  }
}

type CountEntry = { value: number; at: number; inflight?: Promise<number> };
const KEY = "__naisNotebookBridge";
type BridgeState = { counts: Map<string, CountEntry>; drafts: Map<string, Promise<void>> };
const state = (): BridgeState => ((globalThis as Record<string, unknown>)[KEY] ??= { counts: new Map(), drafts: new Map() }) as BridgeState;
const countKey = (userId: string, projectId: string, day: string) => `${userId}|${projectId}|${day}`;

/** Test hook: forget cached counts and running drafts. */
export function resetBridge() {
  state().counts.clear();
  state().drafts.clear();
}

async function internalCall<T>(cfg: BridgeConfig, path: string, init: RequestInit, timeoutMs: number): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${cfg.url}/api/v1/internal/notes/${path}`, {
      ...init,
      headers: { "content-type": "application/json", ...init.headers, "X-NAIS-Internal-Token": cfg.token },
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
    });
  } catch {
    throw new BridgeError("DEPENDENCY_UNAVAILABLE");
  }
  if (!res.ok) {
    let code = res.status === 503 ? "DEPENDENCY_UNAVAILABLE" : "INTERNAL_ERROR";
    let reason: string | null = null;
    try {
      const err = ((await res.json()) as { error?: { code?: unknown; details?: { reason?: unknown } } }).error;
      if (typeof err?.code === "string") code = err.code;
      if (typeof err?.details?.reason === "string") reason = err.details.reason;
    } catch {
      /* not an error envelope */
    }
    throw new BridgeError(code, reason);
  }
  try {
    return (await res.json()) as T;
  } catch {
    throw new BridgeError("DEPENDENCY_UNAVAILABLE");
  }
}

/** GET /internal/notes/notebook-activity (listings only): the number of notebooks saved that day. Throws BridgeError. */
export async function fetchNotebookCount(cfg: BridgeConfig, userId: string, projectId: string, day: string, timeoutMs = COUNT_TIMEOUT_MS): Promise<number> {
  const q = new URLSearchParams({ user_id: userId, project_id: projectId, day });
  const body = await internalCall<Schemas["InternalNotebookActivity"]>(cfg, `notebook-activity?${q}`, { method: "GET" }, timeoutMs);
  if (!Number.isInteger(body?.count) || body.count < 0) throw new BridgeError("DEPENDENCY_UNAVAILABLE");
  const count = body.count;
  state().counts.set(countKey(userId, projectId, day), { value: count, at: Date.now() });
  return count;
}

/** Last known count (0 before the first answer): noteView stays synchronous and never waits on Jupyter. */
export function cachedSourceCount(userId: string, projectId: string, day: string): number {
  return state().counts.get(countKey(userId, projectId, day))?.value ?? 0;
}

/**
 * Refresh the count unless it is younger than COUNT_TTL_MS (the note page polls while a draft runs). Fail-soft: any
 * error (Jupyter down, api down, 2 s timeout) records 0. Concurrent callers share one request.
 */
export async function refreshSourceCount(cfg: BridgeConfig, userId: string, projectId: string, day: string): Promise<number> {
  const counts = state().counts;
  const key = countKey(userId, projectId, day);
  const entry = counts.get(key);
  if (entry && Date.now() - entry.at < COUNT_TTL_MS) return entry.value;
  if (entry?.inflight) return entry.inflight;
  const inflight = fetchNotebookCount(cfg, userId, projectId, day).catch(() => {
    counts.set(key, { value: 0, at: Date.now() });
    return 0;
  });
  counts.set(key, { value: entry?.value ?? 0, at: entry?.at ?? 0, inflight });
  return inflight;
}

/** Deterministic NOTEBOOK ref_id for one notebook (the internal answer carries label and time only): cells of a notebook share it. */
export function notebookRefId(userId: string, projectId: string, label: string): string {
  const title = label.split(" · ")[0] ?? label;
  const h = sha256Hex(`nais-notebook|${userId}|${projectId}|${title}`);
  const variant = ((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** POST /internal/notes/draft-sections → sentences in template order, each citing its notebook cells as NOTEBOOK evidence. Throws BridgeError. */
export async function fetchDraftSentences(cfg: BridgeConfig, req: { userId: string; projectId: string; day: string; projectName: string }, timeoutMs = DRAFT_TIMEOUT_MS): Promise<Sentence[]> {
  const payload: Schemas["InternalDraftSectionsRequest"] = { user_id: req.userId, project_id: req.projectId, day: req.day, project_name: req.projectName.slice(0, 200) };
  const body = await internalCall<Schemas["InternalDraftSections"]>(cfg, "draft-sections", { method: "POST", body: JSON.stringify(payload) }, timeoutMs);
  const sections = body?.sections;
  if (!sections || typeof sections !== "object") throw new BridgeError("LLM_UNAVAILABLE");
  const out: Sentence[] = [];
  for (const section of SECTIONS) {
    for (const s of sections[section] ?? []) {
      const text = typeof s?.text === "string" ? s.text.trim().slice(0, 4000) : "";
      if (!text) continue;
      const evidence = (Array.isArray(s.evidence) ? s.evidence : [])
        .filter((e) => typeof e?.label === "string" && e.label && typeof e.at === "string")
        .map((e): Schemas["NoteEvidence"] => ({ type: "NOTEBOOK", ref_id: notebookRefId(req.userId, req.projectId, e.label), label: e.label.slice(0, 200), at: e.at }));
      out.push({ section, text, evidence });
    }
  }
  return out;
}

/** Bridged drafts in flight, by note id (advanceDraft leaves these RUNNING until the promise settles). */
export const bridgedDrafts = () => state().drafts;

/** Test hook: wait until every bridged draft has settled. */
export async function settleBridgedDrafts(): Promise<void> {
  await Promise.all([...state().drafts.values()]);
}
