import type { DatasetPerson } from "@/shared/api/types";

/** At-the-time affiliation, plus the current one only when it differs. */
export function affiliationText(p: DatasetPerson): { then: string; now: string | null } {
  const cur = p.current_organization;
  const moved = cur && (cur.organization_id !== p.affiliation.organization_id || (cur.organization_id === null && cur.name !== p.affiliation.name));
  return { then: p.affiliation.name, now: moved ? cur.name : null };
}

export function personLabel(p: DatasetPerson, t: (key: string, values?: Record<string, string>) => string): string {
  const { then, now } = affiliationText(p);
  return [p.display_name, then + t("data.people.atTheTime"), now ? t("data.people.now", { org: now }) : null].filter(Boolean).join(" · ");
}
