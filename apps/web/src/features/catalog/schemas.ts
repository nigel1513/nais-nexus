import { z } from "zod";
import { ENUMS } from "@/generated/contracts";
import { splitKeywords } from "@/features/projects/schemas";
import type { Dataset, DatasetPerson, Schemas } from "@/shared/api/types";

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DOI = /^10\.\d{4,9}\/\S+$/;
const URL_RE = /^https?:\/\/\S+$/;

/** `ntis` is display-only (the picked-person chip); it is never sent. */
const person = z.object({ user_id: z.string(), label: z.string(), ntis: z.string().nullish() });
export type PersonValue = z.infer<typeof person>;

/** A calendar date that exists: 2025-02-31 matches the pattern but is rejected. */
const realDate = (s: string) => {
  const [y, m, d] = s.split("-").map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
};
const date = z.union([z.literal(""), z.string().regex(DATE, "validation.date").refine(realDate, "validation.date")]);

const baseObject = z.object({
  title: z.string().trim().min(3, "validation.datasetTitle").max(300, "validation.datasetTitle"),
  subtitle: z.string().max(160, "validation.subtitle"),
  description: z.string().max(20000, "validation.datasetDescription"),
  keywords: z.string(),
  principal_investigator: person.nullable(),
  steward_contact: person.nullable(),
  contact_email_public: z.boolean(),
  contributors: z
    .array(z.object({ user_id: z.string(), label: z.string(), role: z.enum(ENUMS.ContributorRole) }))
    .max(50, "validation.tooMany"),
  project_title: z.string().max(300, "validation.longText300"),
  project_code: z.string().max(64, "validation.longText64"),
  funding_agency: z.string().max(200, "validation.longText200"),
  subject_codes: z.array(z.string()).max(5, "validation.tooMany"),
  method_codes: z.array(z.string()).max(10, "validation.tooMany"),
  material_codes: z.array(z.string()).max(20, "validation.tooMany"),
  method_detail: z.string().max(4000, "validation.longText4000"),
  temporal_start: date,
  temporal_end: date,
  collecting_mode: z.enum(["council", "external", "none"]),
  collecting_organization_id: z.string(),
  collecting_organization_name: z.string().max(200, "validation.longText200"),
  access_level: z.enum(ENUMS.AccessLevel),
  license: z.string().trim().min(1, "validation.required"),
  usage_policy: z.string().max(10000, "validation.longText"),
  allowed_purposes: z.array(z.enum(ENUMS.Purpose)).min(1, "validation.purposesMin"),
  max_grant_days: z.number({ error: "validation.maxGrantDays" }).int("validation.maxGrantDays").min(1, "validation.maxGrantDays").max(365, "validation.maxGrantDays"),
  update_frequency: z.union([z.literal(""), z.enum(ENUMS.UpdateFrequency)]),
  related_publications: z
    .array(
      z.object({
        title: z.string().trim().min(1, "validation.required").max(300, "validation.longText300"),
        doi: z.union([z.literal(""), z.string().regex(DOI, "validation.doi")]),
        url: z.union([z.literal(""), z.string().regex(URL_RE, "validation.url")]),
      }),
    )
    .max(20, "validation.tooMany"),
});

function refine(requirePeople: boolean) {
  return baseObject.superRefine((v, ctx) => {
    const kws = splitKeywords(v.keywords);
    if (kws.length > 30 || kws.some((k) => k.length > 50)) ctx.addIssue({ code: "custom", path: ["keywords"], message: "validation.datasetKeywords" });
    if (v.access_level === "SENSITIVE" && v.max_grant_days > 30) ctx.addIssue({ code: "custom", path: ["max_grant_days"], message: "validation.sensitiveMax" });
    if (v.temporal_start && v.temporal_end && v.temporal_end < v.temporal_start) ctx.addIssue({ code: "custom", path: ["temporal_end"], message: "validation.temporalRange" });
    if (requirePeople) {
      if (!v.principal_investigator) ctx.addIssue({ code: "custom", path: ["principal_investigator"], message: "validation.required" });
      if (!v.steward_contact) ctx.addIssue({ code: "custom", path: ["steward_contact"], message: "validation.required" });
    }
    if (v.collecting_mode === "council" && !v.collecting_organization_id) ctx.addIssue({ code: "custom", path: ["collecting_organization_id"], message: "validation.required" });
    if (v.collecting_mode === "external" && !v.collecting_organization_name.trim()) ctx.addIssue({ code: "custom", path: ["collecting_organization_name"], message: "validation.required" });
    const keys = v.contributors.map((c) => `${c.user_id}|${c.role}`);
    if (new Set(keys).size !== keys.length) ctx.addIssue({ code: "custom", path: ["contributors"], message: "validation.duplicate" });
  });
}

/** People are required only on create: an existing dataset may legitimately have none yet. */
export const datasetFormSchemaFor = (mode: "create" | "edit") => refine(mode === "create");
export const datasetFormSchema = datasetFormSchemaFor("create");

export type DatasetFormValues = z.infer<typeof baseObject>;

export const emptyDatasetForm: DatasetFormValues = {
  title: "",
  subtitle: "",
  description: "",
  keywords: "",
  principal_investigator: null,
  steward_contact: null,
  contact_email_public: false,
  contributors: [],
  project_title: "",
  project_code: "",
  funding_agency: "",
  subject_codes: [],
  method_codes: [],
  material_codes: [],
  method_detail: "",
  temporal_start: "",
  temporal_end: "",
  collecting_mode: "none",
  collecting_organization_id: "",
  collecting_organization_name: "",
  access_level: "CONTROLLED",
  license: "",
  usage_policy: "",
  allowed_purposes: [],
  max_grant_days: 180,
  update_frequency: "",
  related_publications: [],
};

const optional = (s: string) => (s.trim() ? s.trim() : undefined);
const orNull = (s: string) => (s.trim() ? s.trim() : null);

export function toDatasetCreate(v: DatasetFormValues, ownerOrganizationId: string): Schemas["DatasetCreate"] {
  const body: Schemas["DatasetCreate"] = {
    owner_organization_id: ownerOrganizationId,
    title: v.title.trim(),
    description: v.description,
    keywords: splitKeywords(v.keywords),
    access_level: v.access_level,
    license: v.license.trim(),
    usage_policy: optional(v.usage_policy),
    allowed_purposes: v.allowed_purposes,
    max_grant_days: v.max_grant_days,
    principal_investigator_id: v.principal_investigator?.user_id ?? "",
    data_steward_contact_id: v.steward_contact?.user_id ?? "",
    contact_email_public: v.contact_email_public,
    subtitle: optional(v.subtitle),
    project_title: optional(v.project_title),
    project_code: optional(v.project_code),
    funding_agency: optional(v.funding_agency),
    method_detail: optional(v.method_detail),
    temporal_start: optional(v.temporal_start),
    temporal_end: optional(v.temporal_end),
    update_frequency: v.update_frequency || undefined,
  };
  if (v.subject_codes.length) body.subject_codes = v.subject_codes;
  if (v.method_codes.length) body.method_codes = v.method_codes;
  if (v.material_codes.length) body.material_codes = v.material_codes;
  if (v.collecting_mode === "council" && v.collecting_organization_id) body.collecting_organization_id = v.collecting_organization_id;
  if (v.collecting_mode === "external" && v.collecting_organization_name.trim()) body.collecting_organization_name = v.collecting_organization_name.trim();
  if (v.related_publications.length) body.related_publications = v.related_publications.map(publication);
  return body;
}

function publication(p: DatasetFormValues["related_publications"][number]): Schemas["RelatedPublication"] {
  return { title: p.title.trim(), ...(p.doi ? { doi: p.doi } : {}), ...(p.url ? { url: p.url } : {}) };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const sorted = (a: string[]) => [...a].sort();

/**
 * Only changed keys. A nullable research field that went from a value to "" is sent as null. contact_email, domain and
 * provenance are retired inputs and never sent. update_frequency cannot be cleared (not nullable in the contract).
 */
export function toDatasetUpdate(v: DatasetFormValues, before: DatasetFormValues): Schemas["DatasetUpdate"] {
  const out: Schemas["DatasetUpdate"] = {};
  if (v.title.trim() !== before.title.trim()) out.title = v.title.trim();
  if (v.description !== before.description) out.description = v.description;
  if (!same(splitKeywords(v.keywords), splitKeywords(before.keywords))) out.keywords = splitKeywords(v.keywords);
  if (v.license.trim() !== before.license.trim()) out.license = v.license.trim();
  if (v.usage_policy.trim() !== before.usage_policy.trim()) out.usage_policy = v.usage_policy.trim();
  if (v.access_level !== before.access_level || v.max_grant_days !== before.max_grant_days || !same(sorted(v.allowed_purposes), sorted(before.allowed_purposes))) {
    out.access_level = v.access_level;
    out.max_grant_days = v.max_grant_days;
    out.allowed_purposes = v.allowed_purposes;
  }
  if (v.principal_investigator && v.principal_investigator.user_id !== before.principal_investigator?.user_id) out.principal_investigator_id = v.principal_investigator.user_id;
  if (v.steward_contact && v.steward_contact.user_id !== before.steward_contact?.user_id) out.data_steward_contact_id = v.steward_contact.user_id;
  if (v.contact_email_public !== before.contact_email_public) out.contact_email_public = v.contact_email_public;
  for (const k of ["subtitle", "project_title", "project_code", "funding_agency", "method_detail", "temporal_start", "temporal_end"] as const) {
    if (v[k].trim() !== before[k].trim()) out[k] = orNull(v[k]);
  }
  for (const k of ["subject_codes", "method_codes", "material_codes"] as const) {
    if (!same(sorted(v[k]), sorted(before[k]))) out[k] = v[k];
  }
  const org = (x: DatasetFormValues) => [x.collecting_mode === "council" ? x.collecting_organization_id : "", x.collecting_mode === "external" ? x.collecting_organization_name.trim() : ""];
  if (!same(org(v), org(before))) {
    const [id, name] = org(v);
    out.collecting_organization_id = id || null;
    out.collecting_organization_name = name || null;
  }
  if (v.update_frequency && v.update_frequency !== before.update_frequency) out.update_frequency = v.update_frequency;
  if (!same(v.related_publications.map(publication), before.related_publications.map(publication))) out.related_publications = v.related_publications.map(publication);
  return out;
}

export function contributorsChanged(before: DatasetFormValues, after: DatasetFormValues): boolean {
  const key = (v: DatasetFormValues) => v.contributors.map((c) => `${c.user_id}|${c.role}`).join();
  return key(before) !== key(after);
}

/** Same format the user picker shows, so a loaded value looks like a freshly picked one. */
const personValue = (p: DatasetPerson | null | undefined): PersonValue | null =>
  p ? { user_id: p.user_id, label: `${p.display_name} (${p.affiliation.name})`, ntis: p.national_researcher_number ?? null } : null;

export function fromDataset(d: Dataset): DatasetFormValues {
  const people = d.people;
  const org = d.collecting_organization;
  return {
    title: d.title,
    subtitle: d.subtitle ?? "",
    description: d.description,
    keywords: (d.keywords ?? []).join(", "),
    principal_investigator: personValue(people?.principal_investigator),
    steward_contact: personValue(people?.steward_contact),
    contact_email_public: d.contact_email_public ?? false,
    contributors: (people?.contributors ?? []).map((c) => ({ ...personValue(c)!, role: c.role })),
    project_title: d.project_title ?? "",
    project_code: d.project_code ?? "",
    funding_agency: d.funding_agency ?? "",
    subject_codes: d.subject_codes ?? [],
    method_codes: d.method_codes ?? [],
    material_codes: d.material_codes ?? [],
    method_detail: d.method_detail ?? "",
    temporal_start: d.temporal_start ?? "",
    temporal_end: d.temporal_end ?? "",
    collecting_mode: org ? (org.organization_id ? "council" : "external") : "none",
    collecting_organization_id: org?.organization_id ?? "",
    collecting_organization_name: org && !org.organization_id ? org.name : "",
    access_level: d.access_level,
    license: d.license,
    usage_policy: d.usage_policy ?? "",
    allowed_purposes: d.policy.allowed_purposes,
    max_grant_days: d.policy.max_grant_days,
    update_frequency: d.update_frequency ?? "",
    related_publications: (d.related_publications ?? []).map((p) => ({ title: p.title, doi: p.doi ?? "", url: p.url ?? "" })),
  };
}

export function policyChanged(before: DatasetFormValues, after: DatasetFormValues): boolean {
  return (
    before.access_level !== after.access_level ||
    before.max_grant_days !== after.max_grant_days ||
    [...before.allowed_purposes].sort().join() !== [...after.allowed_purposes].sort().join()
  );
}
