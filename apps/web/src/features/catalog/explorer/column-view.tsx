"use client";
import { Table, TBody, Td, Th, THead, Tr } from "@nais/ui";
import { CircleAlert, LoaderCircle, Info } from "lucide-react";
import { useTranslations } from "next-intl";
import type { FileProfile } from "@/shared/api/types";
import { DelayedSkeleton, ErrorView } from "@/shared/ui/state-views";
import { useGetFileProfile } from "../api";

export function conceptName(iri: string): string {
  return iri.replace(/[/#]+$/, "").split(/[/#]/).at(-1) || iri;
}

export function ProfileStatus({ profile }: { profile: FileProfile }) {
  const t = useTranslations();
  const line = "flex items-center gap-2 py-6 text-small [&_svg]:size-4 [&_svg]:shrink-0";
  if (profile.status === "PENDING")
    return (
      <p role="status" className={`${line} text-fg-muted`}>
        <LoaderCircle aria-hidden="true" strokeWidth={1.75} className="motion-safe:animate-spin" />
        {t("data.explorer.pending")}
      </p>
    );
  if (profile.status === "UNSUPPORTED")
    return (
      <p role="status" className={`${line} text-fg-muted`}>
        <Info aria-hidden="true" strokeWidth={1.75} />
        {t("data.explorer.unsupported")}
      </p>
    );
  if (profile.status === "FAILED") {
    const known = ["UNPARSEABLE", "TIMEOUT", "GENERATION_FAILED"];
    const code = profile.failure_code && known.includes(profile.failure_code) ? profile.failure_code : "GENERATION_FAILED";
    return (
      <p role="alert" className={`${line} text-danger`}>
        <CircleAlert aria-hidden="true" strokeWidth={1.75} />
        {t(`data.explorer.failed.${code}`)}
      </p>
    );
  }
  return null;
}

/** Column: schema summary (no raw values, so it is open to everyone who can see the dataset). */
export function ColumnView({ fileId }: { fileId: string }) {
  const t = useTranslations();
  const q = useGetFileProfile(fileId);
  if (q.isPending) return <DelayedSkeleton lines={4} />;
  if (q.isError) return <ErrorView error={q.error} onRetry={() => void q.refetch()} />;
  const p = q.data;
  if (p.status !== "READY") return <ProfileStatus profile={p} />;
  return (
    <div className="flex flex-col gap-2">
      <Table caption={t("data.explorer.columnSummary", { path: p.path })} className="max-md:min-w-160">
        <THead>
          <Tr>
            {(["name", "type", "unit", "description", "concept"] as const).map((c) => (
              <Th key={c}>{t(`data.explorer.col.${c}`)}</Th>
            ))}
            <Th className="text-right">{t("data.explorer.col.missing")}</Th>
            <Th className="text-right">{t("data.explorer.col.distinct")}</Th>
          </Tr>
        </THead>
        <TBody>
          {p.columns.map((c) => (
            <Tr key={c.name} className="hover:bg-bg-hover">
              <Td className="font-mono text-mono font-medium">{c.name}</Td>
              <Td className="text-small text-fg-muted">{c.type}</Td>
              <Td className="font-mono text-mono">{c.unit ?? "—"}</Td>
              <Td className="min-w-48 text-small">{c.description ?? "—"}</Td>
              <Td className="whitespace-nowrap text-small">
                {c.concept_iri && /^https?:\/\//i.test(c.concept_iri) ? (
                  // The IRI's last segment reads as the concept name; the full IRI is the link and its tooltip.
                  <a href={c.concept_iri} title={c.concept_iri} target="_blank" rel="noopener noreferrer" className="font-mono text-mono text-accent-fg underline-offset-4 hover:underline">
                    {conceptName(c.concept_iri)}
                  </a>
                ) : (
                  (c.concept_iri ?? "—")
                )}
              </Td>
              <Td className="num text-right text-small">{(c.missing_ratio * 100).toFixed(1)}</Td>
              <Td className="num text-right text-small">{c.distinct_capped ? `${c.distinct_count}+` : c.distinct_count}</Td>
            </Tr>
          ))}
        </TBody>
      </Table>
      <p className="text-caption text-fg-muted">
        {p.rows_sampled != null ? t(p.truncated ? "data.explorer.sampledTruncated" : "data.explorer.sampled", { rows: p.rows_sampled }) : null}
        {p.columns_truncated ? ` ${t("data.explorer.columnsTruncated")}` : ""}
      </p>
    </div>
  );
}
