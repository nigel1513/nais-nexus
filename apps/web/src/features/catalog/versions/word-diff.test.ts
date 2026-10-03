import { describe, expect, it } from "vitest";
import { wordDiff } from "./word-diff";

describe("wordDiff", () => {
  it("keeps shared words and marks removed and added runs", () => {
    expect(wordDiff("사이클 1~200까지 수록했다.", "사이클 1~500까지 수록했다.")).toEqual([
      { kind: "same", text: "사이클 " },
      { kind: "removed", text: "1~200까지" },
      { kind: "added", text: "1~500까지" },
      { kind: "same", text: " 수록했다." },
    ]);
  });

  it("handles one side empty", () => {
    expect(wordDiff("", "새 설명")).toEqual([{ kind: "added", text: "새 설명" }]);
    expect(wordDiff("옛 설명", "")).toEqual([{ kind: "removed", text: "옛 설명" }]);
  });

  it("gives up on very long texts", () => {
    const long = Array.from({ length: 600 }, (_, i) => `w${i}`).join(" ");
    expect(wordDiff(long, `${long} x`)).toBeNull();
  });
});
