// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { hashFile } from "./hash-client";
import { HASH_CHUNK, sha256Stream } from "./sha256";

const ABC = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
const EMPTY = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

describe("streaming SHA-256", () => {
  it("matches the known digest of 'abc' and of the empty blob", async () => {
    expect(await sha256Stream(new Blob(["abc"]))).toBe(ABC);
    expect(await sha256Stream(new Blob([]))).toBe(EMPTY);
  });

  it("gives the same digest regardless of chunk size and reports progress", async () => {
    const blob = new Blob(["abcdefghij".repeat(1000)]);
    const whole = await sha256Stream(blob);
    const progress = vi.fn();
    expect(await sha256Stream(blob, progress, 7)).toBe(whole);
    expect(progress).toHaveBeenLastCalledWith(blob.size);
    expect(progress.mock.calls.length).toBe(Math.ceil(blob.size / 7));
  });

  it("reads only bounded windows via slice and never the whole blob (bounded memory)", async () => {
    expect(HASH_CHUNK).toBe(8 * 1024 * 1024);
    const blob = new Blob(["x".repeat(100)]);
    const sizes: number[] = [];
    const realSlice = blob.slice.bind(blob);
    const sliceSpy = vi.spyOn(blob, "slice").mockImplementation((s, e) => {
      const part = realSlice(s, e);
      sizes.push(part.size);
      return part;
    });
    const wholeRead = vi.spyOn(blob, "arrayBuffer");
    await sha256Stream(blob, undefined, 30);
    expect(sliceSpy).toHaveBeenCalledTimes(4);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(30);
    expect(wholeRead).not.toHaveBeenCalled();
  });

  it("stops when aborted", async () => {
    const ctl = new AbortController();
    const blob = new Blob(["x".repeat(100)]);
    await expect(sha256Stream(blob, () => ctl.abort(), 10, ctl.signal)).rejects.toThrow(/abort/i);
  });

  it("hashFile falls back to in-thread hashing where Worker is unavailable", async () => {
    expect(typeof Worker).toBe("undefined");
    expect(await hashFile(new Blob(["abc"]))).toBe(ABC);
  });
});
