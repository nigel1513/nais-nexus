"use client";
import { cn } from "@nais/ui";
import { useMemo, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { KINDS, niceTicks, type DayBucket, type Kind } from "./derive";

/**
 * Dashboard marks, following the dataviz method: categorical colour follows the activity kind in a fixed order
 * (--color-series-1…4, validated for light and dark panels; "other" folds into the muted grey), thin bars with a
 * 2px surface gap and a 4px rounded data end, hairline solid grid, text in text tokens only, a hover/focus readout
 * that never gates (each chart has a table twin), and a one-time grow-in from the baseline (transform only).
 */

export const KIND_COLOR: Record<Kind, string> = {
  download: "var(--color-series-1)",
  access: "var(--color-series-2)",
  publish: "var(--color-series-3)",
  readiness: "var(--color-series-4)",
  other: "var(--color-chart-muted)",
};

/** Small square key for a legend (legends mirror the mark: bars → rect). */
export function Swatch({ color, className }: { color: string; className?: string }) {
  return <span aria-hidden="true" className={cn("inline-block size-2 shrink-0 rounded-[2px]", className)} style={{ background: color }} />;
}

/**
 * Stat-tile trend: 30 daily values. `bars` for counts per day (the last 7 days in the accent = the period the caption
 * talks about), `line` for a running level (muted line + wash, accent end dot). Decorative: the tile's text carries
 * the numbers, so it is aria-hidden.
 */
export function Sparkline({ values, variant = "bars", className }: { values: number[]; variant?: "bars" | "line"; className?: string }) {
  const max = Math.max(1, ...values);
  if (values.every((v) => v === 0)) {
    return (
      <div aria-hidden="true" className={cn("flex h-7 items-end", className)}>
        <span className="h-px w-full bg-border" />
      </div>
    );
  }
  if (variant === "bars") {
    return (
      <div aria-hidden="true" className={cn("flex h-7 items-end gap-px", className)}>
        {values.map((v, i) => (
          <span
            key={i}
            className={cn("dash-grow min-w-0 flex-1 rounded-t-[1.5px]", i >= values.length - 7 ? "bg-accent" : "bg-chart-muted")}
            style={{ height: v > 0 ? `${Math.max(8, (v / max) * 100)}%` : "1px", opacity: v > 0 ? 1 : 0.6, "--i": i } as CSSProperties}
          />
        ))}
      </div>
    );
  }
  const min = Math.min(...values);
  const span = Math.max(1, max - min);
  const W = 100;
  const H = 28;
  const pts = values.map((v, i) => [(i / Math.max(1, values.length - 1)) * W, H - 3 - ((v - min) / span) * (H - 6)] as const);
  const line = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(2)},${y.toFixed(2)}`).join("");
  const last = pts.at(-1)!;
  return (
    <div aria-hidden="true" className={cn("relative h-7", className)}>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="absolute inset-0 size-full overflow-visible">
        <path d={`${line}L${W},${H}L0,${H}Z`} fill="var(--color-accent)" opacity={0.1} />
        <path d={line} fill="none" stroke="var(--color-chart-muted)" strokeWidth={2} vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
      </svg>
      <span className="absolute size-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent ring-2 ring-bg-panel" style={{ left: `${last[0]}%`, top: `${(last[1] / H) * 100}%` }} />
    </div>
  );
}

const PLOT_H = 168;

/**
 * 30-day activity: stacked columns by kind. Hover or arrow keys select a day; the readout lists every kind for it
 * (values lead, labels follow). A visually hidden table carries the same numbers for screen readers.
 */
export function ActivityChart({
  buckets,
  kindLabel,
  dayLabel,
  todayLabel,
  label,
  totalLabel,
  dateHeader,
  emptyOverlay,
}: {
  buckets: DayBucket[];
  kindLabel: (k: Kind) => string;
  dayLabel: (key: string) => string;
  todayLabel: string;
  label: string;
  totalLabel: string;
  dateHeader: string;
  emptyOverlay?: ReactNode;
}) {
  const [active, setActive] = useState<number | null>(null);
  const max = Math.max(...buckets.map((b) => b.total));
  const ticks = niceTicks(max);
  const top = ticks.at(-1)!;
  const n = buckets.length;
  const shown = active ?? null;
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      const from = active ?? n - 1;
      setActive(Math.min(n - 1, Math.max(0, from + (e.key === "ArrowRight" ? 1 : -1))));
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      setActive(e.key === "Home" ? 0 : n - 1);
    } else if (e.key === "Escape") setActive(null);
  };
  const b = shown !== null ? buckets[shown]! : null;
  const valueText = (d: DayBucket) => `${dayLabel(d.key)}: ${KINDS.map((k) => `${kindLabel(k)} ${d.counts[k]}`).join(", ")}; ${totalLabel} ${d.total}`;
  return (
    <div className="flex flex-col gap-2">
      <div className="relative flex gap-2">
        {/* y axis: clean ticks, recessive */}
        <div aria-hidden="true" className="relative w-6 shrink-0" style={{ height: PLOT_H }}>
          {ticks.map((t) => (
            <span key={t} className="num absolute right-0 -translate-y-1/2 font-mono text-micro font-normal text-fg-muted" style={{ top: PLOT_H - (t / top) * PLOT_H }}>
              {t}
            </span>
          ))}
        </div>
        <div
          // A day picker over the columns: arrow keys move the selected day, the value text reads that day's counts.
          role="slider"
          tabIndex={0}
          aria-label={label}
          aria-valuemin={0}
          aria-valuemax={n - 1}
          aria-valuenow={shown ?? n - 1}
          aria-valuetext={valueText(buckets[shown ?? n - 1]!)}
          onKeyDown={onKey}
          onBlur={() => setActive(null)}
          onPointerLeave={() => setActive(null)}
          className="relative isolate min-w-0 flex-1 rounded-xs outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-4 focus-visible:ring-offset-bg-panel"
          style={{ height: PLOT_H }}
        >
          {ticks.map((t) => (
            <span key={t} aria-hidden="true" className={cn("absolute inset-x-0 h-px", t === 0 ? "bg-border-strong" : "bg-border/70")} style={{ top: PLOT_H - (t / top) * PLOT_H - (t === 0 ? 0 : 0.5) }} />
          ))}
          <div className="absolute inset-0 flex items-end gap-[3px] sm:gap-1">
            {buckets.map((d, i) => (
              <div
                key={d.key}
                onPointerEnter={() => setActive(i)}
                className={cn("relative flex h-full min-w-0 flex-1 flex-col-reverse justify-start transition-opacity duration-150", shown !== null && shown !== i && "opacity-45")}
              >
                <div className="dash-grow flex flex-col-reverse gap-[2px] [&>*:last-child]:rounded-t-[4px]" style={{ "--i": i } as CSSProperties}>
                  {KINDS.map((k) =>
                    d.counts[k] > 0 ? <span key={k} className="block w-full" style={{ height: Math.max(2, (d.counts[k] / top) * PLOT_H - 2), background: KIND_COLOR[k] }} /> : null,
                  )}
                </div>
                {i === shown ? <span aria-hidden="true" className="absolute inset-x-[-2px] top-0 bottom-0 -z-10 rounded-[3px] bg-bg-hover" /> : null}
              </div>
            ))}
          </div>
          {max === 0 && emptyOverlay ? <div className="absolute inset-0 flex items-center justify-center">{emptyOverlay}</div> : null}
          {b ? (
            <div
              aria-live="polite"
              className="pointer-events-none absolute top-1 z-10 w-44 rounded-sm border border-border bg-bg-panel px-3 py-2 shadow-popover"
              style={shown! > n / 2 ? { right: `${((n - shown!) / n) * 100}%`, marginRight: 8 } : { left: `${((shown! + 1) / n) * 100}%`, marginLeft: 8 }}
            >
              <p className="text-caption text-fg-muted">{dayLabel(b.key)}</p>
              <ul className="mt-1 flex flex-col gap-0.5">
                {[...KINDS].reverse().map((k) => (
                  <li key={k} className="flex items-center gap-2 text-small">
                    <span aria-hidden="true" className="h-0.5 w-2.5 shrink-0 rounded-full" style={{ background: KIND_COLOR[k] }} />
                    <span className="num w-6 shrink-0 text-right font-semibold text-fg">{b.counts[k]}</span>
                    <span className="truncate text-fg-muted">{kindLabel(k)}</span>
                  </li>
                ))}
              </ul>
              <p className="mt-1.5 flex justify-between border-t border-border pt-1.5 text-small text-fg-muted">
                {totalLabel}
                <span className="num font-semibold text-fg">{b.total}</span>
              </p>
            </div>
          ) : null}
        </div>
      </div>
      {/* x axis: one label a week, ending today */}
      <div aria-hidden="true" className="relative ml-8 h-4">
        {buckets.map((d, i) =>
          (n - 1 - i) % 7 === 0 ? (
            <span
              key={d.key}
              className={cn("num absolute top-0 whitespace-nowrap font-mono text-micro font-normal text-fg-muted", i === n - 1 ? "-translate-x-full" : "-translate-x-1/2")}
              style={{ left: `${((i + (i === n - 1 ? 1 : 0.5)) / n) * 100}%` }}
            >
              {i === n - 1 ? todayLabel : dayLabel(d.key)}
            </span>
          ) : null,
        )}
      </div>
      <table className="sr-only">
        <caption>{label}</caption>
        <thead>
          <tr>
            <th scope="col">{dateHeader}</th>
            {KINDS.map((k) => (
              <th key={k} scope="col">
                {kindLabel(k)}
              </th>
            ))}
            <th scope="col">{totalLabel}</th>
          </tr>
        </thead>
        <tbody>
          {buckets
            .filter((d) => d.total > 0)
            .map((d) => (
              <tr key={d.key}>
                <th scope="row">{dayLabel(d.key)}</th>
                {KINDS.map((k) => (
                  <td key={k}>{d.counts[k]}</td>
                ))}
                <td>{d.total}</td>
              </tr>
            ))}
        </tbody>
      </table>
    </div>
  );
}

/** Part-to-whole in one 8px bar: segments in their own colours with the 2px surface gap. Values are listed beside it. */
export function SegmentBar({ parts, className }: { parts: { key: string; value: number; color: string }[]; className?: string }) {
  const total = parts.reduce((n, p) => n + p.value, 0);
  return (
    <div aria-hidden="true" className={cn("flex h-2 gap-[2px] overflow-hidden rounded-[4px] bg-bg-hover", className)}>
      {total > 0
        ? parts
            .filter((p) => p.value > 0)
            .map((p) => <span key={p.key} className="dash-grow-x h-full first:rounded-l-[4px] last:rounded-r-[4px]" style={{ flexGrow: p.value, flexBasis: 0, background: p.color }} />)
        : null}
    </div>
  );
}

/** Field bars: the institute's share in the accent (emphasis), the rest of the council in grey, both on one scale. */
export function FieldBars({ rows, mineLabel, othersLabel }: { rows: { key: string; label: string; mine: number; total: number }[]; mineLabel: string; othersLabel: string }) {
  const max = Math.max(1, ...rows.map((r) => r.total));
  const sorted = useMemo(() => [...rows].sort((a, b) => b.total - a.total || b.mine - a.mine), [rows]);
  return (
    <div className="flex flex-col gap-3">
      <ul className="flex flex-col gap-2">
        {sorted.map((r) => (
          <li key={r.key} className="grid grid-cols-[5.5rem_minmax(0,1fr)_3.25rem] items-center gap-3 text-small">
            <span className="truncate text-fg">{r.label}</span>
            <span aria-hidden="true" className="flex h-2.5 items-stretch gap-[2px]">
              {r.mine > 0 ? <span className="dash-grow-x rounded-l-[2px] bg-accent last:rounded-r-[4px]" style={{ width: `${(r.mine / max) * 100}%` }} /> : null}
              {r.total - r.mine > 0 ? <span className="dash-grow-x rounded-r-[4px] bg-chart-muted first:rounded-l-[2px]" style={{ width: `${((r.total - r.mine) / max) * 100}%` }} /> : null}
            </span>
            <span className="num text-right font-mono text-mono text-fg-muted">
              <span className="sr-only">
                {mineLabel} {r.mine}, {othersLabel} {r.total - r.mine}
              </span>
              <span aria-hidden="true">
                <span className={r.mine ? "font-semibold text-fg" : undefined}>{r.mine}</span>/{r.total}
              </span>
            </span>
          </li>
        ))}
      </ul>
      <p aria-hidden="true" className="flex items-center gap-4 text-caption font-normal text-fg-muted">
        <span className="flex items-center gap-1.5">
          <Swatch color="var(--color-accent)" />
          {mineLabel}
        </span>
        <span className="flex items-center gap-1.5">
          <Swatch color="var(--color-chart-muted)" />
          {othersLabel}
        </span>
      </p>
    </div>
  );
}

/** Remaining share of a grant period; amber inside the last week (always next to a D-day label + icon). */
export function RemainingBar({ share, warn }: { share: number; warn: boolean }) {
  return (
    <span aria-hidden="true" className="block h-1 w-full overflow-hidden rounded-full bg-bg-active">
      <span className={cn("dash-grow-x block h-full rounded-full", warn ? "bg-warning-solid" : "bg-chart-muted")} style={{ width: `${Math.max(3, share * 100)}%` }} />
    </span>
  );
}
