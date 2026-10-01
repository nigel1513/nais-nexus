import { afterEach, describe, expect, it, vi } from "vitest";
import { GET, PUT } from "./route";

const url = "http://localhost:3000/mock-storage/nais-inst-a/uploads/0000";

describe("/mock-storage route (stand-in for presigned object-store URLs)", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("PUT returns 200 with an ETag, GET returns a small text attachment", async () => {
    const put = await PUT(new Request(url, { method: "PUT", body: "bytes" }));
    expect(put.status).toBe(200);
    expect(put.headers.get("ETag")).toMatch(/^"mock-etag-\d+"$/);
    const get = await GET(new Request(`${url}/1`));
    expect(get.status).toBe(200);
    expect(get.headers.get("Content-Disposition")).toContain("attachment");
    expect(await get.text()).toContain("NAIS mock file");
  });

  it.each(["disabled", ""])("is a 404 when the mock flag is %j", async (flag) => {
    vi.stubEnv("NEXT_PUBLIC_API_MOCKING", flag);
    expect((await PUT(new Request(url, { method: "PUT", body: "x" }))).status).toBe(404);
    expect((await GET(new Request(url))).status).toBe(404);
  });
});
