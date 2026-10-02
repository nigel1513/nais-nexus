"use client";
import { cn } from "@nais/ui";
import { useTranslations } from "next-intl";
import type { AccessGrant } from "@/shared/api/types";
import { formatDate } from "@/shared/lib/format";
import { DateTime } from "@/shared/ui/date-text";

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;

/** Days left (rounded up), the share of the term still ahead, and whether it ends within a week. */
export function grantTerm(g: Pick<AccessGrant, "valid_from" | "expires_at">, now = Date.now()) {
  const start = Date.parse(g.valid_from);
  const end = Date.parse(g.expires_at);
  const left = end - now;
  const total = Math.max(end - start, DAY_MS);
  return {
    days: Math.max(0, Math.ceil(left / DAY_MS)),
    totalDays: Math.max(1, Math.round(total / DAY_MS)),
    share: Math.min(1, Math.max(0, left / total)),
    soon: left > 0 && left <= WEEK_MS,
    over: left <= 0,
  };
}

/**
 * A grant's remaining term as a D-day bar: the filled part is what is left of the granted period, neutral until the last
 * week, then amber. The bar is decorative; the D-day and the end date carry the meaning in text.
 */
export function GrantTerm({ grant, wide }: { grant: Pick<AccessGrant, "valid_from" | "expires_at" | "status">; wide?: boolean }) {
  const t = useTranslations();
  const active = grant.status === "ACTIVE";
  const term = grantTerm(grant);
  if (!active || term.over) {
    return (
      <span className="num text-fg-muted">
        <DateTime value={grant.expires_at} dateOnly />
      </span>
    );
  }
  return (
    <span className={cn("inline-flex flex-col items-end gap-1", wide && "w-full items-stretch")}>
      <span className="flex items-center gap-2.5">
        <span aria-hidden="true" className={cn("relative h-1.5 overflow-hidden rounded-full bg-bg-active", wide ? "flex-1" : "w-20")}>
          <span
            className={cn("grow-x absolute inset-y-0 left-0 origin-left rounded-full", term.soon ? "bg-warning-solid" : "bg-fg-subtle")}
            style={{ width: `${Math.max(term.share * 100, 4)}%` }}
          />
        </span>
        <span className={cn("num min-w-12 text-right font-mono text-mono", term.soon ? "font-semibold text-warning" : "text-fg")}>
          {term.days === 0 ? t("access.ddayToday") : t("access.dday", { days: term.days })}
        </span>
      </span>
      <span className="num text-caption font-normal text-fg-muted">{t("access.termOf", { date: formatDate(grant.expires_at), total: term.totalDays })}</span>
    </span>
  );
}
