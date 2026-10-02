"use client";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@nais/ui";
import { useTranslations } from "next-intl";
import { flattenPages } from "@/shared/api/pagination";
import { hasOrgRole, useMeData } from "@/shared/hooks/use-me";
import { useUrlQuery } from "@/shared/hooks/use-url-query";
import { PageHeader } from "@/shared/ui/page-header";
import { useListAccessRequests } from "./api";
import { MyGrantsTab, OrgGrantsTab } from "./components/grant-tabs";
import { MyRequestsTab, ReviewTab } from "./components/request-tabs";

// A steward's work comes first: the review queue leads and is their default tab.
const TABS = ["review", "requests", "grants", "org-grants"] as const;
type Tab = (typeof TABS)[number];
const LABEL: Record<Tab, string> = { requests: "access.tabs.requests", review: "access.tabs.review", grants: "access.tabs.grants", "org-grants": "access.tabs.orgGrants" };

export function AccessScreen() {
  const t = useTranslations();
  const me = useMeData();
  const steward = hasOrgRole(me, "DATA_STEWARD");
  const orgAdmin = hasOrgRole(me, "DATA_STEWARD", "ORG_ADMIN");
  const visible = TABS.filter((k) => (k !== "review" || steward) && (k !== "org-grants" || orgAdmin));
  const fallback = visible[0]!;
  const [params, setParams] = useUrlQuery();
  // The tab is derived from the URL (never copied into state), so Back/Forward and the dashboard's ?tab= links stay in sync.
  const requested = params.get("tab") as Tab | null;
  const tab: Tab = requested && visible.includes(requested) ? requested : fallback;
  // Same query (and cache) as the sidebar's review count.
  const review = useListAccessRequests({ role: "reviewer", status: ["SUBMITTED", "UNDER_REVIEW"], limit: 100 }, { enabled: steward });
  const reviewCount = flattenPages(review.data).length;

  return (
    <>
      <PageHeader title={t("access.title")} description={t("access.description")} />
      <Tabs value={tab} onValueChange={(v) => setParams({ tab: v === fallback ? null : v })}>
        <TabsList aria-label={t("access.tabsLabel")}>
          {visible.map((k) =>
            k === "review" ? (
              <TabsTrigger key={k} value={k} count={review.data ? reviewCount : undefined} aria-label={review.data ? t("access.tabs.reviewLabel", { count: reviewCount }) : undefined}>
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
          <TabsContent value="review" className="pt-4">
            <ReviewTab />
          </TabsContent>
        ) : null}
        <TabsContent value="requests" className="pt-4">
          <MyRequestsTab />
        </TabsContent>
        <TabsContent value="grants" className="pt-4">
          <MyGrantsTab />
        </TabsContent>
        {orgAdmin ? (
          <TabsContent value="org-grants" className="pt-4">
            <OrgGrantsTab />
          </TabsContent>
        ) : null}
      </Tabs>
    </>
  );
}
