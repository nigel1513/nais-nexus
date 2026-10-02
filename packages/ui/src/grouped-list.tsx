"use client";
import * as React from "react";
import { GroupedVirtuoso } from "react-virtuoso";
import { cn } from "./cn";
import { VIRTUALIZE_AFTER } from "./data-table";

export type ListGroup<T> = { key: string; label: React.ReactNode; items: T[] };

const headerCls = "flex h-8 items-center gap-2 border-b border-border bg-bg text-caption text-fg-muted";

const VList = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(function VList(props, ref) {
  return <div ref={ref} {...props} role="list" />;
});

// Module-level so react-virtuoso keeps the same component identities between renders.
const VItem = ({ item: _item, ...props }: React.HTMLAttributes<HTMLDivElement> & { item?: unknown }) => <div {...props} role="listitem" />;
const VGroup = (props: React.HTMLAttributes<HTMLDivElement>) => <div {...props} role="listitem" />;

/**
 * A list split under caption group headers (activity timeline, spec §6). Small lists render as sections with an
 * ordered list each, whose headers stick at `stickyTop` (default: under the 48px top bar) while the page scrolls.
 * Above VIRTUALIZE_AFTER items only the visible window renders (react-virtuoso) inside a bounded frame; it keeps
 * list / listitem roles, and each group header is a list item holding the heading.
 */
export function GroupedList<T>({
  groups,
  itemKey,
  renderItem,
  label,
  headingLevel = 2,
  stickyTop = "top-12",
  virtualize = "auto",
  height = 640,
  className,
  headerClassName,
}: {
  groups: ListGroup<T>[];
  itemKey: (item: T) => string;
  renderItem: (item: T) => React.ReactNode;
  /** Accessible name of the whole list. */
  label: string;
  /** Level of the group headings, to fit the page's outline. */
  headingLevel?: 2 | 3 | 4;
  /** Tailwind `top-*` class for the sticky headers in the non-virtualized list. */
  stickyTop?: string;
  virtualize?: boolean | "auto";
  /** Frame height in px when virtualized. */
  height?: number;
  className?: string;
  /** Extra classes for the group headers (merged over the caption default). */
  headerClassName?: string;
}) {
  const baseId = React.useId();
  const total = groups.reduce((n, g) => n + g.items.length, 0);
  const Heading = `h${headingLevel}` as "h2" | "h3" | "h4";

  if (virtualize === true || (virtualize === "auto" && total > VIRTUALIZE_AFTER)) {
    const flat = groups.flatMap((g) => g.items);
    return (
      <div role="region" aria-label={label} className={cn("overflow-hidden rounded-md border border-border", className)}>
        <GroupedVirtuoso
          style={{ height }}
          groupCounts={groups.map((g) => g.items.length)}
          initialItemCount={Math.min(total, 30)}
          computeItemKey={(index) => itemKey(flat[index]!)}
          components={{
            List: VList,
            Item: VItem,
            Group: VGroup,
          }}
          groupContent={(i) => <Heading className={cn(headerCls, "px-4", headerClassName)}>{groups[i]!.label}</Heading>}
          itemContent={(index) => <div className="px-4">{renderItem(flat[index]!)}</div>}
        />
      </div>
    );
  }

  return (
    <div role="region" aria-label={label} className={className}>
      {groups.map((g, i) => (
        <section key={g.key} aria-labelledby={`${baseId}-${i}`}>
          <Heading id={`${baseId}-${i}`} className={cn(headerCls, "sticky z-[var(--z-sticky)]", stickyTop, headerClassName)}>
            {g.label}
          </Heading>
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
