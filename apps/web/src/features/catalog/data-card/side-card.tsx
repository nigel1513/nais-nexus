"use client";
import { cn } from "@nais/ui";
import { TriangleAlert } from "lucide-react";
import { useTranslations } from "next-intl";
import { useId, type ReactNode, type Ref } from "react";
import type { Dataset, DatasetVersion } from "@/shared/api/types";
import { AccessLevelBadge } from "@/shared/ui/badges";
import { PersonLine } from "../components/person-line";
import { ActivitySummary } from "./activity-summary";
import { DefList } from "./def-list";
import "@/shared/ui/screen-v2.css";

/** One rail section: accent crumb title, then its content; sections share one bordered panel, split by 1px rules. */
export function RailPanel({ title, children, panelRef, focusable }: { title: string; children: ReactNode; panelRef?: Ref<HTMLElement>; focusable?: boolean }) {
  const id = useId();
  return (
    <section
      aria-labelledby={id}
      ref={panelRef}
      tabIndex={focusable ? -1 : undefined}
      className={cn("flex min-w-0 flex-col gap-3 bg-bg-panel px-4 py-4 sm:[&:last-child:nth-child(odd)]:col-span-2 xl:[&:last-child:nth-child(odd)]:col-span-1 xl:last:flex-1", focusable && "outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus")}
    >
      <h2 id={id} className="sv-kicker">
        {title}
      </h2>
      {children}
    </section>
  );
}

/**
 * Right rail of the Data Card: 담당자 (the 문의 button focuses it), 연구책임자, 이용 정책, 활동.
 * Beside the Data Explorer from xl (one column, top-aligned with its header); below xl it sits under the Explorer as a
 * two-column grid. The 1px rules are the panel's own background showing through a 1px gap.
 */
export function SideCard({ dataset: d, versions, ref, className }: { dataset: Dataset; versions: DatasetVersion[]; ref?: Ref<HTMLElement>; className?: string }) {
  const t = useTranslations();
  const steward = d.people?.steward_contact;
  const pi = d.people?.principal_investigator;
  return (
    <aside aria-label={t("data.card.railLabel")} className={cn("grid gap-px overflow-hidden rounded-md border border-border bg-border sm:grid-cols-2 xl:flex xl:flex-col", className)}>
      <RailPanel title={t("data.card.contactTitle")} panelRef={ref} focusable>
        {steward ? <PersonLine person={steward} stacked /> : null}
        {d.people?.steward_contact_absent ? (
          <div role="status" className="flex gap-2 rounded-sm bg-warning-soft p-2.5 text-small">
            <TriangleAlert aria-hidden="true" strokeWidth={1.75} className="mt-0.5 size-4 shrink-0 text-warning" />
            <div>
              <p className="font-medium text-fg">{t("data.card.absent")}</p>
              <p className="text-fg-muted">{t("data.card.absentHint")}</p>
            </div>
          </div>
        ) : null}
        <p className="text-small text-fg-muted">{t("data.card.inquirySoon")}</p>
      </RailPanel>
      {pi ? (
        <RailPanel title={t("data.card.piTitle")}>
          <PersonLine person={pi} stacked />
        </RailPanel>
      ) : null}
      <RailPanel title={t("data.detail.policy")}>
        <DefList
          rows={[
            [t("data.form.accessLevel"), <AccessLevelBadge key="a" level={d.access_level} />],
            [t("data.detail.approvalRequired"), d.policy.approval_required ? t("common.yes") : t("common.no")],
            [t("data.form.maxGrantDays"), <span key="d" className="num">{t("data.detail.days", { count: d.policy.max_grant_days })}</span>],
            [t("data.meta.license"), <span key="l" className="font-mono text-mono">{d.license}</span>],
          ]}
        />
      </RailPanel>
      <RailPanel title={t("data.card.activityTitle")}>
        <ActivitySummary versions={versions} dataset={d} />
      </RailPanel>
    </aside>
  );
}
