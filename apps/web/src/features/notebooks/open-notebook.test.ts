import { describe, expect, it } from "vitest";
import type { DatasetFile, DatasetVersion, Schemas } from "@/shared/api/types";
import { MAX_FILE_BYTES, openNotebook, primaryFile, readmeText, safeName, type OpenDeps } from "./open-notebook";

const U = "00000000-0000-4000-8000-00000000000a";
const P = "00000000-0000-4000-8000-00000000000b";
const JUPYTER = { base: "http://nb.test/notebooks", token: "tok" };

const file = (path: string, size: number, status: DatasetFile["status"] = "VERIFIED"): DatasetFile => ({ file_id: `f-${path}`, path, size_bytes: size, sha256: "0".repeat(64), media_type: "text/csv", status });
const input = (n: number, access: Schemas["AccessLevel"], extra: Partial<Schemas["ProjectInput"]> = {}) =>
  ({ input_id: `0000000${n}-0000-4000-8000-000000000000`, dataset_title: `데이터 ${n}`, version_label: "v1", dataset_version_id: `v${n}`, access_level: access, access_lapsed: false, ...extra }) as Schemas["ProjectInput"];

/** Fake NAIS API + Jupyter: records Jupyter PUTs; `existing` maps a path to the size Jupyter reports. */
function harness({ inputs, versions, existing = {}, clock }: { inputs: Schemas["ProjectInput"][]; versions: Record<string, DatasetFile[]>; existing?: Record<string, number>; clock?: { t: number; step: number } }) {
  const puts: string[] = [];
  const reads: string[] = [];
  const api: OpenDeps["api"] = async (path, init) => {
    if (clock) clock.t += clock.step;
    if (path === "/me") return Response.json({ user_id: U });
    if (path === `/projects/${P}`) return Response.json({ project_id: P, name: "프로젝트", my_role: "RESEARCHER" });
    if (path === `/projects/${P}/inputs`) return Response.json({ items: inputs });
    const m = /^\/dataset-versions\/([^/]+)(\/download-session)?$/.exec(path);
    if (m && !m[2]) return Response.json({ dataset_version_id: m[1], dataset_id: "d", files: versions[m[1]!] ?? [] });
    if (m && m[2] && init?.method === "POST") {
      const ids = (JSON.parse(String(init.body)) as { file_ids: string[] }).file_ids;
      return Response.json({ files: ids.map((id) => ({ file_id: id, url: `http://s3.test/${id}` })) }, { status: 201 });
    }
    return new Response(null, { status: 404 });
  };
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const path = decodeURIComponent(new URL(url).pathname.replace("/notebooks/api/contents/", ""));
    if (init?.method === "PUT") {
      puts.push(path);
      return new Response("{}", { status: 201 });
    }
    if (path.split("/").length <= 3) return Response.json({ type: "directory" });
    if (path in existing) return Response.json({ type: "file", size: existing[path] });
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  const deps: OpenDeps = {
    api,
    jupyter: JUPYTER,
    fetch: fetchImpl,
    sizeOf: (_v: DatasetVersion, f: DatasetFile) => f.size_bytes,
    readFile: async (_v, f) => {
      reads.push(f.path);
      return new Uint8Array(3);
    },
    now: clock ? () => clock.t : undefined,
  };
  return { deps, puts, reads };
}

describe("primaryFile / safeName", () => {
  it("skips '_' files, unverified and non-tabular files; takes the largest csv/parquet", () => {
    expect(primaryFile([file("_codebook.csv", 9e6), file("a.csv", 10), file("b.parquet", 20), file("c.json", 99), file("d.csv", 50, "PENDING")])?.path).toBe("b.parquet");
    expect(primaryFile([file("_x.csv", 1), file("README.md", 2)])).toBeUndefined();
  });

  it("keeps names free of separators, reserved characters and leading dots", () => {
    expect(safeName("../a/b:c*?\"<>|\n d")).toBe("_a_b_c_______ d");
    expect(safeName("...")).toBe("data");
    expect(safeName("..hidden")).toBe("hidden");
  });
});

describe("openNotebook", () => {
  it("validates the project id before any call", async () => {
    let called = false;
    const r = await openNotebook("../x", { api: async () => ((called = true), new Response()), jupyter: JUPYTER, sizeOf: () => 0, readFile: async () => new Uint8Array() });
    expect(r).toEqual({ ok: false, error: "forbidden" });
    expect(called).toBe(false);
  });

  it("refuses a caller who is not a member, and an invalid user id", async () => {
    const { deps } = harness({ inputs: [], versions: {} });
    const notMember: OpenDeps = { ...deps, api: async (path, init) => (path === `/projects/${P}` ? Response.json({ project_id: P, name: "x", my_role: null }) : deps.api(path, init)) };
    expect(await openNotebook(P, notMember)).toEqual({ ok: false, error: "forbidden" });
    const hidden: OpenDeps = { ...deps, api: async (path, init) => (path === `/projects/${P}` ? new Response(null, { status: 404 }) : deps.api(path, init)) };
    expect(await openNotebook(P, hidden)).toEqual({ ok: false, error: "forbidden" });
    const badUser: OpenDeps = { ...deps, api: async (path, init) => (path === "/me" ? Response.json({ user_id: "../../root" }) : deps.api(path, init)) };
    expect(await openNotebook(P, badUser)).toEqual({ ok: false, error: "forbidden" });
  });

  it("copies PUBLIC and INTERNAL inputs only; lists CONTROLLED, SENSITIVE, lapsed and over-50-MiB inputs as skipped", async () => {
    const { deps, puts, reads } = harness({
      inputs: [input(1, "PUBLIC"), input(2, "INTERNAL"), input(3, "CONTROLLED"), input(4, "SENSITIVE"), input(5, "PUBLIC", { access_lapsed: true }), input(6, "INTERNAL")],
      versions: { v1: [file("_codebook.csv", 5), file("data/a.csv", 10)], v2: [file("b.parquet", 10)], v6: [file("big.csv", MAX_FILE_BYTES + 1)] },
    });
    const r = await openNotebook(P, deps);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.location).toBe(`/notebooks/lab/tree/work/${U}/${P}?token=tok`);
    expect(reads).toEqual(["data/a.csv", "b.parquet"]);
    expect(puts.filter((p) => p.includes("/data/"))).toEqual([`work/${U}/${P}/data/데이터 1_v1_a.csv`, `work/${U}/${P}/data/데이터 2_v1_b.parquet`]);
    expect(r.skipped.map((s) => [s.name, s.reason])).toEqual([
      ["데이터 3 v1", "접근 등급 CONTROLLED: 노트북으로 복사하지 않습니다"],
      ["데이터 4 v1", "접근 등급 SENSITIVE: 노트북으로 복사하지 않습니다"],
      ["데이터 5 v1", "접근 권한이 만료되었습니다"],
      ["데이터 6 v1", "파일이 50 MiB를 넘습니다 (50.0 MiB)"],
    ]);
    expect(puts.at(-1)).toBe(`work/${U}/${P}/README.md`);
  });

  it("skips a file Jupyter already holds with the same size, re-copies a changed one", async () => {
    const dir = `work/${U}/${P}/data`;
    const { deps, puts, reads } = harness({
      inputs: [input(1, "PUBLIC"), input(2, "PUBLIC")],
      versions: { v1: [file("a.csv", 10)], v2: [file("b.csv", 10)] },
      existing: { [`${dir}/데이터 1_v1_a.csv`]: 10, [`${dir}/데이터 2_v1_b.csv`]: 7 },
    });
    const r = await openNotebook(P, deps);
    expect(r.ok && r.copied).toEqual(["데이터 2_v1_b.csv"]);
    expect(reads).toEqual(["b.csv"]);
    expect(puts.filter((p) => p.startsWith(`${dir}/`))).toEqual([`${dir}/데이터 2_v1_b.csv`]);
  });

  it("stops copying when the 20 s budget runs out and lists the rest as '복사 중 건너뜀'", async () => {
    const clock = { t: 0, step: 4_000 }; // every API call costs 4 s
    const { deps, puts } = harness({ inputs: [input(1, "PUBLIC"), input(2, "PUBLIC"), input(3, "PUBLIC")], versions: { v1: [file("a.csv", 1)], v2: [file("b.csv", 1)], v3: [file("c.csv", 1)] }, clock });
    const r = await openNotebook(P, deps);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.copied.length).toBeLessThan(3);
    expect(r.skipped.length).toBeGreaterThan(0);
    expect(r.skipped.every((s) => s.reason === "복사 중 건너뜀")).toBe(true);
    expect(puts.at(-1)).toBe(`work/${U}/${P}/README.md`);
  });

  it("is unavailable when Jupyter is not configured or does not answer", async () => {
    const { deps } = harness({ inputs: [], versions: {} });
    expect(await openNotebook(P, { ...deps, jupyter: null })).toEqual({ ok: false, error: "unavailable" });
    expect(await openNotebook(P, { ...deps, fetch: (async () => new Response(null, { status: 502 })) as typeof fetch })).toEqual({ ok: false, error: "unavailable" });
  });
});

describe("readmeText", () => {
  it("names the project, the copied files and why others were skipped", () => {
    const text = readmeText("프로젝트\n이름", ["a.csv"], [{ name: "데이터 3 v1", reason: "복사 중 건너뜀" }], false, Date.UTC(2026, 9, 3, 1, 0));
    expect(text).toContain("# 프로젝트 이름");
    expect(text).toContain("- data/a.csv");
    expect(text).toContain("## 복사하지 않은 입력");
    expect(text).toContain("- 데이터 3 v1: 복사 중 건너뜀");
    expect(text).toContain("2026-10-03 10:00 (KST)");
  });
});
