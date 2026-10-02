"use client";
import { cn } from "@nais/ui";
import { useTranslations } from "next-intl";
import { useState } from "react";
import type { ColumnDistribution } from "@/shared/api/types";
import { formatStat } from "./format-stat";
import "../components/v2.css";

type Bins = NonNullable<ColumnDistribution["histogram"]>;

/**
 * Column distribution (dataviz: one series → one hue, chart-1). Thin bars with a 2px gap and rounded tops on a
 * recessive baseline; the mean is a single ink tick. Hovering a bar keeps it full and dims the rest, with its range ·
 * count above. Min / max / mean sit below as a mono row; a screen-reader table holds every bin.
 */
export function Histogram({ name, min, max, mean, bins }: { name: string; min: number; max: number; mean?: number | null; bins: Bins }) {
  const t = useTranslations();
  const [hover, setHover] = useState<number | null>(null);
  const top = Math.max(0, ...bins.map((b) => b.count));
  const span = max - min;
  const meanAt = mean != null && span > 0 ? Math.min(1, Math.max(0, (mean - min) / span)) : null;
  return (
    <div>
      <div
        role="img"
        aria-label={t("data.explorer.histogramLabel", { name, min: formatStat(min), max: formatStat(max) })}
        className="relative flex h-12 items-end gap-[3px] border-b border-border-strong"
        onMouseLeave={() => setHover(null)}
      >
        {bins.map((b, i) => (
          <div key={i} className="flex h-full min-w-0 flex-1 items-end" onMouseEnter={() => setHover(i)}>
            <div
              data-bin={i}
              className={cn("nx-bar w-full rounded-t-[3px] bg-chart-1 transition-opacity duration-150", hover !== null && hover !== i && "opacity-40")}
              style={{ height: top > 0 ? `${Math.max(b.count > 0 ? 4 : 0, (b.count / top) * 100)}%` : 0 }}
            />
          </div>
        ))}
        {meanAt !== null ? (
          <span aria-hidden="true" className="pointer-events-none absolute -top-1 bottom-0 w-px bg-fg" style={{ left: `${meanAt * 100}%` }} />
        ) : null}
        {hover !== null ? (
          <div
            role="presentation"
            className="pointer-events-none absolute bottom-full z-[var(--z-tooltip)] mb-1.5 -translate-x-1/2 whitespace-nowrap rounded-sm bg-primary px-1.5 py-0.5 font-mono text-caption text-primary-fg"
            style={{ left: `${((hover + 0.5) / bins.length) * 100}%` }}
          >
            {formatStat(bins[hover]!.lower)}–{formatStat(bins[hover]!.upper)} · {bins[hover]!.count.toLocaleString("ko-KR")}
          </div>
        ) : null}
      </div>
      <table className="sr-only">
        <tbody>
          {bins.map((b, i) => (
            <tr key={i}>
              <th scope="row">{`${b.lower}–${b.upper}`}</th>
              <td>{b.count}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
