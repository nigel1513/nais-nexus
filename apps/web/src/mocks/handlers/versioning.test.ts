import { describe, expect, it } from "vitest";
import { getDb } from "../db";
import { DATASET, ORG, USER, VERSION } from "../fixtures";

/** lakeFS-style version rules of the mock (spec §3.3b), driven over the same HTTP surface the UI uses. */
const BASE = "http://localhost:3000/mock-api/v1";
const S = USER.bSteward;
const send = (user: string, method: string, path: string, body?: unknown) =>
  fetch(`${BASE}${path}`, { method, headers: { "x-mock-user": user, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const json = async (user: string, method: string, path: string, body?: unknown, status = 200) => {
  const res = await send(user, method, path, body);
  const text = await res.text();
  expect(res.status, text).toBe(status);
  return text ? JSON.parse(text) : undefined;
};
const draft = (label: string, extra: Record<string, unknown> = {}, status = 201) => json(S, "POST", `/datasets/${DATASET.battery}/versions`, { version_label: label, ...extra }, status);
const get = (id: string) => json(S, "GET", `/dataset-versions/${id}`);
const note = (id: string, text = "변경 메모") => json(S, "PATCH", `/dataset-versions/${id}`, { change_note: text });
const publish = (id: string) => json(S, "POST", `/dataset-versions/${id}/publish`);
const sha = (c: string) => c.repeat(64);

async function upload(versionId: string, files: Record<string, string>) {
  const session = await json(S, "POST", `/dataset-versions/${versionId}/upload-session`, {
    files: Object.entries(files).map(([path, body]) => ({ path, size_bytes: body.length, sha256: sha(String(body.length % 10)), media_type: path.endsWith(".csv") ? "text/csv" : "text/markdown" })),
  }, 201);
  for (const f of session.files) await fetch(f.upload.url, { method: "PUT", body: files[f.path] });
  await json(S, "POST", `/upload-sessions/${session.upload_session_id}/complete`, {});
  return session;
}

describe("seed lineage", () => {
  it("chains v1.0 -> v1.1 -> v2.0 and branches the draft from v2.0", async () => {
    const v20 = await get(VERSION.battery);
    expect([v20.previous_version_id, v20.base_version_id]).toEqual([VERSION.batteryV11, VERSION.batteryV11]);
    expect((await get(VERSION.batteryV11)).previous_version_id).toBe(VERSION.batteryV10);
    expect((await get(VERSION.batteryV10)).previous_version_id).toBeNull();
    const d = await get(VERSION.batteryDraft);
    expect(d).toMatchObject({ base_version_id: VERSION.battery, base_is_latest: true, created_by: USER.bSteward });
    expect(d.files.filter((f: { inherited: boolean }) => f.inherited).map((f: { path: string }) => f.path)).toEqual(["README.md", "_codebook.csv", "_schema.json", "data/test_cells.csv"]);
    expect(v20.change_summary).toEqual({ added: 2, removed: 0, changed: 2, unchanged: 1 });
  });
});

describe("drafts", () => {
  it("inherit the latest published files by default, or start empty, or come from an older version", async () => {
    const d = await draft("v3");
    expect(d).toMatchObject({ base_version_id: VERSION.battery, source_version_id: VERSION.battery, base_is_latest: true });
    expect(d.files).toHaveLength(5);
    expect(d.files.every((f: { inherited: boolean; status: string }) => f.inherited && f.status === "VERIFIED")).toBe(true);
    const own = (await get(VERSION.battery)).files.map((f: { file_id: string }) => f.file_id);
    expect(d.files.some((f: { file_id: string }) => own.includes(f.file_id))).toBe(false); // inherited copies get new ids
    const empty = await draft("v3-empty", { empty: true });
    expect(empty).toMatchObject({ files: [], base_version_id: VERSION.battery, source_version_id: null });
    const revert = await draft("v3-revert", { from_version_id: VERSION.batteryV10 });
    expect(revert).toMatchObject({ base_version_id: VERSION.battery, source_version_id: VERSION.batteryV10 });
    expect(revert.files.map((f: { path: string }) => f.path)).toEqual(["README.md", "data/measurements.csv"]);
    expect(revert.change_summary).toMatchObject({ removed: 3, changed: 2 });
  });

  it("validates from_version_id and empty", async () => {
    const e1 = await draft("x1", { from_version_id: VERSION.batteryDraft }, 422);
    expect(e1.error.details.fields).toEqual([{ field: "from_version_id", reason: "VERSION_NOT_PUBLISHED" }]);
    const e2 = await draft("x2", { from_version_id: VERSION.battery, empty: true }, 422);
    expect(e2.error.details.fields).toEqual([{ field: "empty", reason: "MUTUALLY_EXCLUSIVE" }]);
  });

  it("note is DRAFT-only and 3..2000 trimmed characters", async () => {
    const d = await draft("v3");
    expect((await note(d.dataset_version_id, "  좋아요  ")).change_note).toBe("좋아요");
    expect((await json(S, "PATCH", `/dataset-versions/${d.dataset_version_id}`, { change_note: "  " }, 422)).error.code).toBe("VALIDATION_FAILED");
    expect((await json(S, "PATCH", `/dataset-versions/${VERSION.battery}`, { change_note: "수정" + "!" }, 409)).error.code).toBe("DATASET_VERSION_IMMUTABLE");
    expect((await send(USER.aResearcher, "PATCH", `/dataset-versions/${d.dataset_version_id}`, { change_note: "abc" })).status).toBe(404);
  });

  it("discard removes a DRAFT and its own objects but never a published version", async () => {
    const d = await draft("v3");
    await upload(d.dataset_version_id, { "data/new.csv": "a,b\n1,2\n" });
    const fileId = (await get(d.dataset_version_id)).files.find((f: { path: string }) => f.path === "data/new.csv").file_id;
    expect(getDb().objects[fileId]).toBeDefined();
    await json(S, "DELETE", `/dataset-versions/${d.dataset_version_id}`, undefined, 204);
    expect(getDb().objects[fileId]).toBeUndefined();
    expect((await send(S, "GET", `/dataset-versions/${d.dataset_version_id}`)).status).toBe(404);
    expect(getDb().uploadSessions.some((s) => s.dataset_version_id === d.dataset_version_id)).toBe(false);
    expect((await json(S, "DELETE", `/dataset-versions/${VERSION.battery}`, undefined, 409)).error.code).toBe("DATASET_VERSION_IMMUTABLE");
    expect((await get(VERSION.battery)).files).toHaveLength(5);
  });

  it("uploading over an inherited path replaces the row without a CONFLICT", async () => {
    const d = await draft("v3");
    const before = d.files.find((f: { path: string }) => f.path === "data/measurements.csv");
    await upload(d.dataset_version_id, { "data/measurements.csv": "x\n1\n" });
    const after = (await get(d.dataset_version_id)).files.find((f: { path: string }) => f.path === "data/measurements.csv");
    expect(after).toMatchObject({ inherited: false, status: "VERIFIED" });
    expect(after.file_id).not.toBe(before.file_id);
    expect((await get(VERSION.battery)).files.find((f: { path: string }) => f.path === "data/measurements.csv").size_bytes).not.toBe(4);
  });
});

describe("publish", () => {
  it("needs a change note, sets previous_version_id and freezes a metadata snapshot", async () => {
    const d = await draft("v3");
    const e = await json(S, "POST", `/dataset-versions/${d.dataset_version_id}/publish`, undefined, 409);
    expect(e.error).toMatchObject({ code: "DATASET_VERSION_INCOMPLETE", details: { reasons: ["CHANGE_NOTE_REQUIRED"] } });
    await note(d.dataset_version_id);
    const v = await publish(d.dataset_version_id);
    expect(v).toMatchObject({ status: "PUBLISHED", previous_version_id: VERSION.battery, base_version_id: VERSION.battery, base_is_latest: null });
    expect(getDb().versions.find((x) => x.dataset_version_id === d.dataset_version_id)!.metadata_snapshot).toMatchObject({ title: expect.any(String) });
  });

  it("rejects a stale base with the two version ids", async () => {
    const a = await draft("v3-a");
    const b = await draft("v3-b");
    await note(a.dataset_version_id);
    await publish(a.dataset_version_id);
    await note(b.dataset_version_id);
    const e = await json(S, "POST", `/dataset-versions/${b.dataset_version_id}/publish`, undefined, 409);
    expect(e.error).toMatchObject({ code: "DATASET_VERSION_STALE_BASE", details: { base_version_id: VERSION.battery, latest_version_id: a.dataset_version_id } });
    expect((await get(b.dataset_version_id)).base_is_latest).toBe(false);
  });

  it("inherited files keep their preview and profile after publish (resolved through inherited_from)", async () => {
    const d = await draft("v3");
    const inherited = d.files.find((f: { path: string }) => f.path === "data/measurements.csv");
    // A draft row resolves to its source's profile before publish.
    expect((await json(S, "GET", `/dataset-files/${inherited.file_id}/profile`)).status).toBe("READY");
    await note(d.dataset_version_id);
    const v = await publish(d.dataset_version_id);
    for (const f of v.files.filter((x: { path: string }) => x.path.endsWith("test_cells.csv") || x.path.endsWith("measurements.csv"))) {
      expect((await json(S, "GET", `/dataset-files/${f.file_id}/profile`)).status, f.path).toBe("READY");
      expect((await json(S, "GET", `/dataset-files/${f.file_id}/preview`)).rows.length, f.path).toBeGreaterThan(0);
    }
  });
});

describe("rebase", () => {
  async function twoDrafts() {
    const a = await draft("v3-a");
    const b = await draft("v3-b");
    return { a: a.dataset_version_id as string, b: b.dataset_version_id as string };
  }

  it("takes the latest for untouched paths and keeps the draft's own uploads", async () => {
    const { a, b } = await twoDrafts();
    await upload(a, { "README.md": "# from a\n" });
    await note(a);
    await publish(a);
    await upload(b, { "data/b-only.csv": "q\n1\n" });
    const v = await json(S, "POST", `/dataset-versions/${b}/rebase`, {});
    expect(v).toMatchObject({ base_version_id: a, base_is_latest: true });
    const files = Object.fromEntries(v.files.map((f: { path: string }) => [f.path, f]));
    expect(files["README.md"].inherited).toBe(true);
    expect(files["data/b-only.csv"].inherited).toBe(false);
    await note(b);
    await publish(b);
  });

  it("returns conflicts without changing anything, then honours MINE / THEIRS", async () => {
    const { a, b } = await twoDrafts();
    await upload(a, { "README.md": "# a\n" });
    await note(a);
    await publish(a);
    await upload(b, { "README.md": "# b!!\n" });
    const before = await get(b);
    const e = await json(S, "POST", `/dataset-versions/${b}/rebase`, {}, 409);
    expect(e.error.code).toBe("CONFLICT");
    expect(e.error.details.latest_version_id).toBe(a);
    const [c] = e.error.details.conflicts;
    expect(Object.keys(c).sort()).toEqual(["base", "mine", "path", "theirs"]);
    expect(c.path).toBe("README.md");
    expect(await get(b)).toEqual(before);
    const mine = await json(S, "POST", `/dataset-versions/${b}/rebase`, { resolutions: { "README.md": "MINE" } });
    expect(mine.files.find((f: { path: string }) => f.path === "README.md")).toMatchObject({ inherited: false, sha256: before.files.find((f: { path: string }) => f.path === "README.md").sha256 });
  });

  it("THEIRS replaces the draft's file; unknown resolution paths are 422; open uploads block", async () => {
    const { a, b } = await twoDrafts();
    await upload(a, { "README.md": "# a\n" });
    await note(a);
    await publish(a);
    await upload(b, { "README.md": "# b!!\n" });
    const bad = await json(S, "POST", `/dataset-versions/${b}/rebase`, { resolutions: { "nope.csv": "MINE" } }, 422);
    expect(bad.error.details.fields).toEqual([{ field: "resolutions", reason: "UNKNOWN_PATH", paths: ["nope.csv"] }]);
    const session = await json(S, "POST", `/dataset-versions/${b}/upload-session`, { files: [{ path: "data/p.csv", size_bytes: 4, sha256: sha("1"), media_type: "text/csv" }] }, 201);
    expect(session.status).toBe("OPEN");
    expect((await json(S, "POST", `/dataset-versions/${b}/rebase`, {}, 409)).error.code).toBe("CONFLICT");
    await json(S, "POST", `/upload-sessions/${session.upload_session_id}/complete`, {});
    const theirs = await json(S, "POST", `/dataset-versions/${b}/rebase`, { resolutions: { "README.md": "THEIRS" } });
    expect(theirs.files.find((f: { path: string }) => f.path === "README.md").inherited).toBe(true);
  });

  it("is a no-op when the draft is already current", async () => {
    const d = await draft("v3");
    const v = await json(S, "POST", `/dataset-versions/${d.dataset_version_id}/rebase`);
    expect(v.dataset_version_id).toBe(d.dataset_version_id);
  });
});

describe("diff, file history, citation", () => {
  it("diffs a draft against its base: files, schema (no raw values) and metadata", async () => {
    const d = await draft("v3");
    await upload(d.dataset_version_id, { "data/measurements.csv": "cycle,secret\n1,SECRETVALUE\n" });
    await json(S, "PATCH", `/datasets/${DATASET.battery}`, { license: "CC0-1.0" });
    const res = await send(S, "GET", `/dataset-versions/${d.dataset_version_id}/diff`);
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(text).not.toContain("SECRETVALUE");
    const diff = JSON.parse(text);
    expect(diff.from_version_id).toBe(VERSION.battery);
    expect(diff.summary).toEqual({ added: 0, removed: 0, changed: 1, unchanged: 4 });
    expect(diff.schema).toEqual([{ path: "data/measurements.csv", status: "PROFILE_MISSING" }]); // new upload: shown after publish
    expect(diff.metadata).toContainEqual({ field: "license", before: "CC-BY-4.0", after: "CC0-1.0" });
  });

  it("compares two published versions with the schema layer from inherited-aware profiles", async () => {
    const diff = await json(S, "GET", `/dataset-versions/${VERSION.battery}/diff?against=${VERSION.batteryV10}`);
    expect(diff.summary).toEqual({ added: 3, removed: 0, changed: 2, unchanged: 0 });
    const m = diff.schema.find((s: { path: string }) => s.path === "data/measurements.csv");
    expect(m.status).toBe("COMPARED");
  });

  it("refuses another dataset's version (422) and an invisible one (404)", async () => {
    const other = await json(USER.aSteward, "GET", `/dataset-versions/${VERSION.openMaterials}`);
    const e = await json(S, "GET", `/dataset-versions/${VERSION.battery}/diff?against=${other.dataset_version_id}`, undefined, 422);
    expect(e.error.details.fields).toEqual([{ field: "against", reason: "DIFFERENT_DATASET" }]);
    expect((await send(USER.aResearcher, "GET", `/dataset-versions/${VERSION.battery}/diff?against=${VERSION.batteryDraft}`)).status).toBe(404);
  });

  it("lists a path's state in every published version, drafts excluded", async () => {
    const h = await json(USER.aResearcher, "GET", `/datasets/${DATASET.battery}/file-history?path=data/test_cells.csv`);
    expect(h.items.map((i: { version_label: string; state: string }) => [i.version_label, i.state])).toEqual([["v1.0", "ABSENT"], ["v1.1", "ADDED"], ["v2.0", "UNCHANGED"]]);
    const r = await json(S, "GET", `/datasets/${DATASET.battery}/file-history?path=README.md`);
    expect(r.items.map((i: { state: string }) => i.state)).toEqual(["ADDED", "CHANGED", "CHANGED"]);
    expect((await json(S, "GET", `/datasets/${DATASET.battery}/file-history?path=${encodeURIComponent("a b")}`, undefined, 422)).error.code).toBe("VALIDATION_FAILED");
  });

  it("renders citations and refuses drafts", async () => {
    const c = await json(USER.aResearcher, "GET", `/dataset-versions/${VERSION.battery}/citation?style=bibtex`);
    expect(c).toMatchObject({ dataset_version_id: VERSION.battery, style: "bibtex" });
    expect(c.content).toContain("@misc{nais_");
    expect(c.content).toContain("version = {v2.0}");
    const t = await json(USER.aResearcher, "GET", `/dataset-versions/${VERSION.battery}/citation`);
    expect(t.style).toBe("text");
    expect(t.content).toContain("(Version v2.0) [Data set].");
    expect(JSON.parse((await json(USER.aResearcher, "GET", `/dataset-versions/${VERSION.battery}/citation?style=datacite-json`)).content).types).toEqual({ resourceTypeGeneral: "Dataset" });
    expect((await json(S, "GET", `/dataset-versions/${VERSION.batteryDraft}/citation`, undefined, 409)).error.code).toBe("DATASET_VERSION_NOT_PUBLISHED");
    expect((await send(USER.aResearcher, "GET", `/dataset-versions/${VERSION.batteryDraft}/citation`)).status).toBe(404);
    void ORG;
  });
});
