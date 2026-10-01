"use client";
import { useTranslations } from "next-intl";
import type { DatasetPerson } from "@/shared/api/types";
import { affiliationText } from "../lib/people";

/** Name, NTIS number, at-the-time affiliation and (if different) the current one. Email only when the API sent it. */
export function PersonLine({ person }: { person: DatasetPerson }) {
  const t = useTranslations();
  const { then, now } = affiliationText(person);
  return (
    <span className="inline-flex flex-wrap items-baseline gap-x-2">
      <span className="font-medium">{person.display_name}</span>
      {person.national_researcher_number ? <span className="text-muted-foreground">NTIS {person.national_researcher_number}</span> : null}
      <span className="text-muted-foreground">
        {then}
        {t("data.people.atTheTime")}
        {now ? ` · ${t("data.people.now", { org: now })}` : ""}
      </span>
      {person.email ? <a href={`mailto:${person.email}`} className="underline underline-offset-4">{person.email}</a> : null}
    </span>
  );
}
