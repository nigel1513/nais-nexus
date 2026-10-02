import type { ReactNode } from "react";

/**
 * Form page template (spec §5): each section is a titled block; from 672px of form width the title and its one-line
 * description sit in a 13rem column left of the fields (≥1024px viewport on the page, single column in the 640px sheet).
 */
export function FormSection({ id, title, description, children }: { id: string; title: string; description?: string; children: ReactNode }) {
  return (
    <section
      aria-labelledby={`${id}-title`}
      data-section={id}
      className="grid grid-cols-1 gap-x-8 gap-y-4 border-t border-border py-8 first-of-type:border-t-0 first-of-type:pt-2 @2xl/form:grid-cols-[13rem_minmax(0,1fr)]"
    >
      <div className="flex flex-col gap-1">
        <h2 id={`${id}-title`} className="text-heading text-fg">
          {title}
        </h2>
        {description ? <p className="break-keep text-small text-fg-muted">{description}</p> : null}
      </div>
      <div className="flex min-w-0 flex-col gap-4">{children}</div>
    </section>
  );
}
