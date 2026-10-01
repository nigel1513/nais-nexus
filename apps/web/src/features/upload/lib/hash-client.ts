import { abortError, throwIfAborted } from "./abort";
import { sha256Stream } from "./sha256";

type Pending = { resolve: (hex: string) => void; reject: (error: Error) => void; onProgress?: (bytes: number) => void };
type Reply = { id: number; bytes?: number; hex?: string; error?: string };

let worker: Worker | null = null;
let seq = 0;
const pending = new Map<number, Pending>();

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL("./hash.worker.ts", import.meta.url));
    worker.onmessage = (event: MessageEvent<Reply>) => {
      const p = pending.get(event.data.id);
      if (!p) return;
      if (event.data.hex) {
        pending.delete(event.data.id);
        p.resolve(event.data.hex);
      } else if (event.data.error) {
        pending.delete(event.data.id);
        p.reject(new Error(event.data.error));
      } else if (event.data.bytes !== undefined) p.onProgress?.(event.data.bytes);
    };
  }
  return worker;
}

/** SHA-256 off the UI thread; in environments without Worker (unit tests) it hashes in-thread with the same code. */
export function hashFile(file: Blob, onProgress?: (bytes: number) => void, signal?: AbortSignal): Promise<string> {
  if (typeof Worker === "undefined") return sha256Stream(file, onProgress, undefined, signal);
  return new Promise((resolve, reject) => {
    try {
      throwIfAborted(signal);
    } catch (error) {
      reject(error);
      return;
    }
    const id = ++seq;
    const w = getWorker();
    const onAbort = () => {
      if (!pending.delete(id)) return;
      w.postMessage({ id, cancel: true });
      reject(abortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    const done = () => signal?.removeEventListener("abort", onAbort);
    pending.set(id, {
      resolve: (hex) => (done(), resolve(hex)),
      reject: (error) => (done(), reject(error)),
      onProgress,
    });
    w.postMessage({ id, file });
  });
}
