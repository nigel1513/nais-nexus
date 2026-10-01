"use client";
import { useTranslations } from "next-intl";
import type { ColumnDistribution } from "@/shared/api/types";

const W = 240;
const H = 80;

export function Histogram({ name, min, max, bins }: { name: string; min: number; max: number; bins: NonNullable<ColumnDistribution["histogram"]> }) {
  const t = useTranslations();
  const top = Math.max(1, ...bins.map((b) => b.count));
  const bw = W / Math.max(1, bins.length);
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="img" aria-label={t("data.explorer.histogramLabel", { name, min, max })} className="max-w-full text-primary">
        {bins.map((b, i) => {
          const h = (b.count / top) * (H - 2);
          return <rect key={i} x={i * bw + 0.5} y={H - h} width={Math.max(0, bw - 1)} height={h} fill="currentColor" />;
        })}
      </svg>
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
