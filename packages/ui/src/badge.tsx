import * as React from "react";
import { cn } from "./cn";

export type Tone = "neutral" | "success" | "warning" | "danger" | "info";

export const toneClass: Record<Tone, string> = {
  neutral: "border-border text-foreground bg-muted",
  success: "border-success text-success bg-background",
  warning: "border-warning text-warning bg-background",
  danger: "border-danger text-danger bg-background",
  info: "border-info text-info bg-background",
};

export function Badge({ tone = "neutral", className, ...props }: React.HTMLAttributes<HTMLSpanElement> & { tone?: Tone }) {
  return (
    <span
      className={cn("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap", toneClass[tone], className)}
      {...props}
    />
  );
}
