import { describe, expect, it } from "vitest";
import { setMockUser } from "../../../tests/render";
import { api, unwrap } from "@/shared/api/client";
import type { AuditEvent, Page } from "@/shared/api/types";
import { getDb } from "../db";
import { ORG, USER, VERSION } from "../fixtures";

const as = (user: string | null) => setMockUser(user);
const list = async (query: Record<string, unknown> = {}) =>
  ((await unwrap(api.GET("/audit-events", { params: { query: query as never } }))) as Page<AuditEvent>).items;

function push(action: AuditEvent["action"], actorId: string, actorOrg: string, ownerOrg: string, occurredAt: string): string {
  const id = crypto.randomUUID();
  getDb().audit.push({
    audit_event_id: id,
    occurred_at: occurredAt,
    action,
    result: "SUCCESS",
    reason: null,
    actor: { type: "USER", user_id: actorId, display_name: "x", organization_id: actorOrg },
    resource: { type: "DATASET_VERSION", id: VERSION.battery, owner_organization_id: ownerOrg },
    project_id: null,
    policy_version: null,
    source_event_id: crypto.randomUUID(),
    source_event_type: "t.v1",
    trace_id: "t",
    details: {},
  });
  return id;
}

describe("audit mock mirrors M09 visibility (AT-08)", () => {
  it("actor-org staff do not see download rows of another org's data; the owner org does", async () => {
    const dl = push("FILE_DOWNLOADED", USER.aResearcher, ORG.a, ORG.b, new Date().toISOString());
    const denied = push("DOWNLOAD_DENIED", USER.aResearcher, ORG.a, ORG.b, new Date().toISOString());
    as(USER.aSteward);
    const aIds = (await list()).map((e) => e.audit_event_id);
    expect(aIds).not.toContain(dl);
    expect(aIds).not.toContain(denied);
    as(USER.aAdmin);
    expect((await list()).map((e) => e.audit_event_id)).not.toContain(dl);
    as(USER.bSteward);
    const bIds = (await list()).map((e) => e.audit_event_id);
    expect(bIds).toContain(dl);
    expect(bIds).toContain(denied);
    as(USER.aResearcher);
    expect((await list()).map((e) => e.audit_event_id)).toEqual(expect.arrayContaining([dl, denied]));
  });

  it("actor-org staff still see non-download rows of their own org's actors", async () => {
    const id = push("ACCESS_REQUESTED", USER.aResearcher, ORG.a, ORG.b, new Date().toISOString());
    as(USER.aSteward);
    expect((await list()).map((e) => e.audit_event_id)).toContain(id);
  });

  it("staff with a foreign organization_id filter get 403; platform admin does not", async () => {
    as(USER.aSteward);
    await expect(list({ organization_id: ORG.b })).rejects.toMatchObject({ status: 403, code: "FORBIDDEN" });
    as(USER.aAdmin);
    await expect(list({ organization_id: ORG.b })).rejects.toMatchObject({ status: 403, code: "FORBIDDEN" });
    await expect(list({ organization_id: ORG.a })).resolves.toBeDefined();
    as(USER.admin);
    await expect(list({ organization_id: ORG.b })).resolves.toBeDefined();
  });

  it("`to` is exclusive", async () => {
    const t = "2031-01-01T00:00:00.000Z";
    const id = push("ACCESS_REQUESTED", USER.aResearcher, ORG.a, ORG.a, t);
    as(USER.aResearcher);
    expect((await list({ to: t })).map((e) => e.audit_event_id)).not.toContain(id);
    expect((await list({ to: "2031-01-01T00:00:01.000Z" })).map((e) => e.audit_event_id)).toContain(id);
  });
});
