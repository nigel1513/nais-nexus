import type { AccessGrant, AccessLevel, AccessRequest, Me } from "@/shared/api/types";

export type AccessCta =
  | { kind: "download"; basis: "PUBLIC" | "OWNER_ORGANIZATION" }
  | { kind: "download-grant"; grants: AccessGrant[] }
  | { kind: "view-request"; accessRequestId: string }
  | { kind: "request" }
  | { kind: "unavailable" };

const OPEN: AccessRequest["status"][] = ["SUBMITTED", "UNDER_REVIEW", "CHANGE_REQUESTED"];

/** UI convenience only (M10 §7.6) — the server makes the final decision on every call. */
export function decideAccessCta(input: {
  accessLevel: AccessLevel;
  ownerOrganizationId: string;
  me: Me;
  activeGrants: AccessGrant[];
  requests: AccessRequest[];
}): AccessCta {
  const { accessLevel, ownerOrganizationId, me } = input;
  if (accessLevel === "PUBLIC") return { kind: "download", basis: "PUBLIC" };
  const ownOrg = me.organization.organization_id === ownerOrganizationId;
  if (ownOrg && (me.org_roles.includes("DATA_STEWARD") || me.org_roles.includes("ORG_ADMIN"))) return { kind: "download", basis: "OWNER_ORGANIZATION" };
  if (accessLevel === "INTERNAL") return ownOrg ? { kind: "download", basis: "OWNER_ORGANIZATION" } : { kind: "unavailable" };
  const active = input.activeGrants.filter((g) => g.status === "ACTIVE");
  if (active.length) return { kind: "download-grant", grants: active };
  const open = input.requests.find((r) => OPEN.includes(r.status));
  if (open) return { kind: "view-request", accessRequestId: open.access_request_id };
  return { kind: "request" };
}
