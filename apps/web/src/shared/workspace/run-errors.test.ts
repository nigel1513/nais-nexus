import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadMessages, lookup } from "@/i18n/messages";
import ko from "@/messages/ko.json";
import { RUN_ERROR_CODES, runErrorKey } from "./run-errors";

describe("run error codes", () => {
  it("mirror the backend's RUN_ERROR_CODES", () => {
    const py = readFileSync(path.resolve(__dirname, "../../../../api/modules/workspace/public.py"), "utf8");
    const block = py.slice(py.indexOf("RUN_ERROR_CODES"), py.indexOf("class WorkspaceQueryPort"));
    const backend = [...block.matchAll(/"([A-Z_]+)"/g)].map((m) => m[1]);
    expect([...RUN_ERROR_CODES].sort()).toEqual(backend.sort());
  });

  it("each has a Korean sentence (no English words) and an English one", () => {
    const en = loadMessages("en");
    for (const code of [...RUN_ERROR_CODES, "fallback"]) {
      const sentence = lookup(ko, `workspace.runs.error.${code}`)!;
      expect(sentence, code).toBeTruthy();
      expect(sentence.replace(/CSV|Parquet/g, ""), code).not.toMatch(/[A-Za-z]{2,}/);
      expect(lookup(en, `workspace.runs.error.${code}`), code).toMatch(/^[A-Z]/);
    }
  });

  it("maps a code to its key and anything else to the fallback", () => {
    expect(runErrorKey("INPUT_TOO_LARGE")).toBe("workspace.runs.error.INPUT_TOO_LARGE");
    expect(runErrorKey("STALE_RUN: no progress within the allowed time")).toBe("workspace.runs.error.STALE_RUN");
    expect(runErrorKey("SOMETHING_NEW")).toBe("workspace.runs.error.fallback");
    expect(runErrorKey(null)).toBe("workspace.runs.error.fallback");
  });
});
