import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { server } from "../../../tests/msw";
import { PROJECT, USER } from "@/mocks/fixtures";
import { GET } from "./route";

const JUPYTER = "http://notebook.test/notebooks";
const TOKEN = "jupyter-secret";

/** A fake Jupyter contents API over an in-memory tree (path → directory or file bytes). */
function fakeJupyter() {
  const tree = new Map<string, { type: "directory" } | { type: "file"; data: Buffer }>([["work", { type: "directory" }]]);
  const puts: string[] = [];
  const pathOf = (url: string) => decodeURIComponent(new URL(url).pathname.replace("/notebooks/api/contents/", ""));
  const authorized = (request: Request) => request.headers.get("authorization") === `token ${TOKEN}`;
  server.use(
    http.get(`${JUPYTER}/api/contents/*`, ({ request }) => {
      if (!authorized(request)) return new HttpResponse(null, { status: 403 });
      const node = tree.get(pathOf(request.url));
      if (!node) return HttpResponse.json({ message: "No such file" }, { status: 404 });
      return HttpResponse.json({ type: node.type, size: node.type === "file" ? node.data.byteLength : null, last_modified: "2026-10-03T00:00:00Z" });
    }),
    http.put(`${JUPYTER}/api/contents/*`, async ({ request }) => {
      if (!authorized(request)) return new HttpResponse(null, { status: 403 });
      const path = pathOf(request.url);
      const parent = path.split("/").slice(0, -1).join("/");
      if (tree.get(parent)?.type !== "directory") return HttpResponse.json({ message: "parent missing" }, { status: 404 });
      const model = (await request.json()) as { type: string; format?: string; content?: string };
      puts.push(path);
      if (model.type === "directory") tree.set(path, { type: "directory" });
      else tree.set(path, { type: "file", data: Buffer.from(model.content ?? "", model.format === "base64" ? "base64" : "utf8") });
      return HttpResponse.json({ type: model.type }, { status: 201 });
    }),
  );
  return { tree, puts };
}

const open = (project: string | null, { user = USER.aResearcher as string | null, referer }: { user?: string | null; referer?: string } = {}) =>
  GET(
    new Request(`http://localhost:3000/notebooks-open${project === null ? "" : `?project=${project}`}`, {
      headers: { ...(user ? { cookie: `nais_mock_user=${user}` } : {}), ...(referer ? { referer } : {}) },
    }),
  );

const folder = `work/${USER.aResearcher}/${PROJECT.seed}`;

describe("GET /notebooks-open (mock mode)", () => {
  beforeEach(() => {
    vi.stubEnv("NAIS_JUPYTER_URL", JUPYTER);
    vi.stubEnv("NAIS_JUPYTER_TOKEN", TOKEN);
  });
  afterEach(() => vi.unstubAllEnvs());

  it("creates the folder, copies the PUBLIC input's primary table, writes README.md and redirects into JupyterLab", async () => {
    const { tree } = fakeJupyter();
    const res = await open(PROJECT.seed);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`/notebooks/lab/tree/${folder}?token=${TOKEN}`);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(tree.get(`work/${USER.aResearcher}`)?.type).toBe("directory");
    expect(tree.get(`${folder}/data`)?.type).toBe("directory");
    const files = [...tree.keys()].filter((k) => k.startsWith(`${folder}/data/`));
    expect(files).toHaveLength(1); // the CONTROLLED battery input is not copied; "_" files never are
    expect(files[0]).toMatch(/구조용 세라믹·초내열합금 물성 DB_.*_measurements\.csv$/);
    const csv = (tree.get(files[0]!) as { data: Buffer }).data.toString("utf8");
    expect(csv.split("\n")[0]).toContain(",");
    const readme = (tree.get(`${folder}/README.md`) as { data: Buffer }).data.toString("utf8");
    expect(readme).toContain("# 차세대 이차전지 소재 공동연구");
    expect(readme).toContain("리튬이온 배터리 셀 사이클 시험 데이터");
    expect(readme).toContain("접근 등급 CONTROLLED");
    expect(readme).not.toContain(TOKEN);
  });

  it("does not upload an unchanged file again (same size)", async () => {
    const { puts } = fakeJupyter();
    await open(PROJECT.seed);
    const first = puts.filter((p) => p.startsWith(`${folder}/data`)).length;
    expect(first).toBe(2); // the data/ folder and one file
    puts.length = 0;
    expect((await open(PROJECT.seed)).status).toBe(302);
    expect(puts).toEqual([`${folder}/README.md`]);
  });

  it("refuses non-UUID projects and non-members (forbidden), back to the calling page", async () => {
    fakeJupyter();
    expect((await open("../../etc")).headers.get("location")).toBe("/commons/notebooks?notebook_error=forbidden");
    expect((await open(null)).headers.get("location")).toBe("/commons/notebooks?notebook_error=forbidden");
    const outsider = await open(PROJECT.seed, { user: USER.aSteward, referer: `http://localhost:3000/commons/projects/${PROJECT.seed}?x=1&notebook_error=unavailable` });
    expect(outsider.headers.get("location")).toBe(`/commons/projects/${PROJECT.seed}?x=1&notebook_error=forbidden`);
    // A Referer outside /commons (or another origin) is never followed.
    expect((await open(PROJECT.seed, { user: USER.aSteward, referer: "http://evil.test/phish" })).headers.get("location")).toBe("/commons/notebooks?notebook_error=forbidden");
  });

  it("sends a caller without a session to the notebooks screen (which asks for a login)", async () => {
    fakeJupyter();
    expect((await open(PROJECT.seed, { user: null })).headers.get("location")).toBe("/commons/notebooks");
  });

  it("answers unavailable when Jupyter is not configured, down or rejects the token", async () => {
    vi.stubEnv("NAIS_JUPYTER_TOKEN", "");
    expect((await open(PROJECT.seed)).headers.get("location")).toBe("/commons/notebooks?notebook_error=unavailable");
    vi.stubEnv("NAIS_JUPYTER_TOKEN", TOKEN);
    server.use(http.all(`${JUPYTER}/*`, () => HttpResponse.error()));
    expect((await open(PROJECT.seed)).headers.get("location")).toBe("/commons/notebooks?notebook_error=unavailable");
    server.resetHandlers();
    fakeJupyter();
    vi.stubEnv("NAIS_JUPYTER_TOKEN", "wrong");
    expect((await open(PROJECT.seed)).headers.get("location")).toBe("/commons/notebooks?notebook_error=unavailable");
  });
});
