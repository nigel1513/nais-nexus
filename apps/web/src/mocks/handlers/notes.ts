import { http, HttpResponse } from "msw";
import type { Schemas } from "@/shared/api/types";
import { getDb } from "../db";
import { API, body, currentUser, fail, newId, notify, nowIso, orgName, paginate, recordAudit, validationFailed } from "../http";
import { contentHash, inTemplateOrder, nextChainHash, noteDocument, canonicalJson, SECTION_LABELS, SECTIONS, seoulDate } from "../note-hash";
import { appendDraftBlocks, draftSentences, listNotebookActivity } from "../notebook-activity";
import type { MockDb, MockUser, StoredNote } from "../types";
import { zip } from "../zip";
import { isActiveMember, memberProjectIds, roleOf } from "./workspace";

/**
 * Mirrors apps/api/modules/notes (access.py, service/{notes,signing,settings,drafting,export}.py, search.py, views.py).
 * DRAFT is recorder-only (404 for everyone else); SUBMITTED/SIGNED are readable by the recorder and the witnesses of the
 * snapshot taken at submit; other project members get 403. A SIGNED note never changes (NOTE_LOCKED) — revising creates
 * a new DRAFT version. Hashes follow hashing.py (canonical JSON, sha256, project × organization chain).
 * Signing needs a fresh login in the backend (auth_time ≤ 5 min); a mock session always counts as fresh.
 * Drafting reads only the recorder's Jupyter notebooks of the note's day (notebook-activity.ts, empty until M07):
 * no notebook → 422 NO_NOTEBOOK_ACTIVITY. A queued draft advances on reads (QUEUED → RUNNING → DONE) and appends
 * deterministic AI blocks with NOTEBOOK evidence; the mock never calls a model.
 */
type Relation = "RECORDER" | "WITNESS" | "MEMBER" | "HIDDEN";

const MIN_DRAFT_INTERVAL_MS = 60_000;
const NO_NOTEBOOK_MESSAGE = "오늘 저장한 노트북이 없습니다.";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const STATUSES: Schemas["NoteStatus"][] = ["DRAFT", "SUBMITTED", "SIGNED"];

const projectName = (db: MockDb, projectId: string) => db.projects.find((p) => p.project_id === projectId)?.name ?? "";
const displayName = (db: MockDb, userId: string) => db.users.find((u) => u.user_id === userId)?.display_name ?? "";

// ---------------------------------------------------------------- access (access.py)

function classify(db: MockDb, user: MockUser, note: StoredNote): Relation {
  if (note.recorder_id === user.user_id) return "RECORDER";
  if (note.status === "DRAFT") return "HIDDEN";
  if (!roleOf(db, note.project_id, user.user_id)) return "HIDDEN";
  if (note.witness_required && (note.witness_user_ids ?? []).includes(user.user_id)) return "WITNESS";
  return "MEMBER";
}

function load(db: MockDb, user: MockUser, noteId: string): [StoredNote, Relation] {
  const note = db.notes.find((n) => n.note_id === noteId);
  if (!note) fail("NOT_FOUND", "Note not found.");
  const relation = classify(db, user, note);
  if (relation === "HIDDEN") fail("NOT_FOUND", "Note not found.");
  return [note, relation];
}

function readable(db: MockDb, user: MockUser, noteId: string): [StoredNote, Relation] {
  const [note, relation] = load(db, user, noteId);
  if (relation === "MEMBER") fail("FORBIDDEN", "Only the recorder and the note's witnesses can read this note.");
  return [note, relation];
}

function requireActive(db: MockDb, projectId: string, user: MockUser) {
  if (!roleOf(db, projectId, user.user_id)) fail("FORBIDDEN", "Only ACTIVE members of the project can change its research notes.");
  if (!isActiveMember(db, projectId, user.user_id)) fail("PROJECT_ARCHIVED", "The project is archived; its research notes are read-only.");
}

/** Recorder-only changes: others get the getNote answer (404 hidden, else 403); the project must be ACTIVE. */
function recorderNote(db: MockDb, user: MockUser, noteId: string): StoredNote {
  const [note, relation] = load(db, user, noteId);
  if (relation !== "RECORDER") fail("FORBIDDEN", "Only the recorder can change this note.");
  requireActive(db, note.project_id, user);
  return note;
}

/** (witness_required, witness_user_ids) as a submit would take them now: configured witnesses who are ACTIVE members, never the recorder. */
function witnessSnapshot(db: MockDb, projectId: string, recorderId: string): [boolean, string[]] {
  const row = db.noteSettings[projectId];
  if (!row?.witness_required) return [false, []];
  return [true, row.witness_user_ids.filter((w) => w !== recorderId && isActiveMember(db, projectId, w))];
}

const locked = (): never => fail("NOTE_LOCKED", "Submitted or signed research notes cannot be changed; a signed note is revised as a new version.");
const notWitness = (): never => fail("NOTE_NOT_WITNESS", "Only a witness of this submitted note can do this.");

// ---------------------------------------------------------------- views (views.py)

function noteView(db: MockDb, note: StoredNote, viewerId: string): Schemas["ResearchNote"] {
  const [witnessRequired, witnessIds] = note.status === "DRAFT" ? witnessSnapshot(db, note.project_id, note.recorder_id) : [!!note.witness_required, [...(note.witness_user_ids ?? [])]];
  return {
    note_id: note.note_id,
    project_id: note.project_id,
    project_name: projectName(db, note.project_id),
    organization_id: note.organization_id,
    recorder_id: note.recorder_id,
    recorder_display_name: displayName(db, note.recorder_id),
    note_date: note.note_date,
    version: note.version,
    previous_version_id: note.previous_version_id,
    status: note.status,
    revision: note.revision,
    blocks: note.blocks.map((b) => ({ ...b, evidence: b.evidence.map((e) => ({ ...e })) })),
    draft_status: note.draft_status,
    draft_error: note.draft_error,
    draft_source_count: viewerId === note.recorder_id ? listNotebookActivity(note.recorder_id, note.project_id, note.note_date).length : 0,
    signatures: note.signatures.map((s) => ({ ...s, signer_display_name: displayName(db, s.signer_id) })),
    witness_required: witnessRequired,
    witness_user_ids: witnessIds,
    content_hash: note.content_hash,
    chain_hash: note.chain_hash,
    submitted_at: note.submitted_at,
    rejected_reason: note.rejected_reason,
    created_at: note.created_at,
    updated_at: note.updated_at,
  };
}

function summaryView(db: MockDb, n: StoredNote): Schemas["ResearchNoteSummary"] {
  return {
    note_id: n.note_id,
    project_id: n.project_id,
    project_name: projectName(db, n.project_id),
    recorder_id: n.recorder_id,
    recorder_display_name: displayName(db, n.recorder_id),
    note_date: n.note_date,
    version: n.version,
    status: n.status,
    draft_status: n.draft_status,
    block_count: n.blocks.length,
    unaccepted_ai_count: n.blocks.filter((b) => b.origin === "AI" && !b.accepted).length,
    submitted_at: n.submitted_at,
    updated_at: n.updated_at,
  };
}

const noteLabel = (db: MockDb, n: StoredNote) => `"${projectName(db, n.project_id)}" ${n.note_date} 연구노트`;

function emitViewed(db: MockDb, user: MockUser, note: StoredNote) {
  recordAudit(db, { action: "NOTE_VIEWED", actor: user, resource: { type: "RESEARCH_NOTE", id: note.note_id, owner_organization_id: note.organization_id }, project_id: note.project_id, details: { status: note.status } });
}

/** Latest version of each (project, day) note of a recorder. */
function latestVersions(notes: StoredNote[]): StoredNote[] {
  const best = new Map<string, StoredNote>();
  for (const n of notes) {
    const key = `${n.project_id}|${n.recorder_id}|${n.note_date}`;
    if ((best.get(key)?.version ?? 0) < n.version) best.set(key, n);
  }
  return [...best.values()];
}

const byDayDesc = (a: StoredNote, b: StoredNote) => b.note_date.localeCompare(a.note_date) || b.note_id.localeCompare(a.note_id);

/** Witness-visible notes: SUBMITTED/SIGNED in projects the user belongs to, with the user in the snapshot. */
function witnessNotes(db: MockDb, user: MockUser): StoredNote[] {
  const mine = memberProjectIds(db, user.user_id);
  return db.notes.filter((n) => mine.has(n.project_id) && (n.status === "SUBMITTED" || n.status === "SIGNED") && n.witness_required && (n.witness_user_ids ?? []).includes(user.user_id));
}

// ---------------------------------------------------------------- drafting (service/drafting.py, jobs.draft_note)

/** The draft worker: QUEUED → RUNNING (1st read) → DONE (2nd read), appending AI blocks; a note no longer DRAFT drops the draft. */
function advanceDraft(note: StoredNote) {
  if (note.draft_status === "QUEUED") {
    note.draft_status = "RUNNING";
    return;
  }
  if (note.draft_status !== "RUNNING") return;
  if (note.status !== "DRAFT") {
    note.draft_status = "NONE";
    return;
  }
  appendDraftBlocks(note, draftSentences(listNotebookActivity(note.recorder_id, note.project_id, note.note_date)));
  note.draft_status = "DONE";
  note.draft_error = null;
  note.updated_at = nowIso();
}

// ---------------------------------------------------------------- submit / chain (service/notes.fix_content, signing.py)

function fixContent(note: StoredNote, required: boolean, witnesses: string[]) {
  if (note.blocks.some((b) => b.origin === "AI" && !b.accepted)) fail("NOTE_HAS_UNACCEPTED_AI", "Accept, edit or delete every AI sentence before submitting.");
  const now = nowIso();
  Object.assign(note, { status: "SUBMITTED", draft_status: "NONE", draft_error: null, content_hash: contentHash(note), witness_required: required, witness_user_ids: witnesses, submitted_at: now, rejected_reason: null, updated_at: now });
}

const chainKey = (n: Pick<StoredNote, "project_id" | "organization_id">) => `${n.project_id}:${n.organization_id}`;

function appendToChain(db: MockDb, note: StoredNote) {
  const head = db.noteChains[chainKey(note)] ?? { last_seq: 0, last_chain_hash: "" };
  const seq = head.last_seq + 1;
  const chain = nextChainHash(head.last_chain_hash || null, note.content_hash!);
  db.noteChains[chainKey(note)] = { last_seq: seq, last_chain_hash: chain };
  const now = nowIso();
  Object.assign(note, { status: "SIGNED", chain_seq: seq, chain_hash: chain, signed_at: now, updated_at: now });
}

/** signing.chain_is_intact: rebuild the chain from every SIGNED note's stored content and compare link by link. */
function chainIsIntact(db: MockDb, projectId: string, organizationId: string): boolean {
  const notes = db.notes.filter((n) => n.project_id === projectId && n.organization_id === organizationId && n.status === "SIGNED").sort((a, b) => (a.chain_seq ?? 0) - (b.chain_seq ?? 0));
  let previous: string | null = null;
  for (const [i, n] of notes.entries()) {
    const recomputed = contentHash(n);
    if (n.chain_seq !== i + 1 || recomputed !== n.content_hash) return false;
    const witnesses = new Set(n.witness_user_ids ?? []);
    const roles = new Set<string>();
    for (const s of n.signatures) {
      if (s.content_hash !== recomputed || (n.signed_at && s.signed_at > n.signed_at)) return false;
      if (s.role === "RECORDER" && s.signer_id !== n.recorder_id) return false;
      if (s.role === "WITNESS" && (!witnesses.has(s.signer_id) || s.signer_id === n.recorder_id)) return false;
      roles.add(s.role);
    }
    if (!roles.has("RECORDER") || (n.witness_required && !roles.has("WITNESS"))) return false;
    previous = nextChainHash(previous, recomputed);
    if (previous !== n.chain_hash) return false;
  }
  const head = db.noteChains[`${projectId}:${organizationId}`];
  if (!head) return !notes.length;
  return head.last_seq === notes.length && head.last_chain_hash === previous;
}

// ---------------------------------------------------------------- request checks

function only(raw: unknown, allowed: string[]): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) validationFailed("body", "INVALID_TYPE");
  const extra = Object.keys(raw as object).find((k) => !allowed.includes(k));
  if (extra) validationFailed(extra, "EXTRA_FORBIDDEN");
  return raw as Record<string, unknown>;
}

function dateParam(url: URL, name: "from" | "to"): string | null {
  const v = url.searchParams.get(name);
  if (v !== null && (!ISO_DATE.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`)))) validationFailed(name, "INVALID_DATE");
  return v;
}

function range(url: URL): [string | null, string | null] {
  const from = dateParam(url, "from");
  const to = dateParam(url, "to");
  if (from && to && from > to) validationFailed("from", "AFTER_TO", "from must not be after to.");
  return [from, to];
}

const inRange = (n: StoredNote, [from, to]: [string | null, string | null]) => (!from || n.note_date >= from) && (!to || n.note_date <= to);

function ifMatch(request: Request): number {
  const raw = request.headers.get("if-match");
  const m = raw ? /^"?([1-9][0-9]*)"?$/.exec(raw.trim()) : null;
  if (!m) validationFailed("If-Match", raw ? "INVALID" : "MISSING");
  return Number(m[1]);
}

// ---------------------------------------------------------------- search (search.py, keyword fallback)

const SNIPPET_CHARS = 160;
const LEAD = 40;
const plain = (t: string) => t.replace(/\s+/g, " ").trim();

function snippet(texts: string[], q: string): string {
  const blocks = texts.map(plain).filter(Boolean);
  if (!blocks.length) return "";
  const needle = plain(q).toLowerCase();
  const words = needle.split(" ").filter(Boolean);
  let best = blocks[0]!;
  let at = -1;
  const hit = blocks.find((b) => needle && b.toLowerCase().includes(needle));
  if (hit) {
    best = hit;
    at = hit.toLowerCase().indexOf(needle);
  } else {
    const counts = blocks.map((b) => words.reduce((n, w) => n + b.toLowerCase().split(w).length - 1, 0));
    const max = Math.max(...counts);
    if (max > 0) {
      best = blocks[counts.indexOf(max)]!;
      const positions = words.map((w) => best.toLowerCase().indexOf(w)).filter((i) => i >= 0);
      at = positions.length ? Math.min(...positions) : -1;
    }
  }
  if (best.length <= SNIPPET_CHARS) return best;
  const start = at >= 0 ? Math.max(0, Math.min(at - LEAD, best.length - SNIPPET_CHARS)) : 0;
  const head = start > 0 ? "…" : "";
  const room = SNIPPET_CHARS - head.length;
  let text = best.slice(start, start + room);
  if (start + room < best.length) text = `${text.slice(0, room - 1)}…`;
  return head + text;
}

/** HUMAN blocks and accepted AI blocks: an unaccepted AI sentence is not the researcher's record. */
const searchable = (n: StoredNote) => n.blocks.filter((b) => b.origin === "HUMAN" || b.accepted).map((b) => b.text);

// ---------------------------------------------------------------- export (service/export.py)

const escapeHtml = (v: unknown) => String(v).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#x27;");

function exportHtml(db: MockDb, n: StoredNote): string {
  const rows = SECTIONS.map((section) => {
    const entries = inTemplateOrder(n.blocks)
      .filter((b) => b.section === section)
      .map((b) => `<p>${escapeHtml(b.text)}${b.origin === "AI" ? " <small>(AI 초안)</small>" : ""}</p>${b.evidence.length ? `<ul>${b.evidence.map((e) => `<li>${escapeHtml(e.type)} · ${escapeHtml(e.label)} · ${escapeHtml(e.at)}</li>`).join("")}</ul>` : ""}`)
      .join("");
    return `<tr><th scope="row">${escapeHtml(SECTION_LABELS[section])}</th><td>${entries || "-"}</td></tr>`;
  }).join("");
  const signatures = n.signatures.map((s) => `<tr><th scope="row">${s.role === "RECORDER" ? "기록자" : "확인자"}</th><td>${escapeHtml(displayName(db, s.signer_id))}</td><td>${escapeHtml(s.signed_at)}</td><td><code>${escapeHtml(s.content_hash)}</code></td></tr>`).join("");
  return (
    `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>연구노트 ${escapeHtml(n.note_date)} v${n.version}</title></head><body>` +
    `<h1>연구노트 (v${n.version})</h1><table class="header"><tr><th scope="row">과제명</th><td>${escapeHtml(projectName(db, n.project_id))}</td><th scope="row">연구일자</th><td>${escapeHtml(n.note_date)}</td></tr>` +
    `<tr><th scope="row">기록자</th><td>${escapeHtml(displayName(db, n.recorder_id))}</td><th scope="row">소속</th><td>${escapeHtml(orgName(db, n.organization_id))}</td></tr></table>` +
    `<table class="sections">${rows}</table><h2>서명</h2><table class="signatures"><tr><th>구분</th><th>성명</th><th>서명 일시</th><th>내용 해시</th></tr>${signatures}</table>` +
    `<h2>무결성 정보</h2><dl><dt>내용 해시 (SHA-256)</dt><dd><code>${escapeHtml(n.content_hash ?? "-")}</code></dd><dt>체인 해시</dt><dd><code>${escapeHtml(n.chain_hash ?? "-")}</code></dd><dt>노트 ID</dt><dd><code>${n.note_id}</code></dd></dl></body></html>`
  );
}

function exportRecord(db: MockDb, n: StoredNote) {
  return {
    format: "nais.research-note.v1",
    content: noteDocument(n),
    content_hash: n.content_hash,
    chain_seq: n.chain_seq,
    chain_hash: n.chain_hash,
    status: n.status,
    project_name: projectName(db, n.project_id),
    recorder_display_name: displayName(db, n.recorder_id),
    blocks: n.blocks.map((b) => ({ block_id: b.block_id, accepted: b.accepted, origin: b.origin })),
    witness_required: n.witness_required,
    witness_user_ids: n.status !== "DRAFT" ? [...(n.witness_user_ids ?? [])] : [],
    signatures: n.signatures.map((s) => ({ ...s, signer_display_name: displayName(db, s.signer_id) })),
    submitted_at: n.submitted_at,
    signed_at: n.signed_at,
    rejected_reason: n.rejected_reason,
    created_at: n.created_at,
    updated_at: n.updated_at,
  };
}

// ---------------------------------------------------------------- handlers

export const noteHandlers = [
  http.get(`${API}/notes`, ({ request }) => {
    const user = currentUser(request);
    const db = getDb();
    const url = new URL(request.url);
    const role = url.searchParams.get("role") ?? "recorder";
    if (role !== "recorder" && role !== "witness") validationFailed("role", "INVALID_ENUM");
    const projectId = url.searchParams.get("project_id");
    if (projectId !== null && !UUID.test(projectId)) validationFailed("project_id", "INVALID_UUID");
    const statuses = url.searchParams.getAll("status");
    if (statuses.some((s) => !STATUSES.includes(s as Schemas["NoteStatus"]))) validationFailed("status", "INVALID_ENUM");
    const dates = range(url);
    let rows: StoredNote[];
    if (role === "recorder") {
      rows = latestVersions(db.notes.filter((n) => n.recorder_id === user.user_id)).filter((n) => !statuses.length || statuses.includes(n.status));
    } else {
      const visible = statuses.length ? statuses.filter((s) => s === "SUBMITTED" || s === "SIGNED") : ["SUBMITTED", "SIGNED"];
      rows = witnessNotes(db, user).filter((n) => visible.includes(n.status));
    }
    rows = rows.filter((n) => (!projectId || n.project_id === projectId) && inRange(n, dates)).sort(byDayDesc);
    rows.forEach((n) => n.recorder_id === user.user_id && advanceDraft(n));
    const page = paginate(rows, url);
    return HttpResponse.json({ ...page, items: page.items.map((n) => summaryView(db, n)) });
  }),

  http.get(`${API}/notes/export`, ({ request }) => {
    const user = currentUser(request);
    const db = getDb();
    const url = new URL(request.url);
    const projectId = url.searchParams.get("project_id");
    if (projectId === null) validationFailed("project_id", "MISSING");
    if (!UUID.test(projectId)) validationFailed("project_id", "INVALID_UUID");
    const dates = range(url);
    const isAdmin = user.org_roles.includes("ORG_ADMIN");
    const rows = db.notes
      .filter((n) => n.project_id === projectId && inRange(n, dates))
      .filter((n) => n.recorder_id === user.user_id || (isAdmin && n.organization_id === user.organization_id && (n.status === "SUBMITTED" || n.status === "SIGNED")))
      .sort((a, b) => a.note_date.localeCompare(b.note_date) || a.recorder_id.localeCompare(b.recorder_id) || a.version - b.version);
    if (!rows.length && !roleOf(db, projectId, user.user_id)) fail("NOT_FOUND", "Project not found.");
    for (const n of rows) if (n.recorder_id !== user.user_id) emitViewed(db, user, n);
    const csvRows = rows.map((n) => [n.note_id, n.note_date, n.version, n.recorder_id, n.organization_id, n.status, n.content_hash ?? "", n.chain_seq ?? "", n.chain_hash ?? "", n.submitted_at ?? "", n.signed_at ?? ""].join(","));
    const entries = rows.flatMap((n) => {
      const base = `notes/${n.note_date}_v${n.version}_${n.note_id}`;
      return [
        { name: `${base}.json`, data: canonicalJson(exportRecord(db, n)) },
        { name: `${base}.html`, data: exportHtml(db, n) },
      ];
    });
    entries.push({ name: "hashes.csv", data: ["note_id,note_date,version,recorder_id,organization_id,status,content_hash,chain_seq,chain_hash,submitted_at,signed_at", ...csvRows].join("\n") + "\n" });
    const span = `${dates[0] ?? "all"}-${dates[1] ?? "all"}`;
    return new HttpResponse(zip(entries), { status: 200, headers: { "Content-Type": "application/zip", "Content-Disposition": `attachment; filename="research-notes-${projectId}-${span}.zip"` } });
  }),

  http.get(`${API}/notes/search`, ({ request }) => {
    const user = currentUser(request);
    const db = getDb();
    const url = new URL(request.url);
    const q = url.searchParams.get("q");
    if (q === null || q.length < 1 || q.length > 500) validationFailed("q", q === null ? "MISSING" : "LENGTH");
    const projectId = url.searchParams.get("project_id");
    if (projectId !== null && !UUID.test(projectId)) validationFailed("project_id", "INVALID_UUID");
    const scope = [...latestVersions(db.notes.filter((n) => n.recorder_id === user.user_id)), ...witnessNotes(db, user)].filter((n) => !projectId || n.project_id === projectId);
    const needle = q.toLowerCase();
    const hits = scope
      .filter((n) => searchable(n).some((t) => t.toLowerCase().includes(needle)))
      .sort(byDayDesc)
      .slice(0, 20)
      .map((n): Schemas["NoteSearchHit"] => ({ note_id: n.note_id, project_name: projectName(db, n.project_id), note_date: n.note_date, snippet: snippet(searchable(n), q), score: null }));
    return HttpResponse.json({ items: hits });
  }),

  http.post(`${API}/projects/:project_id/notes/today`, ({ request, params }) => {
    const user = currentUser(request);
    const db = getDb();
    const projectId = String(params.project_id);
    if (!roleOf(db, projectId, user.user_id)) fail("NOT_FOUND", "Project not found.");
    if (!isActiveMember(db, projectId, user.user_id)) fail("PROJECT_ARCHIVED", "The project is archived; its research notes are read-only.");
    const today = seoulDate();
    const existing = latestVersions(db.notes.filter((n) => n.project_id === projectId && n.recorder_id === user.user_id && n.note_date === today))[0];
    if (existing) {
      if (existing.recorder_id === user.user_id) advanceDraft(existing);
      return HttpResponse.json(noteView(db, existing, user.user_id));
    }
    const now = nowIso();
    const note: StoredNote = {
      note_id: newId(),
      project_id: projectId,
      organization_id: user.organization_id,
      recorder_id: user.user_id,
      note_date: today,
      version: 1,
      previous_version_id: null,
      status: "DRAFT",
      revision: 1,
      blocks: [],
      draft_status: "NONE",
      draft_error: null,
      draft_requested_at: null,
      signatures: [],
      witness_required: null,
      witness_user_ids: null,
      content_hash: null,
      chain_hash: null,
      chain_seq: null,
      signed_at: null,
      submitted_at: null,
      rejected_reason: null,
      created_at: now,
      updated_at: now,
    };
    db.notes.push(note);
    return HttpResponse.json(noteView(db, note, user.user_id), { status: 201 });
  }),

  http.get(`${API}/projects/:project_id/note-settings`, ({ request, params }) => {
    const user = currentUser(request);
    const db = getDb();
    const projectId = String(params.project_id);
    if (!roleOf(db, projectId, user.user_id)) fail("NOT_FOUND", "Project not found.");
    const row = db.noteSettings[projectId] ?? { witness_required: false, witness_user_ids: [] };
    return HttpResponse.json({ project_id: projectId, witness_required: row.witness_required, witness_user_ids: [...row.witness_user_ids], llm_enabled: db.llmEnabled } satisfies Schemas["NoteSettings"]);
  }),

  http.patch(`${API}/projects/:project_id/note-settings`, async ({ request, params }) => {
    const user = currentUser(request);
    const db = getDb();
    const projectId = String(params.project_id);
    const b = only(await body(request), ["witness_required", "witness_user_ids"]);
    if (!Object.keys(b).length) validationFailed("body", "EMPTY");
    if (b.witness_required !== undefined && typeof b.witness_required !== "boolean") validationFailed("witness_required", "INVALID_TYPE");
    if (b.witness_user_ids !== undefined) {
      const ids = b.witness_user_ids;
      if (!Array.isArray(ids) || ids.length > 20 || !ids.every((x) => typeof x === "string" && UUID.test(x)) || new Set(ids).size !== ids.length) validationFailed("witness_user_ids", "INVALID");
    }
    const role = roleOf(db, projectId, user.user_id);
    if (!role) fail("NOT_FOUND", "Project not found.");
    if (role !== "PROJECT_OWNER" && role !== "PROJECT_ADMIN") fail("FORBIDDEN", "Only the project owner or an admin can change note settings.");
    if (!isActiveMember(db, projectId, user.user_id)) fail("FORBIDDEN", "The project is archived; its note settings are read-only.");
    const current = db.noteSettings[projectId] ?? { witness_required: false, witness_user_ids: [] };
    const next = { witness_required: (b.witness_required as boolean | undefined) ?? current.witness_required, witness_user_ids: (b.witness_user_ids as string[] | undefined) ?? [...current.witness_user_ids] };
    if (b.witness_user_ids !== undefined) {
      next.witness_user_ids.forEach((w, i) => {
        if (!isActiveMember(db, projectId, w)) fail("VALIDATION_FAILED", "Witnesses must be ACTIVE project members.", { fields: [{ field: `witness_user_ids.${i}`, reason: "NOT_ACTIVE_MEMBER" }] });
      });
    }
    if (next.witness_required && !next.witness_user_ids.length) fail("VALIDATION_FAILED", "Name at least one witness when witnesses are required.", { fields: [{ field: "witness_user_ids", reason: "WITNESS_REQUIRED" }] });
    db.noteSettings[projectId] = next;
    return HttpResponse.json({ project_id: projectId, ...next, witness_user_ids: [...next.witness_user_ids], llm_enabled: db.llmEnabled } satisfies Schemas["NoteSettings"]);
  }),

  http.get(`${API}/notes/:note_id`, ({ request, params }) => {
    const user = currentUser(request);
    const db = getDb();
    const [note, relation] = readable(db, user, String(params.note_id));
    if (relation === "RECORDER") advanceDraft(note);
    else emitViewed(db, user, note);
    return HttpResponse.json(noteView(db, note, user.user_id));
  }),

  http.delete(`${API}/notes/:note_id`, ({ request, params }) => {
    const user = currentUser(request);
    const db = getDb();
    const note = recorderNote(db, user, String(params.note_id));
    if (note.status !== "DRAFT") locked();
    db.notes.splice(db.notes.indexOf(note), 1);
    return new HttpResponse(null, { status: 204 });
  }),

  http.put(`${API}/notes/:note_id/blocks`, async ({ request, params }) => {
    const user = currentUser(request);
    const db = getDb();
    const expected = ifMatch(request);
    const b = only(await body(request), ["blocks"]);
    if (!Array.isArray(b.blocks) || b.blocks.length > 500) validationFailed("blocks", "INVALID");
    const blocks = (b.blocks as Record<string, unknown>[]).map((raw, i) => {
      if (!raw || typeof raw !== "object") validationFailed(`blocks.${i}`, "INVALID_TYPE");
      const extra = Object.keys(raw).find((k) => !["block_id", "section", "text", "accepted"].includes(k));
      if (extra) validationFailed(`blocks.${i}.${extra}`, "EXTRA_FORBIDDEN");
      if (raw.block_id !== undefined && !(typeof raw.block_id === "string" && UUID.test(raw.block_id))) validationFailed(`blocks.${i}.block_id`, "INVALID_UUID");
      if (!SECTIONS.includes(raw.section as Schemas["NoteSection"])) validationFailed(`blocks.${i}.section`, "INVALID_ENUM");
      if (typeof raw.text !== "string" || raw.text.length < 1 || raw.text.length > 4000) validationFailed(`blocks.${i}.text`, "LENGTH");
      if (raw.accepted !== undefined && typeof raw.accepted !== "boolean") validationFailed(`blocks.${i}.accepted`, "INVALID_TYPE");
      return raw as Schemas["NoteBlockWrite"];
    });
    const note = recorderNote(db, user, String(params.note_id));
    if (note.status !== "DRAFT") locked();
    if (note.revision !== expected) fail("CONFLICT", "The note changed since it was loaded (If-Match).", { revision: note.revision });
    const existing = new Map(note.blocks.map((x) => [x.block_id, x]));
    note.blocks = blocks.map((w, position): Schemas["NoteBlock"] => {
      if (w.block_id === undefined) return { block_id: newId(), section: w.section, text: w.text, origin: "HUMAN", accepted: true, evidence: [] };
      const old = existing.get(w.block_id);
      if (!old) fail("VALIDATION_FAILED", "block_id is not a block of this note.", { fields: [{ field: `blocks.${position}.block_id`, reason: "UNKNOWN_BLOCK" }] });
      const accepted = old.origin === "HUMAN" ? true : w.accepted !== undefined ? w.accepted : old.accepted || w.text !== old.text;
      return { block_id: old.block_id, section: w.section, text: w.text, origin: old.origin, accepted, evidence: old.evidence };
    });
    note.revision += 1;
    note.updated_at = nowIso();
    return HttpResponse.json(noteView(db, note, user.user_id));
  }),

  http.post(`${API}/notes/:note_id/draft`, ({ request, params }) => {
    const user = currentUser(request);
    const db = getDb();
    const note = recorderNote(db, user, String(params.note_id));
    if (note.status !== "DRAFT") locked();
    if (!db.llmEnabled) fail("LLM_UNAVAILABLE", "Drafting is unavailable: the local LLM is switched off.");
    if (!listNotebookActivity(note.recorder_id, note.project_id, note.note_date).length) fail("VALIDATION_FAILED", NO_NOTEBOOK_MESSAGE, { reason: "NO_NOTEBOOK_ACTIVITY" });
    const now = Date.now();
    if (note.draft_requested_at && now - Date.parse(note.draft_requested_at) < MIN_DRAFT_INTERVAL_MS) fail("RATE_LIMITED", "A draft of this note was requested less than a minute ago.");
    if (note.draft_status !== "QUEUED" && note.draft_status !== "RUNNING") {
      Object.assign(note, { draft_status: "QUEUED", draft_error: null, draft_requested_at: new Date(now).toISOString() });
    }
    return HttpResponse.json(noteView(db, note, user.user_id), { status: 202 });
  }),

  http.post(`${API}/notes/:note_id/submit`, ({ request, params }) => {
    const user = currentUser(request);
    const db = getDb();
    const note = recorderNote(db, user, String(params.note_id));
    if (note.status !== "DRAFT") locked();
    const [required, witnesses] = witnessSnapshot(db, note.project_id, note.recorder_id);
    if (required && !witnesses.length) fail("CONFLICT", "The project requires a witness, but none of its configured witnesses can witness this note.");
    fixContent(note, required, witnesses);
    recordAudit(db, { action: "NOTE_SUBMITTED", actor: user, resource: { type: "RESEARCH_NOTE", id: note.note_id, owner_organization_id: note.organization_id }, project_id: note.project_id });
    notify(db, witnesses, "NOTE_SUBMITTED", `${noteLabel(db, note)} 확인 요청이 도착했습니다`, `/commons/notes/${note.note_id}`);
    return HttpResponse.json(noteView(db, note, user.user_id));
  }),

  http.post(`${API}/notes/:note_id/reject`, async ({ request, params }) => {
    const user = currentUser(request);
    const db = getDb();
    const b = only(await body(request), ["reason"]);
    if (typeof b.reason !== "string" || b.reason.length < 1 || b.reason.length > 2000) validationFailed("reason", b.reason === undefined ? "MISSING" : "LENGTH");
    const [note, relation] = load(db, user, String(params.note_id));
    if (relation !== "WITNESS") notWitness();
    if (note.status !== "SUBMITTED") locked();
    requireActive(db, note.project_id, user);
    Object.assign(note, { status: "DRAFT", content_hash: null, witness_required: null, witness_user_ids: null, draft_status: "NONE", draft_error: null, rejected_reason: b.reason, signatures: [], updated_at: nowIso() });
    recordAudit(db, { action: "NOTE_REJECTED", actor: user, resource: { type: "RESEARCH_NOTE", id: note.note_id, owner_organization_id: note.organization_id }, project_id: note.project_id, reason: b.reason as string });
    notify(db, [note.recorder_id], "NOTE_REJECTED", `${noteLabel(db, note)}가 반려되었습니다`, `/commons/notes/${note.note_id}`, `사유: ${b.reason}`);
    return HttpResponse.json(noteView(db, note, user.user_id));
  }),

  http.post(`${API}/notes/:note_id/sign`, ({ request, params }) => {
    const user = currentUser(request);
    const db = getDb();
    const [found, relation] = load(db, user, String(params.note_id));
    let note = found;
    if (relation === "MEMBER") notWitness();
    // require_fresh_login: a mock session always counts as a login within the last five minutes.
    if (note.status === "SIGNED") locked();
    let role: "RECORDER" | "WITNESS";
    if (relation === "RECORDER") {
      requireActive(db, note.project_id, user);
      if (note.status === "DRAFT") {
        const [required] = witnessSnapshot(db, note.project_id, note.recorder_id);
        if (required) fail("CONFLICT", "The project requires a witness: submit the note first.");
        fixContent(note, false, []);
      }
      role = "RECORDER";
    } else {
      requireActive(db, note.project_id, user);
      role = "WITNESS";
    }
    note = db.notes.find((n) => n.note_id === found.note_id)!;
    if (note.signatures.some((s) => s.role === role)) fail("CONFLICT", `The note already has its ${role} signature.`);
    if (contentHash(note) !== note.content_hash) fail("CONFLICT", "The note's content does not match its fixed hash; verify the note.");
    note.signatures.push({ signer_id: user.user_id, role, signed_at: nowIso(), content_hash: note.content_hash! });
    const roles = new Set(note.signatures.map((s) => s.role));
    const final = roles.has("RECORDER") && (!note.witness_required || roles.has("WITNESS"));
    if (final) appendToChain(db, note);
    recordAudit(db, { action: "NOTE_SIGNED", actor: user, resource: { type: "RESEARCH_NOTE", id: note.note_id, owner_organization_id: note.organization_id }, project_id: note.project_id, details: { signer_role: role, final } });
    notify(db, [note.recorder_id], "NOTE_SIGNED", final ? `${noteLabel(db, note)} 서명이 완료되었습니다` : `${noteLabel(db, note)}에 확인자 서명이 추가되었습니다`, `/commons/notes/${note.note_id}`);
    return HttpResponse.json(noteView(db, note, user.user_id));
  }),

  http.post(`${API}/notes/:note_id/revise`, ({ request, params }) => {
    const user = currentUser(request);
    const db = getDb();
    const note = recorderNote(db, user, String(params.note_id));
    if (note.status !== "SIGNED") locked();
    const latest = latestVersions(db.notes.filter((n) => n.project_id === note.project_id && n.recorder_id === note.recorder_id && n.note_date === note.note_date))[0];
    if (!latest || latest.version !== note.version) fail("CONFLICT", "A newer version of this note exists; revise the latest version.");
    const now = nowIso();
    const draft: StoredNote = {
      ...note,
      note_id: newId(),
      version: note.version + 1,
      previous_version_id: note.note_id,
      status: "DRAFT",
      revision: 1,
      blocks: note.blocks.map((b) => ({ ...b, block_id: newId(), evidence: b.evidence.map((e) => ({ ...e })) })),
      draft_status: "NONE",
      draft_error: null,
      draft_requested_at: null,
      signatures: [],
      witness_required: null,
      witness_user_ids: null,
      content_hash: null,
      chain_hash: null,
      chain_seq: null,
      signed_at: null,
      submitted_at: null,
      rejected_reason: null,
      created_at: now,
      updated_at: now,
    };
    db.notes.push(draft);
    return HttpResponse.json(noteView(db, draft, user.user_id), { status: 201 });
  }),

  http.get(`${API}/notes/:note_id/verify`, ({ request, params }) => {
    const user = currentUser(request);
    const db = getDb();
    const [note] = readable(db, user, String(params.note_id));
    if (note.status === "DRAFT") fail("CONFLICT", "A DRAFT note has no fixed content to verify.");
    const recomputed = contentHash(note);
    return HttpResponse.json({
      note_id: note.note_id,
      valid: recomputed === note.content_hash,
      content_hash: note.content_hash!,
      recomputed_hash: recomputed,
      chain_valid: chainIsIntact(db, note.project_id, note.organization_id),
      checked_at: nowIso(),
    } satisfies Schemas["NoteVerification"]);
  }),
];
