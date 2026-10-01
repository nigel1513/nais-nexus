"use client";
import * as React from "react";
import { TableVirtuoso } from "react-virtuoso";
import { cn } from "./cn";
import { Table, TBody, Td, Th, THead, Tr } from "./table";

export type DataColumn<T> = {
  key: string;
  header: string;
  cell: (row: T) => React.ReactNode;
  className?: string;
  /** Right-aligned, tabular figures (counts, sizes, dates). */
  numeric?: boolean;
};

/** Above this many rows the table renders only the visible window (react-virtuoso). */
export const VIRTUALIZE_AFTER = 1000;

/**
 * Spec §4 DataTable: 36px rows (dense 32px), sticky bg-subtle header, row hover, numeric columns right-aligned.
 * Small tables become stacked cards below md so 320px never scrolls sideways (M10 §15); virtualized tables keep the
 * table and scroll inside their own frame.
 */
export function DataTable<T>({
  caption,
  columns,
  rows,
  rowKey,
  empty,
  dense,
  stickyHeader,
  virtualize = "auto",
  height = 480,
  selectedKey,
  onRowClick,
}: {
  caption: string;
  columns: DataColumn<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  empty?: React.ReactNode;
  dense?: boolean;
  /** Keep the header visible while the frame scrolls (needs a bounded height). */
  stickyHeader?: boolean;
  /** "auto" virtualizes above VIRTUALIZE_AFTER rows. */
  virtualize?: boolean | "auto";
  /** Frame height in px for virtualized / sticky tables. */
  height?: number;
  selectedKey?: string;
  /** Makes rows clickable; Enter on a focused row does the same. */
  onRowClick?: (row: T) => void;
}) {
  if (rows.length === 0) return <>{empty ?? null}</>;
  const rowH = dense ? "h-8" : "h-9";
  const cellCls = (c: DataColumn<T>) => cn(dense && "h-8 py-1", c.numeric && "num whitespace-nowrap text-right", c.className);
  const thCls = (c: DataColumn<T>) => cn(c.numeric && "text-right", c.className);
  const rowProps = (row: T) => {
    const selected = selectedKey !== undefined && rowKey(row) === selectedKey;
    return {
      "aria-selected": selectedKey !== undefined ? selected : undefined,
      tabIndex: onRowClick ? 0 : undefined,
      onClick: onRowClick ? () => onRowClick(row) : undefined,
      onKeyDown: onRowClick
        ? (e: React.KeyboardEvent) => {
            if (e.key === "Enter") onRowClick(row);
          }
        : undefined,
      className: cn(
        rowH,
        "hover:bg-bg-hover",
        selected && "bg-accent-soft hover:bg-accent-soft",
        onRowClick && "cursor-pointer outline-none focus-visible:bg-bg-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus",
      ),
    };
  };
  const header = (
    <Tr className="border-0">
      {columns.map((c) => (
        <Th key={c.key} className={thCls(c)}>
          {c.header}
        </Th>
      ))}
    </Tr>
  );

  if (virtualize === true || (virtualize === "auto" && rows.length > VIRTUALIZE_AFTER)) {
    return (
      <div className="w-full overflow-hidden rounded-md border border-border bg-bg-panel">
        <TableVirtuoso
          aria-label={caption}
          style={{ height }}
          data={rows}
          initialItemCount={Math.min(rows.length, 30)}
          computeItemKey={(_, row) => rowKey(row)}
          fixedHeaderContent={() => header}
          components={{
            Table: ({ style, ...props }) => (
              <table {...props} style={style} className="w-full border-collapse text-small">
                <caption className="sr-only">{caption}</caption>
                {props.children}
              </table>
            ),
            TableHead: React.forwardRef<HTMLTableSectionElement>(function Head(props, ref) {
              return <thead ref={ref} {...props} className="bg-bg-subtle text-left" />;
            }),
            TableRow: ({ item, ...props }) => {
              const p = rowProps(item);
              return <tr {...props} {...p} className={cn("border-b border-border", p.className)} />;
            },
          }}
          itemContent={(_, row) =>
            columns.map((c) => (
              <Td key={c.key} className={cellCls(c)}>
                {c.cell(row)}
              </Td>
            ))
          }
        />
      </div>
    );
  }

  return (
    <>
      <div className="hidden md:block">
        <Table
          caption={caption}
          frameClassName={stickyHeader ? "overflow-y-auto" : undefined}
          frameStyle={stickyHeader ? { maxHeight: height } : undefined}
          className={stickyHeader ? "[&_thead]:sticky [&_thead]:top-0 [&_thead]:z-10" : undefined}
        >
          <THead>{header}</THead>
          <TBody>
            {rows.map((row) => {
              const p = rowProps(row);
              return (
                <Tr key={rowKey(row)} {...p}>
                  {columns.map((c) => (
                    <Td key={c.key} className={cellCls(c)}>
                      {c.cell(row)}
                    </Td>
                  ))}
                </Tr>
              );
            })}
          </TBody>
        </Table>
      </div>
      <ul className="flex flex-col divide-y divide-border rounded-md border border-border bg-bg-panel md:hidden" aria-label={caption}>
        {rows.map((row) => (
          <li key={rowKey(row)} className="p-3">
            <dl className="grid grid-cols-[minmax(0,auto)_1fr] gap-x-3 gap-y-1 text-small">
              {columns.map((c) => (
                <React.Fragment key={c.key}>
                  <dt className="text-fg-muted">{c.header}</dt>
                  <dd className={cn("min-w-0 break-words text-fg", c.numeric && "num")}>{c.cell(row)}</dd>
                </React.Fragment>
              ))}
            </dl>
          </li>
        ))}
      </ul>
    </>
  );
}
