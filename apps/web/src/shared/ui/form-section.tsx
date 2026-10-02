import type { ReactNode } from "react";
import { Crumb } from "./screen-v2";

/**
 * Form page template (spec §5, UI v2 crumbs): each section is a titled block with an accent eyebrow (mono index +
 * short label) over its heavy title. From 672px of form width the title and its one-line description sit in a 13rem
 * column left of the fields (≥1024px viewport on the page, single column in the 640px sheet).
 */
export function FormSection({ id, title, description, kicker, index, children }: { id: string; title: string; description?: string; kicker?: string; index?: number; children: ReactNode }) {
  return (
    <section
      id={id}
      aria-labelledby={`${id}-title`}
      data-section={id}
      className="grid scroll-mt-20 grid-cols-1 gap-x-8 gap-y-4 border-t border-border py-8 first-of-type:border-t-0 first-of-type:pt-2 @2xl/form:grid-cols-[13rem_minmax(0,1fr)]"
    >
      <div className="flex flex-col gap-1.5">
        <Crumb id={`${id}-title`} kicker={kicker} index={index} title={title} />
        {description ? <p className="break-keep text-small leading-relaxed text-fg-muted">{description}</p> : null}
      </div>
      <div className="flex min-w-0 flex-col gap-4">{children}</div>
    </section>
  );
}
