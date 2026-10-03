"use client";
import { cn, focusRing } from "@nais/ui";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { Fragment } from "react";
import { formatDate } from "@/shared/lib/format";
import type { HubCard as HubCardT } from "../api";

export type HubRail = "trending" | "recent" | "most_used";

/**
 * One dataset on a hub rail: the title (a stretched link over the card), one meta line — 기관 · 분야 · 접근 등급 ·
 * AI-ready · 최근 갱신 — and, when the rail counts something, the real figure. A missing value is left out, never padded.
 */
export function HubCard({ card, rail, subjectLabel }: { card: HubCardT; rail: HubRail; subjectLabel: (label: string) => string | null }) {
  const t = useTranslations();
  const meta = [
    card.owner_organization_name,
    card.subject_labels[0] ? subjectLabel(card.subject_labels[0]) : null,
    t(`enums.AccessLevel.${card.access_level}`),
    card.readiness_overall ? t("hub.card.aiReady", { status: t(`enums.ReadinessOverall.${card.readiness_overall}`) }) : null,
    t("hub.card.updated", { date: formatDate(card.updated_at) }),
  ].filter((m): m is string => !!m);
  const metric = card.metric === null ? null : rail === "trending" ? t("hub.card.requests", { count: card.metric }) : rail === "most_used" ? t("hub.card.uses", { count: card.metric }) : null;
  return (
    <li className="relative flex min-w-0 flex-col gap-2 rounded-md border border-border bg-bg-panel px-4 py-3.5 transition-colors duration-[var(--dur-fast)] hover:border-border-strong">
      <h3 className="line-clamp-2 break-keep text-body font-semibold text-fg">
        <Link href={`/commons/data/${card.dataset_id}`} className={cn("rounded-xs after:absolute after:inset-0 after:rounded-md hover:underline hover:underline-offset-4", focusRing)}>
          {card.title}
        </Link>
      </h3>
      <p className="truncate text-small text-fg-muted">
        {meta.map((m, i) => (
          <Fragment key={i}>
            {i > 0 ? <span aria-hidden="true"> · </span> : null}
            <span>{m}</span>
          </Fragment>
        ))}
      </p>
      {metric ? <p className="num mt-auto text-caption font-medium text-fg">{metric}</p> : null}
    </li>
  );
}
