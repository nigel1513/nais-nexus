import { sha256Stream } from "./sha256";

type Request = { id: number; file: Blob } | { id: number; cancel: true };
const ctx = globalThis as unknown as {
  onmessage: ((event: MessageEvent<Request>) => void) | null;
  postMessage: (message: unknown) => void;
};

const running = new Map<number, AbortController>();

ctx.onmessage = async (event) => {
  const data = event.data;
  if ("cancel" in data) {
    running.get(data.id)?.abort();
    return;
  }
  const { id, file } = data;
  const ctl = new AbortController();
  running.set(id, ctl);
  try {
    const hex = await sha256Stream(file, (bytes) => ctx.postMessage({ id, bytes }), undefined, ctl.signal);
    ctx.postMessage({ id, hex });
  } catch (error) {
    ctx.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  } finally {
    running.delete(id);
  }
};
