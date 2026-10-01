import * as React from "react";
import { cn } from "./cn";

/** Keycap: mono 11px, 1px border, 4px radius — the one radius outside the 6/10/14 scale (spec §4). */
export function Kbd({ className, ...props }: React.HTMLAttributes<HTMLElement>) {
  return (
    <kbd
      className={cn(
        "inline-flex h-5 min-w-5 items-center justify-center rounded-[4px] border border-border bg-bg-subtle px-1 font-mono text-[11px] leading-none text-fg-muted",
        className,
      )}
      {...props}
    />
  );
}
