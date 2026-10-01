import * as React from "react";
import { cn } from "./cn";
import { focusRing } from "./styles";

/** Plain table in a bordered, scrollable frame: header bg-subtle 12/500, rows 36px with 1px dividers. */
export function Table({
  caption,
  captionHidden = true,
  className,
  frameClassName,
  frameStyle,
  children,
}: {
  caption: string;
  captionHidden?: boolean;
  className?: string;
  frameClassName?: string;
  frameStyle?: React.CSSProperties;
  children: React.ReactNode;
}) {
  return (
    // Focusable region so keyboard users can scroll a table wider than its frame (axe scrollable-region-focusable).
    // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
    <div
      role="region"
      aria-label={caption}
      tabIndex={0}
      className={cn("w-full overflow-x-auto rounded-md border border-border bg-bg-panel", focusRing, frameClassName)}
      style={frameStyle}
    >
      <table className={cn("w-full border-collapse text-small", className)}>
        <caption className={captionHidden ? "sr-only" : "px-3 py-2 text-left text-body font-medium"}>{caption}</caption>
        {children}
      </table>
    </div>
  );
}
export function THead({ className, ...props }: React.HTMLAttributes<HTMLTableSectionElement>) {
  return <thead className={cn("bg-bg-subtle text-left", className)} {...props} />;
}
export function TBody({ className, ...props }: React.HTMLAttributes<HTMLTableSectionElement>) {
  return <tbody className={cn(className)} {...props} />;
}
export function Tr({ className, ...props }: React.HTMLAttributes<HTMLTableRowElement>) {
  return <tr className={cn("border-b border-border last:border-0", className)} {...props} />;
}
export function Th({ className, scope = "col", ...props }: React.ThHTMLAttributes<HTMLTableCellElement>) {
  return (
    <th
      scope={scope}
      className={cn("h-9 whitespace-nowrap border-b border-border px-3 text-caption text-fg-muted", className)}
      {...props}
    />
  );
}
export function Td({ className, ...props }: React.TdHTMLAttributes<HTMLTableCellElement>) {
  return <td className={cn("h-9 px-3 py-2 align-middle text-fg", className)} {...props} />;
}
