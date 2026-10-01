import { describe, expect, it } from "vitest";
import { affiliationText } from "./people";

const p = (aff: string, cur: string | null) => ({ user_id: "u", display_name: "홍길동", status: "ACTIVE", national_researcher_number: "10000001",
  affiliation: { organization_id: aff, name: aff === "a" ? "기관 A" : "기관 B" }, current_organization: cur ? { organization_id: cur, name: cur === "a" ? "기관 A" : "기관 B" } : null }) as never;

describe("affiliationText", () => {
  it("shows only the at-the-time org when unchanged", () => expect(affiliationText(p("a", "a"))).toEqual({ then: "기관 A", now: null }));
  it("shows the current org when the person moved", () => expect(affiliationText(p("a", "b"))).toEqual({ then: "기관 A", now: "기관 B" }));
  it("shows nothing extra when the current org is unknown", () => expect(affiliationText(p("a", null))).toEqual({ then: "기관 A", now: null }));
});
