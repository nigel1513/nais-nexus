import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { as } from "../../../tests/mock-api";
import { getDb } from "../db";
import { NOTE, ORG, PROJECT, USER } from "../fixtures";
import { canonicalJson, seoulDate } from "../note-hash";
import { seedNotebookActivity } from "../notebook-activity";
import { sha256Hex } from "../sha256";
import { unzip } from "../zip";

const P = `/projects/${PROJECT.seed}`;
const minjun = as(USER.aResearcher); // recorder of the seed notes, PROJECT_OWNER
const yujin = as(USER.bResearcher); // member (RESEARCHER), other organization
const seoyeon = as(USER.aSteward); // not a member
const jihun = as(USER.aAdmin); // ORG_ADMIN of 한국에너지기술연구원, not a member

const blocksOf = (note: { blocks: { block_id: string; section: string; text: string; accepted: boolean }[] }) => note.blocks.map(({ block_id, section, text, accepted }) => ({ block_id, section, text, accepted }));

async function requireWitness(witnesses: string[] = [USER.bResearcher]) {
  const res = await minjun.patch(`${P}/note-settings`, { witness_required: true, witness_user_ids: witnesses });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
}

describe("notes mocks: seed and visibility", () => {
  it("lists the recorder's latest versions, newest day first", async () => {
    const res = await minjun.get("/notes");
    expect(res.status).toBe(200);
    expect(res.body.items.map((n: { note_id: string; status: string }) => [n.note_id, n.status])).toEqual([
      [NOTE.draft, "DRAFT"],
      [NOTE.signed, "SIGNED"],
    ]);
    expect(res.body.items[0]).toMatchObject({ note_date: seoulDate(), block_count: 7, unaccepted_ai_count: 0, project_name: "차세대 이차전지 소재 공동연구" });
    expect((await minjun.get("/notes?status=SIGNED")).body.items).toHaveLength(1);
    expect((await minjun.get("/notes?from=2026-01-02&to=2026-01-01")).body.error).toMatchObject({ code: "VALIDATION_FAILED", details: { fields: [{ field: "from", reason: "AFTER_TO" }] } });
  });

  it("serves the seed notes in the seven-section template", async () => {
    const note = (await minjun.get(`/notes/${NOTE.signed}`)).body;
    expect(note.blocks.map((b: { section: string }) => b.section)).toEqual(["OBJECTIVE", "METHOD", "PROCEDURE", "RESULTS", "DISCUSSION", "NEXT", "REFERENCES"]);
    expect(note).toMatchObject({ status: "SIGNED", recorder_display_name: "김민준", organization_id: ORG.a, witness_required: false, draft_source_count: 0 });
    expect(note.signatures).toEqual([expect.objectContaining({ role: "RECORDER", signer_display_name: "김민준", content_hash: note.content_hash })]);
  });

  it("keeps DRAFT recorder-only (404) and other members out of SUBMITTED/SIGNED notes (403)", async () => {
    expect((await yujin.get(`/notes/${NOTE.draft}`)).status).toBe(404);
    expect((await yujin.get(`/notes/${NOTE.signed}`)).body.error.code).toBe("FORBIDDEN");
    expect((await seoyeon.get(`/notes/${NOTE.signed}`)).status).toBe(404);
    expect((await yujin.put(`/notes/${NOTE.draft}/blocks`, { blocks: [] }, { "if-match": "2" })).status).toBe(404);
    expect((await yujin.post(`/notes/${NOTE.signed}/revise`)).body.error.code).toBe("FORBIDDEN");
  });

  it("creates today's DRAFT once per recorder and returns it afterwards", async () => {
    const mine = await minjun.post(`${P}/notes/today`);
    expect(mine.status).toBe(200);
    expect(mine.body.note_id).toBe(NOTE.draft);
    const created = await yujin.post(`${P}/notes/today`);
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ organization_id: ORG.b, status: "DRAFT", version: 1, revision: 1, blocks: [] });
    expect((await yujin.post(`${P}/notes/today`)).body.note_id).toBe(created.body.note_id);
    expect((await seoyeon.post(`${P}/notes/today`)).status).toBe(404);
  });
});

describe("notes mocks: locking, hashes and the chain", () => {
  it("never changes a SIGNED note (409 NOTE_LOCKED); revising creates a new DRAFT version", async () => {
    for (const res of [
      await minjun.put(`/notes/${NOTE.signed}/blocks`, { blocks: [] }, { "if-match": "3" }),
      await minjun.delete(`/notes/${NOTE.signed}`),
      await minjun.post(`/notes/${NOTE.signed}/sign`),
      await minjun.post(`/notes/${NOTE.signed}/submit`),
    ]) {
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("NOTE_LOCKED");
    }
    const revised = await minjun.post(`/notes/${NOTE.signed}/revise`);
    expect(revised.status).toBe(201);
    expect(revised.body).toMatchObject({ status: "DRAFT", version: 2, previous_version_id: NOTE.signed, content_hash: null });
    expect(revised.body.blocks.map((b: { text: string }) => b.text)).toEqual((await minjun.get(`/notes/${NOTE.signed}`)).body.blocks.map((b: { text: string }) => b.text));
    expect((await minjun.post(`/notes/${NOTE.signed}/revise`)).body.error.code).toBe("CONFLICT");
    expect((await minjun.delete(`/notes/${revised.body.note_id}`)).status).toBe(204);
    expect((await minjun.get(`/notes/${NOTE.signed}`)).body.status).toBe("SIGNED");
  });

  it("verifies the seed chain and detects tampering with stored content", async () => {
    const ok = (await minjun.get(`/notes/${NOTE.signed}/verify`)).body;
    expect(ok).toMatchObject({ note_id: NOTE.signed, valid: true, chain_valid: true });
    expect(ok.recomputed_hash).toBe(ok.content_hash);
    expect((await minjun.get(`/notes/${NOTE.draft}/verify`)).body.error.code).toBe("CONFLICT");
    getDb().notes.find((n) => n.note_id === NOTE.signed)!.blocks[3]!.text = "사이클 300 시점의 평균 방전 용량은 초기 대비 약 1 % 감소했다.";
    const tampered = (await minjun.get(`/notes/${NOTE.signed}/verify`)).body;
    expect(tampered).toMatchObject({ valid: false, chain_valid: false });
    expect(tampered.recomputed_hash).not.toBe(tampered.content_hash);
  });

  it("signs a DRAFT directly when no witness is required and appends it to the project × organization chain", async () => {
    const signed = await minjun.post(`/notes/${NOTE.draft}/sign`);
    expect(signed.status).toBe(200);
    expect(signed.body).toMatchObject({ status: "SIGNED", witness_required: false, witness_user_ids: [] });
    const head = getDb().noteChains[`${PROJECT.seed}:${ORG.a}`]!;
    expect(head.last_seq).toBe(2);
    const first = getDb().notes.find((n) => n.note_id === NOTE.signed)!;
    expect(signed.body.chain_hash).toBe(createHash("sha256").update(first.chain_hash! + signed.body.content_hash).digest("hex"));
    expect((await minjun.get(`/notes/${NOTE.draft}/verify`)).body).toMatchObject({ valid: true, chain_valid: true });
  });

  it("enforces If-Match on block saves and keeps origin/evidence of listed blocks", async () => {
    const note = (await minjun.get(`/notes/${NOTE.draft}`)).body;
    const stale = await minjun.put(`/notes/${NOTE.draft}/blocks`, { blocks: blocksOf(note) }, { "if-match": "1" });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toMatchObject({ code: "CONFLICT", details: { revision: 2 } });
    const kept = blocksOf(note).slice(0, 2);
    const saved = await minjun.put(`/notes/${NOTE.draft}/blocks`, { blocks: [...kept, { section: "NEXT", text: "온도 보정 단계 추가 여부를 결정한다." }] }, { "if-match": '"2"' });
    expect(saved.body.revision).toBe(3);
    expect(saved.body.blocks.map((b: { block_id: string }) => b.block_id).slice(0, 2)).toEqual(kept.map((b) => b.block_id));
    expect(saved.body.blocks[2]).toMatchObject({ origin: "HUMAN", accepted: true, evidence: [] });
    const unknown = await minjun.put(`/notes/${NOTE.draft}/blocks`, { blocks: [{ block_id: NOTE.signed, section: "NEXT", text: "x" }] }, { "if-match": "3" });
    expect(unknown.body.error.details).toEqual({ fields: [{ field: "blocks.0.block_id", reason: "UNKNOWN_BLOCK" }] });
  });
});

describe("notes mocks: signing needs a fresh login", () => {
  const withLogin = (minutesAgo: number) => ({ cookie: `nais_mock_auth_time=${Date.now() - minutesAgo * 60_000}` });

  it("answers 401 NOTE_SIGNATURE_EXPIRED when the mock login is older than five minutes", async () => {
    const stale = await minjun.post(`/notes/${NOTE.draft}/sign`, undefined, withLogin(6));
    expect(stale.status).toBe(401);
    expect(stale.body.error.code).toBe("NOTE_SIGNATURE_EXPIRED");
    expect((await minjun.get(`/notes/${NOTE.draft}`)).body.status).toBe("DRAFT"); // nothing was fixed
    const fresh = await minjun.post(`/notes/${NOTE.draft}/sign`, undefined, withLogin(1));
    expect(fresh.body.status).toBe("SIGNED");
  });

  it("checks freshness only after the caller's relation to the note (others still get 404/403)", async () => {
    expect((await yujin.post(`/notes/${NOTE.draft}/sign`, undefined, withLogin(30))).status).toBe(404);
    expect((await yujin.post(`/notes/${NOTE.signed}/sign`, undefined, withLogin(30))).body.error.code).toBe("NOTE_NOT_WITNESS");
  });
});

describe("notes mocks: witnesses", () => {
  it("snapshots the witnesses at submit; the snapshot, not the current setting, governs reading and signing", async () => {
    await requireWitness();
    expect((await minjun.post(`/notes/${NOTE.draft}/sign`)).body.error.code).toBe("CONFLICT"); // submit first
    const submitted = await minjun.post(`/notes/${NOTE.draft}/submit`);
    expect(submitted.body).toMatchObject({ status: "SUBMITTED", witness_required: true, witness_user_ids: [USER.bResearcher] });
    expect(getDb().notifications.some((n) => n.user_id === USER.bResearcher && n.type === "NOTE_SUBMITTED")).toBe(true);
    expect((await minjun.put(`/notes/${NOTE.draft}/blocks`, { blocks: [] }, { "if-match": "2" })).body.error.code).toBe("NOTE_LOCKED");

    await minjun.patch(`${P}/note-settings`, { witness_required: false, witness_user_ids: [] });
    const read = await yujin.get(`/notes/${NOTE.draft}`);
    expect(read.status).toBe(200);
    expect(getDb().audit.some((e) => e.action === "NOTE_VIEWED" && e.actor.user_id === USER.bResearcher && e.resource.id === NOTE.draft)).toBe(true);
    expect((await yujin.get("/notes?role=witness")).body.items.map((n: { note_id: string }) => n.note_id)).toEqual([NOTE.draft]);

    const recorder = await minjun.post(`/notes/${NOTE.draft}/sign`);
    expect(recorder.body.status).toBe("SUBMITTED");
    expect((await minjun.post(`/notes/${NOTE.draft}/sign`)).body.error.code).toBe("CONFLICT");
    expect((await jihun.post(`/notes/${NOTE.draft}/sign`)).status).toBe(404);
    const witness = await yujin.post(`/notes/${NOTE.draft}/sign`);
    expect(witness.body).toMatchObject({ status: "SIGNED" });
    expect(witness.body.signatures.map((s: { role: string }) => s.role)).toEqual(["RECORDER", "WITNESS"]);
    expect((await yujin.get(`/notes/${NOTE.draft}/verify`)).body).toMatchObject({ valid: true, chain_valid: true });
  });

  it("lets a snapshot witness return a SUBMITTED note to its recorder with a reason", async () => {
    await requireWitness();
    await minjun.post(`/notes/${NOTE.draft}/submit`);
    expect((await yujin.post(`/notes/${NOTE.draft}/reject`, {})).body.error.code).toBe("VALIDATION_FAILED");
    const rejected = await yujin.post(`/notes/${NOTE.draft}/reject`, { reason: "결과 수치의 근거가 부족합니다." });
    expect(rejected.body).toMatchObject({ status: "DRAFT", rejected_reason: "결과 수치의 근거가 부족합니다.", content_hash: null, signatures: [] });
    expect(getDb().notifications.some((n) => n.user_id === USER.aResearcher && n.type === "NOTE_REJECTED")).toBe(true);
    expect((await yujin.get(`/notes/${NOTE.draft}`)).status).toBe(404); // DRAFT again: recorder-only
    expect((await yujin.post(`/notes/${NOTE.signed}/reject`, { reason: "x" })).body.error.code).toBe("NOTE_NOT_WITNESS");
  });

  it("validates note settings: managers only, witnesses must be ACTIVE members", async () => {
    expect((await yujin.patch(`${P}/note-settings`, { witness_required: false })).body.error.code).toBe("FORBIDDEN");
    expect((await seoyeon.get(`${P}/note-settings`)).status).toBe(404);
    const outsider = await minjun.patch(`${P}/note-settings`, { witness_required: true, witness_user_ids: [USER.aSteward] });
    expect(outsider.body.error.details).toEqual({ fields: [{ field: "witness_user_ids.0", reason: "NOT_ACTIVE_MEMBER" }] });
    expect((await minjun.patch(`${P}/note-settings`, { witness_required: true })).body.error.details).toEqual({ fields: [{ field: "witness_user_ids", reason: "WITNESS_REQUIRED" }] });
    expect((await minjun.get(`${P}/note-settings`)).body).toEqual({ project_id: PROJECT.seed, witness_required: false, witness_user_ids: [], llm_enabled: true });
  });
});

describe("notes mocks: drafting from the day's notebooks", () => {
  it("answers 422 NO_NOTEBOOK_ACTIVITY while no notebook was saved that day (Jupyter is not there yet)", async () => {
    const res = await minjun.post(`/notes/${NOTE.draft}/draft`);
    expect(res.status).toBe(422);
    expect(res.body.error).toMatchObject({ code: "VALIDATION_FAILED", message: expect.stringMatching(/^이 프로젝트에서 오늘\(\d{4}-\d{2}-\d{2}\) 저장한 노트북이 없습니다\. 노트북 탭에서 이 프로젝트의 노트북을 저장한 뒤 다시 시도하세요\.$/), details: { reason: "NO_NOTEBOOK_ACTIVITY" } });
    expect((await minjun.get(`/notes/${NOTE.draft}`)).body.draft_source_count).toBe(0);
    getDb().llmEnabled = false;
    expect((await minjun.post(`/notes/${NOTE.draft}/draft`)).body.error.code).toBe("LLM_UNAVAILABLE");
    expect((await minjun.post(`/notes/${NOTE.signed}/draft`)).body.error.code).toBe("NOTE_LOCKED");
  });

  it("drafts AI blocks with NOTEBOOK evidence that must be accepted before submit (409 NOTE_HAS_UNACCEPTED_AI)", async () => {
    seedNotebookActivity({
      user_id: USER.aResearcher,
      project_id: PROJECT.seed,
      day: seoulDate(),
      title: "temp_c 주기 분석",
      saved_at: new Date().toISOString(),
      cells: [
        { type: "markdown", source_head: "# temp_c 9 사이클 주기 확인", output_kinds: [], output_count: 0, has_error: false },
        { type: "code", source_head: "df = load_input('battery')\ndf.groupby('cell_id').temp_c.mean()", output_kinds: ["table"], output_count: 1, has_error: false },
        { type: "markdown", source_head: "## 챔버 설정 온도와 대조", output_kinds: [], output_count: 0, has_error: false },
      ],
    });
    expect((await minjun.get(`/notes/${NOTE.draft}`)).body.draft_source_count).toBe(1);
    const queued = await minjun.post(`/notes/${NOTE.draft}/draft`);
    expect(queued.status).toBe(202);
    expect(queued.body.draft_status).toBe("QUEUED");
    expect((await minjun.post(`/notes/${NOTE.draft}/draft`)).body.error.code).toBe("RATE_LIMITED");
    expect((await minjun.get(`/notes/${NOTE.draft}`)).body.draft_status).toBe("RUNNING");
    const drafted = (await minjun.get(`/notes/${NOTE.draft}`)).body;
    expect(drafted.draft_status).toBe("DONE");
    const ai = drafted.blocks.filter((b: { origin: string }) => b.origin === "AI");
    expect(ai.length).toBeGreaterThan(0);
    expect(ai.every((b: { accepted: boolean }) => !b.accepted)).toBe(true);
    const procedure = ai.find((b: { section: string }) => b.section === "PROCEDURE");
    expect(procedure.evidence).toEqual([expect.objectContaining({ type: "NOTEBOOK", label: "temp_c 주기 분석 · 셀 2" })]);
    expect((await minjun.get("/notes")).body.items[0].unaccepted_ai_count).toBe(ai.length);

    const blocked = await minjun.post(`/notes/${NOTE.draft}/submit`);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe("NOTE_HAS_UNACCEPTED_AI");
    expect((await minjun.post(`/notes/${NOTE.draft}/sign`)).body.error.code).toBe("NOTE_HAS_UNACCEPTED_AI");

    // editing an AI sentence accepts it; the rest are accepted explicitly; evidence stays with the block
    const write = blocksOf(drafted).map((b) => (b.block_id === procedure.block_id ? { ...b, text: `${b.text} (온도 평균)`, accepted: undefined } : { ...b, accepted: true }));
    const saved = await minjun.put(`/notes/${NOTE.draft}/blocks`, { blocks: write }, { "if-match": String(drafted.revision) });
    const edited = saved.body.blocks.find((b: { block_id: string }) => b.block_id === procedure.block_id);
    expect(edited).toMatchObject({ origin: "AI", accepted: true, evidence: procedure.evidence });
    expect((await minjun.post(`/notes/${NOTE.draft}/submit`)).body.status).toBe("SUBMITTED");
  });

  it("does not append the same sentences twice when the day is drafted again", async () => {
    seedNotebookActivity({ user_id: USER.aResearcher, project_id: PROJECT.seed, day: seoulDate(), title: "용량 비교", saved_at: new Date().toISOString(), cells: [{ type: "code", source_head: "plot(capacity)", output_kinds: ["image"], output_count: 1, has_error: false }] });
    const draftOnce = async () => {
      getDb().notes.find((n) => n.note_id === NOTE.draft)!.draft_requested_at = null;
      expect((await minjun.post(`/notes/${NOTE.draft}/draft`)).status).toBe(202);
      await minjun.get(`/notes/${NOTE.draft}`);
      return (await minjun.get(`/notes/${NOTE.draft}`)).body.blocks.length;
    };
    const first = await draftOnce();
    expect(first).toBeGreaterThan(7);
    expect(await draftOnce()).toBe(first);
  });
});

describe("notes mocks: search and export", () => {
  it("searches only the notes the caller may read, by keyword (score null)", async () => {
    const mine = (await minjun.get("/notes/search?q=열전대")).body.items;
    expect(mine).toEqual([expect.objectContaining({ note_id: NOTE.draft, score: null, project_name: "차세대 이차전지 소재 공동연구" })]);
    expect(mine[0].snippet).toContain("열전대");
    expect((await yujin.get("/notes/search?q=열전대")).body.items).toEqual([]);
    expect((await minjun.get("/notes/search?q=")).body.error.code).toBe("VALIDATION_FAILED");
    expect((await minjun.get("/notes/search?q=%20%20")).body.error.code).toBe("VALIDATION_FAILED");
    expect((await minjun.get("/notes/search?q=용량")).body.items.map((h: { note_id: string }) => h.note_id)).toEqual([NOTE.draft, NOTE.signed]);
  });

  it("exports the caller's notes; an ORG_ADMIN also gets submitted/signed notes of the organization, never DRAFTs", async () => {
    const res = await fetch(`http://localhost:3000/mock-api/v1/notes/export?project_id=${PROJECT.seed}`, { headers: { "x-mock-user": USER.aAdmin } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toBe(`attachment; filename="research-notes-${PROJECT.seed}-all-all.zip"`);
    const files = unzip(new Uint8Array(await res.arrayBuffer()));
    const json = [...files.keys()].filter((k) => k.endsWith(".json"));
    expect(json).toHaveLength(1);
    expect(json[0]).toContain(NOTE.signed);
    const record = JSON.parse(files.get(json[0]!)!);
    expect(sha256Hex(canonicalJson(record.content))).toBe(record.content_hash);
    expect(createHash("sha256").update(canonicalJson(record.content)).digest("hex")).toBe(record.content_hash);
    expect(files.get("hashes.csv")!.split("\n")[1]).toContain(NOTE.signed);
    expect(files.get(json[0]!.replace(".json", ".html"))).toContain("연구 목표");
    expect(getDb().audit.some((e) => e.action === "NOTE_VIEWED" && e.actor.user_id === USER.aAdmin)).toBe(true);

    const own = unzip(new Uint8Array(await (await fetch(`http://localhost:3000/mock-api/v1/notes/export?project_id=${PROJECT.seed}`, { headers: { "x-mock-user": USER.aResearcher } })).arrayBuffer()));
    expect([...own.keys()].filter((k) => k.endsWith(".json"))).toHaveLength(2);
    expect((await seoyeon.get(`/notes/export?project_id=${PROJECT.seed}`)).status).toBe(404);
    expect((await minjun.get("/notes/export")).status).toBe(422);
  });
});

describe("mock sha256", () => {
  it("matches node:crypto", () => {
    for (const text of ["", "abc", "연구노트", "x".repeat(1000), "a".repeat(55), "a".repeat(56), "a".repeat(64)]) {
      expect(sha256Hex(text)).toBe(createHash("sha256").update(text).digest("hex"));
    }
  });
});
