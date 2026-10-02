import { Badge } from "@nais/ui";
import { useTranslations } from "next-intl";
import { sampleHistogram, sampleSeries, type SeriesKind } from "../sample";

const UNIT = 10; // viewBox width per bin; bars leave a 2-unit gap
const HEIGHT = 120;
/** Bins drawn in --accent with a soft band behind them, like a brushed range on a data card column. */
const BRUSH = [22, 26] as const;

const SERIES: { kind: SeriesKind; column: string }[] = [
  { kind: "voltage", column: "voltage_v" },
  { kind: "temperature", column: "temp_c" },
  { kind: "capacity", column: "capacity_ah" },
];

function Histogram() {
  const bins = sampleHistogram();
  const width = bins.length * UNIT;
  return (
    <svg viewBox={`0 0 ${width} ${HEIGHT}`} preserveAspectRatio="none" className="block h-[120px] w-full" aria-hidden>
      <rect x={BRUSH[0] * UNIT - 1} y={0} width={(BRUSH[1] - BRUSH[0] + 1) * UNIT} height={HEIGHT} className="fill-accent-soft" />
      {bins.map((v, i) => {
        const h = Math.max(v * (HEIGHT - 8), v > 0 ? 1 : 0);
        const lit = i >= BRUSH[0] && i <= BRUSH[1];
        return (
          <rect
            key={i}
            x={i * UNIT}
            y={HEIGHT - h}
            width={UNIT - 2}
            height={h}
            shapeRendering="crispEdges"
            className={lit ? "fill-accent" : "fill-chart-muted"}
          />
        );
      })}
    </svg>
  );
}

function Sparkline({ values }: { values: number[] }) {
  const step = 100 / (values.length - 1);
  const points = values.map((v, i) => `${(i * step).toFixed(2)},${(26 - v * 24).toFixed(2)}`).join(" ");
  return (
    <svg viewBox="0 0 100 28" preserveAspectRatio="none" className="block h-7 w-full" aria-hidden>
      <polyline points={points} fill="none" vectorEffect="non-scaling-stroke" strokeWidth={1.25} strokeLinejoin="round" className="stroke-fg-muted" />
    </svg>
  );
}

/**
 * A notebook-style cell (Observable) showing what a data card does with a column: a distribution and per-column
 * trends. Server-rendered SVG, no client JS, and no figures: the data is generated and labelled as a sample.
 */
export function SampleFigure() {
  const t = useTranslations("landing.figure");
  return (
    <figure className="overflow-hidden rounded-md border border-border bg-bg-panel">
      <div className="flex h-9 items-center justify-between gap-3 border-b border-border px-4">
        <span className="min-w-0 truncate font-mono text-mono text-fg-muted">{t("path")}</span>
        <Badge>{t("sample")}</Badge>
      </div>
      <div role="img" aria-label={t("label")}>
        <div className="px-4 pb-3 pt-5">
          <Histogram />
          <div className="h-px bg-border-strong" />
        </div>
        <div className="grid grid-cols-3 border-t border-border">
        {SERIES.map(({ kind, column }, i) => (
          <div key={kind} className={i > 0 ? "border-l border-border px-4 py-3" : "px-4 py-3"}>
            <div className="truncate font-mono text-caption font-normal text-fg-muted">{column}</div>
            <div className="mt-2">
              <Sparkline values={sampleSeries(kind)} />
            </div>
          </div>
          ))}
        </div>
      </div>
      <figcaption className="border-t border-border bg-bg-subtle px-4 py-3 break-keep text-small text-fg-muted">{t("caption")}</figcaption>
    </figure>
  );
}
