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

/** Pinned input as a run/output lineage snapshot (repo.pinned_inputs / output lineage rows). */
export type PinnedInput = { input_id: string; dataset_id: string; dataset_version_id: string; dataset_title: string; version_label: string };
export type StoredInput = { input_id: string; project_id: string; dataset_id: string; dataset_version_id: string; added_by: string; added_at: string; note: string | null; removed_at: string | null };
export type RecipeVersion = { version: number; name: string; input_ids: string[]; steps: Schemas["RecipeStep"][] };
export type StoredRecipe = Schemas["Recipe"] & { deleted_at: string | null; history: RecipeVersion[] };
/** `polls` advances the run on reads (QUEUED → RUNNING → finished), like readiness validations. */
export type StoredRun = Schemas["Run"] & { started_by_organization_id: string; pinned: PinnedInput[]; polls: number };
export type StoredOutputFile = Schemas["OutputFile"] & { key: string };
export type StoredOutput = Omit<Schemas["Output"], "files" | "lineage"> & {
  status: "UPLOADING" | "READY";
  bucket: string;
  upload_expires_at: string | null;
  files: StoredOutputFile[];
  lineage: PinnedInput[];
  recipe_id: string | null;
  recipe_version: number | null;
};
export type StoredApproval = Omit<Schemas["PublishApproval"], "organization_name"> & { kind: "INPUT_OWNER" | "LEAD_ORGANIZATION" };
export type StoredPublishRequest = Omit<Schemas["PublishRequest"], "approvals" | "output_title" | "project_name"> & {
  approvals: StoredApproval[];
  title: string;
  description: string;
  lead_organization_id: string;
  approved_by: string | null;
};
export type StoredThread = Omit<Schemas["Thread"], "created_by_display_name"> & { owner_organization_id: string | null };
export type StoredComment = Omit<Schemas["Comment"], "author_display_name">;
/** dataset_activity rows written by workspace handlers; version/readiness rows are derived from the catalog store. */
export type StoredActivity = { activity_id: string; dataset_id: string; type: Schemas["DatasetActivityType"]; label: string | null; ref_id: string | null; actor_id: string | null; project_id: string | null; occurred_at: string };
export type StoredSignature = Omit<Schemas["NoteSignature"], "signer_display_name">;
export type StoredNote = Omit<Schemas["ResearchNote"], "project_name" | "recorder_display_name" | "draft_source_count" | "signatures" | "witness_required" | "witness_user_ids"> & {
  signatures: StoredSignature[];
  /** Snapshot taken at submit; null while DRAFT. */
  witness_required: boolean | null;
  witness_user_ids: string[] | null;
  chain_seq: number | null;
  signed_at: string | null;
  draft_requested_at: string | null;
};
export type NoteSettingsRow = { witness_required: boolean; witness_user_ids: string[] };
/** NotebookActivityPort stand-in (M07 Jupyter does not exist yet): empty unless a test seeds it. */
export type NotebookActivity = {
  user_id: string;
  project_id: string;
  /** Asia/Seoul date the notebook was saved. */
  day: string;
  notebook_id: string;
  title: string;
  version_id: string | null;
  saved_at: string;
  cells: { type: "code" | "markdown"; source_head: string; output_kinds: string[]; output_count: number; has_error: boolean }[];
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
  inputs: StoredInput[];
  recipes: StoredRecipe[];
  runs: StoredRun[];
  outputs: StoredOutput[];
  /** Workspace objects PUT to mock storage: size and sha256 keyed by `<bucket>/<object key>` (completeOutputUpload re-checks them). */
  blobs: Record<string, { size_bytes: number; sha256: string }>;
  publishRequests: StoredPublishRequest[];
  threads: StoredThread[];
  comments: StoredComment[];
  activity: StoredActivity[];
  notes: StoredNote[];
  noteSettings: Record<string, NoteSettingsRow>;
  /** Hash-chain heads keyed by `<project_id>:<organization_id>`. */
  noteChains: Record<string, { last_seq: number; last_chain_hash: string }>;
  notebookActivity: NotebookActivity[];
  /** Server setting NAIS_LLM_ENABLED as the mock sees it (getNoteSettings.llm_enabled, draftNote 503). */
  llmEnabled: boolean;
};
