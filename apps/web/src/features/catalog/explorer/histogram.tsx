"use client";
import { MiniHistogram } from "@nais/ui";
import { useTranslations } from "next-intl";
import type { ColumnDistribution } from "@/shared/api/types";
import { formatStat } from "./format-stat";

/** Column distribution as a MiniHistogram (chart tokens, hover shows range · count) plus a screen-reader table. */
export function Histogram({ name, min, max, bins }: { name: string; min: number; max: number; bins: NonNullable<ColumnDistribution["histogram"]> }) {
  const t = useTranslations();
  return (
    <div>
      <MiniHistogram
        height={48}
        label={t("data.explorer.histogramLabel", { name, min: formatStat(min), max: formatStat(max) })}
        bins={bins.map((b) => b.count)}
        labels={bins.map((b) => `${formatStat(b.lower)}–${formatStat(b.upper)}`)}
      />
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
