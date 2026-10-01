import type { UploadSession } from "@/shared/api/types";
import { putWithProgress, runPool, uploadMultipart, withRetry, type PutPart, type Sleep } from "./transfer";

export type PreparedFile = { file: Blob; path: string; size: number; sha256: string; media_type: string };
export type CompleteParts = { file_id: string; etags: { part_number: number; etag: string }[] }[];

type Put = (url: string, body: Blob, headers: Record<string, string>, onProgress: (loaded: number) => void, signal?: AbortSignal) => Promise<{ etag: string | null }>;

/** Transfers every not-yet-uploaded file of the session, 3 files at a time (M10 §9.5). Abort via `signal`. */
export async function transferSession(
  session: UploadSession,
  prepared: PreparedFile[],
  deps: { put?: Put; putPart?: PutPart; onProgress?: (path: string, bytes: number) => void; sleep?: Sleep; signal?: AbortSignal } = {},
): Promise<CompleteParts> {
  const byPath = new Map(prepared.map((p) => [p.path, p]));
  const put: Put = deps.put ?? ((url, body, headers, onProgress, signal) => putWithProgress(url, body, headers, onProgress, undefined, signal));
  const parts: CompleteParts = [];
  const pending = session.files.filter((f) => f.status === "PENDING" || f.status === "FAILED");
  for (const f of pending) {
    if (!byPath.has(f.path)) throw new Error(`No local file for ${f.path}`);
    if (!f.upload) throw new Error(`No upload target for ${f.path}`);
  }
  const tasks = pending.map((f) => async () => {
    const local = byPath.get(f.path)!;
    const upload = f.upload!;
    if (upload.method === "PUT") {
      // Headers (Content-Type, x-amz-checksum-sha256) are part of the signature: pass them through untouched.
      await withRetry(() => put(upload.url, local.file, upload.headers ?? {}, (n) => deps.onProgress?.(f.path, n), deps.signal), { sleep: deps.sleep, signal: deps.signal });
      deps.onProgress?.(f.path, local.size);
    } else {
      const etags = await uploadMultipart(local.file, upload.parts, upload.part_size_bytes, {
        putPart: deps.putPart,
        onProgress: (n) => deps.onProgress?.(f.path, n),
        sleep: deps.sleep,
        signal: deps.signal,
      });
      parts.push({ file_id: f.file_id, etags });
    }
  });
  await runPool(tasks, 3, deps.signal);
  return parts;
}
