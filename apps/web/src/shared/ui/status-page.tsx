import { cn } from "@nais/ui";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

/**
 * Full-page state outside the app shell (not found, blocked): the EmptyState pattern on a calm subtle background —
 * icon tile, the code in mono, a title, one line of help and at most two actions. Left-aligned inside a 480px column.
 */
export function StatusPage({
  icon: Icon,
  code,
  title,
  message,
  help,
  actions,
  tone = "neutral",
}: {
  icon: LucideIcon;
  code?: string;
  title: string;
  message: ReactNode;
  help?: ReactNode;
  actions?: ReactNode;
  tone?: "neutral" | "danger";
}) {
  return (
    <main id="main" className="flex min-h-screen items-center justify-center bg-bg-subtle px-4 py-12">
      <div className="w-full max-w-[30rem] rounded-lg border border-border bg-bg-panel p-6 sm:p-8">
        <div className="flex items-center gap-3">
          <span className={cn("flex size-10 shrink-0 items-center justify-center rounded-full", tone === "danger" ? "bg-danger-soft text-danger" : "bg-bg-hover text-fg-muted")}>
            <Icon aria-hidden="true" strokeWidth={1.75} className="size-5" />
          </span>
          {code ? <span className="font-mono text-mono text-fg-muted">{code}</span> : null}
        </div>
        <h1 className="mt-5 text-title text-fg">{title}</h1>
        <div className="mt-2 text-body text-fg-muted">{message}</div>
        {help ? <div className="mt-1 text-small text-fg-muted">{help}</div> : null}
        {actions ? <div className="mt-6 flex flex-wrap gap-2">{actions}</div> : null}
      </div>
    </main>
  );
}
