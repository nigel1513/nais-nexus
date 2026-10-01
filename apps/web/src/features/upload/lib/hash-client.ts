import { abortError, isAbort, throwIfAborted } from "./abort";
import { sha256Stream } from "./sha256";

type Pending = { resolve: (hex: string) => void; reject: (error: Error) => void; onProgress?: (bytes: number) => void };
type Reply = { id: number; bytes?: number; hex?: string; error?: string };

/** Infrastructure failure of the Worker itself (not a hashing/abort result): callers fall back to in-thread hashing. */
class WorkerFailure extends Error {}

let worker: Worker | null = null;
let seq = 0;
const pending = new Map<number, Pending>();

function dropWorker(): void {
  const w = worker;
  worker = null;
  w?.terminate();
}

function failAll(message: string): void {
  const all = [...pending.values()];
  pending.clear();
  dropWorker();
  for (const p of all) p.reject(new WorkerFailure(message));
}

/** Release the Worker once the batch is done; the next hashFile call creates it again. */
function releaseIfIdle(): void {
  if (pending.size === 0) dropWorker();
}

function getWorker(): Worker {
  if (!worker) {
    const w = new Worker(new URL("./hash.worker.ts", import.meta.url));
    w.onmessage = (event: MessageEvent<Reply>) => {
      const p = pending.get(event.data.id);
      if (!p) return;
      if (event.data.hex) {
        pending.delete(event.data.id);
        p.resolve(event.data.hex);
        releaseIfIdle();
      } else if (event.data.error) {
        pending.delete(event.data.id);
        p.reject(new Error(event.data.error));
        releaseIfIdle();
      } else if (event.data.bytes !== undefined) p.onProgress?.(event.data.bytes);
    };
    w.onerror = () => failAll("hash worker failed");
    w.onmessageerror = () => failAll("hash worker message error");
    worker = w;
  }
  return worker;
}

function hashInWorker(file: Blob, onProgress?: (bytes: number) => void, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    throwIfAborted(signal);
    let w: Worker;
    try {
      w = getWorker();
    } catch {
      throw new WorkerFailure("hash worker unavailable");
    }
    const id = ++seq;
    const onAbort = () => {
      if (!pending.delete(id)) return;
      w.postMessage({ id, cancel: true });
      reject(abortError());
      releaseIfIdle();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    const done = () => signal?.removeEventListener("abort", onAbort);
    pending.set(id, {
      resolve: (hex) => (done(), resolve(hex)),
      reject: (error) => (done(), reject(error)),
      onProgress,
    });
    try {
      w.postMessage({ id, file });
    } catch {
      pending.delete(id);
      done();
      releaseIfIdle();
      throw new WorkerFailure("hash worker unavailable");
    }
  });
}

/** SHA-256 off the UI thread; without a (working) Worker it hashes in-thread with the same code. */
export async function hashFile(file: Blob, onProgress?: (bytes: number) => void, signal?: AbortSignal): Promise<string> {
  if (typeof Worker === "undefined") return sha256Stream(file, onProgress, undefined, signal);
  try {
    return await hashInWorker(file, onProgress, signal);
  } catch (error) {
    if (!(error instanceof WorkerFailure) || isAbort(error)) throw error;
    return sha256Stream(file, onProgress, undefined, signal);
  }
}
