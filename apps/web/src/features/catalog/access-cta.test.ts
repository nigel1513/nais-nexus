import { describe, expect, it } from "vitest";
import type { AccessGrant, AccessRequest, Me } from "@/shared/api/types";
import { decideAccessCta } from "./access-cta";

const OWNER = "org-b";
const me = (org: string, roles: Me["org_roles"] = []): Me => ({
  user_id: "u",
  display_name: "U",
  email: "u@x.local",
  status: "ACTIVE",
  organization: { organization_id: org, code: "x", name: "X", type: "RESEARCH_INSTITUTE" },
  org_roles: roles,
  platform_roles: [],
});
const grant = { access_grant_id: "g1", status: "ACTIVE", project_id: "p1", expires_at: "2099-01-01T00:00:00Z" } as AccessGrant;
const req = (status: AccessRequest["status"]) => ({ access_request_id: `r-${status}`, status }) as AccessRequest;
const base = { ownerOrganizationId: OWNER, activeGrants: [] as AccessGrant[], requests: [] as AccessRequest[] };

describe("decideAccessCta (M10 §7.6)", () => {
  it("PUBLIC → download", () => {
    expect(decideAccessCta({ ...base, accessLevel: "PUBLIC", me: me("org-a") })).toEqual({ kind: "download", basis: "PUBLIC" });
  });
  it("own org steward/admin → download for any level", () => {
    expect(decideAccessCta({ ...base, accessLevel: "SENSITIVE", me: me(OWNER, ["DATA_STEWARD"]) }).kind).toBe("download");
    expect(decideAccessCta({ ...base, accessLevel: "CONTROLLED", me: me(OWNER, ["ORG_ADMIN"]) }).kind).toBe("download");
  });
  it("INTERNAL: own org → download, other org → unavailable", () => {
    expect(decideAccessCta({ ...base, accessLevel: "INTERNAL", me: me(OWNER) }).kind).toBe("download");
    expect(decideAccessCta({ ...base, accessLevel: "INTERNAL", me: me("org-a") }).kind).toBe("unavailable");
  });
  it("CONTROLLED with an ACTIVE grant → download-grant (even for own-org researchers)", () => {
    expect(decideAccessCta({ ...base, accessLevel: "CONTROLLED", me: me("org-a"), activeGrants: [grant] })).toEqual({ kind: "download-grant", grants: [grant] });
  });
  it("open request → view-request; closed requests are ignored", () => {
    const cta = decideAccessCta({ ...base, accessLevel: "SENSITIVE", me: me("org-a"), requests: [req("REJECTED"), req("CHANGE_REQUESTED")] });
    expect(cta).toEqual({ kind: "view-request", accessRequestId: "r-CHANGE_REQUESTED" });
  });
  it("otherwise → request", () => {
    expect(decideAccessCta({ ...base, accessLevel: "CONTROLLED", me: me(OWNER), requests: [req("WITHDRAWN")] })).toEqual({ kind: "request" });
  });
  it("ignores non-ACTIVE grants", () => {
    expect(decideAccessCta({ ...base, accessLevel: "CONTROLLED", me: me("org-a"), activeGrants: [{ ...grant, status: "REVOKED" }] }).kind).toBe("request");
  });
  it("ignores ACTIVE grants whose expires_at has passed", () => {
    const expired = { ...grant, expires_at: "2020-01-01T00:00:00Z" };
    expect(decideAccessCta({ ...base, accessLevel: "CONTROLLED", me: me("org-a"), activeGrants: [expired] }).kind).toBe("request");
    expect(decideAccessCta({ ...base, accessLevel: "CONTROLLED", me: me("org-a"), activeGrants: [grant], now: new Date("2100-01-01") }).kind).toBe("request");
  });
});
