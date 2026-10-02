"use client";
import { useTranslations } from "next-intl";
import { Markdown } from "../components/markdown";

export function About({ description }: { description: string }) {
  const t = useTranslations();
  return (
    <section aria-labelledby="about-title" className="flex flex-col gap-3">
      <h2 id="about-title" className="text-heading text-fg">
        {t("data.card.about")}
      </h2>
      {description.trim() ? <Markdown source={description} /> : <p className="text-body text-fg-muted">{t("data.card.noDescription")}</p>}
    </section>
  );
}
