// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ABC = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

type Behaviour = (w: FakeWorker, msg: { id: number; cancel?: boolean }) => void;
class FakeWorker {
  static instances: FakeWorker[] = [];
  static behaviour: Behaviour = () => {};
  static failConstruct = false;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessageerror: (() => void) | null = null;
  terminate = vi.fn();
  constructor() {
    if (FakeWorker.failConstruct) throw new Error("no worker");
    FakeWorker.instances.push(this);
  }
  postMessage(msg: { id: number; cancel?: boolean }) {
    FakeWorker.behaviour(this, msg);
  }
}

async function load() {
  vi.resetModules();
  return (await import("./hash-client")).hashFile;
}

beforeEach(() => {
  FakeWorker.instances = [];
  FakeWorker.failConstruct = false;
  FakeWorker.behaviour = () => {};
  vi.stubGlobal("Worker", FakeWorker);
});
afterEach(() => vi.unstubAllGlobals());

describe("hashFile worker lifecycle", () => {
  it("falls back in-thread when the Worker cannot be constructed", async () => {
    FakeWorker.failConstruct = true;
    const hashFile = await load();
    expect(await hashFile(new Blob(["abc"]))).toBe(ABC);
  });

  it("falls back in-thread when the worker errors mid-hash, and uses a fresh worker next time", async () => {
    FakeWorker.behaviour = (w, m) => {
      if (!m.cancel) queueMicrotask(() => w.onerror?.());
    };
    const hashFile = await load();
    expect(await hashFile(new Blob(["abc"]))).toBe(ABC);
    expect(FakeWorker.instances[0]!.terminate).toHaveBeenCalled();
    FakeWorker.behaviour = (w, m) => queueMicrotask(() => w.onmessage?.({ data: { id: m.id, hex: "ok" } }));
    expect(await hashFile(new Blob(["abc"]))).toBe("ok");
    expect(FakeWorker.instances).toHaveLength(2);
  });

  it("falls back on messageerror too", async () => {
    FakeWorker.behaviour = (w) => queueMicrotask(() => w.onmessageerror?.());
    const hashFile = await load();
    expect(await hashFile(new Blob(["abc"]))).toBe(ABC);
  });

  it("terminates the worker when the batch is done and recreates it lazily", async () => {
    FakeWorker.behaviour = (w, m) => queueMicrotask(() => w.onmessage?.({ data: { id: m.id, hex: "h" } }));
    const hashFile = await load();
    expect(await Promise.all([hashFile(new Blob(["a"])), hashFile(new Blob(["b"]))])).toEqual(["h", "h"]);
    expect(FakeWorker.instances).toHaveLength(1);
    expect(FakeWorker.instances[0]!.terminate).toHaveBeenCalledTimes(1);
    await hashFile(new Blob(["c"]));
    expect(FakeWorker.instances).toHaveLength(2);
  });

  it("abort rejects without a stale pending entry and releases the worker", async () => {
    const hashFile = await load();
    const ctl = new AbortController();
    const p = hashFile(new Blob(["abc"]), undefined, ctl.signal);
    ctl.abort();
    await expect(p).rejects.toThrow(/abort/i);
    expect(FakeWorker.instances[0]!.terminate).toHaveBeenCalled();
  });
});
