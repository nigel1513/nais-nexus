import type { Schemas } from "@/shared/api/types";
import { getDb } from "./db";
import { newId } from "./http";
import type { NotebookActivity, StoredNote } from "./types";

/**
 * Stand-in for the backend NotebookActivityPort (apps/api/modules/notes/public.py). Jupyter (M07) does not exist yet,
 * so the port is empty: every note shows draft_source_count 0 and draftNote answers 422 NO_NOTEBOOK_ACTIVITY.
 * Tests seed saved notebooks with seedNotebookActivity(); the list lives in the mock store and resets with it.
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
