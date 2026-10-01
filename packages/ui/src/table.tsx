import * as React from "react";
import { cn } from "./cn";

export function Table({
  caption,
  captionHidden = true,
  className,
  children,
}: {
  caption: string;
  captionHidden?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="w-full overflow-x-auto">
      <table className={cn("w-full border-collapse text-sm", className)}>
        <caption className={captionHidden ? "sr-only" : "mb-2 text-left font-medium"}>{caption}</caption>
        {children}
      </table>
    </div>
  );
}
export function THead(props: React.HTMLAttributes<HTMLTableSectionElement>) {
  return <thead className="border-b border-border text-left" {...props} />;
}
export function TBody(props: React.HTMLAttributes<HTMLTableSectionElement>) {
  return <tbody {...props} />;
}
export function Tr({ className, ...props }: React.HTMLAttributes<HTMLTableRowElement>) {
  return <tr className={cn("border-b border-border last:border-0", className)} {...props} />;
}
export function Th({ className, scope = "col", ...props }: React.ThHTMLAttributes<HTMLTableCellElement>) {
  return <th scope={scope} className={cn("px-3 py-2 font-medium text-muted-foreground", className)} {...props} />;
}
export function Td({ className, ...props }: React.TdHTMLAttributes<HTMLTableCellElement>) {
  return <td className={cn("px-3 py-2 align-top", className)} {...props} />;
}
