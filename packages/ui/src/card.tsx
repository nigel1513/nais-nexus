import * as React from "react";
import { cn } from "./cn";

type DivProps = React.HTMLAttributes<HTMLDivElement>;

/** Stand-alone object (list item, summary panel): 1px border, radius md, no shadow. Never nest cards. */
export function Card({ className, ...props }: DivProps) {
  return <section className={cn("rounded-md border border-border bg-bg-panel", className)} {...props} />;
}
export function CardHeader({ className, ...props }: DivProps) {
  return <div className={cn("flex flex-col gap-1 px-4 pb-2 pt-4", className)} {...props} />;
}
export function CardTitle({ className, as: Tag = "h2", ...props }: React.HTMLAttributes<HTMLHeadingElement> & { as?: "h2" | "h3" }) {
  return <Tag className={cn("text-heading text-fg", className)} {...props} />;
}
export function CardDescription({ className, ...props }: React.HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn("text-small text-fg-muted", className)} {...props} />;
}
export function CardContent({ className, ...props }: DivProps) {
  return <div className={cn("px-4 pb-4 pt-2", className)} {...props} />;
}
export function CardFooter({ className, ...props }: DivProps) {
  return <div className={cn("flex items-center gap-2 border-t border-border px-4 py-3", className)} {...props} />;
}
