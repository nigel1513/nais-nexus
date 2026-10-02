import { cn, focusRing } from "@nais/ui";
import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { Fragment, type ReactNode } from "react";
import { Crumb } from "./screen-v2";

/**
 * UI v2 page header for work screens (the landing's language inside the app): a dark `--color-hero` band holding a
 * two-step title — a muted context line ("거버넌스 · 기관 · 역할") over the heavy page name — and, when the page carries
 * a summary, a strip of figures split by 1px rules. Figures may link to the view they count.
 */
export function WorkHero({
  context,
  title,
  description,
  meta,
  actions,
  stats,
  statsLabel,
  className,
}: {
  /** Crumb line items; the first reads brighter (where you are), the rest muted. */
  context: ReactNode[];
  title: ReactNode;
  description?: ReactNode;
  /** Small facts under the title (status, dates, IDs). */
  meta?: ReactNode;
  actions?: ReactNode;
  stats?: HeroStat[];
  statsLabel?: string;
  className?: string;
}) {
  // Shares the summary band's classes (screen-v2.css, Track B) so every v2 header reads the same.
  const parts = context.filter((c) => c !== null && c !== undefined && c !== "");
  return (
    <header className={cn("sv-band", className)}>
      <div className="sv-band-in pb-0">
        <div className="min-w-0 flex-1">
          <p className="sv-ctx">
            {parts.map((c, i) => (
              <Fragment key={i}>
                {i > 0 ? <span aria-hidden="true">·</span> : null}
                <span className={i === 0 ? "font-semibold text-hero-fg" : undefined}>{c}</span>
              </Fragment>
            ))}
          </p>
          <h1 className="sv-h1">{title}</h1>
          {description ? <p className="mt-2 max-w-[46em] text-body text-hero-fg-muted [text-wrap:pretty]">{description}</p> : null}
          {meta ? <div className="sv-tags items-center gap-x-3 text-small text-hero-fg-muted">{meta}</div> : null}
        </div>
        {actions ? <div className="sv-acts">{actions}</div> : null}
      </div>
      {stats?.length ? (
        <ul aria-label={statsLabel} className={cn("mt-[22px] grid grid-cols-2 gap-px border-t border-hero-fg/12 bg-hero-fg/12", stats.length >= 4 ? "lg:grid-cols-4" : "sm:grid-cols-3")}>
          {stats.map((s) => (
            <li key={s.label} className="flex min-w-0 bg-hero">
              <HeroFigure {...s} />
            </li>
          ))}
        </ul>
      ) : null}
    </header>
  );
}

export type HeroStat = { label: string; value: string | null; unit?: string; hint?: string; href?: string; highlight?: boolean };

function HeroFigure({ label, value, unit, hint, href, highlight }: HeroStat) {
  const body = (
    <>
      <span className="truncate text-[12.5px] text-hero-fg-muted">{label}</span>
      <span className="flex items-baseline gap-1">
        <span className={cn("num text-[19px] font-bold leading-[1.25] tracking-[-0.03em] sm:text-[22px]", highlight ? "text-hero-accent" : "text-hero-fg")}>{value ?? "—"}</span>
        {unit && value !== null ? <span className="text-small text-hero-fg-muted">{unit}</span> : null}
      </span>
      {hint ? <span className="truncate text-caption font-normal text-hero-fg-muted">{hint}</span> : null}
    </>
  );
  const cls = "flex min-w-0 flex-1 flex-col gap-[3px] px-4 py-3 sm:px-6 sm:pb-4 sm:pt-3.5";
  return href ? (
    <Link href={href} scroll={false} className={cn(cls, "outline-none transition-colors duration-[var(--dur-fast)] hover:bg-hero-fg/5 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-hero-accent")}>
      {body}
    </Link>
  ) : (
    <div className={cls}>{body}</div>
  );
}

/**
 * Panel head: the shared Crumb (accent eyebrow, heavy title, mono count) and, on the right, either "전체 보기 →" or the
 * panel's own controls (a filter, a sort, a view switch). Used for every crumb head with controls on work and data
 * screens. `id` names the title only, so a section labelled by it reads "검토", not "결정 검토".
 */
export function PanelHead({
  id,
  crumb,
  title,
  count,
  more,
  right,
  as = "h2",
  className,
}: {
  id?: string;
  crumb: string;
  title: ReactNode;
  count?: ReactNode;
  more?: { href: string; label: string };
  right?: ReactNode;
  as?: "h2" | "h3";
  className?: string;
}) {
  return (
    <div className={cn("flex flex-wrap items-end justify-between gap-x-4 gap-y-2", className)}>
      <Crumb
        as={as}
        kicker={crumb}
        title={id ? <span id={id}>{title}</span> : title}
        after={count !== undefined && count !== null ? <span className="sv-count">{count}</span> : undefined}
      />
      {right ? <div className="flex shrink-0 items-center gap-2">{right}</div> : null}
      {more ? (
        <Link href={more.href} className={cn("flex shrink-0 items-center gap-1 whitespace-nowrap rounded-sm text-small text-fg-muted hover:text-fg", focusRing)}>
          {more.label}
          <ArrowRight aria-hidden="true" strokeWidth={1.75} className="size-3.5" />
        </Link>
      ) : null}
    </div>
  );
}
