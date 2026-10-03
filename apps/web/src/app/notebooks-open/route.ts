import { errorLocation, openNotebook, type OpenDeps } from "@/features/notebooks/open-notebook";
import { isMocking } from "@/shared/config";

export const dynamic = "force-dynamic";

const redirect = (location: string) => new Response(null, { status: 302, headers: { location, "cache-control": "no-store", "referrer-policy": "no-referrer" } });

function jupyterConfig(env: Record<string, string | undefined> = process.env): OpenDeps["jupyter"] {
  const base = env.NAIS_JUPYTER_URL?.trim();
  const token = env.NAIS_JUPYTER_TOKEN?.trim();
  return base && token ? { base, token } : null;
}

/** Mock mode: the in-process mock API as the mock-login user (cookie), file bytes from the mock store. */
async function mockDeps(request: Request): Promise<Pick<OpenDeps, "api" | "sizeOf" | "readFile">> {
  const [{ getResponse }, { handlers }, { getDb }, { seedTableText }] = await Promise.all([import("msw"), import("@/mocks/handlers"), import("@/mocks/db"), import("@/mocks/recipes")]);
  const cookie = request.headers.get("cookie") ?? "";
  const bytesOf = (version: { dataset_id: string; dataset_version_id: string }, file: { file_id: string; path: string }) => {
    const text = getDb().objects[file.file_id] ?? seedTableText(version.dataset_id, version.dataset_version_id, file.path);
    return text === null || text === undefined ? null : new TextEncoder().encode(text);
  };
  return {
    api: async (path, init = {}) => {
      const { signal: _signal, ...rest } = init;
      void _signal;
      const req = new Request(`http://mock.local/mock-api/v1${path}`, { ...rest, headers: { ...(rest.headers as Record<string, string> | undefined), cookie } });
      return (await getResponse(handlers, req)) ?? new Response(null, { status: 404 });
    },
    sizeOf: (version, file) => bytesOf(version, file)?.byteLength ?? file.size_bytes,
    readFile: async (version, file) => {
      const bytes = bytesOf(version, file);
      if (!bytes) throw new Error("no bytes");
      return bytes;
    },
  };
}

/** Real mode: the api in the compose network with the caller's own access token; files through the presigned URL. */
async function realDeps(): Promise<Pick<OpenDeps, "api" | "sizeOf" | "readFile"> | null> {
  const base = process.env.NAIS_INTERNAL_API_URL?.trim();
  const { auth } = await import("@/auth");
  const session = await auth();
  if (!session?.accessToken || session.error) return null;
  const token = session.accessToken;
  return {
    api: (path, init = {}) => {
      if (!base) return Promise.resolve(new Response(null, { status: 503 }));
      return fetch(`${base.replace(/\/+$/, "")}/api/v1${path}`, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), Authorization: `Bearer ${token}` }, cache: "no-store" });
    },
    sizeOf: (_version, file) => file.size_bytes,
    readFile: async (_version, file, url, signal) => {
      const res = await fetch(url, { signal, cache: "no-store" });
      if (!res.ok) throw new Error(`download ${res.status}`);
      const length = Number(res.headers.get("content-length") ?? file.size_bytes);
      if (length > 50 * 1024 * 1024) throw new Error("too large");
      return new Uint8Array(await res.arrayBuffer());
    },
  };
}

/**
 * GET /notebooks-open?project=<uuid>: prepare the caller's folder in the shared JupyterLab and redirect there
 * (open-notebook.ts). Failures go back to the calling page with ?notebook_error=unavailable|forbidden; without a
 * session, to the notebooks screen (which asks for a login).
 */
export async function GET(request: Request): Promise<Response> {
  const projectId = new URL(request.url).searchParams.get("project");
  const io = isMocking() ? await mockDeps(request) : await realDeps();
  if (!io) return redirect("/commons/notebooks");
  const result = await openNotebook(projectId, { ...io, jupyter: jupyterConfig() });
  if (result.ok) return redirect(result.location);
  if (result.error === "unauthenticated") return redirect("/commons/notebooks");
  return redirect(errorLocation(request.headers.get("referer"), result.error));
}
