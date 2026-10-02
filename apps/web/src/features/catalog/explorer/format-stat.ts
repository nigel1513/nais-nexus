const fmt = new Intl.NumberFormat("ko-KR", { maximumSignificantDigits: 5, useGrouping: false });

/** Column statistics: up to 5 significant digits, no grouping, so values line up in mono. */
export function formatStat(v: number | null | undefined): string {
  return v === null || v === undefined || !Number.isFinite(v) ? "—" : fmt.format(v);
}
