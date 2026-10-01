"use client";
import { useTranslations } from "next-intl";
import { expiryParts, formatDate, formatDateTime } from "@/shared/lib/format";

export function DateTime({ value, dateOnly }: { value?: string | null; dateOnly?: boolean }) {
  if (!value || Number.isNaN(new Date(value).getTime())) return <span>-</span>;
  return (
    <time dateTime={value} title={new Date(value).toISOString()}>
      {dateOnly ? formatDate(value) : formatDateTime(value)}
    </time>
  );
}

export function ExpiryText({ value, now }: { value: string; now?: number }) {
  const t = useTranslations();
  const p = expiryParts(value, now);
  const urgent = p.key === "common.expiresInHours" || (p.key === "common.expiresInDays" && p.count <= 7);
  return (
    <span className="text-sm">
      <DateTime value={value} />{" "}
      <span className={p.key === "common.expired" ? "text-danger" : urgent ? "font-medium text-warning" : "text-muted-foreground"}>
        ({t(p.key, { count: p.count })})
      </span>
    </span>
  );
}
