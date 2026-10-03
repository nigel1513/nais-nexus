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

  it("rejects a body without the required fields", async () => {
    expect((await post({ ...body, cells: undefined })).status).toBe(400);
  });

  it.each(["disabled", ""])("is a 404 when the mock flag is %j", async (flag) => {
    vi.stubEnv("NEXT_PUBLIC_API_MOCKING", flag);
    expect((await post(body)).status).toBe(404);
    expect(listNotebookActivity(body.user_id, body.project_id, body.day)).toEqual([]);
  });
});
