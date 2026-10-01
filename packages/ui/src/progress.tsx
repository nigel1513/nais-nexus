import { cn } from "./cn";

/**
 * 4px bar in --accent (spec §4 Progress). The fill grows with transform: scaleX, never width. `value` null =
 * indeterminate (no aria-valuenow; the bar shows a third, static).
 */
export function Progress({
  value,
  max = 100,
  label,
  valueText,
  tone = "accent",
  className,
}: {
  value: number | null;
  max?: number;
  /** Accessible name. */
  label: string;
  /** Spoken value, e.g. "3 / 12 파일". */
  valueText?: string;
  tone?: "accent" | "success" | "danger";
  className?: string;
}) {
  const ratio = value === null ? null : Math.min(1, Math.max(0, value / max));
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={value === null ? undefined : value}
      aria-valuetext={valueText}
      className={cn("h-1 w-full overflow-hidden rounded-sm bg-bg-active", className)}
    >
      <div
        className={cn(
          "h-full w-full origin-left rounded-sm transition-transform duration-[var(--dur-base)] ease-[var(--ease-out)]",
          tone === "accent" && "bg-accent",
          tone === "success" && "bg-success-solid",
          tone === "danger" && "bg-danger-solid",
        )}
        style={{ transform: `scaleX(${ratio ?? 0.33})` }}
      />
    </div>
  );
}
