import { X } from "lucide-react";
import * as React from "react";
import { cn } from "./cn";

/** 22px outlined chip for vocabulary terms and keywords; removable while editing (spec §4 Tag). */
export function Tag({
  children,
  onRemove,
  removeLabel,
  className,
}: {
  children: React.ReactNode;
  /** Shows a remove button. */
  onRemove?: () => void;
  /** Accessible name of the remove button, e.g. "배터리 제거". Required with onRemove. */
  removeLabel?: string;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex h-5.5 max-w-full items-center gap-1 rounded-sm border border-border bg-bg-panel text-caption text-fg",
        onRemove ? "pl-2 pr-0.5" : "px-2",
        className,
      )}
    >
      <span className="min-w-0 truncate">{children}</span>
      {onRemove ? (
        <button
          type="button"
          aria-label={removeLabel}
          onClick={onRemove}
          className="flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-[4px] text-fg-muted outline-none hover:bg-bg-hover hover:text-fg focus-visible:outline-2 focus-visible:outline-focus"
        >
          <X aria-hidden="true" className="size-3" strokeWidth={2} />
        </button>
      ) : null}
    </span>
  );
}
