import type { LucideIcon } from "lucide-react";
import * as React from "react";
import { cn } from "./cn";
import { iconStroke } from "./styles";

/** Spec §4 EmptyState: 20px icon on a round tile, 14/600 title, one line of help, at most one action. No art. */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
}: {
  icon?: LucideIcon;
  title: string;
  description?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col items-center px-6 py-12 text-center", className)}>
      {Icon ? (
        <span className="mb-3 flex size-10 items-center justify-center rounded-full bg-bg-hover text-fg-muted">
          <Icon aria-hidden="true" className="size-5" strokeWidth={iconStroke} />
        </span>
      ) : null}
      <p className="text-body font-semibold text-fg">{title}</p>
      {description ? <p className="mt-1 max-w-sm text-small text-fg-muted">{description}</p> : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}
