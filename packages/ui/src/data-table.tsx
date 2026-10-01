import * as React from "react";
import { Table, TBody, Td, Th, THead, Tr } from "./table";

export type DataColumn<T> = { key: string; header: string; cell: (row: T) => React.ReactNode; className?: string };

/** Table on md+, stacked cards below md so 320px / 200% zoom never scrolls horizontally (M10 §15). */
export function DataTable<T>({
  caption,
  columns,
  rows,
  rowKey,
  empty,
}: {
  caption: string;
  columns: DataColumn<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  empty?: React.ReactNode;
}) {
  if (rows.length === 0) return <>{empty ?? null}</>;
  return (
    <>
      <div className="hidden md:block">
        <Table caption={caption}>
          <THead>
            <Tr>
              {columns.map((c) => (
                <Th key={c.key} className={c.className}>
                  {c.header}
                </Th>
              ))}
            </Tr>
          </THead>
          <TBody>
            {rows.map((row) => (
              <Tr key={rowKey(row)}>
                {columns.map((c) => (
                  <Td key={c.key} className={c.className}>
                    {c.cell(row)}
                  </Td>
                ))}
              </Tr>
            ))}
          </TBody>
        </Table>
      </div>
      <ul className="flex flex-col gap-2 md:hidden" aria-label={caption}>
        {rows.map((row) => (
          <li key={rowKey(row)} className="rounded-md border border-border p-3">
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
              {columns.map((c) => (
                <React.Fragment key={c.key}>
                  <dt className="text-muted-foreground">{c.header}</dt>
                  <dd className="min-w-0 break-words">{c.cell(row)}</dd>
                </React.Fragment>
              ))}
            </dl>
          </li>
        ))}
      </ul>
    </>
  );
}
