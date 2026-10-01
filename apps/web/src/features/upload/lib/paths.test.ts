import { describe, expect, it } from "vitest";
import { ALLOWED_MEDIA_TYPES, MAX_FILE_BYTES, mediaTypeFor, suggestPath, uploadMessageParams, validatePath, validateSelection } from "./paths";

describe("upload path rules (M10 §9.2, mirrors M03 domain.path_problem)", () => {
  it("accepts safe relative paths", () => {
    expect(validatePath("clean_tabular/data.csv")).toBeNull();
    expect(validatePath("v1.2/_schema.json")).toBeNull();
    expect(validatePath("a/.hidden/x.csv")).toBeNull();
    expect(validatePath("x".repeat(508) + ".csv")).toBeNull();
  });

  it("rejects unsafe or non-ASCII paths", () => {
    expect(validatePath("/etc/passwd")).toBe("leading-slash");
    expect(validatePath("a/../b.csv")).toBe("dotdot");
    expect(validatePath("데이터.csv")).toBe("pattern");
    expect(validatePath("my data.csv")).toBe("pattern");
    expect(validatePath("x".repeat(513))).toBe("pattern");
    expect(validatePath("")).toBe("pattern");
  });

  it("rejects empty and dot segments like the server", () => {
    expect(validatePath("a//b.csv")).toBe("empty-segment");
    expect(validatePath("a/b/")).toBe("empty-segment");
    expect(validatePath("./a.csv")).toBe("dotdot");
    expect(validatePath("a/./b.csv")).toBe("dotdot");
    expect(validatePath("..")).toBe("dotdot");
  });

  it("auto-converts: spaces → _, non-ASCII removed, '..' dropped, collisions get -1, -2", () => {
    expect(suggestPath("my data/결과 파일.csv", new Set())).toBe("my_data/file.csv");
    expect(suggestPath("데이터 파일 1.csv", new Set())).toBe("1.csv");
    expect(suggestPath("../../etc/passwd", new Set())).toBe("etc/passwd");
    const taken = new Set(["my_data/file.csv"]);
    expect(suggestPath("my data/결과.csv", taken)).toBe("my_data/file-1.csv");
    taken.add("my_data/file-1.csv");
    expect(suggestPath("my data/요약.csv", taken)).toBe("my_data/file-2.csv");
    expect(validatePath(suggestPath("완전히 한글 이름", new Set()))).toBeNull();
  });

  it("auto-convert removes empty/dot segments, a leading slash and keeps results within 512 characters", () => {
    expect(suggestPath("/a//./b/c.csv", new Set())).toBe("a/b/c.csv");
    const long = suggestPath(`${"d".repeat(300)}/${"e".repeat(300)}.csv`, new Set());
    expect(long.length).toBeLessThanOrEqual(512);
    expect(long.endsWith(".csv")).toBe(true);
    expect(validatePath(long)).toBeNull();
    const longTaken = suggestPath("x".repeat(600) + ".csv", new Set());
    const next = suggestPath("x".repeat(600) + ".csv", new Set([longTaken]));
    expect(next).not.toBe(longTaken);
    expect(next.length).toBeLessThanOrEqual(512);
    expect(next.endsWith("-1.csv")).toBe(true);
  });

  it("checks the selection: empty, >50 GiB, duplicates, >500 files", () => {
    const { issues, tooMany } = validateSelection([
      { path: "a.csv", size: 0 },
      { path: "b.csv", size: MAX_FILE_BYTES + 1 },
      { path: "c.csv", size: 10 },
      { path: "c.csv", size: 10 },
    ]);
    expect(issues).toEqual([
      { index: 0, code: "empty" },
      { index: 1, code: "too-large" },
      { index: 3, code: "duplicate" },
    ]);
    expect(tooMany).toBe(false);
    expect(validateSelection(Array.from({ length: 501 }, (_, i) => ({ path: `f${i}.csv`, size: 1 }))).tooMany).toBe(true);
  });

  it("flags extensions outside the M03 allow-list (case-insensitive, dotfiles have none)", () => {
    const { issues } = validateSelection([
      { path: "a.exe", size: 1 },
      { path: "noext", size: 1 },
      { path: "A.CSV", size: 1 },
      { path: "d/.csv", size: 1 },
    ]);
    expect(issues).toEqual([
      { index: 0, code: "extension" },
      { index: 1, code: "extension" },
      { index: 3, code: "extension" },
    ]);
  });

  it("accepts exactly 50 GiB", () => {
    expect(validateSelection([{ path: "a.csv", size: MAX_FILE_BYTES }]).issues).toEqual([]);
  });

  it("derives the media type from the extension; a different browser type never wins", () => {
    expect(mediaTypeFor("x.csv", "")).toBe("text/csv");
    expect(mediaTypeFor("x.PARQUET", "")).toBe("application/vnd.apache.parquet");
    expect(mediaTypeFor("x.csv", "application/vnd.ms-excel")).toBe("text/csv");
    expect(mediaTypeFor("x.json", "application/json")).toBe("application/json");
    expect(mediaTypeFor("x.bin", "")).toBe("application/octet-stream");
    for (const [ext, type] of Object.entries(ALLOWED_MEDIA_TYPES)) expect(mediaTypeFor(`f${ext}`, "x/y")).toBe(type);
    expect(Object.keys(ALLOWED_MEDIA_TYPES).sort()).toEqual([".csv", ".h5", ".hdf5", ".json", ".jsonl", ".md", ".nc", ".parquet", ".tsv", ".txt", ".zip"]);
  });

  it("provides the {max} message parameter for FILE_TOO_LARGE / upload.dropHint / upload.issue.too-large", () => {
    expect(uploadMessageParams()).toEqual({ max: "50.0 GiB" });
  });
});
