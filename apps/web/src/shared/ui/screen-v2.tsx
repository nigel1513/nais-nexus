import { cn } from "@nais/ui";
import { Fragment, type CSSProperties, type ReactNode } from "react";
import "./screen-v2.css";

/** Joins context parts with a muted "·" (decorative, hidden from screen readers). Every v2 head and band uses it. */
export function Context({ parts }: { parts: ReactNode[] }) {
  const items = parts.filter((p) => p !== null && p !== undefined && p !== false && p !== "");
  return (
    <p className="sv-ctx">
      {items.map((p, i) => (
        <Fragment key={i}>
          {i > 0 ? <span aria-hidden="true">·</span> : null}
          <span>{p}</span>
        </Fragment>
      ))}
    </p>
  );
}

/**
 * Two-step page title (UI v2): a muted context line over the heavy page name, an optional one-line description, and the
 * page's actions on the right (below the title on phones). The h1 holds only the name, so its accessible name stays it.
 */
export function ScreenTitle({ context, title, description, actions, children }: { context?: ReactNode[]; title: ReactNode; description?: ReactNode; actions?: ReactNode; children?: ReactNode }) {
  return (
    <header className="sv-head">
      <div className="min-w-0 flex-1">
        {context?.length ? <Context parts={context} /> : null}
        <h1 className="sv-h1">{title}</h1>
        {description ? <p className="sv-desc">{description}</p> : null}
        {children}
      </div>
      {actions ? <div className="sv-acts">{actions}</div> : null}
    </header>
  );
}

export type BandFact = { label: string; value: ReactNode; unit?: string; kind?: "number" | "mono" | "text"; accent?: boolean };

/**
 * Summary band (hero tokens, dark in both themes): context line, heavy name, tags and actions on top, then a row of key
 * facts split by 1px rules. Used where the header carries a summary of the thing on the page.
 */
export function SummaryBand({ context, title, tags, actions, facts, label }: { context?: ReactNode[]; title: ReactNode; tags?: ReactNode; actions?: ReactNode; facts: BandFact[]; label: string }) {
  return (
    <section className="sv-band" aria-label={label}>
      <div className="sv-band-in">
        <div className="min-w-0 flex-1">
          {context?.length ? <Context parts={context} /> : null}
          <h1 className="sv-h1">{title}</h1>
          {tags ? <div className="sv-tags">{tags}</div> : null}
        </div>
        {actions ? <div className="sv-acts">{actions}</div> : null}
      </div>
      <dl className="sv-facts" style={{ "--sv-cols": facts.length } as CSSProperties}>
        {facts.map((f) => (
          <div key={f.label}>
            <dt>{f.label}</dt>
            <dd data-mono={f.kind === "mono" ? "" : undefined} data-text={f.kind === "text" ? "" : undefined} data-accent={f.accent ? "" : undefined}>
              {f.value}
              {f.unit ? <small>{f.unit}</small> : null}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/** A tag on the summary band. `tone`: accent (selection, e.g. my role), ok / warn (status dot), or neutral. */
export function BandTag({ tone, icon, children }: { tone?: "accent" | "ok" | "warn"; icon?: ReactNode; children: ReactNode }) {
  return (
    <span className="sv-tag" data-tone={tone}>
      {icon}
      {children}
    </span>
  );
}

/** Crumb label (UI v2): accent eyebrow with an optional mono index ("01"), then the heavy section title and a count. */
export function Crumb({ id, kicker, index, title, count, as: Tag = "h2", className, after }: { id?: string; kicker?: string; index?: number; title: ReactNode; count?: ReactNode; as?: "h2" | "h3"; className?: string; after?: ReactNode }) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-1", className)}>
      {kicker ? (
        <span className="sv-kicker" aria-hidden="true">
          {index !== undefined ? <b>{String(index).padStart(2, "0")}</b> : null}
          {kicker}
        </span>
      ) : null}
      <div className="flex min-w-0 items-baseline gap-2">
        <Tag id={id} className="sv-h2 break-keep">
          {title}
          {count !== undefined && count !== null ? <span className="sv-count ml-2">{count}</span> : null}
        </Tag>
        {after}
      </div>
    </div>
  );
}

export type Step = { label: string; hint?: string; state: "done" | "now" | "next" | "planned"; plannedLabel?: string };

/** The start page's numbered steps, laid out across the page; the current step is the accent one. */
export function StepTrack({ label, steps }: { label: string; steps: Step[] }) {
  return (
    <ol aria-label={label} className="sv-steps break-keep">
      {steps.map((s) => (
        <li key={s.label} data-state={s.state} aria-current={s.state === "now" ? "step" : undefined}>
          <b>
            {s.label}
            {s.state === "planned" && s.plannedLabel ? <span className="sv-plan">{s.plannedLabel}</span> : null}
          </b>
          {s.hint ? <small>{s.hint}</small> : null}
        </li>
      ))}
    </ol>
  );
}
