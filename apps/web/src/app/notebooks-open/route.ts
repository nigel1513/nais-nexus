import { openNotebook, UUID_RE, type OpenDeps, type OpenResult } from "@/features/notebooks/open-notebook";
import { isMocking } from "@/shared/config";

export const dynamic = "force-dynamic";

type OpenBody = { location: string } | { error: Extract<OpenResult, { ok: false }>["error"] };
const json = (status: number, body: OpenBody) => Response.json(body, { status, headers: { "cache-control": "no-store", "referrer-policy": "no-referrer" } });
const STATUS = { unauthenticated: 401, forbidden: 403, archived: 409, unavailable: 503 } as const;

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
      // init.signal (set by open-notebook for every call) bounds the request by the 20 s budget.
      return fetch(`${base.replace(/\/+$/, "")}/api/v1${path}`, { ...init, signal: init.signal, headers: { ...(init.headers as Record<string, string> | undefined), Authorization: `Bearer ${token}` }, cache: "no-store" });
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
 * POST /notebooks-open?project=<uuid>: prepare the caller's folder in the shared JupyterLab (open-notebook.ts) and answer
 * `{ location }`, the JupyterLab address the project's 노트북 tab puts in its frame. Failures answer `{ error }`:
 * 401 unauthenticated, 403 forbidden, 409 archived, 503 unavailable.
 */
export async function POST(request: Request): Promise<Response> {
  const projectId = new URL(request.url).searchParams.get("project");
  const io = isMocking() ? await mockDeps(request) : await realDeps();
  if (!io) return json(401, { error: "unauthenticated" });
  const result = await openNotebook(projectId, { ...io, jupyter: jupyterConfig() });
  return result.ok ? json(200, { location: result.location }) : json(STATUS[result.error], { error: result.error });
}

/** GET (an old link or bookmark): the project's 노트북 tab, which opens the notebook inside the portal. */
export function GET(request: Request): Response {
  const projectId = new URL(request.url).searchParams.get("project");
  const location = projectId && UUID_RE.test(projectId) ? `/commons/projects/${projectId}/notebook` : "/commons/notebooks";
  return new Response(null, { status: 302, headers: { location, "cache-control": "no-store" } });
}
