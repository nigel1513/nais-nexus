"use client";
import { cn } from "@nais/ui";
import { useTranslations } from "next-intl";
import type { Schemas } from "@/shared/api/types";

export type ChangeSummary = Schemas["ChangeSummary"];

const CELLS = 5;

/**
 * Split CELLS blocks over added / removed / changed / unchanged by share (largest remainder); every non-zero kind keeps
 * at least one block so a single removed file never disappears next to fifty unchanged ones.
 */
export function diffCells({ added, removed, changed, unchanged }: ChangeSummary): number[] {
  const parts = [added, removed, changed, unchanged];
  const total = parts.reduce((n, x) => n + x, 0);
  if (total === 0) return [0, 0, 0, CELLS];
  const exact = parts.map((x) => (x * CELLS) / total);
  const cells = exact.map((x, i) => (parts[i]! > 0 ? Math.max(1, Math.floor(x)) : 0));
  const order = exact.map((x, i) => ({ i, rem: x - Math.floor(x) })).sort((a, b) => b.rem - a.rem);
  let sum = cells.reduce((n, x) => n + x, 0);
  for (let k = 0; sum < CELLS; k = (k + 1) % order.length) {
    const i = order[k]!.i;
    if (parts[i]! > 0) {
      cells[i]! += 1;
      sum += 1;
    }
  }
  while (sum > CELLS) {
    const i = cells.indexOf(Math.max(...cells));
    cells[i]! -= 1;
    sum -= 1;
  }
  return cells;
}

const TONE = ["bg-success-solid", "bg-danger-solid", "bg-warning-solid", "bg-border-strong"] as const;

/**
 * GitHub-style diff stat: `+2 −0 ~2` in text tokens' status colours (the glyph carries the meaning, so colour is never
 * alone) and a five-block bar. Screen readers get one sentence instead of glyphs.
 */
export function DiffStat({ summary, className }: { summary: ChangeSummary; className?: string }) {
  const t = useTranslations("data.versioning");
  const sentence = t("summary", summary);
  const cells = diffCells(summary);
  const chip = (text: string, n: number, tone: string) => <span className={cn(n === 0 ? "text-fg-muted" : tone)}>{text}</span>;
  return (
    <span className={cn("inline-flex items-center gap-2.5", className)} title={sentence}>
      <span className="sr-only">{sentence}</span>
      <span aria-hidden="true" className="num inline-flex gap-1.5 font-mono text-[12.5px] font-medium leading-none">
        {chip(`+${summary.added}`, summary.added, "text-success")}
        {chip(`−${summary.removed}`, summary.removed, "text-danger")}
        {chip(`~${summary.changed}`, summary.changed, "text-warning")}
      </span>
      <span aria-hidden="true" className="inline-flex gap-[2px]">
        {cells.flatMap((n, kind) => Array.from({ length: n }, (_, j) => <span key={`${kind}-${j}`} className={cn("size-2 rounded-[2px]", TONE[kind])} />))}
      </span>
    </span>
  );
}
