import { http, HttpResponse } from "msw";
import type { Schemas } from "@/shared/api/types";
import { getDb } from "../db";
import { API, body, currentUser, fail, newestFirst, nowIso, recordAudit } from "../http";
import { READINESS_PROFILES } from "../readiness-results";
import type { StoredValidation } from "../types";
import { isOwnerSteward, queueValidation, visibleVersion } from "./catalog";

/** Public shape only: the store's `polls`/`outcome` bookkeeping never leaves the mock. */
export function validationView(v: StoredValidation): Schemas["ReadinessValidation"] {
  return {
    validation_id: v.validation_id,
    dataset_version_id: v.dataset_version_id,
    profile_id: v.profile_id,
    profile_version: v.profile_version,
    run_status: v.run_status,
    overall_status: v.overall_status,
    summary: v.summary,
    checks: v.checks,
    validator_version: v.validator_version,
    input_fingerprint: v.input_fingerprint,
    error: v.error,
    triggered_by: v.triggered_by,
    created_at: v.created_at,
    started_at: v.started_at,
    completed_at: v.completed_at,
  };
}

/** Each read advances a pending run: QUEUED → RUNNING (1st poll) → COMPLETED (2nd poll). */
function advance(v: StoredValidation) {
  if (v.run_status !== "QUEUED" && v.run_status !== "RUNNING") return;
  v.polls += 1;
  if (v.polls === 1) {
    v.run_status = "RUNNING";
    v.started_at = nowIso();
  } else {
    v.run_status = "COMPLETED";
    v.completed_at = nowIso();
    v.overall_status = v.outcome.overall_status;
    v.summary = v.outcome.summary;
    v.checks = v.outcome.checks;
    const db = getDb();
    const datasetId = db.versions.find((x) => x.dataset_version_id === v.dataset_version_id)?.dataset_id;
    const owner = db.datasets.find((d) => d.dataset_id === datasetId)?.owner_organization_id ?? null;
    recordAudit(db, { action: "READINESS_VALIDATION_COMPLETED", actor: null, resource: { type: "READINESS_VALIDATION", id: v.validation_id, owner_organization_id: owner } });
  }
}

export const readinessHandlers = [
  http.get(`${API}/readiness-profiles`, ({ request }) => {
    currentUser(request);
    return HttpResponse.json({ items: READINESS_PROFILES });
  }),

  http.post(`${API}/dataset-versions/:version_id/readiness-validations`, async ({ request, params }) => {
    const user = currentUser(request);
    const db = getDb();
    const { v, ds } = visibleVersion(db, String(params.version_id), user);
    // M05 §6.2 order: invisible 404 → not steward/platform admin 403 → not published 409 → unknown profile 422 → reuse 200 → in progress 409 → 202.
    if (!isOwnerSteward(user, ds.owner_organization_id) && !user.platform_roles.includes("PLATFORM_ADMIN")) fail("FORBIDDEN");
    if (v.status !== "PUBLISHED") fail("DATASET_VERSION_NOT_PUBLISHED");
    const { profile_id } = await body<{ profile_id: string }>(request);
    if (!READINESS_PROFILES.some((p) => p.profile_id === profile_id)) fail("READINESS_PROFILE_UNKNOWN");
    const runs = db.validations.filter((x) => x.dataset_version_id === v.dataset_version_id && x.profile_id === profile_id);
    const completed = runs.filter((x) => x.run_status === "COMPLETED").sort(newestFirst("created_at"))[0];
    if (completed) return HttpResponse.json(validationView(completed), { status: 200 });
    const running = runs.find((x) => x.run_status === "QUEUED" || x.run_status === "RUNNING");
    if (running) fail("READINESS_VALIDATION_IN_PROGRESS", undefined, { validation_id: running.validation_id });
    return HttpResponse.json(validationView(queueValidation(db, v.dataset_version_id, profile_id, "USER")), { status: 202 });
  }),

  http.get(`${API}/dataset-versions/:version_id/readiness`, ({ request, params }) => {
    const user = currentUser(request);
    const db = getDb();
    const { v } = visibleVersion(db, String(params.version_id), user);
    if (v.status !== "PUBLISHED") fail("NOT_FOUND"); // M05 §6.3: DRAFT versions have no readiness
    const profile = new URL(request.url).searchParams.get("profile_id");
    const latestByProfile = new Map<string, StoredValidation>();
    for (const x of db.validations.filter((y) => y.dataset_version_id === v.dataset_version_id).sort(newestFirst("created_at"))) {
      if (!latestByProfile.has(x.profile_id)) latestByProfile.set(x.profile_id, x);
    }
    if (profile && !latestByProfile.has(profile)) fail("READINESS_NOT_AVAILABLE");
    const items = [...latestByProfile.values()].filter((x) => !profile || x.profile_id === profile);
    items.forEach(advance);
    return HttpResponse.json({ items: items.map(validationView) });
  }),
];
