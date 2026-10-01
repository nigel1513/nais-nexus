import { createSHA256 } from "hash-wasm";
import { throwIfAborted } from "./abort";

/** 8 MiB windows: memory stays constant regardless of file size (M10 §9.3, AT-05). */
export const HASH_CHUNK = 8 * 1024 * 1024;

/** Blob.arrayBuffer where available, FileReader otherwise (older engines / jsdom). Only ever called on a bounded slice. */
function readChunk(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === "function") return blob.arrayBuffer();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
}

export async function sha256Stream(blob: Blob, onProgress?: (bytes: number) => void, chunkSize: number = HASH_CHUNK, signal?: AbortSignal): Promise<string> {
  if (!(chunkSize > 0)) throw new Error("chunk size must be positive");
  throwIfAborted(signal);
  const hasher = await createSHA256();
  hasher.init();
  for (let offset = 0; offset < blob.size; offset += chunkSize) {
    throwIfAborted(signal);
    const chunk = new Uint8Array(await readChunk(blob.slice(offset, offset + chunkSize)));
    hasher.update(chunk);
    onProgress?.(Math.min(offset + chunkSize, blob.size));
  }
  throwIfAborted(signal);
  return hasher.digest("hex");
}
