import type { DatasetFile, DatasetVersion, Project, Schemas } from "@/shared/api/types";

/**
 * "노트북 열기" (M07-lite, D-049): prepares the caller's folder of a project in the one shared JupyterLab and sends the
 * browser there. Runs on the web server only (the Jupyter token never reaches a client bundle):
 *   1. the caller (getMe) must be a member of the project (getProject with the caller's own session);
 *   2. `work/<user_id>/<project_id>/` and its `data/` exist (Jupyter contents API, created when missing);
 *   3. each pinned input's primary table (skip "_" files, largest VERIFIED csv/parquet) is copied to `data/` when its
 *      access level is PUBLIC or INTERNAL and it is ≤ 50 MiB; an unchanged file (same size) is not uploaded again;
 *   4. README.md (project name, copied and skipped inputs, in Korean) is rewritten;
 *   5. the answer is a redirect to `/notebooks/lab/tree/work/<u>/<p>?token=…` (Jupyter turns the token into a cookie).
 * The whole copy shares one 20 s budget: inputs it does not reach are listed as "복사 중 건너뜀" and the redirect goes ahead.
 * Path segments are canonical UUIDs only (validated before any path is built).
 */

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const MAX_FILE_BYTES = 50 * 1024 * 1024;
export const BUDGET_MS = 20_000;
/** Kept back from the copy budget for README.md. */
const README_RESERVE_MS = 3_000;

export type NotebookError = "unavailable" | "forbidden";
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
  const deadline = started + budget - README_RESERVE_MS;
  const left = () => deadline - now();
  const signal = (cap = Infinity) => AbortSignal.timeout(Math.max(1, Math.min(cap, left())));

  if (!projectId || !UUID_RE.test(projectId)) return { ok: false, error: "forbidden" };
  if (!deps.jupyter?.base || !deps.jupyter.token) return { ok: false, error: "unavailable" };
  const jupyter = deps.jupyter;

  // 1. who, and member of the project?
  let me: Schemas["Me"];
  let project: Project;
  try {
    const meRes = await deps.api("/me");
    if (meRes.status === 401) return { ok: false, error: "unauthenticated" };
    if (!meRes.ok) return { ok: false, error: meRes.status === 403 ? "forbidden" : "unavailable" };
    me = (await meRes.json()) as Schemas["Me"];
    const res = await deps.api(`/projects/${projectId}`);
    if (res.status === 401) return { ok: false, error: "unauthenticated" };
    if (res.status === 403 || res.status === 404) return { ok: false, error: "forbidden" };
    if (!res.ok) return { ok: false, error: "unavailable" };
    project = (await res.json()) as Project;
  } catch {
    return { ok: false, error: "unavailable" };
  }
  if (!UUID_RE.test(me.user_id) || !project.my_role || project.project_id !== projectId) return { ok: false, error: "forbidden" };
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
    const res = await deps.api(`/projects/${projectId}/inputs`);
    if (res.ok) inputs = ((await res.json()) as { items: Schemas["ProjectInput"][] }).items ?? [];
    else inputsFailed = true;
  } catch {
    inputsFailed = true;
  }
  const used = new Set<string>();
  let jupyterDown = false;
  for (const [i, input] of inputs.entries()) {
    const label = `${input.dataset_title} ${input.version_label}`;
    if (left() <= 0 || jupyterDown) {
      for (const rest of inputs.slice(i)) skipped.push({ name: `${rest.dataset_title} ${rest.version_label}`, reason: "복사 중 건너뜀" });
      break;
    }
    if (input.access_level !== "PUBLIC" && input.access_level !== "INTERNAL") {
      skipped.push({ name: label, reason: `접근 등급 ${input.access_level}: 노트북으로 복사하지 않습니다` });
      continue;
    }
    if (input.access_lapsed) {
      skipped.push({ name: label, reason: "접근 권한이 만료되었습니다" });
      continue;
    }
    try {
      const vRes = await deps.api(`/dataset-versions/${input.dataset_version_id}`, { signal: signal() });
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
      let name = safeName(`${input.dataset_title}_${input.version_label}_${base}`, 120);
      if (used.has(name)) name = safeName(`${input.dataset_title}_${input.version_label}_${input.input_id.slice(0, 8)}_${base}`, 120);
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
      const sRes = await deps.api(`/dataset-versions/${input.dataset_version_id}/download-session`, {
        method: "POST",
        body: JSON.stringify({ project_id: projectId, file_ids: [file.file_id] }),
        headers: { "content-type": "application/json" },
        signal: signal(),
      });
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

  // 4. README.md (own small allowance, still within the overall budget)
  const readme = readmeText(project.name, [...copied, ...unchanged], skipped, inputsFailed, now());
  try {
    await doFetch(`${jupyter.base.replace(/\/+$/, "")}/api/contents/${enc(`${folder}/README.md`)}`, {
      method: "PUT",
      headers: { Authorization: `token ${jupyter.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ type: "file", format: "text", content: readme }),
      signal: AbortSignal.timeout(Math.max(1, Math.min(README_RESERVE_MS, started + budget - now()))),
      cache: "no-store",
    });
  } catch {
    /* README is a courtesy; the folder is usable without it */
  }

  return { ok: true, location: `/notebooks/lab/tree/${enc(folder)}?token=${encodeURIComponent(jupyter.token)}`, copied, skipped };
}

const oneLine = (s: string) => s.replace(/[\r\n]+/g, " ").trim();

export function readmeText(projectName: string, files: string[], skipped: SkippedInput[], inputsFailed: boolean, nowMs: number): string {
  const kst = new Date(nowMs + 9 * 3_600_000).toISOString().slice(0, 16).replace("T", " ");
  const lines = [
    `# ${oneLine(projectName)}`,
    "",
    "NAIS 프로젝트 노트북 폴더입니다. 이 폴더와 하위 폴더에 저장한 노트북(.ipynb)이 그날 연구노트 AI 초안의 근거가 됩니다.",
    "data/ 폴더는 입력 데이터 복사본이며, 그 안의 노트북은 근거에서 제외됩니다.",
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
  lines.push("", `마지막 갱신: ${kst} (KST)`, "");
  return lines.join("\n");
}

/** Where an error goes back to: the page the button was on (its /commons path from Referer), else the notebooks screen. */
export function errorLocation(referer: string | null, error: NotebookError): string {
  let back = "/commons/notebooks";
  if (referer) {
    try {
      // Only the path is kept (the Location stays relative, so another origin's Referer cannot redirect elsewhere).
      const ref = new URL(referer);
      if (ref.pathname === "/commons" || ref.pathname.startsWith("/commons/")) back = `${ref.pathname}${ref.search}`;
    } catch {
      /* malformed Referer */
    }
  }
  const url = new URL(back, "http://x");
  url.searchParams.set("notebook_error", error);
  return `${url.pathname}${url.search}`;
}
