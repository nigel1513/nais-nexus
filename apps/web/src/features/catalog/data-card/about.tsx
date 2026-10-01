"use client";
import { useTranslations } from "next-intl";
import { Markdown } from "../components/markdown";

export function About({ description }: { description: string }) {
  const t = useTranslations();
  return (
    <section aria-labelledby="about-title">
      <h2 id="about-title" className="mb-2 text-lg font-semibold">
        {t("data.card.about")}
      </h2>
      {description.trim() ? <Markdown source={description} /> : <p className="text-sm text-muted-foreground">{t("data.card.noDescription")}</p>}
    </section>
  );
}
