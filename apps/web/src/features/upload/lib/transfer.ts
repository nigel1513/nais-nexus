import { abortError, isAbort, throwIfAborted } from "./abort";

export type Sleep = (ms: number) => Promise<void>;
const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Part retry policy (M10 §9.5): 3 retries with 1s/2s/4s backoff. */
export const RETRY_DELAYS = [1000, 2000, 4000];

/** Non-2xx storage reply. The message carries only the status — never the presigned URL. */
export class HttpError extends Error {
  constructor(readonly status: number) {
    super(`PUT failed: ${status}`);
    this.name = "HttpError";
  }
}

/**
 * Presigned PUTs are idempotent, so transient failures are safe to repeat: network errors, 408, 429, 5xx.
 * Other 4xx (expired/invalid signature, checksum mismatch) will fail identically and are surfaced at once.
 */
export function isRetryable(error: unknown): boolean {
  if (isAbort(error)) return false;
  if (error instanceof HttpError) return error.status === 408 || error.status === 429 || error.status >= 500;
  return true;
}

type RetryOptions = { delays?: number[]; sleep?: Sleep; signal?: AbortSignal; shouldRetry?: (error: unknown) => boolean };

function abortable(promise: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

export async function withRetry<T>(fn: () => Promise<T>, { delays = RETRY_DELAYS, sleep = realSleep, signal, shouldRetry = isRetryable }: RetryOptions = {}): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    throwIfAborted(signal);
    try {
      return await fn();
    } catch (error) {
      if (signal?.aborted || attempt >= delays.length || !shouldRetry(error)) throw error;
      await abortable(sleep(delays[attempt]!), signal);
    }
  }
}

export async function runPool<T>(tasks: (() => Promise<T>)[], concurrency: number, signal?: AbortSignal): Promise<T[]> {
  const results = new Array<T>(tasks.length);
  let next = 0;
  let failed = false;
  const lanes = Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
    while (!failed && next < tasks.length) {
      throwIfAborted(signal);
      const index = next;
      next += 1;
      try {
        results[index] = await tasks[index]!();
      } catch (error) {
        failed = true;
        throw error;
      }
    }
    throwIfAborted(signal);
  });
  await Promise.all(lanes);
  return results;
}

export type XhrLike = {
  open: (method: string, url: string) => void;
  setRequestHeader: (name: string, value: string) => void;
  send: (body: Blob) => void;
  abort?: () => void;
  getResponseHeader: (name: string) => string | null;
  status: number;
  upload: { onprogress: ((event: ProgressEvent) => void) | null };
  onload: (() => void) | null;
  onerror: (() => void) | null;
  onabort?: (() => void) | null;
};

/**
 * XMLHttpRequest PUT (fetch has no upload progress). Same origin (21051), so the ETag header is readable without CORS.
 * `headers` are set verbatim: they are part of the presigned signature (Content-Type, x-amz-checksum-sha256).
 */
export function putWithProgress(
  url: string,
  body: Blob,
  headers: Record<string, string> = {},
  onProgress?: (loaded: number) => void,
  makeXhr: () => XhrLike = () => new XMLHttpRequest() as unknown as XhrLike,
  signal?: AbortSignal,
): Promise<{ etag: string | null }> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const xhr = makeXhr();
    const onAbort = () => xhr.abort?.();
    const settle = () => signal?.removeEventListener("abort", onAbort);
    xhr.open("PUT", url);
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (event) => onProgress?.(event.loaded);
    xhr.onload = () => {
      settle();
      if (xhr.status >= 200 && xhr.status < 300) resolve({ etag: xhr.getResponseHeader("ETag") });
      else reject(new HttpError(xhr.status));
    };
    xhr.onerror = () => {
      settle();
      reject(new Error("network error"));
    };
    xhr.onabort = () => {
      settle();
      reject(abortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    xhr.send(body);
  });
}

export type PutPart = (url: string, body: Blob, onProgress: (loaded: number) => void, signal?: AbortSignal) => Promise<{ etag: string | null }>;

export async function uploadMultipart(
  file: Blob,
  parts: { part_number: number; url: string }[],
  partSize: number,
  opts: { putPart?: PutPart; concurrency?: number; onProgress?: (bytes: number) => void; sleep?: Sleep; signal?: AbortSignal } = {},
): Promise<{ part_number: number; etag: string }[]> {
  const put: PutPart = opts.putPart ?? ((url, body, onProgress, signal) => putWithProgress(url, body, {}, onProgress, undefined, signal));
  const loaded = new Map<number, number>();
  const report = () => opts.onProgress?.([...loaded.values()].reduce((a, b) => a + b, 0));
  const tasks = parts.map((part) => async () => {
    const start = (part.part_number - 1) * partSize;
    const body = file.slice(start, Math.min(start + partSize, file.size));
    const { etag } = await withRetry(
      () =>
        put(
          part.url,
          body,
          (n) => {
            loaded.set(part.part_number, n);
            report();
          },
          opts.signal,
        ),
      { sleep: opts.sleep, signal: opts.signal },
    );
    if (!etag) throw new Error(`Storage did not return an ETag for part ${part.part_number}`);
    loaded.set(part.part_number, body.size);
    report();
    return { part_number: part.part_number, etag };
  });
  const out = await runPool(tasks, opts.concurrency ?? 4, opts.signal);
  return out.sort((a, b) => a.part_number - b.part_number);
}
