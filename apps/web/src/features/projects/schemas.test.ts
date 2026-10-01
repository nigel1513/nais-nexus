import { describe, expect, it } from "vitest";
import { emptyProjectForm, projectFormSchema, toProjectCreate } from "./schemas";

describe("project form schema", () => {
  it("requires a 2-200 char name and end >= start", () => {
    const r = projectFormSchema.safeParse({ ...emptyProjectForm, name: "x", start_date: "2026-10-02", end_date: "2026-10-01" });
    expect(r.success).toBe(false);
    const issues = r.success ? [] : r.error.issues.map((i) => [i.path.join("."), i.message]);
    expect(issues).toEqual(expect.arrayContaining([["name", "validation.projectName"], ["end_date", "validation.endBeforeStart"]]));
  });

  it("limits keywords to 20 and maps to ProjectCreate", () => {
    const many = Array.from({ length: 21 }, (_, i) => `k${i}`).join(",");
    expect(projectFormSchema.safeParse({ ...emptyProjectForm, name: "ok", keywords: many }).success).toBe(false);
    expect(toProjectCreate({ ...emptyProjectForm, name: "  Joint  ", keywords: "a, b ,,c", start_date: "2026-10-01" })).toEqual({
      name: "Joint",
      description: "",
      visibility: "PRIVATE",
      keywords: ["a", "b", "c"],
      start_date: "2026-10-01",
    });
  });
});
