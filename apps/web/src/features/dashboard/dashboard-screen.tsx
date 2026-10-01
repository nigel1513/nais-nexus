"use client";
import { buttonClass, Card, CardContent, CardFooter, CardHeader, CardTitle, EmptyState } from "@nais/ui";
import type { InfiniteData } from "@tanstack/react-query";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useId, type ReactNode } from "react";
import { useListAccessGrants, useListAccessRequests } from "@/features/governance/api";
import { useListProjects } from "@/features/projects/api";
import { flattenPages } from "@/shared/api/pagination";
import type { AccessGrant, AccessRequest, Page, ProjectSummary } from "@/shared/api/types";
import { hasOrgRole, useMeData } from "@/shared/hooks/use-me";
import { RequestStatusBadge } from "@/shared/ui/badges";
import { ExpiryText } from "@/shared/ui/date-text";
import { PageHeader } from "@/shared/ui/page-header";
import { DelayedSkeleton, ErrorView } from "@/shared/ui/state-views";

type ListQuery<T> = { data?: InfiniteData<Page<T>>; isPending: boolean; isError: boolean; error: unknown; refetch: () => unknown };

function ListCard<T>({
  title,
  query,
  rowKey,
  renderItem,
  empty,
  moreHref,
}: {
  title: string;
  query: ListQuery<T>;
  rowKey: (item: T) => string;
  renderItem: (item: T) => ReactNode;
  empty: ReactNode;
  moreHref: string;
}) {
  const t = useTranslations();
  const headingId = useId();
  const items = flattenPages(query.data).slice(0, 5);
  return (
    <Card aria-labelledby={headingId}>
      <CardHeader>
        <CardTitle id={headingId}>{title}</CardTitle>
      </CardHeader>
      <CardContent>
        {query.isPending ? (
          <DelayedSkeleton lines={3} />
        ) : query.isError ? (
          <ErrorView error={query.error} onRetry={() => void query.refetch()} />
        ) : items.length === 0 ? (
          empty
        ) : (
          <ul className="flex flex-col divide-y divide-border">
            {items.map((item) => (
              <li key={rowKey(item)} className="flex flex-wrap items-center justify-between gap-2 py-2">
                {renderItem(item)}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
      <CardFooter>
        <Link href={moreHref} className={buttonClass("link", "sm", "px-0")}>
          {t("dashboard.viewAll")}
        </Link>
      </CardFooter>
    </Card>
  );
}

export function DashboardScreen() {
  const t = useTranslations();
  const me = useMeData();
  const steward = hasOrgRole(me, "DATA_STEWARD");
  const projects = useListProjects({ scope: "mine", limit: 5 });
  const requests = useListAccessRequests({ role: "requester", status: ["SUBMITTED", "UNDER_REVIEW", "CHANGE_REQUESTED"], limit: 5 });
  const grants = useListAccessGrants({ role: "subject", status: ["ACTIVE"], limit: 5 });
  const review = useListAccessRequests({ role: "reviewer", status: ["SUBMITTED", "UNDER_REVIEW"], limit: 5 }, { enabled: steward });

  return (
    <>
      <PageHeader title={t("dashboard.title")} description={t("dashboard.greeting", { name: me.display_name })} />
      <div className="grid gap-4 md:grid-cols-2">
        <ListCard<ProjectSummary>
          title={t("dashboard.myProjects")}
          query={projects}
          rowKey={(p) => p.project_id}
          moreHref="/commons/projects"
          empty={
            <EmptyState
              title={t("dashboard.noProjects")}
              action={
                <Link href="/commons/projects/new" className={buttonClass()}>
                  {t("dashboard.createFirstProject")}
                </Link>
              }
            />
          }
          renderItem={(p) => (
            <>
              <Link href={`/commons/projects/${p.project_id}`} className="font-medium underline-offset-4 hover:underline">
                {p.name}
              </Link>
              <span className="text-sm text-muted-foreground">{p.my_role ? t(`enums.ProjectRole.${p.my_role}`) : "—"}</span>
            </>
          )}
        />
        <ListCard<AccessRequest>
          title={t("dashboard.openRequests")}
          query={requests}
          rowKey={(r) => r.access_request_id}
          moreHref="/commons/access?tab=requests"
          empty={<EmptyState title={t("dashboard.noRequests")} />}
          renderItem={(r) => (
            <>
              <Link href={`/commons/access/${r.access_request_id}`} className="font-medium underline-offset-4 hover:underline">
                {r.dataset_title ?? r.dataset_id}
              </Link>
              <RequestStatusBadge status={r.status} />
            </>
          )}
        />
        <ListCard<AccessGrant>
          title={t("dashboard.myGrants")}
          query={grants}
          rowKey={(g) => g.access_grant_id}
          moreHref="/commons/access?tab=grants"
          empty={<EmptyState title={t("dashboard.noGrants")} />}
          renderItem={(g) => (
            <>
              <Link href={`/commons/data/${g.dataset_id}`} className="font-medium underline-offset-4 hover:underline">
                {g.dataset_title ?? g.dataset_id}
              </Link>
              <ExpiryText value={g.expires_at} />
            </>
          )}
        />
        {steward ? (
          <ListCard<AccessRequest>
            title={t("dashboard.reviewQueue")}
            query={review}
            rowKey={(r) => r.access_request_id}
            moreHref="/commons/access?tab=review"
            empty={<EmptyState title={t("dashboard.noReview")} />}
            renderItem={(r) => (
              <>
                <Link href={`/commons/access/${r.access_request_id}`} className="font-medium underline-offset-4 hover:underline">
                  {r.dataset_title ?? r.dataset_id}
                </Link>
                <span className="text-sm text-muted-foreground">{t("dashboard.requestedBy", { name: r.requester_display_name ?? "—" })}</span>
              </>
            )}
          />
        ) : null}
      </div>
    </>
  );
}
