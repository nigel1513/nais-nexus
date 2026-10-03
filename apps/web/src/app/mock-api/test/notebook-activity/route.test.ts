import { afterEach, describe, expect, it, vi } from "vitest";
import { listNotebookActivity } from "@/mocks/notebook-activity";
import { POST } from "./route";

const url = "http://localhost:3000/mock-api/test/notebook-activity";
const body = {
  user_id: "00000000-0000-7000-8000-000000000a02",
  project_id: "00000000-0000-7000-8000-000000001001",
  day: "2026-10-03",
  title: "45도 사이클 용량 분석",
  cells: [{ type: "markdown", source_head: "# 목표", output_kinds: [], output_count: 0, has_error: false }],
};
const post = (b: unknown) => POST(new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }));

describe("/mock-api/test/notebook-activity (mock-only e2e hook)", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("seeds a saved notebook into the NotebookActivityPort stand-in", async () => {
    const res = await post(body);
    expect(res.status).toBe(201);
    const seeded = await res.json();
    expect(seeded).toMatchObject({ title: body.title, notebook_id: expect.any(String), version_id: expect.any(String), saved_at: expect.any(String) });
    expect(listNotebookActivity(body.user_id, body.project_id, body.day).map((n) => n.notebook_id)).toEqual([seeded.notebook_id]);
  });

  it("seeds an array of notebooks in one call", async () => {
    const res = await post([body, { ...body, title: "두 번째 노트북" }]);
    expect(res.status).toBe(201);
    expect((await res.json()).map((n: { title: string }) => n.title)).toEqual([body.title, "두 번째 노트북"]);
    expect(listNotebookActivity(body.user_id, body.project_id, body.day)).toHaveLength(2);
  });

  it.each([
    ["no cells", { ...body, cells: undefined }],
    ["cells not an array", { ...body, cells: "x" }],
    ["a cell of an unknown type", { ...body, cells: [{ ...body.cells[0], type: "raw" }] }],
    ["a cell without output_kinds", { ...body, cells: [{ ...body.cells[0], output_kinds: undefined }] }],
    ["a negative output_count", { ...body, cells: [{ ...body.cells[0], output_count: -1 }] }],
    ["has_error not a boolean", { ...body, cells: [{ ...body.cells[0], has_error: "no" }] }],
    ["a malformed day", { ...body, day: "03/10/2026" }],
    ["an empty array", []],
    ["an array with a bad item", [body, { ...body, title: 3 }]],
    ["not an object", "notebook"],
  ])("rejects %s with 400 and seeds nothing", async (_, bad) => {
    expect((await post(bad)).status).toBe(400);
    expect(listNotebookActivity(body.user_id, body.project_id, body.day)).toEqual([]);
  });

  it("rejects a body that is not JSON", async () => {
    const res = await POST(new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: "{" }));
    expect(res.status).toBe(400);
  });

  it.each(["disabled", ""])("is a 404 when the mock flag is %j", async (flag) => {
    vi.stubEnv("NEXT_PUBLIC_API_MOCKING", flag);
    expect((await post(body)).status).toBe(404);
    expect(listNotebookActivity(body.user_id, body.project_id, body.day)).toEqual([]);
  });
});
