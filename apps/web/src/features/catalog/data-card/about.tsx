"use client";
import { useTranslations } from "next-intl";
import { Markdown } from "../components/markdown";
import { PanelHead } from "@/shared/ui/work-hero";

export function About({ description }: { description: string }) {
  const t = useTranslations();
  return (
    <section aria-labelledby="about-title" className="flex flex-col gap-4">
      <PanelHead id="about-title" crumb={t("data.card.hero.aboutCrumb")} title={t("data.card.about")} />
      {description.trim() ? <Markdown source={description} /> : <p className="text-body text-fg-muted">{t("data.card.noDescription")}</p>}
    </section>
  );
}
