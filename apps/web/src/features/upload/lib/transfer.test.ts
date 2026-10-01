import { describe, expect, it, vi } from "vitest";
import { HttpError, NetworkError, putWithProgress, runPool, uploadMultipart, withRetry, type XhrLike } from "./transfer";

describe("runPool", () => {
  it("never runs more than `concurrency` tasks at once and keeps result order", async () => {
    let active = 0;
    let peak = 0;
    const tasks = Array.from({ length: 10 }, (_, i) => async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active -= 1;
      return i;
    });
    expect(await runPool(tasks, 4)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(peak).toBe(4);
  });

  it("stops starting tasks after a failure and after abort", async () => {
    const started: number[] = [];
    const tasks = Array.from({ length: 6 }, (_, i) => async () => {
      started.push(i);
      if (i === 1) throw new Error("boom");
      await new Promise((r) => setTimeout(r, 5));
    });
    await expect(runPool(tasks, 2)).rejects.toThrow("boom");
    expect(started.length).toBeLessThan(6);

    const ctl = new AbortController();
    const ran: number[] = [];
    const more = Array.from({ length: 6 }, (_, i) => async () => {
      ran.push(i);
      ctl.abort();
    });
    await expect(runPool(more, 1, ctl.signal)).rejects.toThrow(/abort/i);
    expect(ran).toEqual([0]);
  });
});

describe("withRetry (3 retries, 1s/2s/4s backoff, idempotent failures only)", () => {
  it("retries with backoff then succeeds", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const fn = vi.fn().mockRejectedValueOnce(new NetworkError()).mockRejectedValueOnce(new NetworkError()).mockResolvedValue("ok");
    expect(await withRetry(fn, { sleep, random: () => 0.5 })).toBe("ok");
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([1000, 2000]);
  });

  it("gives up after the third retry", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const fn = vi.fn().mockRejectedValue(new NetworkError());
    await expect(withRetry(fn, { sleep, random: () => 0.5 })).rejects.toThrow("network error");
    expect(fn).toHaveBeenCalledTimes(4);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([1000, 2000, 4000]);
  });

  it("retries 5xx, 408 and 429 but never other 4xx (expired signature, checksum mismatch)", async () => {
    for (const status of [500, 503, 408, 429]) {
      const fn = vi.fn().mockRejectedValueOnce(new HttpError(status)).mockResolvedValue("ok");
      expect(await withRetry(fn, { sleep: async () => {} })).toBe("ok");
    }
    for (const status of [400, 403, 404, 412]) {
      const fn = vi.fn().mockRejectedValue(new HttpError(status));
      await expect(withRetry(fn, { sleep: async () => {} })).rejects.toThrow(String(status));
      expect(fn).toHaveBeenCalledTimes(1);
    }
  });

  it("does not retry after abort and rejects while sleeping", async () => {
    const ctl = new AbortController();
    const fn = vi.fn().mockRejectedValue(new NetworkError());
    const sleep = vi.fn(async () => ctl.abort());
    await expect(withRetry(fn, { sleep, signal: ctl.signal })).rejects.toThrow();
    expect(fn).toHaveBeenCalledTimes(1);
    const pre = new AbortController();
    pre.abort();
    const never = vi.fn().mockResolvedValue(1);
    await expect(withRetry(never, { signal: pre.signal })).rejects.toThrow(/abort/i);
    expect(never).not.toHaveBeenCalled();
  });
});

describe("retry policy details", () => {
  it("applies +-20% jitter to the delays", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const fn = vi.fn().mockRejectedValue(new NetworkError());
    await expect(withRetry(fn, { sleep, random: () => 0 })).rejects.toThrow();
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([800, 1600, 3200]);
    sleep.mockClear();
    await expect(withRetry(fn, { sleep, random: () => 1 })).rejects.toThrow();
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([1200, 2400, 4800]);
  });

  it("never retries arbitrary errors such as TypeError", async () => {
    const fn = vi.fn().mockRejectedValue(new TypeError("bug"));
    await expect(withRetry(fn, { sleep: async () => {} })).rejects.toThrow("bug");
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("uploadMultipart", () => {
  it("resets a part's progress when its attempt fails", async () => {
    const seen: number[] = [];
    let n = 0;
    const putPart = vi.fn(async (_u: string, body: Blob, onProgress: (n: number) => void) => {
      n += 1;
      if (n === 1) {
        onProgress(8);
        throw new NetworkError();
      }
      onProgress(body.size);
      return { etag: '"e"' };
    });
    await uploadMultipart(new Blob([new Uint8Array(10)]), [{ part_number: 1, url: "u" }], 10, { putPart, sleep: async () => {}, onProgress: (b) => seen.push(b) });
    expect(seen).toEqual([8, 0, 10, 10]);
  });

  it("fails fast when the part list does not match the file size or a slice would be empty", async () => {
    const putPart = vi.fn();
    const mk = (k: number) => Array.from({ length: k }, (_, i) => ({ part_number: i + 1, url: `u/${i}` }));
    await expect(uploadMultipart(new Blob([new Uint8Array(25)]), mk(2), 10, { putPart })).rejects.toThrow(/parts/);
    await expect(uploadMultipart(new Blob([new Uint8Array(25)]), mk(4), 10, { putPart })).rejects.toThrow(/parts/);
    const gap = [1, 3, 3].map((part_number) => ({ part_number, url: "u" }));
    await expect(uploadMultipart(new Blob([new Uint8Array(25)]), gap, 10, { putPart })).rejects.toThrow(/part/);
    expect(putPart).not.toHaveBeenCalled();
  });

  it("uploads slices, retries a failed part and returns ETags ordered by part number", async () => {
    const file = new Blob([new Uint8Array(25)]);
    const bodies: Record<number, number> = {};
    let failedOnce = false;
    const putPart = vi.fn(async (url: string, body: Blob, onProgress: (n: number) => void) => {
      const n = Number(url.split("/").pop());
      if (n === 2 && !failedOnce) {
        failedOnce = true;
        throw new NetworkError();
      }
      bodies[n] = body.size;
      onProgress(body.size);
      return { etag: `"e${n}"` };
    });
    const progress = vi.fn();
    const parts = [3, 1, 2].map((n) => ({ part_number: n, url: `http://x/part/${n}` }));
    const etags = await uploadMultipart(file, parts, 10, { putPart, onProgress: progress, sleep: async () => {} });
    expect(etags).toEqual([
      { part_number: 1, etag: '"e1"' },
      { part_number: 2, etag: '"e2"' },
      { part_number: 3, etag: '"e3"' },
    ]);
    expect(bodies).toEqual({ 1: 10, 2: 10, 3: 5 });
    expect(progress).toHaveBeenLastCalledWith(25);
  });

  it("runs at most 4 parts at a time", async () => {
    let active = 0;
    let peak = 0;
    const putPart = vi.fn(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 3));
      active -= 1;
      return { etag: '"e"' };
    });
    const parts = Array.from({ length: 12 }, (_, i) => ({ part_number: i + 1, url: `u/${i + 1}` }));
    await uploadMultipart(new Blob([new Uint8Array(120)]), parts, 10, { putPart, sleep: async () => {} });
    expect(peak).toBe(4);
  });

  it("fails when storage does not expose the ETag", async () => {
    const putPart = vi.fn().mockResolvedValue({ etag: null });
    await expect(uploadMultipart(new Blob(["abc"]), [{ part_number: 1, url: "u" }], 10, { putPart, sleep: async () => {} })).rejects.toThrow("ETag");
    expect(putPart).toHaveBeenCalledTimes(1);
  });

  it("errors never contain the presigned URL", async () => {
    const putPart = vi.fn().mockRejectedValue(new HttpError(403));
    const err = await uploadMultipart(new Blob(["abc"]), [{ part_number: 1, url: "http://secret.example/sig?X-Amz-Signature=abc" }], 10, { putPart, sleep: async () => {} }).catch((e: Error) => e);
    expect(String(err)).not.toContain("secret.example");
    expect(String(err)).not.toContain("Signature");
  });
});

describe("putWithProgress", () => {
  type FakeXhr = Omit<XhrLike, "abort" | "open"> & { sent?: unknown; headers: Record<string, string>; abort: ReturnType<typeof vi.fn>; open: ReturnType<typeof vi.fn> };
  function fakeXhr(status: number, etag: string | null): FakeXhr {
    const xhr: FakeXhr = {
      headers: {},
      status,
      upload: { onprogress: null },
      onload: null,
      onerror: null,
      onabort: null,
      abort: vi.fn(() => xhr.onabort?.()),
      open: vi.fn(),
      setRequestHeader(k: string, v: string) {
        xhr.headers[k] = v;
      },
      send(body: unknown) {
        xhr.sent = body;
        xhr.upload.onprogress?.({ loaded: 3 } as ProgressEvent);
        xhr.onload?.();
      },
      getResponseHeader: () => etag,
    };
    return xhr;
  }

  it("PUTs with exactly the signed headers, reports progress and returns the ETag", async () => {
    const xhr = fakeXhr(200, '"abc"');
    const progress = vi.fn();
    const signed = { "Content-Type": "text/csv", "x-amz-checksum-sha256": "q83vEjRWeJA=" };
    const out = await putWithProgress("http://x/u", new Blob(["abc"]), signed, progress, () => xhr);
    expect(out).toEqual({ etag: '"abc"' });
    expect(xhr.open).toHaveBeenCalledWith("PUT", "http://x/u");
    expect(xhr.headers).toEqual(signed);
    expect(progress).toHaveBeenCalledWith(3);
  });

  it("rejects non-2xx with an HttpError that omits the URL", async () => {
    const err = await putWithProgress("http://x/u?sig=1", new Blob(["a"]), {}, undefined, () => fakeXhr(403, null)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(403);
    expect(String(err)).toContain("403");
    expect(String(err)).not.toContain("sig=1");
  });

  it("aborts the in-flight request when the signal fires", async () => {
    const ctl = new AbortController();
    const xhr = fakeXhr(200, null);
    xhr.send = function () {
      ctl.abort();
    };
    await expect(putWithProgress("http://x/u", new Blob(["a"]), {}, undefined, () => xhr, ctl.signal)).rejects.toThrow(/abort/i);
    expect(xhr.abort).toHaveBeenCalled();
  });
});
