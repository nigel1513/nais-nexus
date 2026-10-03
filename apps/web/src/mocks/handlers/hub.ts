import { http, HttpResponse } from "msw";
import type { Schemas } from "@/shared/api/types";
import { getDb } from "../db";
import { API, currentUser, fail, newestFirst, orgName, paginate } from "../http";
import type { MockDb, MockUser, StoredActivity, StoredDataset } from "../types";
import { canSeeDataset, readinessOverallFor } from "./catalog";
import { memberProjectIds } from "./workspace";

/**
 * Mirrors apps/api/modules/workspace/service/hub.py: visibility is the catalog's (D-012); counts come from the
 * workspace store (live project inputs → most_used, access requests of the last 7 days → trending) and
 * dataset_activity rows. VERSION_PUBLISHED / READINESS_COMPLETED rows, which the backend writes from catalog and
 * readiness events, are derived here from the catalog store.
 */
const RAIL_SIZE = 6;
const TRENDING_WINDOW_MS = 7 * 86_400_000;

type Summary = { ds: StoredDataset; latestPublishedAt: string | null; readiness: Schemas["ReadinessOverall"] | null };

function summaries(db: MockDb, user: MockUser): Summary[] {
  return db.datasets
    .filter((ds) => ds.status === "ACTIVE" && canSeeDataset(user, ds, db))
    .map((ds) => {
      const latest = db.versions.filter((v) => v.dataset_id === ds.dataset_id && v.status === "PUBLISHED").sort(newestFirst("published_at"))[0];
      return { ds, latestPublishedAt: latest?.published_at ?? null, readiness: latest ? readinessOverallFor(db, latest.dataset_version_id) : null };
    });
}

function card(db: MockDb, s: Summary, metric: number | null): Schemas["HubCard"] {
  return {
    dataset_id: s.ds.dataset_id,
    title: s.ds.title,
    owner_organization_name: orgName(db, s.ds.owner_organization_id),
    subject_labels: (s.ds.subject_codes ?? []).map((code) => db.vocabulary.find((t) => t.scheme === "SUBJECT" && t.code === code)?.label_ko ?? code),
    access_level: s.ds.access_level,
    readiness_overall: s.readiness,
    updated_at: s.ds.updated_at,
    metric,
  };
}

const publishedTs = (s: Summary) => (s.latestPublishedAt ? Date.parse(s.latestPublishedAt) : 0);

/** Datasets with a positive count, highest first (ties: newest publication, then title). */
function countedRail(db: MockDb, all: Summary[], counts: Map<string, number>) {
  return all
    .filter((s) => (counts.get(s.ds.dataset_id) ?? 0) > 0)
    .sort((a, b) => counts.get(b.ds.dataset_id)! - counts.get(a.ds.dataset_id)! || publishedTs(b) - publishedTs(a) || a.ds.title.localeCompare(b.ds.title) || a.ds.dataset_id.localeCompare(b.ds.dataset_id))
    .slice(0, RAIL_SIZE)
    .map((s) => card(db, s, counts.get(s.ds.dataset_id)!));
}

function countBy(ids: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);
  return counts;
}

function organizations(db: MockDb, all: Summary[]): Schemas["HubOrganizationStat"][] {
  const stats = new Map<string, Schemas["HubOrganizationStat"]>();
  for (const { ds } of all) {
    const id = ds.owner_organization_id;
    const stat = stats.get(id) ?? { organization_id: id, name: orgName(db, id), dataset_count: 0, public_count: 0, controlled_count: 0, last_updated_at: null };
    stat.dataset_count += 1;
    stat.public_count += ds.access_level === "PUBLIC" ? 1 : 0;
    stat.controlled_count += ds.access_level === "CONTROLLED" || ds.access_level === "SENSITIVE" ? 1 : 0;
    if (!stat.last_updated_at || ds.updated_at > stat.last_updated_at) stat.last_updated_at = ds.updated_at;
    stats.set(id, stat);
  }
  return [...stats.values()].sort((a, b) => b.dataset_count - a.dataset_count || a.name.localeCompare(b.name) || a.organization_id.localeCompare(b.organization_id));
}

function visible(db: MockDb, user: MockUser, datasetId: string): StoredDataset {
  const ds = db.datasets.find((d) => d.dataset_id === datasetId);
  if (!ds || !canSeeDataset(user, ds, db)) fail("NOT_FOUND", "Dataset not found.");
  return ds;
}

/** Stored rows plus the catalog-derived ones, newest first. */
function activityOf(db: MockDb, datasetId: string): StoredActivity[] {
  const versions = db.versions.filter((v) => v.dataset_id === datasetId);
  const derived: StoredActivity[] = [
    ...versions
      .filter((v) => v.status === "PUBLISHED" && v.published_at)
      .map((v) => ({ activity_id: v.dataset_version_id, dataset_id: datasetId, type: "VERSION_PUBLISHED" as const, label: v.version_label, ref_id: v.dataset_version_id, actor_id: null, project_id: null, occurred_at: v.published_at! })),
    ...db.validations
      .filter((x) => x.run_status === "COMPLETED" && x.completed_at && versions.some((v) => v.dataset_version_id === x.dataset_version_id))
      .map((x) => ({ activity_id: x.validation_id, dataset_id: datasetId, type: "READINESS_COMPLETED" as const, label: x.overall_status ?? null, ref_id: x.dataset_version_id, actor_id: null, project_id: null, occurred_at: x.completed_at! })),
  ];
  return [...derived, ...db.activity.filter((a) => a.dataset_id === datasetId)].sort((a, b) => b.occurred_at.localeCompare(a.occurred_at) || b.activity_id.localeCompare(a.activity_id));
}

export const hubHandlers = [
  http.get(`${API}/hub/overview`, ({ request }) => {
    const user = currentUser(request);
    const db = getDb();
    const all = summaries(db, user);
    const since = Date.now() - TRENDING_WINDOW_MS;
    const requests = countBy(db.requests.filter((r) => r.status !== "DRAFT" && Date.parse(r.created_at) >= since).map((r) => r.dataset_id));
    const uses = countBy(db.inputs.filter((i) => !i.removed_at).map((i) => i.dataset_id));
    const recent = all
      .filter((s) => s.latestPublishedAt)
      .sort((a, b) => publishedTs(b) - publishedTs(a) || a.ds.dataset_id.localeCompare(b.ds.dataset_id))
      .slice(0, RAIL_SIZE)
      .map((s) => card(db, s, null));
    return HttpResponse.json({ rails: { trending: countedRail(db, all, requests), recent, most_used: countedRail(db, all, uses) }, organizations: organizations(db, all) } satisfies Schemas["HubOverview"]);
  }),

  http.get(`${API}/datasets/:dataset_id/projects`, ({ request, params }) => {
    const user = currentUser(request);
    const db = getDb();
    const ds = visible(db, user, String(params.dataset_id));
    const uses = db.inputs.filter((i) => i.dataset_id === ds.dataset_id && !i.removed_at);
    const mine = memberProjectIds(db, user.user_id);
    const items = uses.flatMap((u) => {
      const p = db.projects.find((x) => x.project_id === u.project_id);
      return p && mine.has(p.project_id) ? [{ project_id: p.project_id, name: p.name, lead_organization_name: orgName(db, p.lead_organization_id), input_added_at: u.added_at }] : [];
    });
    return HttpResponse.json({ items, hidden_count: uses.length - items.length } satisfies Schemas["DatasetProjectsResult"]);
  }),

  http.get(`${API}/datasets/:dataset_id/activity`, ({ request, params }) => {
    const user = currentUser(request);
    const db = getDb();
    const url = new URL(request.url);
    const ds = visible(db, user, String(params.dataset_id));
    const page = paginate(activityOf(db, ds.dataset_id), url);
    const mine = memberProjectIds(db, user.user_id);
    const items = page.items.map((r): Schemas["DatasetActivity"] => {
      const shown = r.project_id === null || mine.has(r.project_id);
      const label = r.type === "USED_IN_PROJECT" ? (shown ? (db.projects.find((p) => p.project_id === r.project_id)?.name ?? null) : null) : r.label;
      return {
        activity_id: r.activity_id,
        dataset_id: r.dataset_id,
        type: r.type,
        label,
        ref_id: shown ? r.ref_id : null,
        actor_display_name: shown && r.actor_id ? (db.users.find((u) => u.user_id === r.actor_id)?.display_name ?? null) : null,
        project_id: shown ? r.project_id : null,
        occurred_at: r.occurred_at,
      };
    });
    return HttpResponse.json({ ...page, items });
  }),
];
