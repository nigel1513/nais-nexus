import type { ReactNode } from "react";

/** Label / value pairs for rail panels: muted label left, value right-aligned. */
export function DefList({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-2 text-small">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-fg-muted">{k}</dt>
          <dd className="text-right text-fg">{v}</dd>
        </div>
      ))}
    </dl>
  );
}
