import { describe, expect, it, vi } from "vitest";
import type { UploadSession } from "@/shared/api/types";
import { transferSession, type PreparedFile } from "./run-upload";

const session = (): UploadSession => ({
  upload_session_id: "s",
  dataset_version_id: "v",
  status: "OPEN",
  expires_at: "2099-01-01T00:00:00Z",
  files: [
    { file_id: "f1", path: "a.csv", status: "PENDING", upload: { method: "PUT", url: "http://x/a", headers: { "Content-Type": "text/csv", "x-amz-checksum-sha256": "abc=" } } },
    {
      file_id: "f2",
      path: "big.bin",
      status: "PENDING",
      upload: { method: "MULTIPART", part_size_bytes: 4, parts: [{ part_number: 1, url: "http://x/b/1" }, { part_number: 2, url: "http://x/b/2" }] },
    },
    { file_id: "f3", path: "done.csv", status: "VERIFIED", upload: { method: "PUT", url: "http://x/done" } },
  ],
});

const prepared = (): PreparedFile[] => [
  { file: new Blob(["1,2\n"]), path: "a.csv", size: 4, sha256: "a".repeat(64), media_type: "text/csv" },
  { file: new Blob(["12345678"]), path: "big.bin", size: 8, sha256: "b".repeat(64), media_type: "application/octet-stream" },
];

describe("transferSession", () => {
  it("PUTs small files with the signed headers, multipart-uploads large ones and returns parts for complete", async () => {
    const p = prepared();
    const put = vi.fn().mockResolvedValue({ etag: '"x"' });
    const putPart = vi.fn(async (url: string) => ({ etag: `"${url.slice(-1)}"` }));
    const progress = vi.fn();
    const parts = await transferSession(session(), p, { put, putPart, onProgress: progress, sleep: async () => {} });
    expect(put).toHaveBeenCalledTimes(1);
    expect(put.mock.calls[0]!.slice(0, 3)).toEqual(["http://x/a", p[0]!.file, { "Content-Type": "text/csv", "x-amz-checksum-sha256": "abc=" }]);
    expect(parts).toEqual([{ file_id: "f2", etags: [{ part_number: 1, etag: '"1"' }, { part_number: 2, etag: '"2"' }] }]);
    expect(progress).toHaveBeenCalledWith("a.csv", 4);
    expect(progress).toHaveBeenCalledWith("big.bin", 8);
  });

  it("retries a flaky PUT but not a 403", async () => {
    const { HttpError } = await import("./transfer");
    const flaky = vi.fn().mockRejectedValueOnce(new HttpError(503)).mockResolvedValue({ etag: null });
    const s = session();
    s.files = [s.files[0]!];
    await transferSession(s, prepared(), { put: flaky, sleep: async () => {} });
    expect(flaky).toHaveBeenCalledTimes(2);

    const denied = vi.fn().mockRejectedValue(new HttpError(403));
    await expect(transferSession(s, prepared(), { put: denied, sleep: async () => {} })).rejects.toThrow("403");
    expect(denied).toHaveBeenCalledTimes(1);
  });

  it("transfers re-tried FAILED files and skips UPLOADED/VERIFIED ones", async () => {
    const s = session();
    s.files = [
      { ...s.files[0]!, status: "FAILED" },
      { ...s.files[2]!, status: "UPLOADED" },
    ];
    const put = vi.fn().mockResolvedValue({ etag: null });
    await transferSession(s, prepared(), { put, sleep: async () => {} });
    expect(put).toHaveBeenCalledTimes(1);
  });

  it("runs at most 3 files at a time", async () => {
    const s = session();
    s.files = Array.from({ length: 8 }, (_, i) => ({
      file_id: `f${i}`,
      path: `a${i}.csv`,
      status: "PENDING" as const,
      upload: { method: "PUT" as const, url: `http://x/${i}` },
    }));
    const prep = s.files.map((f) => ({ file: new Blob(["x"]), path: f.path, size: 1, sha256: "a".repeat(64), media_type: "text/csv" }));
    let active = 0;
    let peak = 0;
    const put = vi.fn(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 3));
      active -= 1;
      return { etag: null };
    });
    await transferSession(s, prep, { put, sleep: async () => {} });
    expect(peak).toBe(3);
  });

  it("fails clearly when a pending file has no target or no local file", async () => {
    const s = session();
    s.files = [{ file_id: "f9", path: "zzz.csv", status: "PENDING" }];
    await expect(transferSession(s, prepared(), {})).rejects.toThrow(/zzz\.csv/);
    const s2 = session();
    await expect(transferSession(s2, [], { put: vi.fn() })).rejects.toThrow(/a\.csv/);
  });

  it("cancels: abort stops pending work and propagates the signal", async () => {
    const ctl = new AbortController();
    const s = session();
    s.files = Array.from({ length: 6 }, (_, i) => ({ file_id: `f${i}`, path: `a${i}.csv`, status: "PENDING" as const, upload: { method: "PUT" as const, url: `http://x/${i}` } }));
    const prep = s.files.map((f) => ({ file: new Blob(["x"]), path: f.path, size: 1, sha256: "a".repeat(64), media_type: "text/csv" }));
    const put = vi.fn(async (_u: string, _b: Blob, _h: Record<string, string>, _p: (n: number) => void, signal?: AbortSignal) => {
      expect(signal).toBe(ctl.signal);
      ctl.abort();
      return { etag: null };
    });
    await expect(transferSession(s, prep, { put, signal: ctl.signal, sleep: async () => {} })).rejects.toThrow(/abort/i);
    expect(put.mock.calls.length).toBeLessThanOrEqual(3);
  });
});
