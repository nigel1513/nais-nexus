"use client";
import { Avatar, cn, SelectMenu, type SelectOption } from "@nais/ui";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import type { AccessRequest } from "@/shared/api/types";

/** When the request last entered the queue: the latest SUBMITTED step (a resubmission restarts the wait), else creation. */
export function submittedAt(r: AccessRequest): string {
  return [...(r.history ?? [])].reverse().find((h) => h.status === "SUBMITTED")?.at ?? r.created_at;
}

/** Initials avatar + name, organization in muted text. The avatar is decorative because the name is printed. */
export function Person({ name, org, size = 20, className }: { name: string; org?: string | null; size?: 20 | 24 | 32; className?: string }) {
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-2", className)}>
      <Avatar name={name} size={size} decorative />
      <span className="min-w-0 truncate">
        <span className="text-fg">{name}</span>
        {org ? <span className="text-fg-muted"> · {org}</span> : null}
      </span>
    </span>
  );
}

/** One line above a filterable table: how many rows are loaded on the left, the filter on the right. Without a filter it renders nothing. */
export function ListToolbar({ count, more, filter }: { count: number | undefined; more?: boolean; filter?: ReactNode }) {
  const t = useTranslations();
  if (!filter) return null;
  return (
    <div className="mb-3 flex min-h-8 flex-wrap items-center justify-between gap-3">
      <p className="num text-small text-fg-muted">{!count ? null : t(more ? "access.countMore" : "access.count", { count })}</p>
      {filter}
    </div>
  );
}

const ALL = "ALL";

/** Status filter: a styled listbox (no native select). "" (every status) is stored as ALL inside the listbox. */
export function StatusFilter({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: SelectOption[] }) {
  const t = useTranslations();
  return (
    <SelectMenu
      aria-label={t("access.columns.status")}
      className="w-44"
      value={value || ALL}
      onValueChange={(v) => onChange(!v || v === ALL ? "" : v)}
      options={[{ value: ALL, label: t("access.allStatuses") }, ...options]}
    />
  );
}
