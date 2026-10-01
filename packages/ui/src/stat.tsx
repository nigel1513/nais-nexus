import { ArrowDownRight, ArrowUpRight } from "lucide-react";
import * as React from "react";
import { cn } from "./cn";

/** Dashboard / activity figure: caption label, 20/600 tabular value, optional change (spec §4 Stat). */
export function Stat({
  label,
  value,
  delta,
  trend,
  hint,
  className,
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  /** Change text, e.g. "+3 이번 주". */
  delta?: React.ReactNode;
  trend?: "up" | "down" | "flat";
  hint?: React.ReactNode;
  className?: string;
}) {
  const Arrow = trend === "up" ? ArrowUpRight : trend === "down" ? ArrowDownRight : null;
  return (
    <div className={cn("flex min-w-0 flex-col gap-1", className)}>
      <span className="text-caption text-fg-muted">{label}</span>
      <span className="num text-title text-fg">{value}</span>
      {delta || hint ? (
        <span className="flex items-center gap-1 text-small text-fg-muted">
          {delta ? (
            <span className={cn("num inline-flex items-center gap-0.5", trend === "up" && "text-success", trend === "down" && "text-danger")}>
              {Arrow ? <Arrow aria-hidden="true" className="size-3.5" strokeWidth={2} /> : null}
              {delta}
            </span>
          ) : null}
          {hint ? <span className="truncate">{hint}</span> : null}
        </span>
      ) : null}
    </div>
  );
}
