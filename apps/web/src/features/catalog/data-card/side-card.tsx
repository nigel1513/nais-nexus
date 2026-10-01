"use client";
import { Card, CardContent, CardHeader, CardTitle } from "@nais/ui";
import { useTranslations } from "next-intl";
import type { Ref } from "react";
import type { Dataset } from "@/shared/api/types";
import { AccessLevelBadge } from "@/shared/ui/badges";
import { PersonLine } from "../components/person-line";

export function SideCard({ dataset: d, ref }: { dataset: Dataset; ref?: Ref<HTMLElement> }) {
  const t = useTranslations();
  const steward = d.people?.steward_contact;
  return (
    <aside aria-label={t("data.card.contactTitle")} tabIndex={-1} ref={ref} className="flex flex-col gap-4 focus-visible:outline-2 focus-visible:outline-ring">
      <Card>
        <CardHeader>
          <CardTitle>{t("data.card.contactTitle")}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2 text-sm">
          {steward ? <PersonLine person={steward} /> : null}
          {d.people?.steward_contact_absent ? (
            <div role="status" className="rounded-md border border-warning p-2">
              <p className="font-medium">{t("data.card.absent")}</p>
              <p className="text-muted-foreground">{t("data.card.absentHint")}</p>
            </div>
          ) : null}
          <p className="text-muted-foreground">{t("data.card.inquirySoon")}</p>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>{t("data.detail.policy")}</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2 text-sm">
            <dt className="text-muted-foreground">{t("data.form.accessLevel")}</dt>
            <dd>
              <AccessLevelBadge level={d.access_level} />
            </dd>
            <dt className="text-muted-foreground">{t("data.detail.approvalRequired")}</dt>
            <dd>{d.policy.approval_required ? t("common.yes") : t("common.no")}</dd>
            <dt className="text-muted-foreground">{t("data.form.maxGrantDays")}</dt>
            <dd>{t("data.detail.days", { count: d.policy.max_grant_days })}</dd>
          </dl>
        </CardContent>
      </Card>
    </aside>
  );
}
