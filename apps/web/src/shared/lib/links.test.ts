import { describe, expect, it } from "vitest";
import { safeInternalPath } from "./links";

describe("safeInternalPath", () => {
  it("accepts in-app paths with query and hash", () => {
    expect(safeInternalPath("/commons/access?tab=grants")).toBe("/commons/access?tab=grants");
    expect(safeInternalPath("/settings#notifications")).toBe("/settings#notifications");
  });
  it.each(["/\\evil.com", "//evil.com", "https://evil.com", "javascript:alert(1)", "evil.com", "", null, undefined, "/\\\\evil.com", "/\t/evil.com", "/.//evil.com", "/a/..//evil.com", "/x/..//evil.com?a=1", "/ok?x=\\y"])(
    "rejects %j",
    (link) => {
      expect(safeInternalPath(link, "http://localhost:3000")).toBeNull();
    },
  );
});
