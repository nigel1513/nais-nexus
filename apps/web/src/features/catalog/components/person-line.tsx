"use client";
import { Avatar } from "@nais/ui";
import { useTranslations } from "next-intl";
import type { DatasetPerson } from "@/shared/api/types";
import { affiliationText } from "../lib/people";

/**
 * Name, NTIS number, at-the-time affiliation and (if different) the current one. Email only when the API sent it.
 * `stacked` (right rail): avatar, name on the first line, NTIS and affiliation below.
 */
export function PersonLine({ person, stacked = false }: { person: DatasetPerson; stacked?: boolean }) {
  const t = useTranslations();
  const { then, now } = affiliationText(person);
  const affiliation = (
    <span className="text-fg-muted">
      {then}
      {t("data.people.atTheTime")}
      {now ? ` · ${t("data.people.now", { org: now })}` : ""}
    </span>
  );
  const ntis = person.national_researcher_number ? <span className="num text-fg-muted">NTIS {person.national_researcher_number}</span> : null;
  const email = person.email ? (
    <a href={`mailto:${person.email}`} className="break-all text-accent-fg underline-offset-4 hover:underline">
      {person.email}
    </a>
  ) : null;
  if (stacked)
    return (
      <span className="flex items-start gap-3">
        <Avatar name={person.display_name} size={32} decorative />
        <span className="flex min-w-0 flex-col text-small">
          <span className="text-body font-medium text-fg">{person.display_name}</span>
          {ntis}
          {affiliation}
          {email}
        </span>
      </span>
    );
  return (
    <span className="inline-flex flex-wrap items-baseline gap-x-2">
      <span className="font-medium text-fg">{person.display_name}</span>
      {ntis}
      {affiliation}
      {email}
    </span>
  );
}
