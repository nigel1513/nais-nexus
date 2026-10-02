"use client";
import { cn } from "@nais/ui";
import { useTranslations } from "next-intl";
import { Markdown } from "../components/markdown";
import { PanelHead } from "@/shared/ui/work-hero";

/** 개요: the dataset's own description (markdown), nothing else — facts sit beside it, metadata further down. */
export function About({ description, className }: { description: string; className?: string }) {
  const t = useTranslations();
  return (
    // From xl the crumb lines up with the 한눈에 panel's label beside it (that panel has a 1px border and 16px padding).
    <section aria-labelledby="about-title" className={cn("flex min-w-0 flex-col gap-4 xl:pt-[17px]", className)}>
      <PanelHead id="about-title" crumb={t("data.card.hero.aboutCrumb")} title={t("data.card.about")} />
      {description.trim() ? <Markdown source={description} /> : <p className="text-body text-fg-muted">{t("data.card.noDescription")}</p>}
    </section>
  );
}
