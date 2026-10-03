"use client";
import { buttonClass, EmptyState } from "@nais/ui";
import { Hourglass } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { PageHeader } from "@/shared/ui/page-header";

/** P1 routes are reserved (M10 §1 Out of scope) and hidden from navigation; /commons/notes holds its place until the notes screens land (data-hub plan Task 15). */
export function ReservedScreen({ name }: { name: "marketplace" | "compute" | "notes" }) {
  const t = useTranslations();
  return (
    <>
      <PageHeader title={t(`reserved.${name}`)} />
      <div className="rounded-md border border-dashed border-border-strong">
        <EmptyState
          icon={Hourglass}
          title={t("reserved.comingSoon")}
          description={t("reserved.description")}
          action={
            <Link href="/commons" className={buttonClass("secondary", "sm")}>
              {t("notFound.home")}
            </Link>
          }
        />
      </div>
    </>
  );
}
