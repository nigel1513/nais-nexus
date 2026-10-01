export function abortError(): Error {
  return new DOMException("Upload aborted", "AbortError");
}

export function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}
