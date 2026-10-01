"use client";
import { Toggle } from "@base-ui/react/toggle";
import { ToggleGroup } from "@base-ui/react/toggle-group";
import * as React from "react";
import { cn } from "./cn";

export type SegmentedItem = { value: string; label: React.ReactNode; icon?: React.ReactNode; disabled?: boolean };

/**
 * 28px segmented control (spec §4): slate-3 track, the chosen segment on a raised surface with one shadow step.
 * Exactly one segment is always chosen; arrow keys move between segments. Switching does not animate.
 */
export function SegmentedControl({
  items,
  value,
  onValueChange,
  className,
  "aria-label": ariaLabel,
}: {
  items: SegmentedItem[];
  value: string;
  onValueChange: (value: string) => void;
  className?: string;
  "aria-label": string;
}) {
  return (
    <ToggleGroup
      value={[value]}
      onValueChange={(v) => {
        if (v[0]) onValueChange(v[0]);
      }}
      aria-label={ariaLabel}
      className={cn("inline-flex h-7 items-center gap-0.5 rounded-sm bg-bg-hover p-0.5", className)}
    >
      {items.map((it) => (
        <Toggle
          key={it.value}
          value={it.value}
          disabled={it.disabled}
          className={cn(
            "inline-flex h-6 cursor-pointer select-none items-center gap-1.5 rounded-[4px] px-2.5 text-small font-medium text-fg-muted outline-none",
            "hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-focus",
            "data-[pressed]:bg-bg-raised data-[pressed]:text-fg data-[pressed]:shadow-raised",
            "data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50 [&_svg]:size-3.5",
          )}
        >
          {it.icon}
          {it.label}
        </Toggle>
      ))}
    </ToggleGroup>
  );
}
