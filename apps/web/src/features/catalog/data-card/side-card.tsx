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
import { crumbClass } from "../components/v2";

/** One rail section: accent crumb title, then its content; sections share one bordered panel, split by 1px rules. */
function RailPanel({ title, children, panelRef, focusable }: { title: string; children: ReactNode; panelRef?: Ref<HTMLElement>; focusable?: boolean }) {
  const id = useId();
  return (
    <section
      aria-labelledby={id}
      ref={panelRef}
      tabIndex={focusable ? -1 : undefined}
      className={cn("flex flex-col gap-3 px-4 py-4", focusable && "outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus")}
    >
      <h2 id={id} className={crumbClass}>
        {title}
      </h2>
      {children}
    </section>
  );
}

/**
 * Right rail of the Data Card: 담당자 (the 문의 button focuses it), 연구책임자, 이용 정책, 활동.
 * Stacks under the content below lg.
 */
export function SideCard({ dataset: d, versions, ref }: { dataset: Dataset; versions: DatasetVersion[]; ref?: Ref<HTMLElement> }) {
  const t = useTranslations();
  const steward = d.people?.steward_contact;
  const pi = d.people?.principal_investigator;
  return (
    <aside aria-label={t("data.card.railLabel")} className="flex flex-col divide-y divide-border overflow-hidden rounded-md border border-border bg-bg-panel">
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
