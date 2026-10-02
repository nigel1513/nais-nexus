import { cn } from "@nais/ui";
import type { ReactNode } from "react";
import "./v2.css";

/** Page-title type from the start page: heavy, tight tracking (UI v2). */
export const pageTitle = "text-[26px] leading-[32px] sm:text-[34px] sm:leading-[40px] font-[760] tracking-[-0.04em] text-fg break-keep";
/** Eyebrow ("crumb") label: small, semibold, accent ink. */
export const crumbClass = "text-caption font-semibold tracking-[-0.005em] text-accent-fg";

/**
 * Dark header band (the start page's hero surface) for a page header that carries a summary. The subtree is forced
 * dark, so buttons, inputs and badges inside use their dark-theme tokens in either page theme.
 */
export function HeroBand({ children, className, label }: { children: ReactNode; className?: string; label?: string }) {
  return (
    <div role={label ? "region" : undefined} aria-label={label} className={cn("dark nx-band mb-8 rounded-lg border border-border bg-hero text-fg", className)}>
      {children}
    </div>
  );
}

/** Two-step title: a muted context line over the bold name. */
export function TwoStepTitle({ crumb, context, title, id }: { crumb?: ReactNode; context?: ReactNode; title: ReactNode; id?: string }) {
  return (
    <div className="flex min-w-0 flex-col">
      {crumb ? <p className={cn(crumbClass, "mb-3")}>{crumb}</p> : null}
      {context ? <p className="nx-rise text-[15px] leading-6 font-medium tracking-[-0.02em] text-fg-muted sm:text-[17px] sm:leading-[26px]">{context}</p> : null}
      <h1 id={id} className={cn(pageTitle, "nx-rise nx-rise-2 mt-1 break-words")}>
        {title}
      </h1>
    </div>
  );
}

/** Section head: accent eyebrow, title with an optional count, and something on the right (a control or a link). */
export function SectionHead({ eyebrow, title, count, right, id, className }: { eyebrow: ReactNode; title: ReactNode; count?: ReactNode; right?: ReactNode; id?: string; className?: string }) {
  return (
    <div className={cn("flex flex-wrap items-end justify-between gap-x-4 gap-y-2", className)}>
      <div className="min-w-0">
        <p className={crumbClass}>{eyebrow}</p>
        <h2 id={id} className="mt-0.5 flex min-w-0 items-baseline gap-2 text-[17px] leading-6 font-[700] tracking-[-0.025em] text-fg">
          <span className="truncate">{title}</span>
          {count != null ? <span className="num text-small font-normal tracking-normal text-fg-muted">{count}</span> : null}
        </h2>
      </div>
      {right ? <div className="flex shrink-0 items-center gap-2">{right}</div> : null}
    </div>
  );
}
