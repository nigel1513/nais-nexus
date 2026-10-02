"use client";
import * as React from "react";
import { GroupedVirtuoso } from "react-virtuoso";
import { cn } from "./cn";
import { VIRTUALIZE_AFTER } from "./data-table";

export type ListGroup<T> = { key: string; label: React.ReactNode; items: T[] };

const headerCls = "flex h-8 items-center gap-2 border-b border-border bg-bg text-caption text-fg-muted";

/**
 * A list split under caption group headers (activity timeline, spec §6). Small lists render as plain sections whose
 * headers stick under the 48px top bar while the page scrolls. Above VIRTUALIZE_AFTER items the list renders only
 * the visible window (react-virtuoso) inside a bounded frame, with the group headers sticky inside the frame.
 */
export function GroupedList<T>({
  groups,
  itemKey,
  renderItem,
  label,
  virtualize = "auto",
  height = 640,
  className,
}: {
  groups: ListGroup<T>[];
  itemKey: (item: T) => string;
  renderItem: (item: T) => React.ReactNode;
  /** Accessible name of the whole list. */
  label: string;
  virtualize?: boolean | "auto";
  /** Frame height in px when virtualized. */
  height?: number;
  className?: string;
}) {
  const baseId = React.useId();
  const total = groups.reduce((n, g) => n + g.items.length, 0);

  if (virtualize === true || (virtualize === "auto" && total > VIRTUALIZE_AFTER)) {
    const flat = groups.flatMap((g) => g.items);
    return (
      <div role="region" aria-label={label} className={cn("overflow-hidden rounded-md border border-border", className)}>
        <GroupedVirtuoso
          style={{ height }}
          groupCounts={groups.map((g) => g.items.length)}
          initialItemCount={Math.min(total, 30)}
          computeItemKey={(index) => itemKey(flat[index]!)}
          groupContent={(i) => (
            <div role="heading" aria-level={2} className={cn(headerCls, "px-4")}>
              {groups[i]!.label}
            </div>
          )}
          itemContent={(index) => <div className="px-4">{renderItem(flat[index]!)}</div>}
        />
      </div>
    );
  }

  return (
    <div role="region" aria-label={label} className={className}>
      {groups.map((g, i) => (
        <section key={g.key} aria-labelledby={`${baseId}-${i}`}>
          <h2 id={`${baseId}-${i}`} className={cn(headerCls, "sticky top-12 z-[var(--z-sticky)]")}>
            {g.label}
          </h2>
          <ol>
            {g.items.map((item) => (
              <li key={itemKey(item)}>{renderItem(item)}</li>
            ))}
          </ol>
        </section>
      ))}
    </div>
  );
}
