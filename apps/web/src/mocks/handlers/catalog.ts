import { http, HttpResponse } from "msw";
import type { Schemas } from "@/shared/api/types";
import { getDb } from "../db";
import { API, body, currentUser, fail, newestFirst, newId, notify, nowIso, orgName, paginate, publicOrigin, recordAudit } from "../http";
import { buildResult } from "../readiness-results";
import { emptyResearch } from "../fixtures";
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

const NULLABLE = new Set(["subtitle", "project_title", "project_code", "funding_agency", "method_detail", "temporal_start", "temporal_end", "collecting_organization_id", "collecting_organization_name"]);
const SCHEME_OF = { subject_codes: "SUBJECT", method_codes: "METHOD", material_codes: "MATERIAL" } as const;
const CODE_MAX = { subject_codes: 5, method_codes: 10, material_codes: 20 } as const;
const UPDATE_FREQUENCIES = ["ONCE", "MONTHLY", "QUARTERLY", "YEARLY", "IRREGULAR"];
const CODE_PATTERN = /^[A-Z0-9_]{2,64}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DOI_PATTERN = /^10\.\d{4,9}\/\S+$/;
const URL_PATTERN = /^https?:\/\/\S+$/;
// pydantic-style reasons (platform/errors.py puts err["msg"] into `reason`) for format errors the backend does not name itself.
const TOO_LONG = (n: number) => `String should have at most ${n} characters`;
const NO_MATCH = (pattern: string) => `String should match pattern '${pattern}'`;
const isIsoDate = (v: unknown): v is string => typeof v === "string" && ISO_DATE.test(v) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;

const INTERNAL_KEYS = ["principal_investigator_id", "principal_investigator_org_id", "data_steward_contact_id", "data_steward_contact_org_id", "collecting_organization_id", "collecting_organization_name"] as const;

function orgRef(db: MockDb, ds: StoredDataset): Schemas["OrganizationRef"] | null {
  if (ds.collecting_organization_id) return { organization_id: ds.collecting_organization_id, name: orgName(db, ds.collecting_organization_id) };
  if (ds.collecting_organization_name) return { organization_id: null, name: ds.collecting_organization_name };
  return null;
}

function personOf(db: MockDb, userId: string, affiliation: string): Schemas["DatasetPerson"] {
  const u = db.users.find((x) => x.user_id === userId);
  return {
    user_id: userId,
    display_name: u?.display_name ?? userId,
    national_researcher_number: u?.national_researcher_number ?? null,
    status: u && u.status === "ACTIVE" && u.membership_status === "ACTIVE" ? "ACTIVE" : "DISABLED",
    affiliation: { organization_id: affiliation, name: orgName(db, affiliation) },
    current_organization: u ? { organization_id: u.organization_id, name: orgName(db, u.organization_id) } : null,
  };
}

const eligibleMember = (u: MockUser | undefined, owner: string) => !!u && u.status === "ACTIVE" && u.membership_status === "ACTIVE" && u.organization_id === owner;

export function peopleBlock(db: MockDb, ds: StoredDataset): Schemas["DatasetPeople"] {
  const steward = ds.data_steward_contact_id ? db.users.find((u) => u.user_id === ds.data_steward_contact_id) : undefined;
  const absent = !eligibleMember(steward, ds.owner_organization_id);
  const contact = ds.data_steward_contact_id ? personOf(db, ds.data_steward_contact_id, ds.data_steward_contact_org_id!) : null;
  if (contact && ds.contact_email_public && !absent && steward) contact.email = steward.email;
  return {
    principal_investigator: ds.principal_investigator_id ? personOf(db, ds.principal_investigator_id, ds.principal_investigator_org_id!) : null,
    steward_contact: contact,
    contributors: db.contributors
      .filter((c) => c.dataset_id === ds.dataset_id)
      .sort((a, b) => a.position - b.position)
      .map((c) => ({ ...personOf(db, c.user_id, c.affiliation_organization_id), role: c.role })),
    steward_contact_absent: absent,
  };
}

/** Mirrors the backend NoGrants stance for previews (P6) only; downloads honour ACTIVE, unexpired grants. */
export function canDownload(user: MockUser, ds: StoredDataset, db: MockDb): boolean {
  return (
    isPlatformAdmin(user) ||
    user.organization_id === ds.owner_organization_id ||
    ds.access_level === "PUBLIC" ||
    db.grants.some((g) => g.subject_user_id === user.user_id && g.dataset_id === ds.dataset_id && g.status === "ACTIVE" && Date.parse(g.expires_at) > Date.now())
  );
}

function statsOf(db: MockDb, datasetId: string): Schemas["Dataset"]["stats"] {
  const v = db.versions.filter((x) => x.dataset_id === datasetId && x.status === "PUBLISHED").sort(newestFirst("published_at"))[0];
  if (!v) return undefined;
  return { file_count: v.file_count, total_bytes: v.total_bytes, media_types: [...new Set(v.files.map((f) => f.media_type))].sort() };
}

export function datasetView(db: MockDb, ds: StoredDataset): Schemas["Dataset"] {
  const rest: Partial<StoredDataset> = { ...ds };
  for (const k of INTERNAL_KEYS) delete rest[k];
  const stats = statsOf(db, ds.dataset_id);
  return { ...(rest as Schemas["Dataset"]), people: peopleBlock(db, ds), collecting_organization: orgRef(db, ds), ...(stats ? { stats } : {}), latest_published_version: latestPublished(db, ds.dataset_id) };
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
function validateDataset(input: (Partial<Schemas["DatasetCreate"]> | Schemas["DatasetUpdate"]) & { status?: string }, partial: boolean) {
  const fields: Field[] = [];
  const text = (name: string, value: unknown, min: number, max: number) => {
    if (typeof value !== "string" || value.length < min || value.length > max) fields.push({ field: name, reason: "LENGTH" });
  };
  // StrictIn rejects null except on the nullable research fields (clearing); everything else has no "clear" semantics.
  for (const [k, v] of Object.entries(input)) if (v === null && !(partial && NULLABLE.has(k))) fields.push({ field: k, reason: "NULL_NOT_ALLOWED" });
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

  // Research metadata (Wave 1.5): length / pattern / enum errors carry pydantic-style reasons (P5).
  const research = input as Record<string, unknown>;
  const present = (k: string) => research[k] !== undefined && research[k] !== null;
  const maxText = (k: string, max: number) => {
    if (!present(k)) return;
    if (typeof research[k] !== "string") fields.push({ field: k, reason: "Input should be a valid string" });
    else if ((research[k] as string).length > max) fields.push({ field: k, reason: TOO_LONG(max) });
  };
  maxText("subtitle", 160);
  maxText("project_title", 300);
  maxText("project_code", 64);
  maxText("funding_agency", 200);
  maxText("method_detail", 4000);
  if (present("collecting_organization_name")) {
    const v = research.collecting_organization_name;
    if (typeof v !== "string" || v.length < 1) fields.push({ field: "collecting_organization_name", reason: "String should have at least 1 character" });
    else if (v.length > 200) fields.push({ field: "collecting_organization_name", reason: TOO_LONG(200) });
  }
  for (const [k, max] of Object.entries(CODE_MAX)) {
    if (!present(k)) continue;
    const v = research[k];
    if (!Array.isArray(v)) fields.push({ field: k, reason: "Input should be a valid list" });
    else if (v.length > max) fields.push({ field: k, reason: `List should have at most ${max} items after validation, not ${v.length}` });
    else if (new Set(v).size !== v.length) fields.push({ field: k, reason: "Value error, the list has duplicates" });
    else if (v.some((c) => typeof c !== "string" || !CODE_PATTERN.test(c))) fields.push({ field: k, reason: NO_MATCH(CODE_PATTERN.source) });
  }
  for (const k of ["temporal_start", "temporal_end"]) if (present(k) && !isIsoDate(research[k])) fields.push({ field: k, reason: "Input should be a valid date or datetime, invalid character in year" });
  if (present("update_frequency") && !UPDATE_FREQUENCIES.includes(String(research.update_frequency))) {
    fields.push({ field: "update_frequency", reason: "Input should be 'ONCE', 'MONTHLY', 'QUARTERLY', 'YEARLY' or 'IRREGULAR'" });
  }
  if (present("contact_email_public") && typeof research.contact_email_public !== "boolean") fields.push({ field: "contact_email_public", reason: "Input should be a valid boolean" });
  if (present("related_publications")) {
    const pubs = research.related_publications;
    if (!Array.isArray(pubs)) fields.push({ field: "related_publications", reason: "Input should be a valid list" });
    else if (pubs.length > 20) fields.push({ field: "related_publications", reason: `List should have at most 20 items after validation, not ${pubs.length}` });
    else {
      (pubs as Partial<Schemas["RelatedPublication"]>[]).forEach((pub, i) => {
        const at = `related_publications.${i}`;
        if (typeof pub?.title !== "string") fields.push({ field: `${at}.title`, reason: "Field required" });
        else if (pub.title.length < 1) fields.push({ field: `${at}.title`, reason: "String should have at least 1 character" });
        else if (pub.title.length > 300) fields.push({ field: `${at}.title`, reason: TOO_LONG(300) });
        if (pub?.doi !== undefined && !(typeof pub.doi === "string" && DOI_PATTERN.test(pub.doi))) fields.push({ field: `${at}.doi`, reason: NO_MATCH(DOI_PATTERN.source) });
        if (pub?.url !== undefined && !(typeof pub.url === "string" && URL_PATTERN.test(pub.url))) fields.push({ field: `${at}.url`, reason: NO_MATCH(URL_PATTERN.source) });
      });
    }
  }
  if (!partial) {
    for (const k of ["principal_investigator_id", "data_steward_contact_id"]) if (!present(k)) fields.push({ field: k, reason: "Field required" });
  }
  if (fields.length) invalid(fields);
}

/**
 * research.validate_research: person eligibility (same organization, ACTIVE; only when assigned or changed), vocabulary membership,
 * temporal range, mutually exclusive collecting organization. Returns the `*_org_id` additions for newly assigned persons.
 */
function validateResearch(db: MockDb, owner: string, values: Record<string, unknown>, current?: StoredDataset): Partial<StoredDataset> {
  const problems: Field[] = [];
  const out: Partial<StoredDataset> = {};
  const people = [
    ["principal_investigator_id", "principal_investigator_org_id"],
    ["data_steward_contact_id", "data_steward_contact_org_id"],
  ] as const;
  for (const [field, orgField] of people) {
    const id = values[field];
    if (typeof id !== "string" || (current && current[field] === id)) continue;
    const person = db.users.find((u) => u.user_id === id);
    if (!eligibleMember(person, owner)) problems.push({ field, reason: "PERSON_NOT_ELIGIBLE" });
    else out[orgField] = person!.organization_id;
  }
  for (const [field, scheme] of Object.entries(SCHEME_OF)) {
    const codes = values[field];
    if (Array.isArray(codes) && codes.some((c) => !db.vocabulary.some((t) => t.scheme === scheme && t.code === c))) problems.push({ field, reason: "VOCABULARY_TERM_UNKNOWN" });
  }
  const pick = <K extends keyof StoredDataset>(k: K): StoredDataset[K] | undefined => (k in values ? (values[k] as StoredDataset[K]) : current?.[k]);
  const start = pick("temporal_start") as string | null | undefined;
  const end = pick("temporal_end") as string | null | undefined;
  if (start && end && end < start) problems.push({ field: "temporal_end", reason: "TEMPORAL_RANGE" });
  const orgId = pick("collecting_organization_id");
  const orgText = pick("collecting_organization_name");
  if (orgId && orgText) problems.push({ field: "collecting_organization_name", reason: "MUTUALLY_EXCLUSIVE" });
  if (typeof values.collecting_organization_id === "string" && !db.organizations.some((o) => o.organization_id === values.collecting_organization_id)) {
    problems.push({ field: "collecting_organization_id", reason: "UNKNOWN_ORGANIZATION" });
  }
  if (problems.length) invalid(problems, "Research metadata is invalid.");
  return out;
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
  "subtitle", "principal_investigator_id", "data_steward_contact_id", "contact_email_public", "project_title", "project_code", "funding_agency",
  "subject_codes", "method_codes", "material_codes", "method_detail", "temporal_start", "temporal_end", "collecting_organization_id",
  "collecting_organization_name", "update_frequency", "related_publications",
]);
const RESEARCH_KEYS = [...DATASET_UPDATE_KEYS].filter((k) => !["title", "description", "keywords", "domain", "access_level", "license", "usage_policy", "allowed_purposes", "max_grant_days", "contact_email", "provenance", "status"].includes(k));
const POLICY_INPUTS = new Set(["access_level", "allowed_purposes", "max_grant_days"]);

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

/** documents.build_documents: what `q` searches (title, description, keywords, owner, subtitle, vocabulary labels, PI, collecting organization). */
function searchText(db: MockDb, ds: StoredDataset): string[] {
  const labels = (["subject_codes", "material_codes", "method_codes"] as const).flatMap((field) =>
    (ds[field] ?? []).flatMap((code) => {
      const t = db.vocabulary.find((x) => x.scheme === SCHEME_OF[field] && x.code === code);
      return t ? [t.label_ko, t.label_en] : [];
    }),
  );
  const pi = ds.principal_investigator_id ? db.users.find((u) => u.user_id === ds.principal_investigator_id)?.display_name : undefined;
  return [ds.title, ds.description, ...(ds.keywords ?? []), orgName(db, ds.owner_organization_id), ds.subtitle ?? "", ...labels, pi ?? "", orgRef(db, ds)?.name ?? ""];
}

const SCHEMES = ["SUBJECT", "METHOD", "MATERIAL"];
const CONTRIBUTOR_ROLES = ["CO_INVESTIGATOR", "DATA_COLLECTOR", "DATA_CURATOR"];
const IRI_PATTERN = /^https?:\/\/\S+$/;

function schemeOf(raw: unknown): Schemas["VocabularyScheme"] {
  if (!SCHEMES.includes(String(raw))) invalid([{ field: "scheme", reason: "Input should be 'SUBJECT', 'METHOD' or 'MATERIAL'" }]);
  return raw as Schemas["VocabularyScheme"];
}

const JSONLD_CONTEXT = {
  "@vocab": "https://schema.org/",
  dcat: "http://www.w3.org/ns/dcat#",
  dct: "http://purl.org/dc/terms/",
  prov: "http://www.w3.org/ns/prov#",
};

function ldOrg(base: string, ref: Schemas["OrganizationRef"]) {
  return ref.organization_id ? { "@type": "Organization", "@id": `${base}/id/organization/${ref.organization_id}`, name: ref.name } : { "@type": "Organization", name: ref.name };
}

function ldPerson(base: string, p: Schemas["DatasetPerson"]) {
  return {
    "@type": "Person",
    "@id": `${base}/id/person/${p.user_id}`,
    name: p.display_name,
    ...(p.national_researcher_number ? { identifier: { "@type": "PropertyValue", propertyID: "NTIS", value: p.national_researcher_number } } : {}),
    affiliation: ldOrg(base, p.affiliation),
    ...(p.email ? { email: p.email } : {}),
  };
}

function ldTerms(db: MockDb, base: string, scheme: Schemas["VocabularyScheme"], codes: string[]) {
  return codes.map((code) => {
    const t = db.vocabulary.find((x) => x.scheme === scheme && x.code === code);
    return {
      "@type": "DefinedTerm",
      "@id": `${base}/vocabulary/${scheme}/${code}`,
      termCode: code,
      name: t?.label_ko ?? code,
      inDefinedTermSet: `${base}/vocabulary/${scheme}`,
      ...(t?.iri ? { sameAs: t.iri } : {}),
    };
  });
}

/** jsonld.dataset_jsonld (backend Task 8, P7: DefinedTerm @id). */
function datasetJsonLd(db: MockDb, ds: StoredDataset, base: string): Record<string, unknown> {
  const people = peopleBlock(db, ds);
  const latest = latestPublished(db, ds.dataset_id);
  const collecting = orgRef(db, ds);
  const doc: Record<string, unknown> = {
    "@context": JSONLD_CONTEXT,
    "@type": ["Dataset", "dcat:Dataset"],
    "@id": `${base}/id/dataset/${ds.dataset_id}`,
    identifier: ds.dataset_id,
    name: ds.title,
    description: ds.description,
    keywords: ds.keywords ?? [],
    license: ds.license,
    conditionsOfAccess: ds.access_level,
    dateCreated: ds.created_at,
    dateModified: ds.updated_at,
    "dct:accrualPeriodicity": ds.update_frequency ?? "ONCE",
    publisher: ldOrg(base, { organization_id: ds.owner_organization_id, name: orgName(db, ds.owner_organization_id) }),
    about: [...ldTerms(db, base, "SUBJECT", ds.subject_codes ?? []), ...ldTerms(db, base, "MATERIAL", ds.material_codes ?? [])],
    measurementTechnique: ldTerms(db, base, "METHOD", ds.method_codes ?? []),
    creator: people.principal_investigator ? [ldPerson(base, people.principal_investigator)] : [],
    contributor: people.contributors.map((c) => ({ ...ldPerson(base, c), roleName: c.role })),
    citation: (ds.related_publications ?? []).map((p) => ({ "@type": "ScholarlyArticle", name: p.title, ...(p.doi ? { sameAs: `https://doi.org/${p.doi}` } : p.url ? { url: p.url } : {}) })),
  };
  if (people.steward_contact) doc.maintainer = ldPerson(base, people.steward_contact);
  if (ds.subtitle) doc.alternativeHeadline = ds.subtitle;
  if (ds.usage_policy) doc.usageInfo = ds.usage_policy;
  if (ds.temporal_start) doc.temporalCoverage = `${ds.temporal_start}/${ds.temporal_end ?? ".."}`;
  if (collecting) doc.sourceOrganization = ldOrg(base, collecting);
  if (ds.funding_agency) doc.funder = { "@type": "Organization", name: ds.funding_agency };
  if (ds.project_title || ds.project_code) doc.isPartOf = { "@type": "ResearchProject", name: ds.project_title ?? null, identifier: ds.project_code ?? null };
  if (ds.method_detail) doc["prov:wasGeneratedBy"] = { "@type": "prov:Activity", description: ds.method_detail };
  if (latest) {
    doc.version = latest.version_label;
    doc.datePublished = latest.published_at;
  }
  return doc;
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
    const subjects = url.searchParams.getAll("subject");
    const materials = url.searchParams.getAll("material");
    const methods = url.searchParams.getAll("method");
    const collecting = url.searchParams.getAll("collecting_organization_id");
    const piId = url.searchParams.get("principal_investigator_id");
    const from = url.searchParams.get("temporal_from");
    const to = url.searchParams.get("temporal_to");
    for (const [field, v] of [["temporal_from", from], ["temporal_to", to]] as const) if (v !== null && !isIsoDate(v)) invalid([{ field, reason: "Input should be a valid date or datetime, invalid character in year" }]);
    if (from && to && from > to) invalid([{ field: "temporal_to", reason: "TEMPORAL_RANGE" }], "temporal_from is after temporal_to.");
    const sort = url.searchParams.get("sort") ?? "relevance";
    if (!["relevance", "updated_desc", "title_asc"].includes(sort)) invalid([{ field: "sort", reason: "INVALID" }]);
    const effectiveSort = sort === "relevance" && !q ? "updated_desc" : sort;

    // query.build_search_body: every filter (and the visibility rule) narrows both the hits and the facet counts.
    const matches = db.datasets
      .filter((ds) => ds.status === "ACTIVE" && canSeeDataset(user, ds, db))
      .filter((ds) => !q || searchText(db, ds).some((s) => s.toLowerCase().includes(q)))
      .map((ds) => ({ ds, latest: latestPublished(db, ds.dataset_id) }))
      .filter((x) => !levels.length || levels.includes(x.ds.access_level))
      .filter((x) => !owners.length || owners.includes(x.ds.owner_organization_id))
      .filter((x) => !purposes.length || x.ds.policy.allowed_purposes.some((p) => purposes.includes(p)))
      .filter((x) => !keywords.length || (x.ds.keywords ?? []).some((k) => keywords.includes(k.toLowerCase())))
      .filter((x) => !readiness.length || (x.latest?.readiness_overall && readiness.includes(x.latest.readiness_overall)))
      .filter((x) => !subjects.length || x.ds.subject_codes?.some((c) => subjects.includes(c)))
      .filter((x) => !materials.length || x.ds.material_codes?.some((c) => materials.includes(c)))
      .filter((x) => !methods.length || x.ds.method_codes?.some((c) => methods.includes(c)))
      .filter((x) => !collecting.length || (x.ds.collecting_organization_id && collecting.includes(x.ds.collecting_organization_id)))
      .filter((x) => !piId || x.ds.principal_investigator_id === piId)
      // Period overlap: needs a start; a missing end is open-ended.
      .filter((x) => (!from && !to) || !!x.ds.temporal_start)
      .filter((x) => !to || x.ds.temporal_start! <= to)
      .filter((x) => !from || !x.ds.temporal_end || x.ds.temporal_end >= from);

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
      subject: facet(matches.flatMap((x) => x.ds.subject_codes ?? [])),
      material: facet(matches.flatMap((x) => x.ds.material_codes ?? [])),
      method: facet(matches.flatMap((x) => x.ds.method_codes ?? [])),
      collecting_organization_id: facet(matches.map((x) => x.ds.collecting_organization_id), (id) => orgName(db, id)),
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
        subtitle: ds.subtitle ?? null,
        principal_investigator_name: ds.principal_investigator_id ? (db.users.find((u) => u.user_id === ds.principal_investigator_id)?.display_name ?? null) : null,
        temporal_start: ds.temporal_start ?? null,
        temporal_end: ds.temporal_end ?? null,
        subject_codes: ds.subject_codes ?? [],
        collecting_organization_name: orgRef(db, ds)?.name ?? null,
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
    const researchInput = Object.fromEntries(RESEARCH_KEYS.filter((k) => (input as Record<string, unknown>)[k] !== undefined).map((k) => [k, (input as Record<string, unknown>)[k]]));
    const orgIds = validateResearch(db, input.owner_organization_id, researchInput);
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
      ...emptyResearch(),
      ...(researchInput as Partial<ReturnType<typeof emptyResearch>>),
      ...orgIds,
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
    const orgIds = validateResearch(db, ds.owner_organization_id, Object.fromEntries(Object.entries(patch).filter(([k]) => RESEARCH_KEYS.includes(k))), ds);
    const before = { ...ds };
    const previous = ds.policy;
    const policy = buildPolicy(patch.access_level ?? ds.access_level, patch.allowed_purposes ?? ds.policy.allowed_purposes, patch.max_grant_days ?? ds.policy.max_grant_days);
    const plain: Partial<Schemas["DatasetUpdate"]> = { ...patch };
    for (const key of ["access_level", "allowed_purposes", "max_grant_days", "keywords"] as const) delete plain[key];
    Object.assign(ds, plain, orgIds, patch.keywords ? { keywords: keywordsOf(patch.keywords) } : {}, { access_level: policy.access_level, updated_at: nowIso() });
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
    // metadata_changed mirror: any non-policy, non-status field that actually changed.
    const changedFields = keys
      .filter((k) => !POLICY_INPUTS.has(k) && k !== "status")
      .filter((k) => JSON.stringify((before as Record<string, unknown>)[k] ?? null) !== JSON.stringify((ds as Record<string, unknown>)[k] ?? null))
      .sort();
    if (changedFields.length) {
      recordAudit(db, { action: "DATASET_UPDATED", actor: user, resource: { type: "DATASET", id: ds.dataset_id, owner_organization_id: ds.owner_organization_id }, details: { changed_fields: changedFields } });
    }
    return HttpResponse.json(datasetView(db, ds));
  }),

  http.get(`${API}/vocabulary/:scheme`, ({ request, params }) => {
    currentUser(request);
    const scheme = schemeOf(params.scheme);
    const items = getDb()
      .vocabulary.filter((t) => t.scheme === scheme)
      .sort((a, b) => (a.parent_code ?? "").localeCompare(b.parent_code ?? "") || a.code.localeCompare(b.code));
    return HttpResponse.json({ items });
  }),

  http.post(`${API}/vocabulary/:scheme`, async ({ request, params }) => {
    const user = currentUser(request);
    const db = getDb();
    const scheme = schemeOf(params.scheme);
    const input = await body<Schemas["VocabularyTermCreate"]>(request);
    const problems: Field[] = [];
    const known = ["code", "label_ko", "label_en", "iri", "parent_code"];
    for (const k of Object.keys(input)) if (!known.includes(k)) problems.push({ field: k, reason: "Extra inputs are not permitted" });
    for (const k of ["code", "label_ko", "label_en"] as const) if (typeof input[k] !== "string") problems.push({ field: k, reason: "Field required" });
    if (typeof input.code === "string" && !CODE_PATTERN.test(input.code)) problems.push({ field: "code", reason: NO_MATCH(CODE_PATTERN.source) });
    for (const k of ["label_ko", "label_en"] as const) {
      const v = input[k];
      if (typeof v === "string" && v.length < 1) problems.push({ field: k, reason: "String should have at least 1 character" });
      else if (typeof v === "string" && v.length > 200) problems.push({ field: k, reason: TOO_LONG(200) });
    }
    if (input.iri !== undefined && !(typeof input.iri === "string" && IRI_PATTERN.test(input.iri))) problems.push({ field: "iri", reason: NO_MATCH(IRI_PATTERN.source) });
    if (input.parent_code !== undefined && !(typeof input.parent_code === "string" && CODE_PATTERN.test(input.parent_code))) problems.push({ field: "parent_code", reason: NO_MATCH(CODE_PATTERN.source) });
    if (problems.length) invalid(problems);
    if (!isPlatformAdmin(user)) fail("FORBIDDEN", "Only a PLATFORM_ADMIN can add vocabulary terms.");
    if (input.parent_code && !db.vocabulary.some((t) => t.scheme === scheme && t.code === input.parent_code)) invalid([{ field: "parent_code", reason: "VOCABULARY_TERM_UNKNOWN" }], "Unknown parent term.");
    if (db.vocabulary.some((t) => t.scheme === scheme && t.code === input.code)) fail("CONFLICT", "This code already exists in the scheme.");
    const term: Schemas["VocabularyTerm"] = { scheme, code: input.code, label_ko: input.label_ko, label_en: input.label_en, iri: input.iri ?? null, parent_code: input.parent_code ?? null };
    db.vocabulary.push(term);
    return HttpResponse.json(term, { status: 201 });
  }),

  http.get(`${API}/datasets/:dataset_id/contributors`, ({ request, params }) => {
    const user = currentUser(request);
    const db = getDb();
    return HttpResponse.json({ items: peopleBlock(db, visibleDataset(db, String(params.dataset_id), user)).contributors });
  }),

  http.put(`${API}/datasets/:dataset_id/contributors`, async ({ request, params }) => {
    const user = currentUser(request);
    const db = getDb();
    const input = await body<Schemas["DatasetContributorsPut"]>(request);
    const shape: Field[] = [];
    if (!Array.isArray(input.contributors)) shape.push({ field: "contributors", reason: "Field required" });
    else if (input.contributors.length > 50) shape.push({ field: "contributors", reason: `List should have at most 50 items after validation, not ${input.contributors.length}` });
    else {
      input.contributors.forEach((c, i) => {
        if (typeof c?.user_id !== "string") shape.push({ field: `contributors.${i}.user_id`, reason: "Field required" });
        if (!CONTRIBUTOR_ROLES.includes(String(c?.role))) shape.push({ field: `contributors.${i}.role`, reason: "Input should be 'CO_INVESTIGATOR', 'DATA_COLLECTOR' or 'DATA_CURATOR'" });
      });
    }
    if (shape.length) invalid(shape);
    const ds = visibleDataset(db, String(params.dataset_id), user);
    requireSteward(user, ds);
    const wanted = input.contributors.map((c) => ({ user_id: c.user_id, role: c.role }));
    const key = (c: { user_id: string; role: string }) => `${c.user_id}|${c.role}`;
    const problems: Field[] = [];
    if (new Set(wanted.map(key)).size !== wanted.length) problems.push({ field: "contributors", reason: "DUPLICATE" });
    const existing = db.contributors.filter((c) => c.dataset_id === ds.dataset_id).sort((a, b) => a.position - b.position);
    const existingKeys = new Set(existing.map(key));
    wanted.forEach((c, i) => {
      if (existingKeys.has(key(c))) return;
      const u = db.users.find((x) => x.user_id === c.user_id);
      if (!u || u.status !== "ACTIVE" || u.membership_status !== "ACTIVE") problems.push({ field: `contributors[${i}].user_id`, reason: "PERSON_NOT_ELIGIBLE" });
    });
    if (problems.length) invalid(problems, "Contributors are invalid.");
    if (wanted.map(key).join() !== existing.map(key).join()) {
      const rows = wanted.map((c, position) => ({
        dataset_id: ds.dataset_id,
        user_id: c.user_id,
        role: c.role,
        // Unchanged pairs keep their at-the-time affiliation; new ones take the person's current organization.
        affiliation_organization_id: existing.find((e) => key(e) === key(c))?.affiliation_organization_id ?? db.users.find((u) => u.user_id === c.user_id)!.organization_id,
        position,
      }));
      db.contributors = [...db.contributors.filter((c) => c.dataset_id !== ds.dataset_id), ...rows];
      ds.updated_at = nowIso();
      recordAudit(db, { action: "DATASET_UPDATED", actor: user, resource: { type: "DATASET", id: ds.dataset_id, owner_organization_id: ds.owner_organization_id }, details: { changed_fields: ["contributors"] } });
    }
    return HttpResponse.json({ items: peopleBlock(db, ds).contributors });
  }),

  http.get(`${API}/datasets/:dataset_id/metadata.jsonld`, ({ request, params }) => {
    const user = currentUser(request);
    const db = getDb();
    const ds = visibleDataset(db, String(params.dataset_id), user);
    return HttpResponse.json(datasetJsonLd(db, ds, publicOrigin(request)), { headers: { "Content-Type": "application/ld+json" } });
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
