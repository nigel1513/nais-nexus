import * as React from "react";
import { cn } from "./cn";

export type Tone = "neutral" | "success" | "warning" | "danger" | "info" | "accent";

/** Fill = step 3, text = step 11 of the tone's scale (spec §4 Badge). */
export const toneClass: Record<Tone, string> = {
  neutral: "bg-bg-active text-fg-muted",
  success: "bg-success-soft text-success",
  warning: "bg-warning-soft text-warning",
  danger: "bg-danger-soft text-danger",
  info: "bg-info-soft text-info",
  accent: "bg-accent-soft text-accent-fg",
};

const dotClass: Record<Tone, string> = {
  neutral: "bg-fg-subtle",
  success: "bg-success-solid",
  warning: "bg-warning-solid",
  danger: "bg-danger-solid",
  info: "bg-info-solid",
  accent: "bg-accent",
};

export type BadgeProps = React.HTMLAttributes<HTMLSpanElement> & {
  tone?: Tone;
  /** Status style: a 6px dot in the tone's solid colour + plain muted text, no fill. */
  dot?: boolean;
};

/** 20px label, 12/500. */
export function Badge({ tone = "neutral", dot, className, children, ...props }: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex h-5 shrink-0 items-center gap-1 whitespace-nowrap rounded-sm text-caption [&_svg]:size-3 [&_svg]:shrink-0",
        dot ? "gap-1.5 px-0 text-fg-muted" : cn("px-1.5", toneClass[tone]),
        className,
      )}
      {...props}
    >
      {dot ? <span aria-hidden="true" className={cn("size-1.5 rounded-full", dotClass[tone])} /> : null}
      {children}
    </span>
  );
}
