import { cn } from "@nais/ui";
import type { ReactNode } from "react";

/**
 * Left-aligned page header (spec §5): h1 (display), one muted line, a meta row (small, muted), badges, and the page's
 * actions on the right (below the title on phones). Breadcrumbs live in the top bar, not here.
 * `children` renders under the title block for screens not yet moved to `meta` / `badges`.
 */
export function PageHeader({
  title,
  description,
  meta,
  badges,
  actions,
  children,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  meta?: ReactNode;
  badges?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("mb-6 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between", className)}>
      <div className="min-w-0 flex-1">
        <h1 className="text-display break-words text-fg">{title}</h1>
        {description ? <p className="mt-1 text-body text-fg-muted">{description}</p> : null}
        {meta ? <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-small text-fg-muted">{meta}</div> : null}
        {badges ? <div className="mt-3 flex flex-wrap items-center gap-1.5">{badges}</div> : null}
        {children}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}
