"use client";
import { Button, buttonClass, cn, DataTable, EmptyState, focusRing, Input, type DataColumn } from "@nais/ui";
import { Database, Search } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useState, type FormEvent } from "react";
import { useListVocabulary } from "@/features/catalog/api";
import { useMeData } from "@/shared/hooks/use-me";
import { DateTime } from "@/shared/ui/date-text";
import { ScreenTitle } from "@/shared/ui/screen-v2";
import { DelayedSkeleton, ErrorView } from "@/shared/ui/state-views";
import { PanelHead } from "@/shared/ui/work-hero";
import { useHubOverview, type HubCard as HubCardT, type HubOrganizationStat } from "./api";
import { HubCard, type HubRail } from "./components/hub-card";

const RAILS: HubRail[] = ["trending", "recent", "most_used"];

const chipCls = cn(
  "inline-flex h-7 items-center rounded-full border border-border bg-bg-panel px-3 text-caption whitespace-nowrap text-fg-muted transition-colors duration-[var(--dur-fast)] hover:border-border-strong hover:text-fg",
  focusRing,
);

/** Data hub home (plan §4.1): search, field and institute chips into the full search, three rails, the institute table. */
export function HubScreen() {
  const t = useTranslations();
  const me = useMeData();
  const overview = useHubOverview();
  const data = overview.data;
  const rails = data ? RAILS.filter((r) => data.rails[r].length > 0) : [];

  return (
    <>
      <ScreenTitle
        context={[t("hub.context"), me.organization.name]}
        title={t("hub.title")}
        actions={
          <Link href="/commons/data" className={buttonClass("secondary", "md")}>
            {t("hub.allData")}
          </Link>
        }
      />
      <div className="flex flex-col gap-10">
        <Finder organizations={data?.organizations ?? []} />
        {overview.isPending ? (
          <DelayedSkeleton lines={6} />
        ) : overview.isError ? (
          <ErrorView error={overview.error} onRetry={() => void overview.refetch()} />
        ) : (
          <>
            {rails.length === 0 ? (
              <EmptyState icon={Database} title={t("hub.empty")} action={<Link href="/commons/data" className={buttonClass("secondary")}>{t("hub.allData")}</Link>} />
            ) : (
              rails.map((r) => <Rail key={r} rail={r} cards={data!.rails[r]} />)
            )}
            <Organizations rows={data!.organizations} />
          </>
        )}
      </div>
    </>
  );
}

/** Search box plus 분야 / 기관 chips: every way in lands on the full search with that filter. */
function Finder({ organizations }: { organizations: HubOrganizationStat[] }) {
  const t = useTranslations();
  const locale = useLocale();
  const router = useRouter();
  const [q, setQ] = useState("");
  const subjects = useListVocabulary("SUBJECT");
  const topSubjects = (subjects.data?.items ?? []).filter((s) => !s.parent_code);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const text = q.trim();
    router.push(text ? `/commons/data?${new URLSearchParams({ q: text })}` : "/commons/data");
  };
  return (
    <section aria-label={t("hub.finder")} className="flex flex-col gap-4">
      <form role="search" aria-label={t("hub.searchLabel")} onSubmit={submit} className="flex w-full max-w-2xl gap-2">
        <div className="relative min-w-0 flex-1">
          <label htmlFor="hub-search" className="sr-only">
            {t("shell.searchLabel")}
          </label>
          <Search aria-hidden="true" className="pointer-events-none absolute left-3.5 top-1/2 size-[18px] -translate-y-1/2 text-fg-muted" strokeWidth={1.75} />
          <Input id="hub-search" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("shell.searchPlaceholder")} className="h-11 rounded-md pl-10 text-[15px]" />
        </div>
        <Button type="submit" className="h-11">
          {t("hub.search")}
        </Button>
      </form>
      <ChipRow label={t("hub.subjects")} items={topSubjects.map((s) => ({ key: s.code, label: locale === "en" ? s.label_en : s.label_ko, href: `/commons/data?subject=${encodeURIComponent(s.code)}` }))} />
      <ChipRow label={t("hub.organizations")} items={organizations.map((o) => ({ key: o.organization_id, label: o.name, href: `/commons/data?owner_organization_id=${o.organization_id}` }))} />
    </section>
  );
}

function ChipRow({ label, items }: { label: string; items: { key: string; label: string; href: string }[] }) {
  if (!items.length) return null;
  return (
    <div className="flex flex-col gap-1.5 sm:flex-row sm:items-baseline sm:gap-3">
      <span aria-hidden="true" className="w-10 shrink-0 text-caption text-fg-muted">
        {label}
      </span>
      <ul aria-label={label} className="flex flex-wrap gap-1.5">
        {items.map((i) => (
          <li key={i.key}>
            <Link href={i.href} className={chipCls}>
              {i.label}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Rail({ rail, cards }: { rail: HubRail; cards: HubCardT[] }) {
  const t = useTranslations();
  const id = `hub-rail-${rail}`;
  return (
    <section aria-labelledby={id} className="flex flex-col gap-4">
      <PanelHead id={id} crumb={t(`hub.rails.${rail}.crumb`)} title={t(`hub.rails.${rail}.title`)} right={<span className="text-small text-fg-muted">{t(`hub.rails.${rail}.basis`)}</span>} />
      <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {cards.map((c) => (
          <HubCard key={c.dataset_id} card={c} rail={rail} />
        ))}
      </ul>
    </section>
  );
}

function Organizations({ rows }: { rows: HubOrganizationStat[] }) {
  const t = useTranslations();
  const columns: DataColumn<HubOrganizationStat>[] = [
    {
      key: "name",
      header: t("hub.orgs.name"),
      className: "w-full",
      cell: (o) => (
        <Link href={`/commons/data?owner_organization_id=${o.organization_id}`} className={cn("rounded-xs font-medium text-fg underline-offset-4 hover:underline", focusRing)}>
          {o.name}
        </Link>
      ),
    },
    { key: "datasets", header: t("hub.orgs.datasets"), numeric: true, cell: (o) => o.dataset_count },
    { key: "public", header: t("hub.orgs.public"), numeric: true, cell: (o) => o.public_count },
    { key: "controlled", header: t("hub.orgs.controlled"), numeric: true, cell: (o) => o.controlled_count },
    { key: "updated", header: t("hub.orgs.updated"), numeric: true, cell: (o) => (o.last_updated_at ? <DateTime value={o.last_updated_at} dateOnly /> : "—") },
  ];
  if (!rows.length) return null;
  return (
    <section aria-labelledby="hub-orgs" className="flex flex-col gap-4">
      <PanelHead id="hub-orgs" crumb={t("hub.orgs.crumb")} title={t("hub.orgs.title")} count={rows.length} />
      <DataTable caption={t("hub.orgs.title")} columns={columns} rows={rows} rowKey={(o) => o.organization_id} />
    </section>
  );
}
