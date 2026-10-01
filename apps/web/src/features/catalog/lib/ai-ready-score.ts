import type { ReadinessCheckResult, ReadinessValidation } from "@/shared/api/types";

const PRIMARY = ["TABULAR_ML_BASIC", "GENERIC_BASIC"] as const; // D-028 order

/** (PASS + 0.5 x WARNING) / applicable checks x 10, one decimal; null when there is no completed run or nothing applicable. */
export function aiReadyScore(validations: ReadinessValidation[]): { score: number | null; profileId: string | null; checks: ReadinessCheckResult[] } {
  for (const profile of PRIMARY) {
    const latest = validations
      .filter((v) => v.profile_id === profile && v.run_status === "COMPLETED")
      .sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
    if (!latest) continue;
    const checks = latest.checks ?? [];
    const scored = checks.filter((c) => c.status !== "NOT_APPLICABLE");
    if (!scored.length) return { score: null, profileId: profile, checks };
    const points = scored.reduce((n, c) => n + (c.status === "PASS" ? 1 : c.status === "WARNING" ? 0.5 : 0), 0);
    return { score: Math.round((100 * points) / scored.length) / 10, profileId: profile, checks };
  }
  return { score: null, profileId: null, checks: [] };
}
