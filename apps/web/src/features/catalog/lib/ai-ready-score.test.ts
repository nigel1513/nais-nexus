import { describe, expect, it } from "vitest";
import type { ReadinessValidation } from "@/shared/api/types";
import { aiReadyScore } from "./ai-ready-score";

const run = (profile_id: string, statuses: string[], created_at = "2026-10-01T00:00:00Z", run_status = "COMPLETED") =>
  ({ validation_id: profile_id + created_at, dataset_version_id: "v", profile_id, profile_version: "1", run_status, created_at,
     checks: statuses.map((status, i) => ({ check_id: `c${i}`, status, severity: "REQUIRED", message: "m", evidence: {} })) }) as unknown as ReadinessValidation;

describe("aiReadyScore", () => {
  it("weights WARNING as half and ignores NOT_APPLICABLE", () => {
    expect(aiReadyScore([run("GENERIC_BASIC", ["PASS", "PASS", "WARNING", "FAIL", "NOT_APPLICABLE"])]).score).toBe(6.3);
  });
  it("prefers the latest completed TABULAR_ML_BASIC over GENERIC_BASIC", () => {
    const r = aiReadyScore([run("GENERIC_BASIC", ["FAIL"]), run("TABULAR_ML_BASIC", ["PASS"], "2026-09-01T00:00:00Z"), run("TABULAR_ML_BASIC", ["PASS", "FAIL"], "2026-10-02T00:00:00Z")]);
    expect([r.profileId, r.score]).toEqual(["TABULAR_ML_BASIC", 5]);
  });
  it("returns null when nothing completed or nothing applicable", () => {
    expect(aiReadyScore([]).score).toBeNull();
    expect(aiReadyScore([run("GENERIC_BASIC", ["PASS"], undefined, "RUNNING")]).score).toBeNull();
    expect(aiReadyScore([run("GENERIC_BASIC", ["NOT_APPLICABLE"])]).score).toBeNull();
  });
});
