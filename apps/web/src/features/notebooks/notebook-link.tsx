"use client";
import { Button, buttonClass, cn } from "@nais/ui";
import { NotebookPen, TriangleAlert, X } from "lucide-react";
import { useTranslations } from "next-intl";
import type { ComponentProps } from "react";
import { useUrlQuery } from "@/shared/hooks/use-url-query";

/** The server route that prepares the caller's Jupyter folder of a project and redirects into JupyterLab. */
export const notebookHref = (projectId: string) => `/notebooks-open?project=${encodeURIComponent(projectId)}`;

/**
 * "노트북 열기": a plain anchor, not a Next <Link> — the route answers with a redirect to /notebooks/ (JupyterLab), which
 * must be a full navigation in the same tab and must never be prefetched.
 */
export function OpenNotebookLink({ projectId, variant = "secondary", size, className, children, ...rest }: { projectId: string; variant?: Parameters<typeof buttonClass>[0]; size?: Parameters<typeof buttonClass>[1] } & Omit<ComponentProps<"a">, "href">) {
  const t = useTranslations();
  return (
    <a href={notebookHref(projectId)} className={className ?? buttonClass(variant, size)} {...rest}>
      <NotebookPen aria-hidden="true" strokeWidth={1.75} />
      {children ?? t("notebooks.open")}
    </a>
  );
}

/** ?notebook_error=unavailable|forbidden, set by /notebooks-open when it sends the browser back: an inline alert. */
export function NotebookErrorAlert({ className }: { className?: string }) {
  const t = useTranslations();
  const [params, setParams] = useUrlQuery();
  const error = params.get("notebook_error");
  if (error !== "unavailable" && error !== "forbidden") return null;
  return (
    <div role="alert" className={cn("flex items-start gap-2 rounded-md border border-warning-line bg-warning-soft p-3 text-small text-fg", className)}>
      <TriangleAlert aria-hidden="true" strokeWidth={1.75} className="mt-0.5 size-4 shrink-0 text-warning" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className="font-medium">{t(`notebooks.error.${error}`)}</p>
        {error === "unavailable" ? <p className="text-fg-muted">{t("notebooks.error.unavailableHint")}</p> : null}
      </div>
      <Button variant="ghost" size="sm" aria-label={t("notebooks.dismiss")} onClick={() => setParams({ notebook_error: null })}>
        <X aria-hidden="true" strokeWidth={1.75} />
      </Button>
    </div>
  );
}
