import { z } from "zod";
import { ENUMS } from "@/generated/contracts";
import { splitKeywords } from "@/features/projects/schemas";
import type { Dataset, Schemas } from "@/shared/api/types";

export const datasetFormSchema = z
  .object({
    title: z.string().trim().min(3, "validation.datasetTitle").max(300, "validation.datasetTitle"),
    description: z.string().max(20000, "validation.datasetDescription"),
    keywords: z.string(),
    domain: z.string(),
    access_level: z.enum(ENUMS.AccessLevel),
    license: z.string().trim().min(1, "validation.required"),
    usage_policy: z.string().max(10000, "validation.longText"),
    allowed_purposes: z.array(z.enum(ENUMS.Purpose)).min(1, "validation.purposesMin"),
    max_grant_days: z.number({ error: "validation.maxGrantDays" }).int("validation.maxGrantDays").min(1, "validation.maxGrantDays").max(365, "validation.maxGrantDays"),
    contact_email: z.union([z.literal(""), z.email("validation.email")]),
    provenance: z.string().max(10000, "validation.longText"),
  })
  .superRefine((v, ctx) => {
    const kws = splitKeywords(v.keywords);
    if (kws.length > 30 || kws.some((k) => k.length > 50)) ctx.addIssue({ code: "custom", path: ["keywords"], message: "validation.datasetKeywords" });
    if (v.access_level === "SENSITIVE" && v.max_grant_days > 30) ctx.addIssue({ code: "custom", path: ["max_grant_days"], message: "validation.sensitiveMax" });
  });

export type DatasetFormValues = z.infer<typeof datasetFormSchema>;

export const emptyDatasetForm: DatasetFormValues = {
  title: "",
  description: "",
  keywords: "",
  domain: "",
  access_level: "CONTROLLED",
  license: "",
  usage_policy: "",
  allowed_purposes: [],
  max_grant_days: 180,
  contact_email: "",
  provenance: "",
};

const optional = (s: string) => (s.trim() ? s.trim() : undefined);

export function toDatasetCreate(
  v: DatasetFormValues,
  ownerOrganizationId: string,
  people: { principalInvestigatorId: string; stewardContactId: string },
): Schemas["DatasetCreate"] {
  return {
    owner_organization_id: ownerOrganizationId,
    title: v.title.trim(),
    description: v.description,
    keywords: splitKeywords(v.keywords),
    domain: optional(v.domain),
    access_level: v.access_level,
    license: v.license.trim(),
    usage_policy: optional(v.usage_policy),
    allowed_purposes: v.allowed_purposes,
    max_grant_days: v.max_grant_days,
    contact_email: optional(v.contact_email),
    provenance: optional(v.provenance),
    principal_investigator_id: people.principalInvestigatorId,
    data_steward_contact_id: people.stewardContactId,
    contact_email_public: false,
  };
}

export function toDatasetUpdate(v: DatasetFormValues): Schemas["DatasetUpdate"] {
  const create = toDatasetCreate(v, "", { principalInvestigatorId: "", stewardContactId: "" });
  return {
    title: create.title,
    description: create.description,
    keywords: create.keywords,
    domain: create.domain,
    access_level: create.access_level,
    license: create.license,
    usage_policy: create.usage_policy,
    allowed_purposes: create.allowed_purposes,
    max_grant_days: create.max_grant_days,
    contact_email: create.contact_email,
    provenance: create.provenance,
  };
}

export function fromDataset(d: Dataset): DatasetFormValues {
  return {
    title: d.title,
    description: d.description,
    keywords: (d.keywords ?? []).join(", "),
    domain: d.domain ?? "",
    access_level: d.access_level,
    license: d.license,
    usage_policy: d.usage_policy ?? "",
    allowed_purposes: d.policy.allowed_purposes,
    max_grant_days: d.policy.max_grant_days,
    contact_email: d.contact_email ?? "",
    provenance: d.provenance ?? "",
  };
}

export function policyChanged(before: DatasetFormValues, after: DatasetFormValues): boolean {
  return (
    before.access_level !== after.access_level ||
    before.max_grant_days !== after.max_grant_days ||
    [...before.allowed_purposes].sort().join() !== [...after.allowed_purposes].sort().join()
  );
}
