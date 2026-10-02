"use client";
import { Badge, type Tone } from "@nais/ui";
import { useTranslations } from "next-intl";
import type { ProjectRole } from "@/shared/api/types";

const ROLE_TONE: Record<ProjectRole, Tone> = { PROJECT_OWNER: "accent", PROJECT_ADMIN: "info", RESEARCHER: "neutral", VIEWER: "neutral" };

/** A project role as a badge: owner accent, admin info, researcher/viewer neutral. */
export function ProjectRoleBadge({ role }: { role: ProjectRole }) {
  const t = useTranslations();
  return <Badge tone={ROLE_TONE[role]}>{t(`enums.ProjectRole.${role}`)}</Badge>;
}
