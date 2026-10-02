import * as React from "react";
import { cn } from "./cn";

/** Keycap: mono 11px, 1px border, --radius-xs (4px) (spec §4). */
export function Kbd({ className, ...props }: React.HTMLAttributes<HTMLElement>) {
  return (
    <kbd
      className={cn(
        "inline-flex h-5 min-w-5 items-center justify-center rounded-xs border border-border bg-bg-subtle px-1 font-mono text-micro leading-none text-fg-muted",
        className,
      )}
      {...props}
    />
  );
}
