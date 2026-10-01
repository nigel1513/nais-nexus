"use client";
import { EmptyState } from "@nais/ui";
import { useTranslations } from "next-intl";
import { PageHeader } from "@/shared/ui/page-header";

/** P1 routes are reserved (M10 §1 Out of scope) and hidden from navigation. */
export function ReservedScreen({ name }: { name: "marketplace" | "compute" }) {
  const t = useTranslations();
  return (
    <>
      <PageHeader title={t(`reserved.${name}`)} />
      <EmptyState title={t("reserved.comingSoon")} description={t("reserved.description")} />
    </>
  );
}
