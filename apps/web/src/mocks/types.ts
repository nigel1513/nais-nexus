import type { Schemas } from "@/shared/api/types";
import type { PreviewBody } from "./previews";

export type MockUser = {
  user_id: string;
  display_name: string;
  email: string;
  organization_id: string;
  org_roles: Schemas["OrgRole"][];
  platform_roles: Schemas["PlatformRole"][];
  status: Schemas["ActiveStatus"];
  membership_status: Schemas["ActiveStatus"];
  updated_at: string;
  national_researcher_number: string | null;
  /** Earlier memberships (transferUserOrganization); the current one is `organization_id`. */
  history: { organization_id: string; started_at: string; ended_at: string }[];
};

export type StoredProject = Omit<Schemas["Project"], "my_role" | "member_count">;
/** Internal ids stay in the store; datasetView turns them into `people`, `collecting_organization` and `stats`. */
export type StoredDataset = Omit<Schemas["Dataset"], "latest_published_version" | "people" | "collecting_organization" | "stats"> & {
  principal_investigator_id: string | null;
  principal_investigator_org_id: string | null;
  data_steward_contact_id: string | null;
  data_steward_contact_org_id: string | null;
  collecting_organization_id: string | null;
  collecting_organization_name: string | null;
};
export type StoredContributor = { dataset_id: string; user_id: string; role: Schemas["ContributorRole"]; affiliation_organization_id: string; position: number };
export type StoredVersion = Omit<Schemas["DatasetVersion"], "readiness_overall">;
export type ReadinessOutcome = Pick<Schemas["ReadinessValidation"], "overall_status" | "summary" | "checks">;
export type StoredValidation = Schemas["ReadinessValidation"] & { polls: number; outcome: ReadinessOutcome };
/** `created_by` is bookkeeping (who may complete the session); it never leaves the mock. */
export type StoredUploadSession = Schemas["UploadSession"] & { created_by?: string };
export type StoredNotification = Schemas["Notification"] & { user_id: string };

export type StoredPreview = {
  status: Schemas["FilePreviewStatus"];
  failure_code?: "UNPARSEABLE" | "TIMEOUT" | "GENERATION_FAILED";
  column_profile?: { format: "csv" | "tsv" | "parquet"; rows_sampled: number; truncated: boolean; columns_truncated: boolean; columns: Schemas["ColumnProfile"][] };
  preview?: PreviewBody;
  generated_at?: string;
};

export type MockDb = {
  organizations: Schemas["Organization"][];
  users: MockUser[];
  projects: StoredProject[];
  projectMembers: Schemas["ProjectMember"][];
  datasets: StoredDataset[];
  versions: StoredVersion[];
  uploadSessions: StoredUploadSession[];
  requests: Schemas["AccessRequest"][];
  grants: Schemas["AccessGrant"][];
  validations: StoredValidation[];
  audit: Schemas["AuditEvent"][];
  notifications: StoredNotification[];
  contributors: StoredContributor[];
  vocabulary: Schemas["VocabularyTerm"][];
  /** Data Explorer rows keyed by file_id; only tabular files have one. */
  previews: Record<string, StoredPreview>;
  /** Captured upload bodies (≤ 2 MiB, lenient UTF-8) keyed by file_id; the mock stand-in for object storage. */
  objects: Record<string, string>;
};
