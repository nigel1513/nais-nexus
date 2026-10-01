import { describe, expect, it } from "vitest";
import { cn } from "./cn";

describe("cn", () => {
  it("keeps a text colour next to a text-size token", () => {
    expect(cn("text-primary-fg", "text-body")).toBe("text-primary-fg text-body");
    expect(cn("text-small", "text-body")).toBe("text-body");
    expect(cn("text-fg", "text-fg-muted")).toBe("text-fg-muted");
  });
});
