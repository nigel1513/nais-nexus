import type { DatasetFile, DatasetVersion, Project, Schemas } from "@/shared/api/types";

/**
 * "노트북 열기" (M07-lite, D-049): prepares the caller's folder of a project in the one shared JupyterLab and answers
 * where it is. Runs on the web server only (the Jupyter token is in no client bundle):
 *   1. the caller (getMe) must be a member of the project (getProject with the caller's own session);
 *   2. `work/<user_id>/<project_id>/` and its `data/` exist (Jupyter contents API, created when missing);
 *   3. each pinned input's primary table (skip "_" files, largest VERIFIED csv/parquet) is copied to `data/` when its
 *      access level is PUBLIC or INTERNAL and it is ≤ 50 MiB; an unchanged file (same size) is not uploaded again;
 *   4. README.md (project name, copied and skipped inputs, in Korean) is rewritten; the save carries the caller's
 *      display name (`nais_author_name`) for the folder's notebook history (infra/notebook/nais_nb_hooks.py: Jupyter's
 *      save hooks keep every project folder a git repository, author `<name> <<user_id>@nais.local>`, and commit each save);
 *   5. the document to show: the folder's most recently modified notebook, else a new starter notebook `analysis.ipynb`
 *      (`nais_starter`: the hook dates it back, so opening the tab alone is no "notebook saved today");
 *   6. the answer is `/notebooks/lab/workspaces/<workspace>/tree/work/<u>/<p>/<doc>?token=…` (Jupyter turns the token
 *      into a cookie): one JupyterLab workspace per user and project (workspaceName), so a project never restores
 *      another project's tabs while its own layout is kept; the document opens in the main area and the file browser
 *      starts in its folder. The project's 노트북 tab shows it in a frame inside the portal (notebook-tab.tsx).
 * The whole copy shares one 20 s budget: inputs it does not reach are listed as "복사 중 건너뜀" and the folder still opens.
 * Path segments are canonical UUIDs only (validated before any path is built). File names the opener creates are ASCII.
 */

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const MAX_FILE_BYTES = 50 * 1024 * 1024;
export const BUDGET_MS = 20_000;
/** Kept back from the copy budget for README.md and the document to open. */
const FINISH_RESERVE_MS = 5_000;
/** The starter notebook made in a folder without notebooks (ASCII name). */
export const STARTER_NOTEBOOK = "analysis.ipynb";

export type NotebookError = "unavailable" | "forbidden" | "archived";
export type OpenResult = { ok: true; location: string; copied: string[]; skipped: SkippedInput[] } | { ok: false; error: NotebookError | "unauthenticated" };
export type SkippedInput = { name: string; reason: string };

export type OpenDeps = {
  /** NAIS API as the signed-in caller (path under /api/v1, e.g. "/me"). */
  api: (path: string, init?: RequestInit) => Promise<Response>;
  /** Size of the bytes readFile would return (real mode: the catalog's size_bytes). */
  sizeOf: (version: DatasetVersion, file: DatasetFile) => number;
  /** The file's bytes from a download session's URL (mock mode reads its own store). */
  readFile: (version: DatasetVersion, file: DatasetFile, url: string, signal: AbortSignal) => Promise<Uint8Array>;
  jupyter: { base: string; token: string } | null;
  fetch?: typeof fetch;
  now?: () => number;
  budgetMs?: number;
};

class JupyterDown extends Error {}

const enc = (path: string) => path.split("/").map(encodeURIComponent).join("/");

/** The JupyterLab workspace of one user's folder of one project: URL-safe (UUIDs only), unique per user and project. */
export function workspaceName(userId: string, projectId: string): string {
  if (!UUID_RE.test(userId) || !UUID_RE.test(projectId)) throw new Error("workspace ids must be canonical UUIDs");
  return `nais-${userId}-${projectId}`;
}

/** The JupyterLab address: the project's own workspace, the folder (and the document opened in the main area). */
export function labLocation({ userId, projectId, doc, token }: { userId: string; projectId: string; doc?: string | null; token: string }): string {
  const path = `work/${userId}/${projectId}${doc ? `/${doc}` : ""}`;
  return `/notebooks/lab/workspaces/${workspaceName(userId, projectId)}/tree/${enc(path)}?token=${encodeURIComponent(token)}`;
}

type Entry = { name?: unknown; type?: unknown; last_modified?: unknown };

/** The most recently modified notebook among a folder listing's entries (hidden files skipped). */
export function latestNotebook(entries: Entry[]): string | null {
  let best: { name: string; at: number } | null = null;
  for (const e of entries) {
    if (e.type !== "notebook" || typeof e.name !== "string" || !e.name.endsWith(".ipynb") || e.name.startsWith(".")) continue;
    const parsed = typeof e.last_modified === "string" ? Date.parse(e.last_modified) : NaN;
    const at = Number.isNaN(parsed) ? 0 : parsed;
    if (!best || at > best.at || (at === best.at && e.name < best.name)) best = { name: e.name, at };
  }
  return best?.name ?? null;
}

/** Same rule as the backend's reader.primary_file. */
export function primaryFile(files: DatasetFile[]): DatasetFile | undefined {
  const candidates = files.filter((f) => f.status === "VERIFIED" && /\.(csv|parquet)$/i.test(f.path) && !(f.path.split("/").pop() ?? "").startsWith("_"));
  return candidates.sort((a, b) => b.size_bytes - a.size_bytes || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))[0];
}

/** A file name safe for Jupyter and any OS: no separators, control or reserved characters, no leading dot. */
export function safeName(text: string, max = 80): string {
  const s = text
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .slice(0, max)
    .trim();
  return s || "data";
}

const bytesLabel = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MiB` : `${Math.max(1, Math.round(n / 1024))} KiB`);

function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
}

export async function openNotebook(projectId: string | null, deps: OpenDeps): Promise<OpenResult> {
  const now = deps.now ?? Date.now;
  const doFetch = deps.fetch ?? fetch;
  const started = now();
  const budget = deps.budgetMs ?? BUDGET_MS;
  const deadline = started + budget - FINISH_RESERVE_MS;
  const left = () => deadline - now();
  const signal = (cap = Infinity) => AbortSignal.timeout(Math.max(1, Math.min(cap, left())));
  /** An API call bounded by `cap` and the overall budget; it settles on timeout even if the transport ignores the signal. */
  const call = (path: string, init: RequestInit = {}, cap = 5_000): Promise<Response> => {
    const s = signal(cap);
    return Promise.race([
      deps.api(path, { ...init, signal: s }),
      new Promise<never>((_, reject) => {
        if (s.aborted) reject(new Error("timeout"));
        s.addEventListener("abort", () => reject(new Error("timeout")), { once: true });
      }),
    ]);
  };

  if (!projectId || !UUID_RE.test(projectId)) return { ok: false, error: "forbidden" };
  if (!deps.jupyter?.base || !deps.jupyter.token) return { ok: false, error: "unavailable" };
  const jupyter = deps.jupyter;

  // 1. who, and member of the project?
  let me: Schemas["Me"];
  let project: Project;
  try {
    const meRes = await call("/me");
    if (meRes.status === 401) return { ok: false, error: "unauthenticated" };
    if (!meRes.ok) return { ok: false, error: meRes.status === 403 ? "forbidden" : "unavailable" };
    me = (await meRes.json()) as Schemas["Me"];
    const res = await call(`/projects/${projectId}`);
    if (res.status === 401) return { ok: false, error: "unauthenticated" };
    if (res.status === 403 || res.status === 404) return { ok: false, error: "forbidden" };
    if (!res.ok) return { ok: false, error: "unavailable" };
    project = (await res.json()) as Project;
  } catch {
    return { ok: false, error: "unavailable" };
  }
  if (!UUID_RE.test(me.user_id) || !project.my_role || project.project_id !== projectId) return { ok: false, error: "forbidden" };
  if (project.status === "ARCHIVED") return { ok: false, error: "archived" };
  const folder = `work/${me.user_id}/${projectId}`;

  // Jupyter contents API (token header; never logged).
  const contents = (path: string, init: RequestInit & { query?: string } = {}, timeoutMs?: number) =>
    doFetch(`${jupyter.base.replace(/\/+$/, "")}/api/contents/${enc(path)}${init.query ?? ""}`, {
      ...init,
      headers: { Authorization: `token ${jupyter.token}`, "Content-Type": "application/json", ...init.headers },
      signal: signal(timeoutMs),
      cache: "no-store",
    });
  const stat = async (path: string): Promise<{ type: string; size: number | null } | null> => {
    const res = await contents(path, { method: "GET", query: "?content=0" }, 5_000);
    if (res.status === 404) return null;
    if (!res.ok) throw new JupyterDown(`stat ${res.status}`);
    const m = (await res.json()) as { type?: string; size?: number | null };
    return { type: String(m.type ?? ""), size: typeof m.size === "number" ? m.size : null };
  };
  const ensureDir = async (path: string) => {
    const s = await stat(path);
    if (s?.type === "directory") return;
    if (s) throw new JupyterDown(`${path} is not a directory`);
    const res = await contents(path, { method: "PUT", body: JSON.stringify({ type: "directory" }) }, 5_000);
    if (!res.ok && res.status !== 409) throw new JupyterDown(`mkdir ${res.status}`);
  };

  // 2. folders
  try {
    await ensureDir(`work/${me.user_id}`);
    await ensureDir(folder);
    await ensureDir(`${folder}/data`);
  } catch {
    return { ok: false, error: "unavailable" };
  }

  // 3. inputs
  const copied: string[] = [];
  const unchanged: string[] = [];
  const skipped: SkippedInput[] = [];
  let inputs: Schemas["ProjectInput"][] = [];
  let inputsFailed = false;
  try {
    const res = await call(`/projects/${projectId}/inputs`);
    if (res.ok) inputs = ((await res.json()) as { items: Schemas["ProjectInput"][] }).items ?? [];
    else inputsFailed = true;
  } catch {
    inputsFailed = true;
  }
  const used = new Set<string>();
  let jupyterDown = false;
  for (const input of inputs) {
    const label = `${input.dataset_title} ${input.version_label}`;
    // Policy reasons first, so an input is never reported as "복사 중 건너뜀" when it would not be copied at all.
    if (input.access_level !== "PUBLIC" && input.access_level !== "INTERNAL") {
      skipped.push({ name: label, reason: `접근 등급 ${input.access_level}: 노트북으로 복사하지 않습니다` });
      continue;
    }
    if (input.access_lapsed) {
      skipped.push({ name: label, reason: "접근 권한이 만료되었습니다" });
      continue;
    }
    if (left() <= 0 || jupyterDown) {
      skipped.push({ name: label, reason: "복사 중 건너뜀" });
      continue;
    }
    try {
      const vRes = await call(`/dataset-versions/${input.dataset_version_id}`, {}, Infinity);
      if (!vRes.ok) {
        skipped.push({ name: label, reason: "데이터 버전을 읽지 못했습니다" });
        continue;
      }
      const version = (await vRes.json()) as DatasetVersion;
      const file = primaryFile(version.files ?? []);
      if (!file) {
        skipped.push({ name: label, reason: "표 형식(csv/parquet) 파일이 없습니다" });
        continue;
      }
      const size = deps.sizeOf(version, file);
      if (size > MAX_FILE_BYTES) {
        skipped.push({ name: label, reason: `파일이 50 MiB를 넘습니다 (${bytesLabel(size)})` });
        continue;
      }
      const base = file.path.split("/").pop() ?? "data.csv";
      // Only the title is shortened: the label, the id suffix and the extension always survive.
      const stem = `${safeName(input.dataset_title, 60)}_${safeName(input.version_label, 40)}`;
      let name = `${stem}_${safeName(base, 80)}`;
      if (used.has(name)) name = `${stem}_${input.input_id.slice(0, 8)}_${safeName(base, 80)}`;
      used.add(name);
      const target = `${folder}/data/${name}`;
      let existing: Awaited<ReturnType<typeof stat>>;
      try {
        existing = await stat(target);
      } catch {
        jupyterDown = true;
        skipped.push({ name: label, reason: "복사 중 건너뜀" });
        continue;
      }
      if (existing && existing.size === size) {
        unchanged.push(name);
        continue;
      }
      const sRes = await call(
        `/dataset-versions/${input.dataset_version_id}/download-session`,
        { method: "POST", body: JSON.stringify({ project_id: projectId, file_ids: [file.file_id] }), headers: { "content-type": "application/json" } },
        Infinity,
      );
      if (!sRes.ok) {
        skipped.push({ name: label, reason: "다운로드 권한이 없거나 세션을 만들지 못했습니다" });
        continue;
      }
      const session = (await sRes.json()) as Schemas["DownloadSession"];
      const url = session.files.find((f) => f.file_id === file.file_id)?.url;
      if (!url) {
        skipped.push({ name: label, reason: "다운로드 주소를 받지 못했습니다" });
        continue;
      }
      const bytes = await deps.readFile(version, file, url, signal());
      if (bytes.byteLength > MAX_FILE_BYTES) {
        skipped.push({ name: label, reason: `파일이 50 MiB를 넘습니다 (${bytesLabel(bytes.byteLength)})` });
        continue;
      }
      const put = await contents(target, { method: "PUT", body: JSON.stringify({ type: "file", format: "base64", content: base64(bytes) }) });
      if (!put.ok) {
        if (put.status >= 500 || put.status === 401 || put.status === 403) jupyterDown = true;
        skipped.push({ name: label, reason: "복사 중 건너뜀" });
        continue;
      }
      copied.push(name);
    } catch {
      skipped.push({ name: label, reason: "복사 중 건너뜀" });
    }
  }

  // 4. README.md, 5. the document to show: their own small allowance, still within the overall budget.
  const finish = (cap: number) => AbortSignal.timeout(Math.max(1, Math.min(cap, started + budget - now())));
  const put = (path: string, model: Record<string, unknown>, cap: number) =>
    doFetch(`${jupyter.base.replace(/\/+$/, "")}/api/contents/${enc(path)}`, {
      method: "PUT",
      headers: { Authorization: `token ${jupyter.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(model),
      signal: finish(cap),
      cache: "no-store",
    });
  const files = [...copied, ...unchanged];
  let readmeOk = false;
  try {
    const res = await put(`${folder}/README.md`, { type: "file", format: "text", content: readmeText(project.name, files, skipped, inputsFailed), nais_author_name: me.display_name }, 2_000);
    readmeOk = res.ok;
  } catch {
    /* README is a courtesy; the folder is usable without it */
  }
  let doc: string | null = null;
  try {
    const res = await doFetch(`${jupyter.base.replace(/\/+$/, "")}/api/contents/${enc(folder)}?content=1`, {
      method: "GET",
      headers: { Authorization: `token ${jupyter.token}` },
      signal: finish(1_500),
      cache: "no-store",
    });
    if (res.ok) {
      const listing = (await res.json()) as { content?: unknown };
      doc = latestNotebook(Array.isArray(listing.content) ? (listing.content as Entry[]) : []);
      if (!doc) {
        const made = await put(`${folder}/${STARTER_NOTEBOOK}`, { type: "notebook", content: starterNotebook(project.name, files), nais_starter: true }, 2_000);
        if (made.ok) doc = STARTER_NOTEBOOK;
      }
    }
  } catch {
    /* the folder opens without a document */
  }
  if (!doc && readmeOk) doc = "README.md";

  return { ok: true, location: labLocation({ userId: me.user_id, projectId, doc, token: jupyter.token }), copied, skipped };
}

const oneLine = (s: string) => s.replace(/[\r\n]+/g, " ").trim();

/**
 * README.md of the folder. No timestamp: the file is rewritten on every open and enters the folder's history only when
 * its content changes.
 */
export function readmeText(projectName: string, files: string[], skipped: SkippedInput[], inputsFailed: boolean): string {
  const lines = [
    `# ${oneLine(projectName)}`,
    "",
    "NAIS 프로젝트 노트북 폴더입니다. 이 폴더와 하위 폴더에 저장한 노트북(.ipynb)이 그날 연구노트 AI 초안의 근거가 됩니다.",
    "data/ 폴더는 입력 데이터 복사본이며, 그 안의 노트북은 근거에서 제외됩니다.",
    "저장할 때마다 이 폴더의 변경 이력이 자동으로 기록됩니다(git). 왼쪽 Git 패널에서 이력과 비교를 볼 수 있습니다. data/ 폴더, 표 파일(csv·parquet 등)과 20 MB가 넘는 파일은 이력에 넣지 않습니다.",
    "",
    "## 입력 데이터 (data/)",
    "",
    ...(files.length ? files.map((f) => `- data/${f}`) : ["- 복사한 파일이 없습니다."]),
  ];
  if (skipped.length || inputsFailed) {
    lines.push("", "## 복사하지 않은 입력", "");
    if (inputsFailed) lines.push("- 프로젝트 입력 목록을 읽지 못했습니다. 노트북을 다시 열어 보세요.");
    for (const s of skipped) lines.push(`- ${oneLine(s.name)}: ${s.reason}`);
  }
  lines.push("");
  return lines.join("\n");
}

const pyString = (text: string) => JSON.stringify(text);

/** The starter notebook (nbformat 4.5, python3 kernel): what the folder is, and a first cell reading the first input. */
export function starterNotebook(projectName: string, files: string[]): Record<string, unknown> {
  const first = files[0];
  const read = first ? `df = pd.${/\.parquet$/i.test(first) ? "read_parquet" : "read_csv"}(${pyString(`data/${first}`)})` : null;
  const intro = [
    `# ${oneLine(projectName)} 분석`,
    "",
    "NAIS 프로젝트의 내 노트북 폴더입니다.",
    "",
    "- `data/`: 프로젝트 입력 데이터 복사본입니다. 복사한 파일과 복사하지 않은 입력은 `README.md`에 있습니다.",
    "- 이 폴더에 저장한 노트북(.ipynb)이 그날 연구노트 AI 초안의 근거가 됩니다.",
    "- 저장할 때마다 변경 이력이 자동으로 기록됩니다. 왼쪽 Git 패널에서 이력과 비교를 볼 수 있습니다.",
  ].join("\n");
  const code = ["import pandas as pd", ...(read ? ["", read, "df.head()"] : [])].join("\n");
  return {
    cells: [
      { cell_type: "markdown", id: "nais-intro", metadata: {}, source: intro },
      { cell_type: "code", id: "nais-start", metadata: {}, execution_count: null, outputs: [], source: code },
    ],
    metadata: {
      kernelspec: { name: "python3", display_name: "Python 3 (ipykernel)", language: "python" },
      language_info: { name: "python" },
    },
    nbformat: 4,
    nbformat_minor: 5,
  };
}

