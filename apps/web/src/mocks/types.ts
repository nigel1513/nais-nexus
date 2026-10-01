import type { Schemas } from "@/shared/api/types";

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
};

export type StoredProject = Omit<Schemas["Project"], "my_role" | "member_count">;
export type StoredDataset = Omit<Schemas["Dataset"], "latest_published_version">;
export type StoredVersion = Omit<Schemas["DatasetVersion"], "readiness_overall">;
export type ReadinessOutcome = Pick<Schemas["ReadinessValidation"], "overall_status" | "summary" | "checks">;
export type StoredValidation = Schemas["ReadinessValidation"] & { polls: number; outcome: ReadinessOutcome };
/** `created_by` is bookkeeping (who may complete the session); it never leaves the mock. */
export type StoredUploadSession = Schemas["UploadSession"] & { created_by?: string };
export type StoredNotification = Schemas["Notification"] & { user_id: string };

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
};
