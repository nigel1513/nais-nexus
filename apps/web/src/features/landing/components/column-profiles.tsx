"use client";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { binRange, SAMPLE_BINS, SAMPLE_COLUMNS, type SampleColumn } from "../sample";

const H = 44;

function Column({ column, grow, interactive }: { column: SampleColumn; grow: number | null; interactive: boolean }) {
  const t = useTranslations("landing.ui");
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(200);
  const [hover, setHover] = useState<number | null>(null);

  // Draw in real pixels so 1px gaps and crisp edges survive any column width.
  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([entry]) => setWidth(Math.max(120, Math.round(entry!.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const max = Math.max(...column.bins);
  const bw = width / SAMPLE_BINS;
  const [lo, hi] = [binRange(column, 0)[0], binRange(column, SAMPLE_BINS - 1)[1]];
  const unit = column.unit ? ` ${column.unit}` : "";
  const pick = (clientX: number) => {
    const r = box.current!.getBoundingClientRect();
    setHover(Math.max(0, Math.min(SAMPLE_BINS - 1, Math.floor(((clientX - r.left) / r.width) * SAMPLE_BINS))));
  };

  return (
    <div className="lp-col">
      <div className="lp-col-name">
        {column.name}
        <span>{column.type}</span>
      </div>
      <div ref={box}>
        <svg
          viewBox={`0 0 ${width} ${H}`}
          aria-hidden
          style={interactive ? { cursor: "crosshair" } : undefined}
          onPointerMove={interactive ? (e) => pick(e.clientX) : undefined}
          onPointerLeave={interactive ? () => setHover(null) : undefined}
        >
          {column.bins.map((v, i) => {
            const h = Math.max((v / max) * (H - 2), v ? 1 : 0);
            const on = hover === null ? Math.abs(i - column.peak) <= 1 : i === hover;
            return (
              <rect
                key={i}
                x={i * bw + 0.5}
                y={H - h}
                width={Math.max(1, bw - 2)}
                height={h}
                shapeRendering="crispEdges"
                fill={on ? "var(--color-accent)" : "var(--color-chart-muted)"}
                className={grow === null ? undefined : "lp-grow"}
                style={grow === null ? undefined : { animationDelay: `${grow + i * 14}ms` }}
              />
            );
          })}
        </svg>
      </div>
      <div className="lp-col-stat">
        {hover === null ? (
          <>
            <span>{lo}</span>
            <span>{hi + unit}</span>
          </>
        ) : (
          <>
            <span data-hot>{`${binRange(column, hover).join("–")}${unit}`}</span>
            <span>{t("rows", { count: column.bins[hover]!.toLocaleString("ko-KR") })}</span>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Column profile grid, as a data card shows it. `grow` replays the bars growing once: on mount (the hero window,
 * after it has risen) or when first scrolled into view. A grid already on screen at load never re-animates.
 * `replay` grows them again when the hero window comes back into focus.
 * Hover is instant: it is read many times and must not lag the pointer.
 */
export function ColumnProfiles({ grow, replay = 0, interactive = false, label }: { grow: "mount" | "view"; replay?: number; interactive?: boolean; label: string }) {
  const root = useRef<HTMLDivElement>(null);
  const [base, setBase] = useState<number | null>(grow === "mount" ? 900 : null);

  // A new `replay` value grows the bars again (remounting the columns restarts the CSS animation).
  useEffect(() => {
    if (replay > 0) setBase(120);
  }, [replay]);

  useEffect(() => {
    if (grow !== "view") return;
    const el = root.current;
    if (!el || typeof IntersectionObserver === "undefined" || el.getBoundingClientRect().top < window.innerHeight) return;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (!entry!.isIntersecting) return;
        io.disconnect();
        setBase(280);
      },
      { threshold: 0.3 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [grow]);

  return (
    <div ref={root} className="lp-cols" role="img" aria-label={label}>
      {SAMPLE_COLUMNS.map((c, k) => (
        <Column key={`${c.name}-${replay}`} column={c} grow={base === null ? null : base + k * 70} interactive={interactive} />
      ))}
    </div>
  );
}
