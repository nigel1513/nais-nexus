"use client";
import { buttonClass } from "@nais/ui";
import { NotebookPen } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import type { ComponentProps } from "react";

/** The project's 노트북 tab: JupyterLab inside the portal (notebook-tab.tsx). */
export const notebookHref = (projectId: string) => `/commons/projects/${encodeURIComponent(projectId)}/notebook`;

/** "노트북 열기": a link to the project workspace's 노트북 tab. */
export function OpenNotebookLink({ projectId, variant = "secondary", size, className, children, ...rest }: { projectId: string; variant?: Parameters<typeof buttonClass>[0]; size?: Parameters<typeof buttonClass>[1] } & Omit<ComponentProps<typeof Link>, "href">) {
  const t = useTranslations();
  return (
    <Link href={notebookHref(projectId)} className={className ?? buttonClass(variant, size)} {...rest}>
      <NotebookPen aria-hidden="true" strokeWidth={1.75} />
      {children ?? t("notebooks.open")}
    </Link>
  );
}
