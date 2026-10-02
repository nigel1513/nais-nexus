import { http, HttpResponse } from "msw";
import type { Schemas } from "@/shared/api/types";
import { getDb } from "../db";
import { emptyResearch } from "../fixtures";
import { API, body, currentUser, fail, newestFirst, newId, notify, nowIso, orgName, paginate, publicOrigin, recordAudit, validationFailed } from "../http";
import { applySteps, InputProblem, neededInputs, PREVIEW_INPUT_ROWS, PREVIEW_RESULT_ROWS, previewRows, readInput, schemaOnly, StepError, type Table, toCsv } from "../recipes";
import { sha256Hex } from "../sha256";
import type { MockDb, MockUser, PinnedInput, StoredDataset, StoredInput, StoredOutput, StoredPublishRequest, StoredRecipe, StoredRun, StoredThread, StoredVersion } from "../types";
import { ALLOWED_MEDIA, bucketOf, canSeeDataset } from "./catalog";
import { memberOf } from "./projects";

/**
 * Mirrors apps/api/modules/workspace (access.py, service/{inputs,recipes,runs,outputs,publish,threads}.py, jobs.py):
 * read = ACTIVE project member (404 otherwise), write = member other than VIEWER (403) of an ACTIVE project
 * (409 PROJECT_ARCHIVED, or 403 where the contract lists no 409). Dataset use needs PUBLIC, the caller's own
 * organization, or an ACTIVE unexpired grant from the governance store (`db.grants`). Runs and hub publication are
 * asynchronous in the backend; here a run advances on reads (QUEUED → RUNNING → finished) and an approved publication
 * is carried out right after the decision response is built (the worker "after commit").
 */
const STRICTNESS: Schemas["AccessLevel"][] = ["PUBLIC", "INTERNAL", "CONTROLLED", "SENSITIVE"];
const NO_INPUTS_FLOOR: Schemas["AccessLevel"] = "INTERNAL";
const UPLOAD_TTL_MS = 15 * 60_000;
const DOWNLOAD_TTL_MS = 300_000;
const RESULT_NAME = "result.parquet";
const RESULT_MEDIA_TYPE = "application/vnd.apache.parquet";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SCOPES: Schemas["ThreadScope"][] = ["PROJECT", "DATASET", "OUTPUT", "RECIPE"];

// ---------------------------------------------------------------- access (access.py)

export function roleOf(db: MockDb, projectId: string, userId: string): Schemas["ProjectRole"] | null {
  return memberOf(db, projectId, userId)?.role ?? null;
}

export function isActiveMember(db: MockDb, projectId: string, userId: string): boolean {
  return !!memberOf(db, projectId, userId) && db.projects.find((p) => p.project_id === projectId)?.status === "ACTIVE";
}

/** ProjectQueryPort.list_project_ids_for_member. */
export const memberProjectIds = (db: MockDb, userId: string) => new Set(db.projectMembers.filter((m) => m.user_id === userId).map((m) => m.project_id));

function requireReader(db: MockDb, projectId: string, user: MockUser) {
  if (!roleOf(db, projectId, user.user_id)) fail("NOT_FOUND", "Project not found.");
}

function requireWriter(db: MockDb, projectId: string, user: MockUser) {
  const role = roleOf(db, projectId, user.user_id);
  if (!role || role === "VIEWER") fail("FORBIDDEN", "Only project members other than VIEWER can change the workspace.");
  if (!isActiveMember(db, projectId, user.user_id)) fail("PROJECT_ARCHIVED", "The project is archived.");
}

function requireOpenWriter(db: MockDb, projectId: string, user: MockUser) {
  const role = roleOf(db, projectId, user.user_id);
  if (!role || role === "VIEWER") fail("FORBIDDEN", "Only project members other than VIEWER can change the workspace.");
  if (!isActiveMember(db, projectId, user.user_id)) fail("FORBIDDEN", "The project is archived; its workspace is read-only.");
}

export function hasActiveGrant(db: MockDb, userId: string, datasetId: string): boolean {
  return db.grants.some((g) => g.subject_user_id === userId && g.dataset_id === datasetId && g.status === "ACTIVE" && Date.parse(g.expires_at) > Date.now());
}

/** access.dataset_access: PUBLIC, the user's own organization's dataset, or an ACTIVE grant (no platform-admin bypass). */
export function datasetAccess(db: MockDb, who: { user_id: string; organization_id: string }, ds: StoredDataset | undefined): boolean {
  return !!ds && (ds.access_level === "PUBLIC" || who.organization_id === ds.owner_organization_id || hasActiveGrant(db, who.user_id, ds.dataset_id));
}

const datasetOf = (db: MockDb, id: string) => db.datasets.find((d) => d.dataset_id === id);
const versionOf = (db: MockDb, id: string) => db.versions.find((v) => v.dataset_version_id === id);
const accessible = (db: MockDb, user: MockUser, datasetId: string) => datasetAccess(db, user, datasetOf(db, datasetId));
const stricter = (a: Schemas["AccessLevel"], b: Schemas["AccessLevel"]) => (STRICTNESS.indexOf(a) >= STRICTNESS.indexOf(b) ? a : b);

function requireNotLooser(requested: Schemas["AccessLevel"], floor: Schemas["AccessLevel"]) {
  if (STRICTNESS.indexOf(requested) < STRICTNESS.indexOf(floor)) {
    fail("VALIDATION_FAILED", `access_level may not be looser than ${floor}, the strictest level of the project's inputs.`, { field: "access_level", minimum: floor });
  }
}

/** outputs.current_floor: strictest current level of the datasets (missing → SENSITIVE); INTERNAL with none. */
function currentFloor(db: MockDb, datasetIds: string[]): Schemas["AccessLevel"] {
  if (!datasetIds.length) return NO_INPUTS_FLOOR;
  return datasetIds.map((id) => datasetOf(db, id)?.access_level ?? "SENSITIVE").reduce(stricter);
}

function latestPublished(db: MockDb, datasetId: string): StoredVersion | undefined {
  return db.versions.filter((v) => v.dataset_id === datasetId && v.status === "PUBLISHED").sort(newestFirst("published_at"))[0];
}

const displayName = (db: MockDb, userId: string) => db.users.find((u) => u.user_id === userId)?.display_name ?? "";
const projectName = (db: MockDb, projectId: string) => db.projects.find((p) => p.project_id === projectId)?.name ?? "";
const leadOrg = (db: MockDb, projectId: string) => db.projects.find((p) => p.project_id === projectId)!.lead_organization_id;

// ---------------------------------------------------------------- request-body checks (pydantic models)

function only(raw: unknown, allowed: string[], field = "body"): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) validationFailed(field, "INVALID_TYPE");
  const extra = Object.keys(raw as object).find((k) => !allowed.includes(k));
  if (extra) validationFailed(extra, "EXTRA_FORBIDDEN");
  return raw as Record<string, unknown>;
}

const isUuid = (v: unknown): v is string => typeof v === "string" && UUID.test(v);
const isText = (v: unknown, min: number, max: number): v is string => typeof v === "string" && v.length >= min && v.length <= max;

function uuidList(v: unknown, field: string, max = 10) {
  if (!Array.isArray(v) || v.length < 1 || v.length > max) validationFailed(field, "LENGTH");
  if (!v.every(isUuid)) validationFailed(field, "INVALID_UUID");
  if (new Set(v).size !== v.length) validationFailed(field, "NOT_UNIQUE");
  return v as string[];
}

const STEP_KEYS: Record<Schemas["RecipeStepType"], [required: string[], optional: string[]]> = {
  select_columns: [["columns"], []],
  filter_rows: [["column", "op"], ["value"]],
  drop_missing: [["columns"], []],
  fill_missing: [["column", "value"], []],
  cast_type: [["column", "to"], []],
  convert_unit: [["column", "factor", "offset", "unit_label"], []],
  aggregate: [["group_by", "metrics"], []],
  join: [["right_input_id", "on", "how"], []],
  sort: [["by", "descending"], []],
  limit: [["n"], []],
};

/** model.py: the RecipeStep oneOf (strict JSON types, distinct column lists). */
function validateSteps(v: unknown, field = "steps"): Schemas["RecipeStep"][] {
  if (!Array.isArray(v) || v.length > 50) validationFailed(field, "LENGTH");
  const names = (x: unknown, min = 1) => Array.isArray(x) && x.length >= min && x.every((c) => isText(c, 1, 255)) && new Set(x).size === x.length;
  const scalar = (x: unknown) => typeof x === "string" || typeof x === "boolean" || (typeof x === "number" && Number.isFinite(x));
  v.forEach((step: Record<string, unknown>, i: number) => {
    const at = `${field}.${i}`;
    const keys = STEP_KEYS[step?.type as Schemas["RecipeStepType"]];
    if (!keys) validationFailed(`${at}.type`, "UNKNOWN_STEP_TYPE");
    const [required, optional] = keys;
    const extra = Object.keys(step).find((k) => k !== "type" && !required.includes(k) && !optional.includes(k));
    if (extra) validationFailed(`${at}.${extra}`, "EXTRA_FORBIDDEN");
    const missing = required.find((k) => !(k in step));
    if (missing) validationFailed(`${at}.${missing}`, "MISSING");
    const bad = (k: string) => validationFailed(`${at}.${k}`, "INVALID");
    switch (step.type) {
      case "select_columns":
        if (!names(step.columns)) bad("columns");
        break;
      case "filter_rows":
        if (!isText(step.column, 1, 255)) bad("column");
        if (!["eq", "ne", "lt", "le", "gt", "ge", "contains", "in", "is_null", "not_null"].includes(step.op as string)) bad("op");
        if (step.value !== undefined && step.value !== null && !scalar(step.value) && !(Array.isArray(step.value) && step.value.length <= 1000 && step.value.every((x) => typeof x !== "boolean" && scalar(x)))) bad("value");
        break;
      case "drop_missing":
        if (step.columns !== null && !(Array.isArray(step.columns) && (step.columns.length === 0 || names(step.columns)))) bad("columns");
        break;
      case "fill_missing":
        if (!isText(step.column, 1, 255)) bad("column");
        if (!scalar(step.value)) bad("value");
        break;
      case "cast_type":
        if (!isText(step.column, 1, 255)) bad("column");
        if (!["int", "float", "string", "bool", "datetime"].includes(step.to as string)) bad("to");
        break;
      case "convert_unit":
        if (!isText(step.column, 1, 255)) bad("column");
        if (typeof step.factor !== "number" || !Number.isFinite(step.factor)) bad("factor");
        if (typeof step.offset !== "number" || !Number.isFinite(step.offset)) bad("offset");
        if (!isText(step.unit_label, 1, 32)) bad("unit_label");
        break;
      case "aggregate":
        if (!Array.isArray(step.group_by) || !(step.group_by.length === 0 || names(step.group_by))) bad("group_by");
        if (!Array.isArray(step.metrics) || !step.metrics.length || !step.metrics.every((m: Record<string, unknown>) => m && isText(m.column, 1, 255) && ["count", "sum", "mean", "min", "max"].includes(m.fn as string) && Object.keys(m).length === 2)) bad("metrics");
        break;
      case "join":
        if (!isUuid(step.right_input_id)) bad("right_input_id");
        if (!names(step.on)) bad("on");
        if (step.how !== "inner" && step.how !== "left") bad("how");
        break;
      case "sort":
        if (!names(step.by)) bad("by");
        if (typeof step.descending !== "boolean") bad("descending");
        break;
      case "limit":
        if (!Number.isInteger(step.n) || (step.n as number) < 1 || (step.n as number) > 5_000_000) bad("n");
        break;
    }
  });
  return v as Schemas["RecipeStep"][];
}

function statuses<T extends string>(url: URL, allowed: readonly T[]): T[] | null {
  const values = url.searchParams.getAll("status");
  if (values.some((s) => !allowed.includes(s as T))) validationFailed("status", "INVALID_ENUM");
  return values.length ? (values as T[]) : null;
}

// ---------------------------------------------------------------- inputs (service/inputs.py)

function inputView(db: MockDb, user: MockUser, row: StoredInput): Schemas["ProjectInput"] {
  const ds = datasetOf(db, row.dataset_id)!;
  const pinned = versionOf(db, row.dataset_version_id)!;
  const newest = latestPublished(db, row.dataset_id);
  return {
    input_id: row.input_id,
    project_id: row.project_id,
    dataset_id: row.dataset_id,
    dataset_title: ds.title,
    dataset_version_id: row.dataset_version_id,
    version_label: pinned.version_label,
    newer_version_label: newest && newest.dataset_version_id !== pinned.dataset_version_id ? newest.version_label : null,
    access_level: ds.access_level,
    access_lapsed: !datasetAccess(db, user, ds),
    added_by: row.added_by,
    added_by_display_name: displayName(db, row.added_by),
    added_at: row.added_at,
    note: row.note,
  };
}

const liveInputs = (db: MockDb, projectId: string) => db.inputs.filter((i) => i.project_id === projectId && !i.removed_at);

/** Visible (404) and ACTIVE (409) dataset. */
function usableDataset(db: MockDb, user: MockUser, datasetId: string): StoredDataset {
  const ds = datasetOf(db, datasetId);
  if (!ds || !canSeeDataset(user, ds, db)) fail("NOT_FOUND", "Dataset not found.");
  if (ds.status !== "ACTIVE") fail("CONFLICT", "The dataset is withdrawn.");
  return ds;
}

function publishedVersion(db: MockDb, datasetId: string, versionId: string | undefined): StoredVersion {
  if (versionId === undefined) {
    const latest = latestPublished(db, datasetId);
    if (!latest) fail("DATASET_VERSION_NOT_PUBLISHED", "The dataset has no published version.");
    return latest;
  }
  const v = versionOf(db, versionId);
  if (!v) fail("NOT_FOUND", "Dataset version not found.");
  if (v.dataset_id !== datasetId) fail("VALIDATION_FAILED", "dataset_version_id does not belong to the dataset.", { field: "dataset_version_id" });
  if (v.status !== "PUBLISHED") fail("DATASET_VERSION_NOT_PUBLISHED", "Only a PUBLISHED version can be pinned.");
  return v;
}

function requireAccess(db: MockDb, user: MockUser, ds: StoredDataset) {
  if (!datasetAccess(db, user, ds)) fail("ACCESS_REQUIRED", "An active access grant for this dataset is required.", { dataset_id: ds.dataset_id });
}

function liveInput(db: MockDb, projectId: string, inputId: string): StoredInput {
  const row = db.inputs.find((i) => i.input_id === inputId && i.project_id === projectId && !i.removed_at);
  if (!row) fail("NOT_FOUND", "Input not found.");
  return row;
}

// ---------------------------------------------------------------- recipes (service/recipes.py)

const recipeView = (r: StoredRecipe): Schemas["Recipe"] => ({ recipe_id: r.recipe_id, project_id: r.project_id, name: r.name, input_ids: [...r.input_ids], steps: r.steps, version: r.version, updated_by: r.updated_by, updated_at: r.updated_at });

function liveRecipe(db: MockDb, projectId: string, recipeId: string): StoredRecipe {
  const r = db.recipes.find((x) => x.recipe_id === recipeId && x.project_id === projectId && !x.deleted_at);
  if (!r) fail("NOT_FOUND", "Recipe not found.");
  return r;
}

const recipeInvalid = (e: StepError): never => fail("RECIPE_INVALID", e.message, e.details());

function inputProblem(inputId: string, reason: string, message: string): never {
  return recipeInvalid(new StepError(null, reason, message, undefined, inputId));
}

/** resolve_inputs: the recipe's live inputs in order; a removed or foreign id is 422 RECIPE_INVALID (UNKNOWN_INPUT). */
function resolveInputs(db: MockDb, projectId: string, inputIds: string[]): StoredInput[] {
  return inputIds.map((id) => db.inputs.find((i) => i.input_id === id && i.project_id === projectId && !i.removed_at) ?? inputProblem(id, "UNKNOWN_INPUT", "The recipe uses an input that is not in the project."));
}

function requireLiveAccess(db: MockDb, user: MockUser, inputs: StoredInput[]) {
  const lapsed = inputs.filter((i) => !accessible(db, user, i.dataset_id)).map((i) => i.input_id);
  if (lapsed.length) fail("INPUT_ACCESS_LAPSED", "Access to an input of this recipe was revoked or expired.", { input_ids: lapsed });
}

const INPUT_MESSAGES: Record<InputProblem["reason"], string> = {
  INPUT_UNAVAILABLE: "The input's pinned version is not published.",
  INPUT_NOT_TABULAR: "The input's version has no CSV or Parquet file to read.",
  INPUT_UNREADABLE: "The input file cannot be parsed.",
};

function readTables(db: MockDb, byId: Map<string, StoredInput>, ids: string[], maxRows?: number): Map<string, Table> {
  const out = new Map<string, Table>();
  for (const id of ids) {
    const input = byId.get(id);
    if (!input) continue; // a join outside the recipe: applySteps reports it with its step index
    try {
      out.set(id, readInput(db, input.dataset_version_id, maxRows));
    } catch (e) {
      if (e instanceof InputProblem) inputProblem(id, e.reason, INPUT_MESSAGES[e.reason]);
      throw e;
    }
  }
  return out;
}

function runSteps(steps: Schemas["RecipeStep"][], tables: Map<string, Table>, inputIds: string[]): Table {
  try {
    return applySteps(steps, tables, inputIds);
  } catch (e) {
    if (e instanceof StepError) recipeInvalid(e);
    throw e;
  }
}

/** recipes.validate: inputs exist, joins reference recipe inputs, steps fit the inputs' columns. */
function validateRecipe(db: MockDb, projectId: string, inputIds: string[], steps: Schemas["RecipeStep"][]) {
  const resolved = resolveInputs(db, projectId, inputIds);
  steps.forEach((s, index) => {
    if (s.type === "join" && !inputIds.includes(s.right_input_id)) {
      recipeInvalid(new StepError(index, "UNKNOWN_INPUT", `Step ${index + 1} (join): the joined input is not one of the recipe's inputs.`, undefined, s.right_input_id));
    }
  });
  const byId = new Map(resolved.map((i) => [i.input_id, i]));
  const schemas = new Map([...readTables(db, byId, neededInputs(steps, inputIds), PREVIEW_INPUT_ROWS)].map(([id, t]) => [id, schemaOnly(t)]));
  runSteps(steps, schemas, inputIds);
}

function recipeBody(raw: unknown) {
  const b = only(raw, ["name", "input_ids", "steps"]);
  if (!isText(b.name, 1, 200)) validationFailed("name", "LENGTH");
  const inputIds = uuidList(b.input_ids, "input_ids");
  const steps = validateSteps(b.steps);
  return { name: b.name as string, input_ids: inputIds, steps };
}

function ifMatch(request: Request): number {
  const raw = request.headers.get("if-match");
  const m = raw ? /^"?([1-9][0-9]*)"?$/.exec(raw.trim()) : null;
  if (!m) validationFailed("If-Match", raw ? "INVALID" : "MISSING");
  return Number(m[1]);
}

// ---------------------------------------------------------------- runs (service/runs.py, jobs.run_recipe)

const runView = (r: StoredRun): Schemas["Run"] => ({
  run_id: r.run_id,
  project_id: r.project_id,
  recipe_id: r.recipe_id,
  recipe_version: r.recipe_version,
  status: r.status,
  started_by: r.started_by,
  queued_at: r.queued_at,
  started_at: r.started_at,
  finished_at: r.finished_at,
  input_rows: r.input_rows,
  output_rows: r.output_rows,
  error: r.error,
  output_id: r.output_id,
});

const summary = (code: string, text: string) => `${code}: ${text}`.slice(0, 500);

function failRun(db: MockDb, run: StoredRun, recipeName: string, error: string) {
  run.status = "FAILED";
  run.error = error.slice(0, 500);
  run.finished_at = nowIso();
  const starter = db.users.find((u) => u.user_id === run.started_by) ?? null;
  recordAudit(db, { action: "RUN_FAILED", actor: starter, resource: { type: "RUN", id: run.run_id }, project_id: run.project_id, details: { error: run.error } });
  notify(db, [run.started_by], "RUN_FAILED", `"${recipeName}" 레시피 실행이 실패했습니다`, `/commons/projects/${run.project_id}/recipes/${run.recipe_id}`, `오류: ${run.error}`);
}

/** jobs._execute: re-check the starter's access, read every needed input in full, apply, store the derived output. */
function executeRun(db: MockDb, run: StoredRun) {
  const recipe = db.recipes.find((r) => r.recipe_id === run.recipe_id)!;
  const version = recipe.history.find((h) => h.version === run.recipe_version)!;
  const starter = { user_id: run.started_by, organization_id: run.started_by_organization_id };
  const lapsed = run.pinned.filter((p) => !datasetAccess(db, starter, datasetOf(db, p.dataset_id))).length;
  if (lapsed) return failRun(db, run, version.name, summary("INPUT_ACCESS_LAPSED", `access to ${lapsed} input(s) was revoked or expired before the run`));
  const tables = new Map<string, Table>();
  for (const id of neededInputs(version.steps, version.input_ids)) {
    const pinned = run.pinned.find((p) => p.input_id === id);
    if (!pinned) return failRun(db, run, version.name, summary("RECIPE_INVALID", "a join step reads an input that is not in the recipe"));
    try {
      tables.set(id, readInput(db, pinned.dataset_version_id));
    } catch (e) {
      if (!(e instanceof InputProblem)) throw e;
      return failRun(db, run, version.name, summary(e.reason, `${pinned.dataset_title}@${pinned.version_label}: ${INPUT_MESSAGES[e.reason]}`));
    }
  }
  let result: Table;
  try {
    result = applySteps(version.steps, tables, version.input_ids);
  } catch (e) {
    if (!(e instanceof StepError)) throw e;
    return failRun(db, run, version.name, summary("RECIPE_INVALID", e.message));
  }
  const now = nowIso();
  const outputId = newId();
  const bucket = bucketOf(db, leadOrg(db, run.project_id));
  const key = `workspace/${run.project_id}/outputs/${outputId}/${RESULT_NAME}`;
  const bytes = new TextEncoder().encode(toCsv(result));
  const sha256 = sha256Hex(toCsv(result));
  db.blobs[`${bucket}/${key}`] = { size_bytes: bytes.length, sha256 };
  const level = run.pinned.length ? run.pinned.map((p) => datasetOf(db, p.dataset_id)!.access_level).reduce(stricter) : NO_INPUTS_FLOOR;
  db.outputs.push({
    output_id: outputId,
    project_id: run.project_id,
    kind: "DERIVED_DATASET",
    title: `${version.name} (v${run.recipe_version})`.slice(0, 300),
    access_level: level,
    status: "READY",
    bucket,
    upload_expires_at: null,
    files: [{ name: RESULT_NAME, size_bytes: bytes.length, sha256, media_type: RESULT_MEDIA_TYPE, key }],
    produced_by_run_id: run.run_id,
    lineage: run.pinned.map((p) => ({ ...p })),
    recipe_id: run.recipe_id,
    recipe_version: run.recipe_version,
    publish_status: "NONE",
    created_by: run.started_by,
    created_at: now,
  });
  Object.assign(run, { status: "SUCCEEDED", finished_at: now, input_rows: [...tables.values()].reduce((n, t) => n + t.rows.length, 0), output_rows: result.rows.length, output_id: outputId });
  const actor = db.users.find((u) => u.user_id === run.started_by) ?? null;
  recordAudit(db, { action: "RUN_SUCCEEDED", actor, resource: { type: "RUN", id: run.run_id }, project_id: run.project_id });
  recordAudit(db, { action: "OUTPUT_CREATED", actor, resource: { type: "OUTPUT", id: outputId }, project_id: run.project_id });
}

/** Each read advances a pending run: QUEUED → RUNNING (1st poll) → SUCCEEDED/FAILED (2nd poll). */
function advanceRun(db: MockDb, run: StoredRun) {
  if (run.status !== "QUEUED" && run.status !== "RUNNING") return;
  run.polls += 1;
  if (run.polls === 1) {
    run.status = "RUNNING";
    run.started_at = nowIso();
  } else executeRun(db, run);
}

// ---------------------------------------------------------------- outputs (service/outputs.py)

function outputView(o: StoredOutput): Schemas["Output"] {
  return {
    output_id: o.output_id,
    project_id: o.project_id,
    kind: o.kind,
    title: o.title,
    access_level: o.access_level,
    files: o.files.map(({ name, size_bytes, sha256, media_type }) => ({ name, size_bytes, sha256, media_type })),
    produced_by_run_id: o.produced_by_run_id,
    lineage: {
      inputs: o.lineage.map(({ dataset_id, dataset_title, dataset_version_id, version_label }) => ({ dataset_id, dataset_title, dataset_version_id, version_label })),
      recipe_id: o.recipe_id,
      recipe_version: o.recipe_version,
      run_id: o.produced_by_run_id,
    },
    publish_status: o.publish_status,
    created_by: o.created_by,
    created_at: o.created_at,
  };
}

function readyOutput(db: MockDb, projectId: string, outputId: string): StoredOutput {
  const o = db.outputs.find((x) => x.output_id === outputId && x.project_id === projectId);
  if (!o || o.status !== "READY") fail("NOT_FOUND", "Output not found.");
  return o;
}

function lapsedLineage(db: MockDb, user: MockUser, o: StoredOutput): string[] {
  return o.lineage.filter((i) => !accessible(db, user, i.dataset_id)).map((i) => i.input_id);
}

function outputBody(raw: unknown) {
  const b = only(raw, ["title", "access_level", "files"]);
  if (!isText(b.title, 1, 300)) validationFailed("title", "LENGTH");
  if (!STRICTNESS.includes(b.access_level as Schemas["AccessLevel"])) validationFailed("access_level", "INVALID_ENUM");
  if (!Array.isArray(b.files) || b.files.length < 1 || b.files.length > 20) validationFailed("files", "LENGTH");
  (b.files as Record<string, unknown>[]).forEach((f, i) => {
    only(f, ["name", "size_bytes", "sha256", "media_type"], `files.${i}`);
    if (typeof f.name !== "string" || !/^[A-Za-z0-9._-]{1,255}$/.test(f.name)) validationFailed(`files.${i}.name`, "PATTERN");
    if (!Number.isInteger(f.size_bytes) || (f.size_bytes as number) < 1 || (f.size_bytes as number) > 5_368_709_120) validationFailed(`files.${i}.size_bytes`, "OUT_OF_RANGE");
    if (typeof f.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(f.sha256)) validationFailed(`files.${i}.sha256`, "PATTERN");
    if (typeof f.media_type !== "string") validationFailed(`files.${i}.media_type`, "INVALID_TYPE");
  });
  return b as unknown as Schemas["OutputUploadCreate"];
}

// ---------------------------------------------------------------- publication (service/publish.py)

function publishView(db: MockDb, r: StoredPublishRequest): Schemas["PublishRequest"] {
  return {
    request_id: r.request_id,
    output_id: r.output_id,
    project_id: r.project_id,
    status: r.status,
    approvals: r.approvals.map((a) => ({ organization_id: a.organization_id, organization_name: orgName(db, a.organization_id), decided_by: a.decided_by, decision: a.decision, comment: a.comment, decided_at: a.decided_at })),
    created_by: r.created_by,
    created_at: r.created_at,
    output_title: db.outputs.find((o) => o.output_id === r.output_id)?.title ?? "",
    project_name: projectName(db, r.project_id),
    published_dataset_id: r.published_dataset_id ?? null,
    failure_reason: r.failure_reason ?? null,
  };
}

/** Purposes every input allows; ACADEMIC_RESEARCH when none remain or no inputs. */
function commonPurposes(db: MockDb, datasetIds: string[]): Schemas["Purpose"][] {
  let common: Schemas["Purpose"][] | null = null;
  for (const id of datasetIds) {
    const allowed = datasetOf(db, id)?.policy.allowed_purposes ?? [];
    common = common === null ? [...allowed] : common.filter((p) => allowed.includes(p));
  }
  return common?.length ? common : ["ACADEMIC_RESEARCH"];
}

function lineageNote(o: StoredOutput, r: StoredPublishRequest): string {
  const lines = [`NAIS 프로젝트 산출물(output ${o.output_id})에서 소유 기관 검토를 거쳐 공개된 파생 데이터셋.`];
  if (o.lineage.length) lines.push("원본 데이터셋:", ...o.lineage.map((i) => `- ${i.dataset_title}@${i.version_label} (dataset ${i.dataset_id}, version ${i.dataset_version_id})`));
  else lines.push("원본 데이터셋: 없음 (업로드 산출물)");
  if (o.recipe_id) lines.push(`레시피 ${o.recipe_id} v${o.recipe_version}, 실행 ${o.produced_by_run_id}`);
  lines.push(`공개 승인: 주관 기관(organization ${r.lead_organization_id}) 데이터 관리자 ${r.approved_by} 및 입력 소유 기관 검토 (publish request ${r.request_id}).`);
  return lines.join("\n").slice(0, 10_000);
}

/**
 * publish_approved: the catalog creates the dataset (owner = project lead organization) and publishes v1 from the
 * output's files. A file the catalog cannot verify (the mock's stand-in: a name containing "corrupt", as in the
 * catalog upload mock) is a terminal failure: request REJECTED with failure_reason, output REJECTED.
 */
function publishApproved(db: MockDb, r: StoredPublishRequest) {
  const o = db.outputs.find((x) => x.output_id === r.output_id)!;
  const now = nowIso();
  const approver = db.users.find((u) => u.user_id === r.approved_by) ?? null;
  if (o.files.some((f) => f.name.toLowerCase().includes("corrupt"))) {
    r.status = "REJECTED";
    r.failure_reason = "카탈로그 파일 검증에 실패했습니다(verification failed): 산출물 파일을 확인한 뒤 다시 요청하세요.";
    o.publish_status = "REJECTED";
    recordAudit(db, { action: "OUTPUT_PUBLISH_DECIDED", actor: null, resource: { type: "PUBLISH_REQUEST", id: r.request_id }, project_id: r.project_id, details: { decision: "REJECT", failure_reason: r.failure_reason } });
    notify(db, [r.created_by], "OUTPUT_PUBLISH_DECIDED", `"${o.title}" 허브 공개에 실패했습니다`, `/commons/projects/${r.project_id}/outputs/${o.output_id}`, `사유: ${r.failure_reason}`);
    return;
  }
  const datasetIds = o.lineage.map((i) => i.dataset_id);
  const level = stricter(o.access_level, currentFloor(db, datasetIds));
  const datasetId = newId();
  const owner = r.lead_organization_id;
  const purposes = commonPurposes(db, datasetIds);
  db.datasets.push({
    dataset_id: datasetId,
    owner_organization_id: owner,
    owner_organization_name: orgName(db, owner),
    title: r.title,
    description: r.description,
    keywords: [],
    domain: null,
    access_level: level,
    license: "원본 데이터셋의 라이선스를 따름 (파생 데이터)",
    usage_policy: null,
    contact_email: null,
    provenance: lineageNote(o, r),
    ...emptyResearch(),
    principal_investigator_id: null,
    principal_investigator_org_id: null,
    data_steward_contact_id: null,
    data_steward_contact_org_id: null,
    collecting_organization_id: null,
    collecting_organization_name: null,
    policy: { dataset_id: datasetId, owner_organization_id: owner, access_level: level, allowed_purposes: purposes, approval_required: level === "CONTROLLED" || level === "SENSITIVE", max_grant_days: level === "SENSITIVE" ? 30 : 90 },
    status: "ACTIVE",
    created_by: r.created_by,
    created_at: now,
    updated_at: now,
  });
  const files = o.files.map((f) => ({ file_id: newId(), path: f.name, size_bytes: f.size_bytes, sha256: f.sha256, media_type: f.media_type, status: "VERIFIED" as const }));
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  db.versions.push({
    dataset_version_id: newId(),
    dataset_id: datasetId,
    version_label: "v1",
    status: "PUBLISHED",
    published_at: now,
    change_note: "프로젝트 산출물에서 공개",
    files,
    file_count: files.length,
    total_bytes: files.reduce((n, f) => n + f.size_bytes, 0),
    manifest_sha256: sha256Hex(sorted.map((f) => `${f.path}\t${f.size_bytes}\t${f.sha256}\n`).join("")),
    created_at: now,
  });
  recordAudit(db, { action: "DATASET_CREATED", actor: approver, resource: { type: "DATASET", id: datasetId, owner_organization_id: owner } });
  r.published_dataset_id = datasetId;
  o.publish_status = "PUBLISHED";
  db.activity.push({ activity_id: newId(), dataset_id: datasetId, type: "OUTPUT_PUBLISHED", label: null, ref_id: o.output_id, actor_id: r.approved_by, project_id: r.project_id, occurred_at: now });
}

// ---------------------------------------------------------------- threads (service/threads.py)

type Target = { scope: Schemas["ThreadScope"]; target_id: string; project_id: string | null; owner: string | null };

function readableTarget(db: MockDb, user: MockUser, scope: Schemas["ThreadScope"], targetId: string): Target {
  if (scope === "DATASET") {
    const ds = datasetOf(db, targetId);
    if (!ds || !canSeeDataset(user, ds, db)) fail("NOT_FOUND", "Dataset not found.");
    return { scope, target_id: targetId, project_id: null, owner: ds.owner_organization_id };
  }
  const projectId =
    scope === "PROJECT"
      ? db.projects.some((p) => p.project_id === targetId)
        ? targetId
        : null
      : scope === "OUTPUT"
        ? (db.outputs.find((o) => o.output_id === targetId && o.status === "READY")?.project_id ?? null)
        : (db.recipes.find((r) => r.recipe_id === targetId && !r.deleted_at)?.project_id ?? null);
  if (!projectId || !roleOf(db, projectId, user.user_id)) fail("NOT_FOUND", "Thread target not found.");
  return { scope, target_id: targetId, project_id: projectId, owner: null };
}

function readableThread(db: MockDb, user: MockUser, threadId: string): StoredThread {
  const t = db.threads.find((x) => x.thread_id === threadId);
  if (!t) fail("NOT_FOUND", "Thread not found.");
  const ds = t.scope === "DATASET" ? datasetOf(db, t.target_id) : undefined;
  const visible = t.scope === "DATASET" ? !!ds && canSeeDataset(user, ds, db) : !!roleOf(db, t.project_id!, user.user_id);
  if (!visible) fail("NOT_FOUND", "Thread not found.");
  return t;
}

function requireOpen(db: MockDb, user: MockUser, projectId: string | null) {
  if (projectId && !isActiveMember(db, projectId, user.user_id)) fail("FORBIDDEN", "The project is archived; its discussions are read-only.");
}

const threadView = (db: MockDb, t: StoredThread): Schemas["Thread"] => {
  const { owner_organization_id: _owner, ...rest } = t;
  void _owner;
  return { ...rest, created_by_display_name: displayName(db, t.created_by) };
};

const commentView = (db: MockDb, c: MockDb["comments"][number]): Schemas["Comment"] => ({ ...c, author_display_name: displayName(db, c.author_id) });

function datasetTitle(db: MockDb, datasetId: string) {
  return datasetOf(db, datasetId)?.title ?? "데이터셋";
}

function stewardsOf(db: MockDb, orgIds: string[]): string[] {
  return db.users.filter((u) => orgIds.includes(u.organization_id) && u.org_roles.includes("DATA_STEWARD") && u.status === "ACTIVE" && u.membership_status === "ACTIVE").map((u) => u.user_id);
}

function commentAdded(db: MockDb, user: MockUser, t: StoredThread, newThread: boolean) {
  recordAudit(db, { action: "COMMENT_ADDED", actor: user, resource: { type: "THREAD", id: t.thread_id, owner_organization_id: t.owner_organization_id }, project_id: t.project_id });
  if (t.scope !== "DATASET" || !t.owner_organization_id) return;
  const what = newThread ? "데이터에 새 토론이 시작되었습니다" : "데이터 토론에 새 댓글이 달렸습니다";
  notify(db, stewardsOf(db, [t.owner_organization_id]), "DATASET_COMMENT_ADDED", `"${datasetTitle(db, t.target_id)}" ${what}`, `/commons/data/${t.target_id}?tab=discussion`, `토론: ${t.title}`);
}

// ---------------------------------------------------------------- handlers

const P = `${API}/projects/:project_id`;

export const workspaceHandlers = [
  // ------------------------------------------------ inputs
  http.get(`${P}/inputs`, ({ request, params }) => {
    const user = currentUser(request);
    const db = getDb();
    const projectId = String(params.project_id);
    requireReader(db, projectId, user);
    return HttpResponse.json({ items: liveInputs(db, projectId).sort((a, b) => a.added_at.localeCompare(b.added_at)).map((i) => inputView(db, user, i)) });
  }),

  http.post(`${P}/inputs`, async ({ request, params }) => {
    const user = currentUser(request);
    const db = getDb();
    const projectId = String(params.project_id);
    requireWriter(db, projectId, user);
    const b = only(await body(request), ["dataset_id", "dataset_version_id", "note"]);
    if (!isUuid(b.dataset_id)) validationFailed("dataset_id", b.dataset_id === undefined ? "MISSING" : "INVALID_UUID");
    if (b.dataset_version_id !== undefined && !isUuid(b.dataset_version_id)) validationFailed("dataset_version_id", "INVALID_UUID");
    if (b.note !== undefined && !isText(b.note, 0, 2000)) validationFailed("note", "LENGTH");
    const ds = usableDataset(db, user, b.dataset_id);
    const version = publishedVersion(db, ds.dataset_id, b.dataset_version_id as string | undefined);
    requireAccess(db, user, ds);
    if (liveInputs(db, projectId).some((i) => i.dataset_id === ds.dataset_id)) fail("CONFLICT", "The dataset is already an input of this project.");
    const row: StoredInput = { input_id: newId(), project_id: projectId, dataset_id: ds.dataset_id, dataset_version_id: version.dataset_version_id, added_by: user.user_id, added_at: nowIso(), note: (b.note as string | undefined) ?? null, removed_at: null };
    db.inputs.push(row);
    db.activity.push({ activity_id: newId(), dataset_id: ds.dataset_id, type: "USED_IN_PROJECT", label: null, ref_id: projectId, actor_id: user.user_id, project_id: projectId, occurred_at: row.added_at });
    recordAudit(db, { action: "PROJECT_INPUT_ADDED", actor: user, resource: { type: "PROJECT_INPUT", id: row.input_id, owner_organization_id: ds.owner_organization_id }, project_id: projectId, details: { dataset_id: ds.dataset_id, version_label: version.version_label } });
    return HttpResponse.json(inputView(db, user, row), { status: 201 });
  }),

  http.patch(`${P}/inputs/:input_id`, async ({ request, params }) => {
    const user = currentUser(request);
    const db = getDb();
    const projectId = String(params.project_id);
    requireWriter(db, projectId, user);
    const b = only(await body(request), ["dataset_version_id", "note"]);
    if (!Object.keys(b).length) validationFailed("body", "EMPTY");
    if (b.dataset_version_id !== undefined && !isUuid(b.dataset_version_id)) validationFailed("dataset_version_id", "INVALID_UUID");
    if (b.note !== undefined && b.note !== null && !isText(b.note, 0, 2000)) validationFailed("note", "LENGTH");
    const row = liveInput(db, projectId, String(params.input_id));
    const newVersion = b.dataset_version_id as string | undefined;
    if (newVersion !== undefined && newVersion !== row.dataset_version_id) {
      const ds = usableDataset(db, user, row.dataset_id);
      const version = publishedVersion(db, row.dataset_id, newVersion);
      requireAccess(db, user, ds);
      const previous = versionOf(db, row.dataset_version_id);
      row.dataset_version_id = version.dataset_version_id;
      recordAudit(db, {
        action: "PROJECT_INPUT_VERSION_CHANGED",
        actor: user,
        resource: { type: "PROJECT_INPUT", id: row.input_id, owner_organization_id: ds.owner_organization_id },
        project_id: projectId,
        details: { previous_version_label: previous?.version_label ?? "", version_label: version.version_label },
      });
    }
    if ("note" in b) row.note = (b.note as string | null) ?? null;
    return HttpResponse.json(inputView(db, user, row));
  }),

  http.delete(`${P}/inputs/:input_id`, ({ request, params }) => {
    const user = currentUser(request);
    const db = getDb();
    const projectId = String(params.project_id);
    requireWriter(db, projectId, user);
    const row = liveInput(db, projectId, String(params.input_id));
    row.removed_at = nowIso();
    recordAudit(db, { action: "PROJECT_INPUT_REMOVED", actor: user, resource: { type: "PROJECT_INPUT", id: row.input_id, owner_organization_id: datasetOf(db, row.dataset_id)?.owner_organization_id }, project_id: projectId });
    return new HttpResponse(null, { status: 204 });
  }),

  // ------------------------------------------------ recipes
  http.get(`${P}/recipes`, ({ request, params }) => {
    const user = currentUser(request);
    const db = getDb();
    const projectId = String(params.project_id);
    requireReader(db, projectId, user);
    return HttpResponse.json({ items: db.recipes.filter((r) => r.project_id === projectId && !r.deleted_at).sort(newestFirst("updated_at")).map(recipeView) });
  }),

  http.post(`${P}/recipes`, async ({ request, params }) => {
    const user = currentUser(request);
    const db = getDb();
    const projectId = String(params.project_id);
    requireOpenWriter(db, projectId, user);
    const b = recipeBody(await body(request));
    validateRecipe(db, projectId, b.input_ids, b.steps);
    const now = nowIso();
    const row: StoredRecipe = { recipe_id: newId(), project_id: projectId, ...b, version: 1, updated_by: user.user_id, updated_at: now, deleted_at: null, history: [{ version: 1, ...b }] };
    db.recipes.push(row);
    recordAudit(db, { action: "RECIPE_SAVED", actor: user, resource: { type: "RECIPE", id: row.recipe_id }, project_id: projectId, details: { recipe_version: 1 } });
    return HttpResponse.json(recipeView(row), { status: 201 });
  }),

  http.get(`${P}/recipes/:recipe_id`, ({ request, params }) => {
    const user = currentUser(request);
    const db = getDb();
    const projectId = String(params.project_id);
    requireReader(db, projectId, user);
    return HttpResponse.json(recipeView(liveRecipe(db, projectId, String(params.recipe_id))));
  }),

  http.put(`${P}/recipes/:recipe_id`, async ({ request, params }) => {
    const user = currentUser(request);
    const db = getDb();
    const projectId = String(params.project_id);
    const expected = ifMatch(request);
    const b = recipeBody(await body(request));
    requireWriter(db, projectId, user);
    const current = liveRecipe(db, projectId, String(params.recipe_id));
    if (current.version !== expected) fail("CONFLICT", "The recipe was saved by someone else; reload it and apply your changes again.", { current_version: current.version });
    validateRecipe(db, projectId, b.input_ids, b.steps);
    Object.assign(current, b, { version: current.version + 1, updated_by: user.user_id, updated_at: nowIso() });
    current.history.push({ version: current.version, ...b });
    recordAudit(db, { action: "RECIPE_SAVED", actor: user, resource: { type: "RECIPE", id: current.recipe_id }, project_id: projectId, details: { recipe_version: current.version } });
    return HttpResponse.json(recipeView(current));
  }),

  http.delete(`${P}/recipes/:recipe_id`, ({ request, params }) => {
    const user = currentUser(request);
    const db = getDb();
    const projectId = String(params.project_id);
    requireWriter(db, projectId, user);
    const recipe = liveRecipe(db, projectId, String(params.recipe_id));
    if (db.runs.some((r) => r.recipe_id === recipe.recipe_id && (r.status === "QUEUED" || r.status === "RUNNING"))) fail("RUN_NOT_ALLOWED", "A run of this recipe is queued or running.");
    recipe.deleted_at = nowIso();
    return new HttpResponse(null, { status: 204 });
  }),

  http.post(`${P}/recipes/:recipe_id/preview`, async ({ request, params }) => {
    const user = currentUser(request);
    const db = getDb();
    const projectId = String(params.project_id);
    const text = await request.text();
    let raw: unknown = {};
    if (text.trim()) {
      try {
        raw = JSON.parse(text);
      } catch {
        fail("VALIDATION_FAILED", "Invalid JSON body");
      }
    }
    const b = only(raw, ["input_ids", "steps"]);
    const bodyIds = b.input_ids === undefined ? undefined : uuidList(b.input_ids, "input_ids");
    const bodySteps = b.steps === undefined ? undefined : validateSteps(b.steps);
    requireReader(db, projectId, user);
    const recipe = liveRecipe(db, projectId, String(params.recipe_id));
    const inputIds = bodyIds ?? [...recipe.input_ids];
    const steps = bodySteps ?? recipe.steps;
    const resolved = resolveInputs(db, projectId, inputIds);
    requireLiveAccess(db, user, resolved);
    const tables = readTables(db, new Map(resolved.map((i) => [i.input_id, i])), neededInputs(steps, inputIds), PREVIEW_INPUT_ROWS);
    const result = runSteps(steps, tables, inputIds);
    return HttpResponse.json({
      header: result.names,
      rows: previewRows(result),
      rows_truncated: result.rows.length > PREVIEW_RESULT_ROWS,
      input_rows_read: [...tables.values()].reduce((n, t) => n + t.rows.length, 0),
      output_rows: result.rows.length,
    } satisfies Schemas["RecipePreview"]);
  }),

  // ------------------------------------------------ runs
  http.post(`${P}/recipes/:recipe_id/runs`, ({ request, params }) => {
    const user = currentUser(request);
    const db = getDb();
    const projectId = String(params.project_id);
    requireWriter(db, projectId, user);
    const recipe = liveRecipe(db, projectId, String(params.recipe_id));
    if (db.runs.some((r) => r.recipe_id === recipe.recipe_id && (r.status === "QUEUED" || r.status === "RUNNING"))) fail("RUN_NOT_ALLOWED", "A run of this recipe is already queued or running.");
    const inputs = resolveInputs(db, projectId, recipe.input_ids);
    requireLiveAccess(db, user, inputs);
    const unpublished = inputs.filter((i) => versionOf(db, i.dataset_version_id)?.status !== "PUBLISHED").map((i) => i.input_id);
    if (unpublished.length) fail("RUN_NOT_ALLOWED", "An input's pinned dataset version is no longer published; pin another version first.", { input_ids: unpublished });
    const pinned: PinnedInput[] = inputs.map((i) => ({ input_id: i.input_id, dataset_id: i.dataset_id, dataset_version_id: i.dataset_version_id, dataset_title: datasetOf(db, i.dataset_id)?.title ?? "", version_label: versionOf(db, i.dataset_version_id)?.version_label ?? "" }));
    const run: StoredRun = {
      run_id: newId(),
      project_id: projectId,
      recipe_id: recipe.recipe_id,
      recipe_version: recipe.version,
      status: "QUEUED",
      started_by: user.user_id,
      started_by_organization_id: user.organization_id,
      queued_at: nowIso(),
      started_at: null,
      finished_at: null,
      input_rows: null,
      output_rows: null,
      error: null,
      output_id: null,
      pinned,
      polls: 0,
    };
    db.runs.push(run);
    return HttpResponse.json(runView(run), { status: 202 });
  }),

  http.get(`${P}/runs`, ({ request, params }) => {
    const user = currentUser(request);
    const db = getDb();
    const url = new URL(request.url);
    const projectId = String(params.project_id);
    const recipeId = url.searchParams.get("recipe_id");
    if (recipeId !== null && !isUuid(recipeId)) validationFailed("recipe_id", "INVALID_UUID");
    const wanted = statuses(url, ["QUEUED", "RUNNING", "SUCCEEDED", "FAILED"] as const);
    requireReader(db, projectId, user);
    const runs = db.runs.filter((r) => r.project_id === projectId && (!recipeId || r.recipe_id === recipeId));
    runs.forEach((r) => advanceRun(db, r));
    const shown = runs.filter((r) => !wanted || wanted.includes(r.status)).sort(newestFirst("queued_at"));
    const page = paginate(shown, url);
    return HttpResponse.json({ ...page, items: page.items.map(runView) });
  }),

  http.get(`${P}/runs/:run_id`, ({ request, params }) => {
    const user = currentUser(request);
    const db = getDb();
    const projectId = String(params.project_id);
    requireReader(db, projectId, user);
    const run = db.runs.find((r) => r.run_id === params.run_id && r.project_id === projectId);
    if (!run) fail("NOT_FOUND", "Run not found.");
    advanceRun(db, run);
    return HttpResponse.json(runView(run));
  }),

  // ------------------------------------------------ outputs
  http.get(`${P}/outputs`, ({ request, params }) => {
    const user = currentUser(request);
    const db = getDb();
    const url = new URL(request.url);
    const projectId = String(params.project_id);
    const kind = url.searchParams.get("kind");
    if (kind !== null && kind !== "DERIVED_DATASET" && kind !== "FILE") validationFailed("kind", "INVALID_ENUM");
    requireReader(db, projectId, user);
    const outputs = db.outputs.filter((o) => o.project_id === projectId && o.status === "READY" && (!kind || o.kind === kind)).sort(newestFirst("created_at"));
    const page = paginate(outputs, url);
    return HttpResponse.json({ ...page, items: page.items.map(outputView) });
  }),

  http.post(`${P}/outputs`, async ({ request, params }) => {
    const user = currentUser(request);
    const db = getDb();
    const projectId = String(params.project_id);
    const b = outputBody(await body(request));
    requireOpenWriter(db, projectId, user);
    const lineage: PinnedInput[] = liveInputs(db, projectId).map((i) => ({ input_id: i.input_id, dataset_id: i.dataset_id, dataset_version_id: i.dataset_version_id, dataset_title: datasetOf(db, i.dataset_id)?.title ?? "", version_label: versionOf(db, i.dataset_version_id)?.version_label ?? "" }));
    const floor = lineage.length ? lineage.map((i) => datasetOf(db, i.dataset_id)?.access_level ?? "SENSITIVE").reduce(stricter, "PUBLIC") : NO_INPUTS_FLOOR;
    requireNotLooser(b.access_level, floor);
    const outputId = newId();
    const bucket = bucketOf(db, leadOrg(db, projectId));
    const expires = new Date(Date.now() + UPLOAD_TTL_MS).toISOString();
    const origin = publicOrigin(request);
    const files = b.files.map((f) => ({ ...f, key: `workspace/${projectId}/outputs/${outputId}/${f.name}` }));
    db.outputs.push({
      output_id: outputId,
      project_id: projectId,
      kind: "FILE",
      title: b.title,
      access_level: b.access_level,
      status: "UPLOADING",
      bucket,
      upload_expires_at: expires,
      files,
      produced_by_run_id: null,
      lineage,
      recipe_id: null,
      recipe_version: null,
      publish_status: "NONE",
      created_by: user.user_id,
      created_at: nowIso(),
    });
    return HttpResponse.json(
      { output_id: outputId, expires_at: expires, files: files.map((f) => ({ name: f.name, upload: { method: "PUT" as const, url: `${origin}/mock-storage/${bucket}/${f.key}`, headers: { "Content-Type": f.media_type } } })) } satisfies Schemas["OutputUploadSession"],
      { status: 201 },
    );
  }),

  http.post(`${P}/outputs/:output_id/complete`, ({ request, params }) => {
    const user = currentUser(request);
    const db = getDb();
    const projectId = String(params.project_id);
    requireReader(db, projectId, user);
    const o = db.outputs.find((x) => x.output_id === params.output_id && x.project_id === projectId);
    if (!o) fail("NOT_FOUND", "Output not found.");
    if (o.created_by !== user.user_id) fail("FORBIDDEN", "Only the uploader can complete this upload.");
    if (o.status === "READY") return HttpResponse.json(outputView(o)); // repeated completion: same output, no second event
    requireOpenWriter(db, projectId, user);
    if (o.upload_expires_at && Date.now() > Date.parse(o.upload_expires_at)) fail("UPLOAD_SESSION_EXPIRED", "The upload session expired; start a new upload.");
    requireNotLooser(o.access_level, currentFloor(db, o.lineage.map((i) => i.dataset_id)));
    const problems = o.files.flatMap((f) => {
      const blob = db.blobs[`${o.bucket}/${f.key}`];
      if (!blob) return [{ name: f.name, reason: "MISSING" }];
      if (blob.size_bytes !== f.size_bytes) return [{ name: f.name, reason: "SIZE_MISMATCH" }];
      if (blob.sha256 !== f.sha256) return [{ name: f.name, reason: "SHA256_MISMATCH" }];
      return [];
    });
    if (problems.length) fail("UPLOAD_CHECKSUM_MISMATCH", "Stored files do not match the declared size or sha256; upload them again.", { files: problems });
    o.status = "READY";
    o.created_at = nowIso();
    o.upload_expires_at = null;
    recordAudit(db, { action: "OUTPUT_CREATED", actor: user, resource: { type: "OUTPUT", id: o.output_id }, project_id: projectId });
    return HttpResponse.json(outputView(o));
  }),

  http.get(`${P}/outputs/:output_id`, ({ request, params }) => {
    const user = currentUser(request);
    const db = getDb();
    const projectId = String(params.project_id);
    requireReader(db, projectId, user);
    return HttpResponse.json(outputView(readyOutput(db, projectId, String(params.output_id))));
  }),

  http.post(`${P}/outputs/:output_id/download`, ({ request, params }) => {
    const user = currentUser(request);
    const db = getDb();
    const projectId = String(params.project_id);
    if (!roleOf(db, projectId, user.user_id)) fail("FORBIDDEN", "Only project members can download outputs.");
    const o = readyOutput(db, projectId, String(params.output_id));
    const lapsed = lapsedLineage(db, user, o);
    if (lapsed.length) fail("INPUT_ACCESS_LAPSED", "Access to an input this output derives from was revoked or expired.", { input_ids: lapsed });
    const origin = publicOrigin(request);
    return HttpResponse.json(
      {
        output_id: o.output_id,
        expires_at: new Date(Date.now() + DOWNLOAD_TTL_MS).toISOString(),
        files: o.files.map((f) => ({ name: f.name, url: `${origin}/mock-storage/${o.bucket}/${f.key}`, size_bytes: f.size_bytes, sha256: f.sha256 })),
      } satisfies Schemas["OutputDownload"],
      { status: 201 },
    );
  }),

  // ------------------------------------------------ publication
  http.post(`${P}/outputs/:output_id/publish-requests`, async ({ request, params }) => {
    const user = currentUser(request);
    const db = getDb();
    const projectId = String(params.project_id);
    const text = await request.text();
    let raw: unknown = {};
    if (text.trim()) {
      try {
        raw = JSON.parse(text);
      } catch {
        fail("VALIDATION_FAILED", "Invalid JSON body");
      }
    }
    const b = only(raw, ["title", "description"]);
    if (b.title !== undefined && !isText(b.title, 3, 300)) validationFailed("title", "LENGTH");
    if (b.description !== undefined && !isText(b.description, 0, 20_000)) validationFailed("description", "LENGTH");
    requireReader(db, projectId, user);
    requireWriter(db, projectId, user);
    const o = readyOutput(db, projectId, String(params.output_id));
    if (o.publish_status !== "NONE" && o.publish_status !== "REJECTED") fail("OUTPUT_PUBLISH_PENDING", "The output already has a pending or approved publish request.");
    const lapsed = lapsedLineage(db, user, o);
    if (lapsed.length) fail("INPUT_ACCESS_LAPSED", "Access to an input this output derives from was revoked or expired.", { input_ids: lapsed });
    requireNotLooser(o.access_level, currentFloor(db, o.lineage.map((i) => i.dataset_id)));
    const title = (b.title as string | undefined) ?? o.title;
    if (title.trim().length < 3) fail("VALIDATION_FAILED", "A dataset title needs at least 3 characters; give a title.", { fields: [{ field: "title", reason: "TOO_SHORT" }] });
    const ext = (name: string) => (name.lastIndexOf(".") > 0 ? name.slice(name.lastIndexOf(".")).toLowerCase() : "");
    const fileProblems = o.files.filter((f) => ALLOWED_MEDIA[ext(f.name)] !== f.media_type.trim().toLowerCase()).map((f) => ({ path: f.name, reason: "FILE_TYPE_NOT_ALLOWED" }));
    if (fileProblems.length) fail("VALIDATION_FAILED", "The output's files cannot become a catalog dataset (file name, type or size).", { files: fileProblems });
    const lead = leadOrg(db, projectId);
    const owners = [...new Set(o.lineage.map((i) => datasetOf(db, i.dataset_id)?.owner_organization_id).filter((x): x is string => !!x))];
    const approvals = [...owners.map((org) => ({ kind: "INPUT_OWNER" as const, org })), ...(owners.includes(lead) ? [] : [{ kind: "LEAD_ORGANIZATION" as const, org: lead }])].map(({ kind, org }) => ({ organization_id: org, kind, decided_by: null, decision: null, comment: null, decided_at: null }));
    const req: StoredPublishRequest = {
      request_id: newId(),
      output_id: o.output_id,
      project_id: projectId,
      status: "PENDING",
      approvals,
      created_by: user.user_id,
      created_at: nowIso(),
      published_dataset_id: null,
      failure_reason: null,
      title,
      description: (b.description as string | undefined) ?? "",
      lead_organization_id: lead,
      approved_by: null,
    };
    db.publishRequests.push(req);
    o.publish_status = "PENDING";
    recordAudit(db, { action: "OUTPUT_PUBLISH_REQUESTED", actor: user, resource: { type: "PUBLISH_REQUEST", id: req.request_id }, project_id: projectId });
    notify(db, stewardsOf(db, approvals.map((a) => a.organization_id)), "OUTPUT_PUBLISH_REQUESTED", `"${o.title}" 허브 공개 검토 요청이 도착했습니다`, "/commons/access?tab=publish", `프로젝트: ${projectName(db, projectId)}`);
    return HttpResponse.json(publishView(db, req), { status: 201 });
  }),

  http.get(`${API}/publish-requests`, ({ request }) => {
    const user = currentUser(request);
    const db = getDb();
    const url = new URL(request.url);
    const role = url.searchParams.get("role") ?? "requester";
    if (role !== "requester" && role !== "reviewer") validationFailed("role", "INVALID_ENUM");
    const wanted = statuses(url, ["PENDING", "APPROVED", "REJECTED"] as const);
    const projectId = url.searchParams.get("project_id");
    if (projectId !== null && !isUuid(projectId)) validationFailed("project_id", "INVALID_UUID");
    let rows: StoredPublishRequest[];
    if (role === "reviewer") {
      rows = user.org_roles.includes("DATA_STEWARD") ? db.publishRequests.filter((r) => r.approvals.some((a) => a.organization_id === user.organization_id)) : [];
    } else {
      const mine = memberProjectIds(db, user.user_id);
      rows = db.publishRequests.filter((r) => mine.has(r.project_id));
    }
    rows = rows.filter((r) => (!wanted || wanted.includes(r.status)) && (!projectId || r.project_id === projectId)).sort(newestFirst("created_at"));
    const page = paginate(rows, url);
    return HttpResponse.json({ ...page, items: page.items.map((r) => publishView(db, r)) });
  }),

  http.post(`${API}/publish-requests/:request_id/decision`, async ({ request, params }) => {
    const user = currentUser(request);
    const db = getDb();
    const b = only(await body(request), ["decision", "comment"]);
    if (b.decision !== "APPROVE" && b.decision !== "REJECT") validationFailed("decision", b.decision === undefined ? "MISSING" : "INVALID_ENUM");
    if (b.comment !== undefined && !isText(b.comment, 0, 2000)) validationFailed("comment", "LENGTH");
    const req = db.publishRequests.find((r) => r.request_id === params.request_id);
    if (!req) fail("NOT_FOUND", "Publish request not found.");
    const slot = req.approvals.find((a) => a.organization_id === user.organization_id && user.org_roles.includes("DATA_STEWARD"));
    if (!slot) {
      if (req.approvals.some((a) => a.organization_id === user.organization_id) || roleOf(db, req.project_id, user.user_id)) fail("FORBIDDEN", "Only a DATA_STEWARD of an organization with an approval slot can decide.");
      fail("NOT_FOUND", "Publish request not found.");
    }
    if (user.user_id === req.created_by) fail("FORBIDDEN", "The requester cannot decide their own publish request.");
    const decision = b.decision as Schemas["PublishDecision"];
    const comment = typeof b.comment === "string" && b.comment.trim() ? b.comment : null;
    if (decision === "REJECT" && comment === null) fail("VALIDATION_FAILED", "A rejection needs a comment.", { fields: [{ field: "comment", reason: "REQUIRED" }] });
    if (req.status !== "PENDING" || slot.decision !== null) fail("CONFLICT", "This approval slot or request is already decided.");
    const now = nowIso();
    Object.assign(slot, { decided_by: user.user_id, decision, comment, decided_at: now });
    const output = db.outputs.find((o) => o.output_id === req.output_id)!;
    let publish = false;
    if (decision === "REJECT") {
      req.status = "REJECTED";
      output.publish_status = "REJECTED";
    } else if (req.approvals.every((a) => a.decision === "APPROVE")) {
      const leadSlot = req.approvals.find((a) => a.organization_id === req.lead_organization_id) ?? slot;
      req.status = "APPROVED";
      req.approved_by = leadSlot.decided_by;
      output.publish_status = "APPROVED";
      publish = true;
    }
    recordAudit(db, { action: "OUTPUT_PUBLISH_DECIDED", actor: user, resource: { type: "PUBLISH_REQUEST", id: req.request_id, owner_organization_id: slot.organization_id }, project_id: req.project_id, details: { decision } });
    const title =
      decision === "REJECT" ? `"${output.title}" 허브 공개 요청이 반려되었습니다` : req.status === "APPROVED" ? `"${output.title}" 허브 공개가 승인되었습니다` : `"${output.title}" 허브 공개 요청이 일부 승인되었습니다 (다른 기관 검토 중)`;
    notify(db, [req.created_by], "OUTPUT_PUBLISH_DECIDED", title, `/commons/projects/${req.project_id}/outputs/${output.output_id}`);
    const view = publishView(db, req);
    if (publish) publishApproved(db, req); // the publication job, queued after commit
    return HttpResponse.json(view);
  }),

  // ------------------------------------------------ threads
  http.get(`${API}/threads`, ({ request }) => {
    const user = currentUser(request);
    const db = getDb();
    const url = new URL(request.url);
    const scope = url.searchParams.get("scope");
    const targetId = url.searchParams.get("target_id");
    const projectId = url.searchParams.get("project_id");
    const resolvedRaw = url.searchParams.get("resolved");
    if (scope !== null && !SCOPES.includes(scope as Schemas["ThreadScope"])) validationFailed("scope", "INVALID_ENUM");
    for (const [k, v] of [["target_id", targetId], ["project_id", projectId]] as const) if (v !== null && !isUuid(v)) validationFailed(k, "INVALID_UUID");
    if (resolvedRaw !== null && resolvedRaw !== "true" && resolvedRaw !== "false") validationFailed("resolved", "INVALID_BOOLEAN");
    const resolved = resolvedRaw === null ? null : resolvedRaw === "true";
    let rows: StoredThread[];
    if (projectId && !scope && !targetId) {
      if (!roleOf(db, projectId, user.user_id)) fail("NOT_FOUND", "Project not found.");
      rows = db.threads.filter((t) => t.project_id === projectId);
    } else if (!projectId && scope && targetId) {
      readableTarget(db, user, scope as Schemas["ThreadScope"], targetId);
      rows = db.threads.filter((t) => t.scope === scope && t.target_id === targetId);
    } else {
      fail("VALIDATION_FAILED", "Give either scope and target_id, or project_id.", { fields: [{ field: "project_id", reason: "SELECTOR_REQUIRED" }] });
    }
    rows = rows.filter((t) => resolved === null || t.resolved === resolved).sort(newestFirst("last_comment_at"));
    const page = paginate(rows, url);
    return HttpResponse.json({ ...page, items: page.items.map((t) => threadView(db, t)) });
  }),

  http.post(`${API}/threads`, async ({ request }) => {
    const user = currentUser(request);
    const db = getDb();
    const b = only(await body(request), ["scope", "target_id", "title", "body"]);
    if (!SCOPES.includes(b.scope as Schemas["ThreadScope"])) validationFailed("scope", "INVALID_ENUM");
    if (!isUuid(b.target_id)) validationFailed("target_id", "INVALID_UUID");
    if (!isText(b.title, 1, 200)) validationFailed("title", "LENGTH");
    if (!isText(b.body, 1, 10_000)) validationFailed("body", "LENGTH");
    const target = readableTarget(db, user, b.scope as Schemas["ThreadScope"], b.target_id);
    requireOpen(db, user, target.project_id);
    const now = nowIso();
    const thread: StoredThread = { thread_id: newId(), scope: target.scope, target_id: target.target_id, project_id: target.project_id, title: b.title, created_by: user.user_id, created_at: now, resolved: false, comment_count: 1, last_comment_at: now, owner_organization_id: target.owner };
    db.threads.push(thread);
    db.comments.push({ comment_id: newId(), thread_id: thread.thread_id, body: b.body, author_id: user.user_id, created_at: now, edited_at: null });
    if (thread.scope === "DATASET") db.activity.push({ activity_id: newId(), dataset_id: thread.target_id, type: "DISCUSSION_STARTED", label: thread.title, ref_id: thread.thread_id, actor_id: user.user_id, project_id: null, occurred_at: now });
    commentAdded(db, user, thread, true);
    return HttpResponse.json(threadView(db, thread), { status: 201 });
  }),

  http.patch(`${API}/threads/:thread_id`, async ({ request, params }) => {
    const user = currentUser(request);
    const db = getDb();
    const b = only(await body(request), ["resolved", "title"]);
    if (!Object.keys(b).length) validationFailed("body", "EMPTY");
    if (b.resolved !== undefined && typeof b.resolved !== "boolean") validationFailed("resolved", "INVALID_TYPE");
    if (b.title !== undefined && !isText(b.title, 1, 200)) validationFailed("title", "LENGTH");
    const thread = readableThread(db, user, String(params.thread_id));
    const moderator =
      thread.created_by === user.user_id ||
      (thread.scope === "DATASET" ? user.organization_id === thread.owner_organization_id && user.org_roles.includes("DATA_STEWARD") : ["PROJECT_OWNER", "PROJECT_ADMIN"].includes(roleOf(db, thread.project_id!, user.user_id) ?? ""));
    if (!moderator) fail("FORBIDDEN", "Only the thread author or a moderator can change this thread.");
    requireOpen(db, user, thread.project_id);
    if (typeof b.resolved === "boolean") thread.resolved = b.resolved;
    if (typeof b.title === "string") thread.title = b.title;
    return HttpResponse.json(threadView(db, thread));
  }),

  http.get(`${API}/threads/:thread_id/comments`, ({ request, params }) => {
    const user = currentUser(request);
    const db = getDb();
    const url = new URL(request.url);
    const thread = readableThread(db, user, String(params.thread_id));
    const rows = db.comments.filter((c) => c.thread_id === thread.thread_id).sort((a, b) => a.created_at.localeCompare(b.created_at));
    const page = paginate(rows, url);
    return HttpResponse.json({ ...page, items: page.items.map((c) => commentView(db, c)) });
  }),

  http.post(`${API}/threads/:thread_id/comments`, async ({ request, params }) => {
    const user = currentUser(request);
    const db = getDb();
    const b = only(await body(request), ["body"]);
    if (!isText(b.body, 1, 10_000)) validationFailed("body", "LENGTH");
    const thread = readableThread(db, user, String(params.thread_id));
    requireOpen(db, user, thread.project_id);
    const now = nowIso();
    const comment = { comment_id: newId(), thread_id: thread.thread_id, body: b.body, author_id: user.user_id, created_at: now, edited_at: null };
    db.comments.push(comment);
    thread.comment_count += 1;
    thread.last_comment_at = now;
    commentAdded(db, user, thread, false);
    return HttpResponse.json(commentView(db, comment), { status: 201 });
  }),
];
