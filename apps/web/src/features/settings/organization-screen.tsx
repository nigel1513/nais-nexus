"use client";
import { useTranslations } from "next-intl";
import { useGetOrganization, useListOrganizationMembers } from "@/features/organizations/api";
import { flattenPages } from "@/shared/api/pagination";
import { useMeData } from "@/shared/hooks/use-me";
import { PageHeader } from "@/shared/ui/page-header";
import { RequireRole } from "@/shared/ui/require-role";
import { DelayedSkeleton, ErrorView, LoadMore } from "@/shared/ui/state-views";
import { MemberRow } from "./components/member-row";

function Members() {
  const t = useTranslations();
  const me = useMeData();
  const orgId = me.organization.organization_id;
  const org = useGetOrganization(orgId);
  const members = useListOrganizationMembers(orgId);
  if (members.isPending || org.isPending) return <DelayedSkeleton lines={5} />;
  if (members.isError) return <ErrorView error={members.error} onRetry={() => void members.refetch()} />;
  return (
    <div className="flex flex-col gap-4">
      {org.data ? (
        <dl className="grid max-w-md grid-cols-[8rem_1fr] gap-y-1 text-sm">
          <dt className="text-muted-foreground">{t("org.code")}</dt>
          <dd>{org.data.code}</dd>
          <dt className="text-muted-foreground">{t("org.type")}</dt>
          <dd>{t(`enums.OrganizationType.${org.data.type}`)}</dd>
          <dt className="text-muted-foreground">{t("org.memberCount")}</dt>
          <dd>{org.data.member_count ?? "—"}</dd>
          <dt className="text-muted-foreground">{t("org.datasetCount")}</dt>
          <dd>{org.data.dataset_count ?? "—"}</dd>
        </dl>
      ) : null}
      <section aria-labelledby="org-members" className="flex flex-col gap-2">
        <h2 id="org-members" className="text-lg font-semibold">
          {t("org.members")}
        </h2>
        {flattenPages(members.data).map((m) => (
          <MemberRow key={`${m.user_id}:${m.updated_at ?? ""}`} member={m} isSelf={m.user_id === me.user_id} organizationId={orgId} />
        ))}
        <LoadMore hasNextPage={members.hasNextPage} isFetchingNextPage={members.isFetchingNextPage} fetchNextPage={members.fetchNextPage} />
      </section>
    </div>
  );
}

export function OrganizationScreen() {
  const t = useTranslations();
  const me = useMeData();
  return (
    <>
      <PageHeader title={t("org.title", { name: me.organization.name })} description={t("org.description")} />
      <RequireRole anyOf={["ORG_ADMIN"]}>
        <Members />
      </RequireRole>
    </>
  );
}
