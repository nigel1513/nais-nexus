"use client";
import { Button, cn, Table, TBody, Td, Th, THead, Tr } from "@nais/ui";
import { Sheet } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { DelayedSkeleton, ErrorView } from "@/shared/ui/state-views";
import { useGetDatasetVersion, useGetFileProfiles } from "../api";
import { isTabular } from "../lib/tabular";

const PAGE = 20;

/** 열 설명: every tabular file's columns in one full-width table, grouped by file (column · type · unit · description). */
export function ColumnTable({ versionId }: { versionId: string }) {
  const t = useTranslations();
  const version = useGetDatasetVersion(versionId);
  const [shown, setShown] = useState(PAGE);
  const tabular = (version.data?.files ?? []).filter((f) => f.status === "VERIFIED" && isTabular(f.path));
  const visible = tabular.slice(0, shown);
  const profiles = useGetFileProfiles(visible.map((f) => f.file_id));
  if (version.isPending) return <DelayedSkeleton lines={3} />;
  if (version.isError) return <ErrorView error={version.error} onRetry={() => void version.refetch()} />;
  if (tabular.length === 0) return <p className="text-small text-fg-muted">{t("data.explorer.empty")}</p>;
  // Each file opens with a full-width group row (path · column count); its columns follow, so the 설명 column gets the width.
  const groupRow = (fileId: string, path: string, note: string, first: boolean) => (
    <Tr key={`${fileId}:group`} className={cn("bg-bg-subtle", !first && "border-t border-border-strong")}>
      <Td colSpan={4} className="py-1.5">
        <span className="flex min-w-0 items-center gap-2">
          <Sheet aria-hidden="true" strokeWidth={1.75} className="size-3.5 shrink-0 text-chart-2" />
          <span className="truncate font-mono text-mono text-fg" title={path}>
            {path}
          </span>
          <span className="num shrink-0 font-mono text-micro text-fg-muted">{note}</span>
        </span>
      </Td>
    </Tr>
  );
  return (
    <div className="flex flex-col gap-2">
      <Table caption={t("data.explorer.columnTable")} className="min-w-160 table-fixed">
        <colgroup>
          <col className="w-[26%]" />
          <col className="w-28" />
          <col className="w-24" />
          <col />
        </colgroup>
        <THead>
          <Tr>
            {(["column", "type", "unit", "description"] as const).map((c) => (
              <Th key={c}>{t(`data.explorer.col.${c}`)}</Th>
            ))}
          </Tr>
        </THead>
        <TBody>
          {visible.map((f, i) => {
            const q = profiles[i];
            const p = q?.data;
            if (p?.status === "READY") {
              return [
                groupRow(f.file_id, f.path, t("data.explorer.fileColumns", { count: p.columns.length }), i === 0),
                ...p.columns.map((c) => (
                  <Tr key={`${f.file_id}:${c.name}`} className="align-top hover:bg-bg-hover">
                    <Td className="break-all font-mono text-mono font-semibold">{c.name}</Td>
                    <Td>
                      <span className="rounded-xs bg-bg-hover px-1.5 py-0.5 font-mono text-micro text-fg-muted">{c.type}</span>
                    </Td>
                    <Td className="font-mono text-mono">{c.unit ?? <span className="text-fg-muted">—</span>}</Td>
                    <Td className="text-small [text-wrap:pretty]">{c.description ?? <span className="text-fg-muted">—</span>}</Td>
                  </Tr>
                )),
              ];
            }
            const note = q?.isError ? t("data.explorer.statusShort.FAILED") : p ? t(`data.explorer.statusShort.${p.status}`) : "…";
            return groupRow(f.file_id, f.path, note, i === 0);
          })}
        </TBody>
      </Table>
      {tabular.length > shown ? (
        <Button size="sm" className="self-start" onClick={() => setShown((n) => n + PAGE)}>
          {t("data.explorer.showMore")}
        </Button>
      ) : null}
    </div>
  );
}
