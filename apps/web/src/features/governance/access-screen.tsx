"use client";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@nais/ui";
import { useTranslations } from "next-intl";
import { flattenPages } from "@/shared/api/pagination";
import { hasOrgRole, useMeData } from "@/shared/hooks/use-me";
import { useUrlQuery } from "@/shared/hooks/use-url-query";
import { usePublishRequests } from "@/features/workspace/api";
import { PublishReviewTab } from "@/features/workspace/publish-review-tab";
import { WorkHero, type HeroStat } from "@/shared/ui/work-hero";
import { useListAccessGrants, useListAccessRequests } from "./api";
import { grantTerm } from "./components/grant-term";
import { MyGrantsTab, OrgGrantsTab } from "./components/grant-tabs";
import { submittedAt } from "./components/request-meta";
import { MyRequestsTab, ReviewTab } from "./components/request-tabs";

// A steward's work comes first: the review queue leads and is their default tab.
const TABS = ["review", "publish", "requests", "grants", "org-grants"] as const;
type Tab = (typeof TABS)[number];
const LABEL: Record<Tab, string> = {
  requests: "access.tabs.requests",
  review: "access.tabs.review",
  publish: "access.tabs.publish",
  grants: "access.tabs.grants",
  "org-grants": "access.tabs.orgGrants",
};
const DAY_MS = 86_400_000;
const LIMIT = 100;

/** "12", or "100+" when the first page was full (these lists have no totals). */
const countOf = (data: { pages: { page: { has_more?: boolean } }[] } | undefined, n: number) => (!data ? null : data.pages.at(-1)?.page.has_more ? `${n}+` : String(n));

export function AccessScreen() {
  const t = useTranslations();
  const me = useMeData();
  const steward = hasOrgRole(me, "DATA_STEWARD");
  const orgAdmin = hasOrgRole(me, "DATA_STEWARD", "ORG_ADMIN");
  const visible = TABS.filter((k) => ((k !== "review" && k !== "publish") || steward) && (k !== "org-grants" || orgAdmin));
  const fallback = visible[0]!;
  const [params, setParams] = useUrlQuery();
  // The tab is derived from the URL (never copied into state), so Back/Forward and the dashboard's ?tab= links stay in sync.
  const requested = params.get("tab") as Tab | null;
  const tab: Tab = requested && visible.includes(requested) ? requested : fallback;
  // Same query (and cache) as the sidebar's review count.
  const review = useListAccessRequests({ role: "reviewer", status: ["SUBMITTED", "UNDER_REVIEW"], limit: LIMIT }, { enabled: steward });
  const open = useListAccessRequests({ role: "requester", status: ["SUBMITTED", "UNDER_REVIEW", "CHANGE_REQUESTED"], limit: LIMIT });
  const grants = useListAccessGrants({ role: "subject", status: ["ACTIVE"], limit: LIMIT });
  const reviewRows = flattenPages(review.data);
  const openRows = flattenPages(open.data);
  const grantRows = flattenPages(grants.data);
  const reviewCount = reviewRows.length;
  // Same query (and cache) as the 공개 요청 tab's default filter; counts the requests still waiting on my organization.
  const publish = usePublishRequests({ role: "reviewer", status: ["PENDING"] }, { enabled: steward });
  const publishCount = flattenPages(publish.data).filter(
    (r) => r.created_by !== me.user_id && r.approvals.some((a) => a.organization_id === me.organization.organization_id && a.decision === null),
  ).length;

  const now = Date.now();
  const oldest = reviewRows.length ? Math.max(...reviewRows.map((r) => Math.floor((now - Date.parse(submittedAt(r))) / DAY_MS))) : 0;
  const changes = openRows.filter((r) => r.status === "CHANGE_REQUESTED").length;
  const expiring = grantRows.filter((g) => grantTerm(g, now).soon).length;
  const tabHref = (k: Tab) => (k === fallback ? "/commons/access" : `/commons/access?tab=${k}`);
  const role = steward ? t("enums.OrgRole.DATA_STEWARD") : hasOrgRole(me, "ORG_ADMIN") ? t("enums.OrgRole.ORG_ADMIN") : t("dashboard.researcher");

  const stats: HeroStat[] = [
    ...(steward
      ? [
          {
            label: t("access.stats.review"),
            value: countOf(review.data, reviewCount),
            unit: t("access.stats.unitCount"),
            hint: reviewCount ? (oldest > 0 ? t("access.stats.reviewOldest", { days: oldest }) : t("access.stats.reviewToday")) : t("access.stats.reviewNone"),
            href: tabHref("review"),
            highlight: reviewCount > 0,
          },
        ]
      : []),
    {
      label: t("access.stats.open"),
      value: countOf(open.data, openRows.length),
      unit: t("access.stats.unitCount"),
      hint: changes ? t("access.stats.openChanges", { count: changes }) : openRows.length ? t("access.stats.openHint") : t("access.stats.openNone"),
      href: tabHref("requests"),
      highlight: !steward && changes > 0,
    },
    { label: t("access.stats.grants"), value: countOf(grants.data, grantRows.length), unit: t("access.stats.unitItems"), hint: t("access.stats.grantsHint"), href: tabHref("grants") },
    {
      label: t("access.stats.expiring"),
      value: grants.data ? String(expiring) : null,
      unit: t("access.stats.unitItems"),
      hint: expiring ? t("access.stats.expiringHint") : t("access.stats.expiringNone"),
      href: tabHref("grants"),
      highlight: !steward && expiring > 0,
    },
  ];

  return (
    <>
      <WorkHero
        context={[t("access.context"), me.organization.name, role]}
        title={t("access.title")}
        description={t("access.description")}
        stats={stats}
        statsLabel={t("access.stats.label")}
      />
      <Tabs value={tab} onValueChange={(v) => setParams({ tab: v === fallback ? null : v })}>
        <TabsList aria-label={t("access.tabsLabel")}>
          {visible.map((k) =>
            k === "review" ? (
              <TabsTrigger key={k} value={k} count={review.data ? reviewCount : undefined} aria-label={review.data ? t("access.tabs.reviewLabel", { count: reviewCount }) : undefined}>
                {t(LABEL[k])}
              </TabsTrigger>
            ) : k === "publish" ? (
              <TabsTrigger key={k} value={k} count={publish.data ? publishCount : undefined} aria-label={publish.data ? t("access.tabs.publishLabel", { count: publishCount }) : undefined}>
                {t(LABEL[k])}
              </TabsTrigger>
            ) : (
              <TabsTrigger key={k} value={k}>
                {t(LABEL[k])}
              </TabsTrigger>
            ),
          )}
        </TabsList>
        {steward ? (
          <TabsContent value="review" className="pt-6">
            <ReviewTab />
          </TabsContent>
        ) : null}
        {steward ? (
          <TabsContent value="publish" className="pt-6">
            <PublishReviewTab />
          </TabsContent>
        ) : null}
        <TabsContent value="requests" className="pt-6">
          <MyRequestsTab />
        </TabsContent>
        <TabsContent value="grants" className="pt-6">
          <MyGrantsTab />
        </TabsContent>
        {orgAdmin ? (
          <TabsContent value="org-grants" className="pt-6">
            <OrgGrantsTab />
          </TabsContent>
        ) : null}
      </Tabs>
    </>
  );
}
