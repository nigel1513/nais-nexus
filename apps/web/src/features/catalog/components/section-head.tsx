import { cn } from "@nais/ui";
import type { ReactNode } from "react";
import { Crumb } from "@/shared/ui/screen-v2";

/**
 * Catalog variant of the shared v2 Crumb: the crumb (accent eyebrow + heavy title + count) on the left and the
 * section's controls (a view switch, sort) on the right, bottom-aligned.
 */
export function SectionHead({ eyebrow, title, count, right, id, className }: { eyebrow: string; title: ReactNode; count?: ReactNode; right?: ReactNode; id?: string; className?: string }) {
  return (
    <div className={cn("flex flex-wrap items-end justify-between gap-x-4 gap-y-2", className)}>
      <Crumb id={id} kicker={eyebrow} title={title} count={count} />
      {right ? <div className="flex shrink-0 items-center gap-2">{right}</div> : null}
    </div>
  );
}
