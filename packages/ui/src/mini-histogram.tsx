"use client";
import * as React from "react";
import { cn } from "./cn";

const UNIT = 10; // viewBox width per bin; 1 unit is the gap between bars

/**
 * Column-distribution sparkbar (spec §4 MiniHistogram): plain SVG so dozens fit on one screen. Bars are slate-8,
 * highlighted bins (a filter, the hovered bar) are --accent; hovering shows the bin's label and count.
 */
export function MiniHistogram({
  bins,
  labels,
  highlight,
  height = 32,
  label,
  formatValue = (v) => v.toLocaleString("ko-KR"),
  onBinClick,
  className,
}: {
  bins: number[];
  /** Bin labels (e.g. ranges), same length as bins. */
  labels?: string[];
  /** Bin indexes drawn in --accent. */
  highlight?: number[];
  height?: number;
  /** Accessible summary, e.g. "voltage 분포". */
  label: string;
  formatValue?: (v: number) => string;
  onBinClick?: (index: number) => void;
  className?: string;
}) {
  const [hover, setHover] = React.useState<number | null>(null);
  const max = Math.max(0, ...bins);
  const width = bins.length * UNIT;
  const lit = new Set(highlight ?? []);
  return (
    <div className={cn("relative w-full", className)} onMouseLeave={() => setHover(null)}>
      <svg
        role="img"
        aria-label={label}
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        width="100%"
        height={height}
        className="block overflow-visible"
      >
        {bins.map((v, i) => {
          const h = max > 0 ? (v / max) * height : 0;
          const on = hover === i || lit.has(i);
          return (
            <g key={i}>
              <rect
                data-bin={i}
                x={i * UNIT}
                y={height - h}
                width={UNIT - 1}
                height={h}
                shapeRendering="crispEdges"
                className={on ? "fill-accent" : "fill-chart-muted"}
              />
              {/* Full-height hit area so short bars are still easy to point at. */}
              <rect
                x={i * UNIT}
                y={0}
                width={UNIT}
                height={height}
                fill="transparent"
                className={onBinClick ? "cursor-pointer" : undefined}
                onMouseEnter={() => setHover(i)}
                onClick={onBinClick ? () => onBinClick(i) : undefined}
              />
            </g>
          );
        })}
      </svg>
      {hover !== null ? (
        <div
          role="presentation"
          className="pointer-events-none absolute bottom-full z-10 mb-1 -translate-x-1/2 whitespace-nowrap rounded-sm bg-primary px-1.5 py-0.5 font-mono text-caption text-primary-fg"
          style={{ left: `${((hover + 0.5) / bins.length) * 100}%` }}
        >
          {labels?.[hover] ? `${labels[hover]} · ` : ""}
          {formatValue(bins[hover]!)}
        </div>
      ) : null}
    </div>
  );
}
