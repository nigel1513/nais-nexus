"use client";
import { useTranslations } from "next-intl";
import type { FileProfile } from "@/shared/api/types";
import { DelayedSkeleton, ErrorView } from "@/shared/ui/state-views";
import { useGetFileProfile } from "../api";

export function ProfileStatus({ profile }: { profile: FileProfile }) {
  const t = useTranslations();
  if (profile.status === "PENDING") return <p role="status" className="text-sm text-muted-foreground">{t("data.explorer.pending")}</p>;
  if (profile.status === "UNSUPPORTED") return <p role="status" className="text-sm text-muted-foreground">{t("data.explorer.unsupported")}</p>;
  if (profile.status === "FAILED") {
    const code = profile.failure_code ?? "GENERATION_FAILED";
    return <p role="alert" className="text-sm text-destructive">{t(`data.explorer.failed.${code}`)}</p>;
  }
  return null;
}

export function ColumnView({ fileId }: { fileId: string }) {
  const t = useTranslations();
  const q = useGetFileProfile(fileId);
  if (q.isPending) return <DelayedSkeleton lines={4} />;
  if (q.isError) return <ErrorView error={q.error} onRetry={() => void q.refetch()} />;
  const p = q.data;
  if (p.status !== "READY") return <ProfileStatus profile={p} />;
  return (
    <div>
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- scrollable region must be keyboard reachable */}
      <div className="overflow-x-auto" tabIndex={0} role="region" aria-label={t("data.explorer.columnSummary", { path: p.path })}>
        <table aria-label={t("data.explorer.columnSummary", { path: p.path })} className="w-full text-left text-sm">
          <thead>
            <tr className="border-b">
              {(["name", "type", "unit", "description", "concept", "missing", "distinct"] as const).map((c) => (
                <th key={c} scope="col" className="px-2 py-1 font-medium">{t(`data.explorer.col.${c}`)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {p.columns.map((c) => (
              <tr key={c.name} className="border-b align-top">
                <td className="px-2 py-1 font-mono">{c.name}</td>
                <td className="px-2 py-1">{c.type}</td>
                <td className="px-2 py-1">{c.unit ?? "—"}</td>
                <td className="px-2 py-1">{c.description ?? "—"}</td>
                <td className="px-2 py-1">
                  {c.concept_iri && /^https?:\/\//i.test(c.concept_iri) ? (
                    <a href={c.concept_iri} target="_blank" rel="noopener noreferrer" className="break-all underline underline-offset-4">{c.concept_iri}</a>
                  ) : (
                    (c.concept_iri ?? "—")
                  )}
                </td>
                <td className="px-2 py-1">{(c.missing_ratio * 100).toFixed(1)}</td>
                <td className="px-2 py-1">{c.distinct_capped ? `${c.distinct_count}+` : c.distinct_count}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        {p.rows_sampled != null ? t(p.truncated ? "data.explorer.sampledTruncated" : "data.explorer.sampled", { rows: p.rows_sampled }) : null}
        {p.columns_truncated ? ` ${t("data.explorer.columnsTruncated")}` : ""}
      </p>
    </div>
  );
}
