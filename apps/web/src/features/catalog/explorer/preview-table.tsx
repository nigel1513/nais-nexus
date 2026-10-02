"use client";
import { Table, TBody, Td, Th, THead, Tr } from "@nais/ui";

/** Raw-value preview: mono 12.5 cells, sticky header inside a bounded frame, nulls as a muted dash. */
export function PreviewTable({ caption, header, rows, maxHeight }: { caption: string; header: string[]; rows: (string | null)[][]; maxHeight?: number }) {
  return (
    <Table
      caption={caption}
      frameClassName={maxHeight ? "overflow-y-auto" : undefined}
      frameStyle={maxHeight ? { maxHeight } : undefined}
      className="[&_thead]:sticky [&_thead]:top-0 [&_thead]:z-[var(--z-sticky)]"
    >
      <THead>
        <Tr>
          {header.map((h, i) => (
            <Th key={i} className="font-mono">
              {h}
            </Th>
          ))}
        </Tr>
      </THead>
      <TBody>
        {rows.map((r, i) => (
          <Tr key={i} className="h-8 hover:bg-bg-hover">
            {r.map((cell, j) => (
              <Td key={j} className="h-8 whitespace-nowrap py-1 font-mono text-mono">
                {cell === null ? <span className="text-fg-muted">—</span> : cell}
              </Td>
            ))}
          </Tr>
        ))}
      </TBody>
    </Table>
  );
}
