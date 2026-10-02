import type { Schemas } from "@/shared/api/types";
import { sha256Hex } from "./sha256";

/**
 * Mirror of apps/api/modules/notes/hashing.py: canonical JSON (keys sorted, no whitespace, NFC strings, UTC timestamps
 * with microseconds), content_hash = sha256(canonical_json(note_document)), chain_hash = sha256(prev + content).
 */
export const SECTIONS: Schemas["NoteSection"][] = ["OBJECTIVE", "METHOD", "PROCEDURE", "RESULTS", "DISCUSSION", "NEXT", "REFERENCES"];
export const SECTION_LABELS: Record<Schemas["NoteSection"], string> = {
  OBJECTIVE: "연구 목표",
  METHOD: "연구 방법·재료",
  PROCEDURE: "수행 내용",
  RESULTS: "결과 및 관찰",
  DISCUSSION: "고찰·문제점",
  NEXT: "향후 계획",
  REFERENCES: "참고 자료",
};
export const GENESIS_CHAIN_HASH = "0".repeat(64);

type HashedNote = {
  note_id: string;
  project_id: string;
  organization_id: string;
  recorder_id: string;
  note_date: string;
  version: number;
  previous_version_id: string | null;
  blocks: Pick<Schemas["NoteBlock"], "section" | "text" | "origin" | "evidence">[];
};

/** UTC `YYYY-MM-DDTHH:MM:SS.ffffffZ` (hashing._timestamp). */
export function canonicalTimestamp(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new Error("timestamps in research notes must be valid");
  return `${new Date(ms).toISOString().slice(0, 23)}000Z`;
}

function normalize(value: unknown): unknown {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") return value.normalize("NFC");
  if (typeof value === "number") {
    if (!Number.isInteger(value)) throw new TypeError("floats have no canonical form in research-note hashes");
    return value;
  }
  if (Array.isArray(value)) return value.map(normalize);
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as object).map((k) => k.normalize("NFC")).sort()) {
      out[key] = normalize((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  throw new TypeError(`${typeof value} has no canonical JSON form`);
}

/** Keys sorted by code point (Python sort_keys), compact separators, non-ASCII kept as is (ensure_ascii=False). */
export function canonicalJson(value: unknown): string {
  const sortKeys = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sortKeys);
    if (v && typeof v === "object") {
      const entries = Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      return Object.fromEntries(entries.map(([k, x]) => [k, sortKeys(x)]));
    }
    return v;
  };
  return JSON.stringify(sortKeys(normalize(value)));
}

const sectionIndex = (s: string) => {
  const i = SECTIONS.indexOf(s as Schemas["NoteSection"]);
  return i < 0 ? SECTIONS.length : i;
};

/** Blocks grouped by section in template order; stable within a section (sections.in_template_order). */
export function inTemplateOrder<B extends { section: string }>(blocks: B[]): B[] {
  return blocks
    .map((b, i) => ({ b, i }))
    .sort((x, y) => sectionIndex(x.b.section) - sectionIndex(y.b.section) || x.i - y.i)
    .map(({ b }) => b);
}

export function noteDocument(note: HashedNote) {
  return {
    note_id: note.note_id,
    project_id: note.project_id,
    organization_id: note.organization_id,
    recorder_id: note.recorder_id,
    note_date: note.note_date,
    version: note.version,
    previous_version_id: note.previous_version_id,
    blocks: inTemplateOrder(note.blocks).map((b) => ({
      section: b.section,
      text: b.text.normalize("NFC"),
      origin: b.origin,
      evidence: b.evidence.map((e) => ({ type: e.type, ref_id: e.ref_id, label: e.label, at: canonicalTimestamp(e.at) })),
    })),
  };
}

export const contentHash = (note: HashedNote) => sha256Hex(canonicalJson(noteDocument(note)));

export function nextChainHash(previous: string | null, content: string): string {
  const head = previous ?? GENESIS_CHAIN_HASH;
  if (!/^[a-f0-9]{64}$/.test(head) || !/^[a-f0-9]{64}$/.test(content)) throw new Error("chain links are lower-case hex sha256 digests");
  return sha256Hex(head + content);
}

/** Asia/Seoul calendar date (no daylight saving) of an instant: notes.service.seoul_date. */
export const seoulDate = (ms: number = Date.now()) => new Date(ms + 9 * 3_600_000).toISOString().slice(0, 10);
