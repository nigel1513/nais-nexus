import { http, HttpResponse } from "msw";
import type { Schemas } from "@/shared/api/types";
import { getDb } from "../db";
import { API, body, currentUser, fail, newestFirst, newId, notify, nowIso, orgName, paginate, publicOrigin, recordAudit } from "../http";
import { buildResult } from "../readiness-results";
import type { MockDb, MockUser, StoredDataset, StoredUploadSession, StoredValidation, StoredVersion } from "../types";

/**
 * Mirrors apps/api/modules/catalog (access.py, service/*, domain.py): visibility D-012/D-040, steward-only writes,
 * upload rules (path/type/size checks, per-session instructions), publish freezing the manifest.
 * Storage object keys are opaque to the web, so the mock uses `<origin>/mock-storage/<bucket>/uploads/<file_id>[/<part>]`.
 */
const MiB = 1024 * 1024;
const PART = 64 * MiB;
const SYNC_VERIFY_MAX = 256 * MiB;
const MAX_FILE = 50 * 1024 ** 3;
const MAX_PARTS = 10_000;
const MAX_FILES_PER_VERSION = 10_000;
const SESSION_TTL_MS = 3_600_000;
const PURPOSES: Schemas["Purpose"][] = ["ACADEMIC_RESEARCH", "AI_TRAINING", "COMMERCIAL_RESEARCH", "EDUCATION", "PUBLIC_INTEREST"];
const ALLOWED_MEDIA: Record<string, string> = {
  ".csv": "text/csv",
  ".tsv": "text/tab-separated-values",
  ".json": "application/json",
  ".jsonl": "application/x-ndjson",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".parquet": "application/vnd.apache.parquet",
  ".h5": "application/x-hdf5",
  ".hdf5": "application/x-hdf5",
  ".nc": "application/x-netcdf",
  ".zip": "application/zip",
};

type Field = { field: string; reason: string; [k: string]: unknown };
const invalid = (fields: Field[], message = "Request validation failed."): never => fail("VALIDATION_FAILED", message, { fields });

export const bucketOf = (db: MockDb, orgId: string) => `nais-${db.organizations.find((o) => o.organization_id === orgId)?.code ?? "platform"}`;

const isPlatformAdmin = (user: MockUser) => user.platform_roles.includes("PLATFORM_ADMIN");

function hasPublishedVersion(db: MockDb, datasetId: string) {
  return db.versions.some((v) => v.dataset_id === datasetId && v.status === "PUBLISHED");
}

/** access.can_see_dataset (D-012 + D-040): owner org and platform admins always; others only ACTIVE, non-INTERNAL, with a published version. */
export function canSeeDataset(user: MockUser, ds: StoredDataset, db: MockDb = getDb()): boolean {
  if (isPlatformAdmin(user) || user.organization_id === ds.owner_organization_id) return true;
  return ds.status === "ACTIVE" && ds.access_level !== "INTERNAL" && hasPublishedVersion(db, ds.dataset_id);
}

export function isOwnerSteward(user: MockUser, ownerOrgId: string): boolean {
  return user.organization_id === ownerOrgId && user.org_roles.includes("DATA_STEWARD");
}

/** access.can_see_all_versions: DRAFT versions are visible to platform admins and the owner org's DATA_STEWARD / ORG_ADMIN. */
export function canSeeAllVersions(user: MockUser, ownerOrgId: string): boolean {
  return isPlatformAdmin(user) || (user.organization_id === ownerOrgId && (user.org_roles.includes("DATA_STEWARD") || user.org_roles.includes("ORG_ADMIN")));
}

/** M03 §4.5 primary profile rule: TABULAR_ML_BASIC COMPLETED, else GENERIC_BASIC COMPLETED, else null. */
export function readinessOverallFor(db: MockDb, versionId: string): Schemas["ReadinessOverall"] | null {
  const done = db.validations.filter((v) => v.dataset_version_id === versionId && v.run_status === "COMPLETED");
  const latest = (profile: string) => done.filter((v) => v.profile_id === profile).sort(newestFirst("created_at"))[0];
  return (latest("TABULAR_ML_BASIC") ?? latest("GENERIC_BASIC"))?.overall_status ?? null;
}

const byPath = (a: { path: string }, b: { path: string }) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

export function versionView(db: MockDb, v: StoredVersion): Schemas["DatasetVersion"] {
  return { ...v, files: [...v.files].sort(byPath), readiness_overall: v.status === "PUBLISHED" ? readinessOverallFor(db, v.dataset_version_id) : null };
}

function latestPublished(db: MockDb, datasetId: string): Schemas["DatasetVersionSummary"] | null {
  const v = db.versions.filter((x) => x.dataset_id === datasetId && x.status === "PUBLISHED").sort(newestFirst("published_at"))[0];
  if (!v) return null;
  return {
    dataset_version_id: v.dataset_version_id,
    version_label: v.version_label,
    status: v.status,
    published_at: v.published_at,
    readiness_overall: readinessOverallFor(db, v.dataset_version_id),
  };
}

export function datasetView(db: MockDb, ds: StoredDataset): Schemas["Dataset"] {
  return { ...ds, latest_published_version: latestPublished(db, ds.dataset_id) };
}

export function visibleDataset(db: MockDb, id: string, user: MockUser): StoredDataset {
  const ds = db.datasets.find((d) => d.dataset_id === id);
  if (!ds || !canSeeDataset(user, ds, db)) fail("NOT_FOUND");
  return ds;
}

/** can_see_version: dataset visible, and either PUBLISHED or the caller may see all versions. */
export function visibleVersion(db: MockDb, versionId: string, user: MockUser): { v: StoredVersion; ds: StoredDataset } {
  const v = db.versions.find((x) => x.dataset_version_id === versionId);
  if (!v) fail("NOT_FOUND");
  const ds = visibleDataset(db, v.dataset_id, user);
  if (v.status !== "PUBLISHED" && !canSeeAllVersions(user, ds.owner_organization_id)) fail("NOT_FOUND");
  return { v, ds };
}

function requireSteward(user: MockUser, ds: StoredDataset) {
  if (!isOwnerSteward(user, ds.owner_organization_id)) fail("FORBIDDEN", "Only a DATA_STEWARD of the owner organization can do this.");
}

/** access.steward_version: invisible → 404, visible but not steward → 403. */
function stewardVersion(db: MockDb, versionId: string, user: MockUser) {
  const found = visibleVersion(db, versionId, user);
  requireSteward(user, found.ds);
  return found;
}

function requireDraft(v: StoredVersion) {
  if (v.status !== "DRAFT") fail("DATASET_VERSION_IMMUTABLE", `Dataset version is ${v.status} and cannot be modified.`);
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Mirrors schemas.py (DatasetCreateIn / DatasetUpdateIn): collects every violation as details.fields[{field, reason}]. */
function validateDataset(input: Partial<Schemas["DatasetCreate"]> & { status?: string }, partial: boolean) {
  const fields: Field[] = [];
  const text = (name: string, value: unknown, min: number, max: number) => {
    if (typeof value !== "string" || value.length < min || value.length > max) fields.push({ field: name, reason: "LENGTH" });
  };
  // StrictIn rejects null: the real API has no "clear this field" semantics.
  for (const [k, v] of Object.entries(input)) if (v === null) fields.push({ field: k, reason: "NULL_NOT_ALLOWED" });
  const has = (k: keyof typeof input) => input[k] !== undefined && input[k] !== null;
  if (!partial || has("title")) text("title", input.title, 3, 300);
  if (!partial || has("description")) text("description", input.description, 0, 20000);
  if (!partial || has("license")) text("license", input.license, 1, 200);
  if (has("usage_policy")) text("usage_policy", input.usage_policy, 0, 10000);
  if (has("provenance")) text("provenance", input.provenance, 0, 10000);
  if (has("keywords") && (!Array.isArray(input.keywords) || input.keywords.length > 30 || input.keywords.some((k) => typeof k !== "string" || k.length < 1 || k.length > 50))) {
    fields.push({ field: "keywords", reason: "INVALID" });
  }
  if (has("contact_email") && !EMAIL.test(String(input.contact_email))) fields.push({ field: "contact_email", reason: "INVALID_EMAIL" });
  if (!partial || has("access_level")) {
    if (!["PUBLIC", "INTERNAL", "CONTROLLED", "SENSITIVE"].includes(String(input.access_level))) fields.push({ field: "access_level", reason: "INVALID" });
  }
  if (!partial || has("allowed_purposes")) {
    const p = input.allowed_purposes;
    if (!Array.isArray(p) || !p.length) fields.push({ field: "allowed_purposes", reason: "MIN_ITEMS" });
    else if (new Set(p).size !== p.length) fields.push({ field: "allowed_purposes", reason: "DUPLICATE" });
    else if (p.some((x) => !PURPOSES.includes(x))) fields.push({ field: "allowed_purposes", reason: "INVALID" });
  }
  if (has("max_grant_days") && (!Number.isInteger(input.max_grant_days) || input.max_grant_days! < 1 || input.max_grant_days! > 365)) {
    fields.push({ field: "max_grant_days", reason: "OUT_OF_RANGE" });
  }
  if (has("status") && !["ACTIVE", "WITHDRAWN"].includes(String(input.status))) fields.push({ field: "status", reason: "INVALID" });
  if (fields.length) invalid(fields);
}

/** domain.build_policy: approval_required is derived; SENSITIVE defaults to and is capped at 30 days. */
function buildPolicy(level: Schemas["AccessLevel"], purposes: Schemas["Purpose"][], maxDays: number | undefined) {
  const days = maxDays ?? (level === "SENSITIVE" ? 30 : 180);
  if (level === "SENSITIVE" && days > 30) fail("INVALID_POLICY", "SENSITIVE datasets allow at most 30 grant days");
  return {
    access_level: level,
    allowed_purposes: PURPOSES.filter((p) => purposes.includes(p)),
    approval_required: level === "CONTROLLED" || level === "SENSITIVE",
    max_grant_days: days,
  };
}

const keywordsOf = (k: string[] = []) => [...new Set(k.map((x) => x.trim()).filter(Boolean))];

function recompute(v: StoredVersion) {
  v.file_count = v.files.length;
  v.total_bytes = v.files.reduce((n, f) => n + f.size_bytes, 0);
}

/** domain.manifest_sha256 (M03 §4.9): sha256 over the path-sorted `path\tsize\tsha256\n` lines. */
async function manifestSha256(files: { path: string; size_bytes: number; sha256: string }[]): Promise<string> {
  const text = [...files].sort(byPath).map((f) => `${f.path}\t${f.size_bytes}\t${f.sha256}\n`).join("");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const isTabular = (path: string) => /\.(csv|tsv|parquet)$/i.test(path) && !(path.split("/").pop() ?? "").startsWith("_");

/** The mock computes an outcome from the version's real metadata so new datasets do not all show PASS. */
function outcomeFor(db: MockDb, versionId: string, profileId: string) {
  const v = db.versions.find((x) => x.dataset_version_id === versionId);
  const ds = v && db.datasets.find((d) => d.dataset_id === v.dataset_id);
  const overrides: Parameters<typeof buildResult>[1] = {};
  if (ds && (!ds.description.trim() || !ds.contact_email)) {
    overrides["metadata.completeness"] = ["FAIL", "필수 메타데이터가 누락되었습니다.", { required_missing: [!ds.description.trim() ? "description" : "", !ds.contact_email ? "contact_email" : ""].filter(Boolean) }];
  }
  if (ds && !ds.provenance) overrides["provenance.presence"] = ["FAIL", "provenance 정보가 없습니다.", { sources: ["dataset.provenance"] }];
  return buildResult(profileId, overrides);
}

export function queueValidation(db: MockDb, versionId: string, profileId: string, triggeredBy: "AUTO_ON_PUBLISH" | "USER"): StoredValidation {
  const v: StoredValidation = {
    validation_id: newId(),
    dataset_version_id: versionId,
    profile_id: profileId,
    profile_version: "1.0.0",
    run_status: "QUEUED",
    overall_status: null,
    summary: { pass: 0, warning: 0, fail: 0, not_applicable: 0 },
    checks: [],
    validator_version: "mock-1.0.0",
    input_fingerprint: newId().replaceAll("-", "").padEnd(64, "0"),
    error: null,
    triggered_by: triggeredBy,
    created_at: nowIso(),
    started_at: null,
    completed_at: null,
    polls: 0,
    outcome: outcomeFor(db, versionId, profileId),
  };
  db.validations.push(v);
  return v;
}

// ---------- upload sessions

const sessionExpired = (s: StoredUploadSession) => s.status === "OPEN" && Date.parse(s.expires_at) <= Date.now();

function pendingInOpenSession(db: MockDb, fileId: string): boolean {
  return db.uploadSessions.some((s) => s.status === "OPEN" && !sessionExpired(s) && s.files.some((f) => f.file_id === fileId && f.status === "PENDING"));
}

/** upload_session_response: EXPIRED is computed, and upload instructions exist only for PENDING files of an open session. */
function uploadSessionView(s: StoredUploadSession): Schemas["UploadSession"] {
  const open = s.status === "OPEN" && !sessionExpired(s);
  return {
    upload_session_id: s.upload_session_id,
    dataset_version_id: s.dataset_version_id,
    status: sessionExpired(s) ? "EXPIRED" : s.status,
    expires_at: s.expires_at,
    files: [...s.files].sort(byPath).map(({ upload, ...f }) => ({ ...f, ...(open && f.status === "PENDING" && upload ? { upload } : {}) })),
  };
}

const DATASET_UPDATE_KEYS = new Set([
  "title", "description", "keywords", "domain", "access_level", "license", "usage_policy",
  "allowed_purposes", "max_grant_days", "contact_email", "provenance", "status",
]);

function validateUploadFiles(files: Schemas["UploadSessionCreate"]["files"]) {
  const problems: Field[] = [];
  const seen = new Set<string>();
  files.forEach((f, i) => {
    let reason: string | null = null;
    if (typeof f.path !== "string" || f.path.length < 1 || f.path.length > 512) reason = "LENGTH";
    else if (!/^[A-Za-z0-9._/-]+$/.test(f.path)) reason = "CHARACTERS";
    else if (f.path.startsWith("/")) reason = "ABSOLUTE";
    else if (f.path.includes("//") || f.path.endsWith("/")) reason = "EMPTY_SEGMENT";
    else if (f.path.split("/").some((seg) => seg === "." || seg === "..")) reason = "DOT_SEGMENT";
    else if (seen.has(f.path)) reason = "DUPLICATE_PATH";
    seen.add(f.path);
    if (reason) problems.push({ field: `files.${i}.path`, reason });
    if (typeof f.media_type !== "string" || !f.media_type.trim()) problems.push({ field: `files.${i}.media_type`, reason: "REQUIRED" });
    if (!Number.isInteger(f.size_bytes) || f.size_bytes < 1) problems.push({ field: `files.${i}.size_bytes`, reason: "OUT_OF_RANGE" });
    if (!/^[a-f0-9]{64}$/.test(f.sha256 ?? "")) problems.push({ field: `files.${i}.sha256`, reason: "INVALID" });
  });
  if (problems.length) invalid(problems, "Invalid file path.");
  const ext = (p: string) => {
    const name = p.split("/").pop()!;
    const dot = name.lastIndexOf(".");
    return dot > 0 ? name.slice(dot).toLowerCase() : "";
  };
  const badTypes = files.filter((f) => ALLOWED_MEDIA[ext(f.path)] !== f.media_type.trim().toLowerCase());
  if (badTypes.length) fail("FILE_TYPE_NOT_ALLOWED", "File type is not in the allow list.", { files: badTypes.map((f) => ({ path: f.path, media_type: f.media_type })) });
  const tooLarge = files.filter((f) => f.size_bytes > MAX_FILE || Math.ceil(f.size_bytes / PART) > MAX_PARTS);
  if (tooLarge.length) fail("FILE_TOO_LARGE", "File exceeds the per-file limit.", { files: tooLarge.map((f) => ({ path: f.path, size_bytes: f.size_bytes })), max_bytes: MAX_FILE });
}

export const catalogHandlers = [
  http.get(`${API}/datasets`, ({ request }) => {
    const user = currentUser(request);
    const db = getDb();
    const url = new URL(request.url);
    const q = (url.searchParams.get("q") ?? "").trim().toLowerCase();
    const levels = url.searchParams.getAll("access_level");
    const owners = url.searchParams.getAll("owner_organization_id");
    const purposes = url.searchParams.getAll("purpose");
    const keywords = url.searchParams.getAll("keyword").map((k) => k.trim().toLowerCase());
    const readiness = url.searchParams.getAll("readiness_status");
    const sort = url.searchParams.get("sort") ?? "relevance";
    if (!["relevance", "updated_desc", "title_asc"].includes(sort)) invalid([{ field: "sort", reason: "INVALID" }]);
    const effectiveSort = sort === "relevance" && !q ? "updated_desc" : sort;

    // query.build_search_body: every filter (and the visibility rule) narrows both the hits and the facet counts.
    const matches = db.datasets
      .filter((ds) => ds.status === "ACTIVE" && canSeeDataset(user, ds, db))
      .filter((ds) => !q || [ds.title, ds.description, ...(ds.keywords ?? []), orgName(db, ds.owner_organization_id)].some((s) => s.toLowerCase().includes(q)))
      .map((ds) => ({ ds, latest: latestPublished(db, ds.dataset_id) }))
      .filter((x) => !levels.length || levels.includes(x.ds.access_level))
      .filter((x) => !owners.length || owners.includes(x.ds.owner_organization_id))
      .filter((x) => !purposes.length || x.ds.policy.allowed_purposes.some((p) => purposes.includes(p)))
      .filter((x) => !keywords.length || (x.ds.keywords ?? []).some((k) => keywords.includes(k.toLowerCase())))
      .filter((x) => !readiness.length || (x.latest?.readiness_overall && readiness.includes(x.latest.readiness_overall)));

    const facet = (values: (string | null | undefined)[], label?: (v: string) => string): Schemas["FacetBucket"][] => {
      const counts = new Map<string, number>();
      for (const v of values) if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
      return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([value, count]) => ({ value, count, ...(label ? { label: label(value) } : {}) }));
    };
    const facets = {
      access_level: facet(matches.map((x) => x.ds.access_level)),
      owner_organization_id: facet(matches.map((x) => x.ds.owner_organization_id), (id) => orgName(db, id)),
      purpose: facet(matches.flatMap((x) => x.ds.policy.allowed_purposes)),
      keyword: facet(matches.flatMap((x) => x.ds.keywords ?? [])),
      readiness_status: facet(matches.map((x) => x.latest?.readiness_overall)),
    };

    const hits: Schemas["DatasetSearchHit"][] = matches
      .sort((a, b) => {
        if (effectiveSort === "title_asc") return a.ds.title.localeCompare(b.ds.title) || a.ds.dataset_id.localeCompare(b.ds.dataset_id);
        if (effectiveSort === "relevance") {
          const diff = (a.ds.title.toLowerCase().includes(q) ? 0 : 1) - (b.ds.title.toLowerCase().includes(q) ? 0 : 1);
          if (diff) return diff;
        }
        return b.ds.updated_at.localeCompare(a.ds.updated_at) || a.ds.dataset_id.localeCompare(b.ds.dataset_id);
      })
      .map(({ ds, latest }) => ({
        dataset_id: ds.dataset_id,
        title: ds.title,
        snippet: ds.description.slice(0, 140),
        owner_organization_id: ds.owner_organization_id,
        owner_organization_name: orgName(db, ds.owner_organization_id),
        access_level: ds.access_level,
        keywords: ds.keywords ?? [],
        allowed_purposes: ds.policy.allowed_purposes,
        latest_version_label: latest?.version_label ?? null,
        readiness_overall: latest?.readiness_overall ?? null,
        updated_at: ds.updated_at,
      }));
    return HttpResponse.json({ ...paginate(hits, url), total: hits.length, facets });
  }),

  http.post(`${API}/datasets`, async ({ request }) => {
    const user = currentUser(request);
    const db = getDb();
    const input = await body<Schemas["DatasetCreate"]>(request);
    validateDataset(input, false);
    if (!isOwnerSteward(user, input.owner_organization_id)) fail("FORBIDDEN", "Only a DATA_STEWARD of the owner organization can create datasets.");
    const policy = buildPolicy(input.access_level, input.allowed_purposes, input.max_grant_days);
    const now = nowIso();
    const id = newId();
    const ds: StoredDataset = {
      dataset_id: id,
      owner_organization_id: input.owner_organization_id,
      owner_organization_name: orgName(db, input.owner_organization_id),
      title: input.title,
      description: input.description ?? "",
      keywords: keywordsOf(input.keywords),
      domain: input.domain ?? null,
      access_level: input.access_level,
      license: input.license,
      usage_policy: input.usage_policy ?? null,
      contact_email: input.contact_email ?? null,
      provenance: input.provenance ?? null,
      policy: { dataset_id: id, owner_organization_id: input.owner_organization_id, ...policy },
      status: "ACTIVE",
      created_by: user.user_id,
      created_at: now,
      updated_at: now,
    };
    db.datasets.push(ds);
    recordAudit(db, { action: "DATASET_CREATED", actor: user, resource: { type: "DATASET", id, owner_organization_id: ds.owner_organization_id } });
    return HttpResponse.json(datasetView(db, ds), { status: 201 });
  }),

  http.get(`${API}/datasets/:dataset_id`, ({ request, params }) => {
    const user = currentUser(request);
    const db = getDb();
    return HttpResponse.json(datasetView(db, visibleDataset(db, String(params.dataset_id), user)));
  }),

  http.patch(`${API}/datasets/:dataset_id`, async ({ request, params }) => {
    const user = currentUser(request);
    const db = getDb();
    const raw = await body<Schemas["DatasetUpdate"]>(request);
    if (!Object.keys(raw).length) invalid([{ field: "body", reason: "EMPTY" }]);
    // Only DatasetUpdate keys are accepted (no mass assignment of owner/ids/timestamps).
    const unknown = Object.keys(raw).filter((k) => !DATASET_UPDATE_KEYS.has(k));
    if (unknown.length) invalid(unknown.map((field) => ({ field, reason: "UNKNOWN_FIELD" })));
    const patch = raw;
    validateDataset(patch, true);
    const ds = visibleDataset(db, String(params.dataset_id), user);
    requireSteward(user, ds);
    const keys = Object.keys(patch);
    if (ds.status === "WITHDRAWN" && !(keys.length === 1 && patch.status === "ACTIVE")) {
      fail("CONFLICT", 'A WITHDRAWN dataset can only be reactivated with {"status": "ACTIVE"}.');
    }
    const previous = ds.policy;
    const policy = buildPolicy(patch.access_level ?? ds.access_level, patch.allowed_purposes ?? ds.policy.allowed_purposes, patch.max_grant_days ?? ds.policy.max_grant_days);
    const plain: Partial<Schemas["DatasetUpdate"]> = { ...patch };
    for (const key of ["access_level", "allowed_purposes", "max_grant_days", "keywords"] as const) delete plain[key];
    Object.assign(ds, plain, patch.keywords ? { keywords: keywordsOf(patch.keywords) } : {}, { access_level: policy.access_level, updated_at: nowIso() });
    ds.policy = { ...ds.policy, ...policy };
    const changed =
      previous.access_level !== policy.access_level ||
      previous.max_grant_days !== policy.max_grant_days ||
      previous.allowed_purposes.join() !== policy.allowed_purposes.join();
    if (changed) {
      recordAudit(db, {
        action: "POLICY_CHANGED",
        actor: user,
        resource: { type: "DATASET", id: ds.dataset_id, owner_organization_id: ds.owner_organization_id },
        details: { access_level: policy.access_level, max_grant_days: policy.max_grant_days },
      });
    }
    return HttpResponse.json(datasetView(db, ds));
  }),

  http.get(`${API}/datasets/:dataset_id/policy`, ({ request, params }) => {
    const user = currentUser(request);
    return HttpResponse.json(visibleDataset(getDb(), String(params.dataset_id), user).policy);
  }),

  http.get(`${API}/datasets/:dataset_id/versions`, ({ request, params }) => {
    const user = currentUser(request);
    const db = getDb();
    const ds = visibleDataset(db, String(params.dataset_id), user);
    const all = canSeeAllVersions(user, ds.owner_organization_id);
    const items = db.versions
      .filter((v) => v.dataset_id === ds.dataset_id && (all || v.status === "PUBLISHED"))
      .sort(newestFirst("created_at"))
      .map((v) => versionView(db, v));
    return HttpResponse.json({ items });
  }),

  http.post(`${API}/datasets/:dataset_id/versions`, async ({ request, params }) => {
    const user = currentUser(request);
    const db = getDb();
    const input = await body<{ version_label: string; change_note?: string }>(request);
    if (!/^[A-Za-z0-9._-]{1,32}$/.test(input.version_label ?? "")) invalid([{ field: "version_label", reason: "PATTERN" }]);
    const ds = visibleDataset(db, String(params.dataset_id), user);
    requireSteward(user, ds);
    if (ds.status !== "ACTIVE") fail("CONFLICT", "WITHDRAWN datasets cannot get new versions.");
    if (db.versions.some((v) => v.dataset_id === ds.dataset_id && v.version_label === input.version_label)) fail("DATASET_VERSION_LABEL_EXISTS");
    const v: StoredVersion = {
      dataset_version_id: newId(),
      dataset_id: ds.dataset_id,
      version_label: input.version_label,
      status: "DRAFT",
      published_at: null,
      change_note: input.change_note ?? null,
      files: [],
      file_count: 0,
      total_bytes: 0,
      manifest_sha256: null,
      created_at: nowIso(),
    };
    db.versions.push(v);
    return HttpResponse.json(versionView(db, v), { status: 201 });
  }),

  http.get(`${API}/dataset-versions/:version_id`, ({ request, params }) => {
    const user = currentUser(request);
    const db = getDb();
    const { v } = visibleVersion(db, String(params.version_id), user);
    // Mock verification worker: files > 256 MiB stay UPLOADED after complete and settle on the next read ("asyncfail" paths fail).
    for (const f of v.files) {
      if (f.status !== "UPLOADED") continue;
      f.status = f.path.includes("asyncfail") ? "FAILED" : "VERIFIED";
      for (const s of db.uploadSessions) {
        const sf = s.files.find((x) => x.file_id === f.file_id);
        if (sf) Object.assign(sf, { status: f.status, failure_code: f.status === "FAILED" ? "CHECKSUM_MISMATCH" : null });
      }
    }
    return HttpResponse.json(versionView(db, v));
  }),

  http.post(`${API}/dataset-versions/:version_id/upload-session`, async ({ request, params }) => {
    const user = currentUser(request);
    const db = getDb();
    const { v, ds } = stewardVersion(db, String(params.version_id), user);
    requireDraft(v);
    const input = await body<Schemas["UploadSessionCreate"]>(request);
    if (!Array.isArray(input.files) || input.files.length < 1 || input.files.length > 500) invalid([{ field: "files", reason: input.files?.length ? "TOO_MANY_ITEMS" : "MIN_ITEMS" }]);
    validateUploadFiles(input.files);
    const conflicts = input.files
      .map((f) => v.files.find((x) => x.path === f.path))
      .filter((x): x is Schemas["DatasetFile"] => !!x && (x.status === "UPLOADED" || x.status === "VERIFIED" || pendingInOpenSession(db, x.file_id)))
      .map((x) => x.path)
      .sort();
    if (conflicts.length) fail("CONFLICT", "These paths already exist in the version.", { paths: conflicts });
    const paths = new Set(input.files.map((f) => f.path));
    if (v.files.filter((f) => !paths.has(f.path)).length + paths.size > MAX_FILES_PER_VERSION) invalid([{ field: "files", reason: "TOO_MANY_FILES" }], `A version holds at most ${MAX_FILES_PER_VERSION} files.`);

    const origin = publicOrigin(request);
    const bucket = bucketOf(db, ds.owner_organization_id);
    const files: StoredUploadSession["files"] = input.files.map((f) => {
      const existing = v.files.find((x) => x.path === f.path);
      const file_id = existing?.file_id ?? newId();
      const row: Schemas["DatasetFile"] = { file_id, path: f.path, size_bytes: f.size_bytes, sha256: f.sha256, media_type: f.media_type.trim().toLowerCase(), status: "PENDING" };
      if (existing) Object.assign(existing, row);
      else v.files.push(row);
      const upload =
        f.size_bytes > PART
          ? {
              method: "MULTIPART" as const,
              part_size_bytes: PART,
              parts: Array.from({ length: Math.ceil(f.size_bytes / PART) }, (_, i) => ({ part_number: i + 1, url: `${origin}/mock-storage/${bucket}/uploads/${file_id}/${i + 1}` })),
            }
          : { method: "PUT" as const, url: `${origin}/mock-storage/${bucket}/uploads/${file_id}`, headers: { "Content-Type": row.media_type } };
      return { file_id, path: f.path, status: "PENDING" as const, failure_code: null, upload };
    });
    recompute(v);
    const session: StoredUploadSession = {
      upload_session_id: newId(),
      dataset_version_id: v.dataset_version_id,
      status: "OPEN",
      expires_at: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
      files,
      created_by: user.user_id,
    };
    db.uploadSessions.push(session);
    return HttpResponse.json(uploadSessionView(session), { status: 201 });
  }),

  http.get(`${API}/upload-sessions/:upload_session_id`, ({ request, params }) => {
    const user = currentUser(request);
    const db = getDb();
    const s = db.uploadSessions.find((x) => x.upload_session_id === params.upload_session_id);
    const v = s && db.versions.find((x) => x.dataset_version_id === s.dataset_version_id);
    const ds = v && db.datasets.find((d) => d.dataset_id === v.dataset_id);
    if (!s || !v || !ds || !isOwnerSteward(user, ds.owner_organization_id)) fail("NOT_FOUND", "Upload session not found.");
    // Asynchronous verification (files > 256 MiB are only UPLOADED after complete): the worker finishes on the next poll.
    for (const f of s.files) {
      if (f.status !== "UPLOADED") continue;
      f.status = "VERIFIED";
      const row = v.files.find((x) => x.file_id === f.file_id);
      if (row) row.status = "VERIFIED";
    }
    return HttpResponse.json(uploadSessionView(s));
  }),

  http.delete(`${API}/dataset-versions/:version_id/files/:file_id`, ({ request, params }) => {
    const user = currentUser(request);
    const db = getDb();
    const { v } = stewardVersion(db, String(params.version_id), user);
    requireDraft(v);
    const idx = v.files.findIndex((f) => f.file_id === params.file_id);
    if (idx < 0) fail("NOT_FOUND", "File not found.");
    if (v.files[idx]!.status === "PENDING" && pendingInOpenSession(db, v.files[idx]!.file_id)) fail("CONFLICT", "The file is still being uploaded in an open session.");
    v.files.splice(idx, 1);
    recompute(v);
    return new HttpResponse(null, { status: 204 });
  }),

  http.post(`${API}/upload-sessions/:upload_session_id/complete`, async ({ request, params }) => {
    const user = currentUser(request);
    const db = getDb();
    const s = db.uploadSessions.find((x) => x.upload_session_id === params.upload_session_id);
    const v = s && db.versions.find((x) => x.dataset_version_id === s.dataset_version_id);
    const ds = v && db.datasets.find((d) => d.dataset_id === v.dataset_id);
    if (!s || !v || !ds) fail("NOT_FOUND", "Upload session not found.");
    if (s.created_by !== user.user_id && !isOwnerSteward(user, ds.owner_organization_id)) {
      if (canSeeDataset(user, ds, db)) fail("FORBIDDEN", "Only the session creator or an owner-organization steward can complete it.");
      fail("NOT_FOUND", "Upload session not found.");
    }
    requireDraft(v);
    if (s.status === "EXPIRED" || sessionExpired(s)) {
      s.status = "EXPIRED";
      fail("UPLOAD_SESSION_EXPIRED", "Upload session expired; create a new one.");
    }
    if (s.status !== "OPEN") fail("CONFLICT", "Upload session is already completed.");
    const input = await body<{ parts?: { file_id: string; etags: { part_number: number; etag: string }[] }[] }>(request);
    const pending = s.files.filter((f) => f.status === "PENDING");
    const multipartIds = new Set(pending.filter((f) => f.upload?.method === "MULTIPART").map((f) => f.file_id));
    const given = new Map((input.parts ?? []).map((p) => [p.file_id, p.etags ?? []]));
    const problems: Field[] = [
      ...[...given.keys()].filter((id) => !multipartIds.has(id)).map((file_id) => ({ field: "parts", reason: "UNKNOWN_FILE", file_id })),
      ...[...multipartIds].sort().filter((id) => !given.get(id)?.length).map((file_id) => ({ field: "parts", reason: "MISSING_PARTS", file_id })),
    ];
    if (problems.length) invalid(problems, "Multipart files need their part ETags.");
    const syncVerify = pending.reduce((n, f) => n + (v.files.find((x) => x.file_id === f.file_id)?.size_bytes ?? 0), 0) <= SYNC_VERIFY_MAX;
    for (const f of pending) {
      const row = v.files.find((x) => x.file_id === f.file_id);
      const expected = f.upload?.method === "MULTIPART" ? f.upload.parts.length : 0;
      let failure: string | null = null;
      if (f.path.includes("corrupt")) failure = "CHECKSUM_MISMATCH";
      else if (expected && given.get(f.file_id)!.length !== expected) failure = "OBJECT_MISSING";
      f.status = failure ? "FAILED" : syncVerify ? "VERIFIED" : "UPLOADED";
      f.failure_code = failure;
      if (row) row.status = f.status;
    }
    s.status = "COMPLETED";
    return HttpResponse.json(uploadSessionView(s));
  }),

  http.post(`${API}/dataset-versions/:version_id/publish`, async ({ request, params }) => {
    const user = currentUser(request);
    const db = getDb();
    const { v, ds } = stewardVersion(db, String(params.version_id), user);
    requireDraft(v);
    if (ds.status === "WITHDRAWN") fail("CONFLICT", "WITHDRAWN datasets cannot publish versions.");
    const notReady = v.files.filter((f) => f.status !== "VERIFIED");
    if (!v.files.length || notReady.length) {
      fail("DATASET_VERSION_INCOMPLETE", "Publishing needs at least one file and every file VERIFIED.", { files: notReady.map((f) => ({ file_id: f.file_id, path: f.path, status: f.status })) });
    }
    v.manifest_sha256 = await manifestSha256(v.files);
    v.status = "PUBLISHED";
    v.published_at = nowIso();
    ds.updated_at = v.published_at;
    queueValidation(db, v.dataset_version_id, "GENERIC_BASIC", "AUTO_ON_PUBLISH");
    if (v.files.some((f) => isTabular(f.path))) queueValidation(db, v.dataset_version_id, "TABULAR_ML_BASIC", "AUTO_ON_PUBLISH");
    recordAudit(db, { action: "DATASET_VERSION_PUBLISHED", actor: user, resource: { type: "DATASET_VERSION", id: v.dataset_version_id, owner_organization_id: ds.owner_organization_id } });
    // M09 §7.3: every holder of an ACTIVE grant on the dataset hears about the new version.
    const holders = db.grants.filter((g) => g.dataset_id === ds.dataset_id && g.status === "ACTIVE" && Date.parse(g.expires_at) > Date.now()).map((g) => g.subject_user_id);
    notify(db, holders, "DATASET_PUBLISHED", `"${ds.title}" 새 버전 ${v.version_label}이(가) 게시되었습니다`, `/commons/data/${ds.dataset_id}`);
    return HttpResponse.json(versionView(db, v));
  }),
];
