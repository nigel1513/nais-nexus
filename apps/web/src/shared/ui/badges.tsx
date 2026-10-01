"use client";
import { StatusBadge, type Tone } from "@nais/ui";
import {
  Archive, Ban, Building2, CircleCheck, CircleDashed, CircleX, Clock, Eye, Globe, LoaderCircle, Lock, Minus, PencilLine, Send,
  ShieldAlert, TriangleAlert, Undo2, Upload, type LucideIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import type {
  AccessGrantStatus, AccessLevel, AccessRequestStatus, DatasetVersionStatus, FileStatus, ProjectStatus, ReadinessCheckStatus,
  ReadinessOverall, ReadinessRunStatus,
} from "@/shared/api/types";

type Spec = readonly [Tone, LucideIcon];

function EnumBadge<T extends string>({ enumName, value, map }: { enumName: string; value: T; map: Record<T, Spec> }) {
  const t = useTranslations();
  const [tone, icon] = map[value];
  return <StatusBadge tone={tone} icon={icon} label={(t as (key: string) => string)(`enums.${enumName}.${value}`)} />;
}

const ACCESS: Record<AccessLevel, Spec> = { PUBLIC: ["success", Globe], INTERNAL: ["neutral", Building2], CONTROLLED: ["warning", Lock], SENSITIVE: ["danger", ShieldAlert] };
const READINESS: Record<ReadinessOverall, Spec> = { PASS: ["success", CircleCheck], WARNING: ["warning", TriangleAlert], FAIL: ["danger", CircleX] };
const REQUEST: Record<AccessRequestStatus, Spec> = {
  DRAFT: ["neutral", PencilLine],
  SUBMITTED: ["info", Send],
  UNDER_REVIEW: ["info", Eye],
  CHANGE_REQUESTED: ["warning", PencilLine],
  APPROVED: ["success", CircleCheck],
  REJECTED: ["danger", CircleX],
  WITHDRAWN: ["neutral", Undo2],
};
const GRANT: Record<AccessGrantStatus, Spec> = { ACTIVE: ["success", CircleCheck], EXPIRED: ["neutral", Clock], REVOKED: ["danger", Ban] };
const VERSION: Record<DatasetVersionStatus, Spec> = { DRAFT: ["neutral", PencilLine], PUBLISHED: ["success", CircleCheck], WITHDRAWN: ["neutral", Archive] };
const PROJECT: Record<ProjectStatus, Spec> = { ACTIVE: ["success", CircleCheck], ARCHIVED: ["neutral", Archive] };
const FILE: Record<FileStatus, Spec> = { PENDING: ["neutral", Clock], UPLOADED: ["info", Upload], VERIFIED: ["success", CircleCheck], FAILED: ["danger", CircleX] };
const RUN: Record<ReadinessRunStatus, Spec> = { QUEUED: ["neutral", Clock], RUNNING: ["info", LoaderCircle], COMPLETED: ["success", CircleCheck], FAILED: ["danger", CircleX] };
const CHECK: Record<ReadinessCheckStatus, Spec> = { PASS: ["success", CircleCheck], WARNING: ["warning", TriangleAlert], FAIL: ["danger", CircleX], NOT_APPLICABLE: ["neutral", Minus] };

export const AccessLevelBadge = ({ level }: { level: AccessLevel }) => <EnumBadge enumName="AccessLevel" value={level} map={ACCESS} />;
export const RequestStatusBadge = ({ status }: { status: AccessRequestStatus }) => <EnumBadge enumName="AccessRequestStatus" value={status} map={REQUEST} />;
export const GrantStatusBadge = ({ status }: { status: AccessGrantStatus }) => <EnumBadge enumName="AccessGrantStatus" value={status} map={GRANT} />;
export const VersionStatusBadge = ({ status }: { status: DatasetVersionStatus }) => <EnumBadge enumName="DatasetVersionStatus" value={status} map={VERSION} />;
export const ProjectStatusBadge = ({ status }: { status: ProjectStatus }) => <EnumBadge enumName="ProjectStatus" value={status} map={PROJECT} />;
export const FileStatusBadge = ({ status }: { status: FileStatus }) => <EnumBadge enumName="FileStatus" value={status} map={FILE} />;
export const RunStatusBadge = ({ status }: { status: ReadinessRunStatus }) => <EnumBadge enumName="ReadinessRunStatus" value={status} map={RUN} />;
export const CheckStatusBadge = ({ status }: { status: ReadinessCheckStatus }) => <EnumBadge enumName="ReadinessCheckStatus" value={status} map={CHECK} />;

export function ReadinessBadge({ value }: { value: ReadinessOverall | null | undefined }) {
  const t = useTranslations();
  if (!value) return <StatusBadge tone="neutral" icon={CircleDashed} label={t("common.notValidated")} />;
  return <EnumBadge enumName="ReadinessOverall" value={value} map={READINESS} />;
}
