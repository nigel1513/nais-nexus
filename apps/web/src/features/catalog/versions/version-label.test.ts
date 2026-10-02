import { describe, expect, it } from "vitest";
import { suggestNextLabels } from "./version-label";

describe("suggestNextLabels", () => {
  it.each([
    ["v1", { minor: "v1.1", major: "v2.0" }],
    ["v1.1", { minor: "v1.2", major: "v2.0" }],
    ["v2.0.3", { minor: "v2.1", major: "v3.0" }],
    ["2026.09", { minor: "2026.10", major: "2027.0" }],
    [null, { minor: "v1.0", major: "v1.0" }],
  ])("%s", (latest, expected) => expect(suggestNextLabels(latest)).toEqual(expected));

  it("returns null for non-numeric labels", () => expect(suggestNextLabels("final")).toBeNull());
});
