import type { Schemas } from "@/shared/api/types";
import type { ReadinessOutcome } from "./types";

type Severity = "REQUIRED" | "RECOMMENDED";

const GENERIC: [string, Severity][] = [
  ["metadata.completeness", "REQUIRED"],
  ["provenance.presence", "REQUIRED"],
  ["policy.license_usage", "REQUIRED"],
  ["integrity.file_checksum", "REQUIRED"],
  ["schema.presence", "RECOMMENDED"],
  ["semantics.units_codebook", "RECOMMENDED"],
  ["semantics.mapping_status", "RECOMMENDED"],
];

const TABULAR: [string, Severity][] = [
  ["metadata.completeness", "REQUIRED"],
  ["provenance.presence", "REQUIRED"],
  ["policy.license_usage", "REQUIRED"],
  ["integrity.file_checksum", "REQUIRED"],
  ["schema.presence", "REQUIRED"],
  ["schema.datatype_validity", "REQUIRED"],
  ["data.missing_values", "RECOMMENDED"],
  ["semantics.units_codebook", "REQUIRED"],
  ["semantics.mapping_status", "RECOMMENDED"],
];

const CHECKS: Record<string, [string, Severity][]> = { GENERIC_BASIC: GENERIC, TABULAR_ML_BASIC: TABULAR };

export const READINESS_PROFILES: Schemas["ReadinessProfile"][] = [
  {
    profile_id: "GENERIC_BASIC",
    version: "1.0.0",
    name: "Generic basic",
    description: "모든 데이터셋에 적용되는 기본 AI-Ready 점검",
    checks: GENERIC.map(([check_id, severity]) => ({ check_id, severity })),
  },
  {
    profile_id: "TABULAR_ML_BASIC",
    version: "1.0.0",
    name: "Tabular ML basic",
    description: "표 형식 데이터의 기계학습 활용 점검",
    checks: TABULAR.map(([check_id, severity]) => ({ check_id, severity })),
  },
];

type Override = [Schemas["ReadinessCheckStatus"], string, Record<string, unknown>?];

/** Every check PASS unless overridden; overall per 09_AI_READY_RULES (REQUIRED FAIL → FAIL, else any non-pass → WARNING). */
export function buildResult(profileId: string, overrides: Record<string, Override> = {}): ReadinessOutcome {
  const checks: Schemas["ReadinessCheckResult"][] = (CHECKS[profileId] ?? GENERIC).map(([check_id, severity]) => {
    const o = overrides[check_id];
    return {
      check_id,
      severity,
      status: o ? o[0] : "PASS",
      message: o ? o[1] : "기준을 충족합니다.",
      evidence: o?.[2] ?? {},
    };
  });
  const requiredFail = checks.some((c) => c.severity === "REQUIRED" && c.status === "FAIL");
  const anyIssue = checks.some((c) => c.status === "FAIL" || c.status === "WARNING");
  const count = (s: Schemas["ReadinessCheckStatus"]) => checks.filter((c) => c.status === s).length;
  return {
    overall_status: requiredFail ? "FAIL" : anyIssue ? "WARNING" : "PASS",
    summary: { pass: count("PASS"), warning: count("WARNING"), fail: count("FAIL"), not_applicable: count("NOT_APPLICABLE") },
    checks,
  };
}
