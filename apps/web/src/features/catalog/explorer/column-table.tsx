"use client";
import { Button, cn, Table, TBody, Td, Th, THead, Tr } from "@nais/ui";
import { Sheet } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { DelayedSkeleton, ErrorView } from "@/shared/ui/state-views";
import { useGetDatasetVersion, useGetFileProfiles } from "../api";
import { isTabular } from "../lib/tabular";

const PAGE = 20;

/** 열 설명: every tabular file's columns in one table (file · column · type · unit · description). */
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
  const fileCell = (path: string) => (
    <Td className="max-w-56 truncate font-mono text-mono text-fg-muted" title={path}>
      <span className="flex items-center gap-1.5">
        <Sheet aria-hidden="true" strokeWidth={1.75} className="size-3.5 shrink-0 text-chart-2" />
        <span className="truncate">{path}</span>
      </span>
    </Td>
  );
  return (
    <div className="flex flex-col gap-2">
      <Table caption={t("data.explorer.columnTable")} className="min-w-160">
        <THead>
          <Tr>
            {(["file", "column", "type", "unit", "description"] as const).map((c) => (
              <Th key={c}>{t(`data.explorer.col.${c}`)}</Th>
            ))}
          </Tr>
        </THead>
        <TBody>
          {visible.map((f, i) => {
            const q = profiles[i];
            const p = q?.data;
            if (p?.status === "READY") {
              // The file path shows once, on its first column; the rows below it belong to the same file.
              return p.columns.map((c, j) => (
                <Tr key={`${f.file_id}:${c.name}`} className={cn("align-top hover:bg-bg-hover", j === 0 && i > 0 && "border-t border-border-strong")}>
                  {j === 0 ? fileCell(f.path) : <Td aria-label={f.path} />}
                  <Td className="font-mono text-mono font-semibold">{c.name}</Td>
                  <Td>
                    <span className="rounded-xs bg-bg-hover px-1.5 py-0.5 font-mono text-micro text-fg-muted">{c.type}</span>
                  </Td>
                  <Td className="font-mono text-mono">{c.unit ?? <span className="text-fg-muted">—</span>}</Td>
                  <Td className="min-w-48 text-small">{c.description ?? <span className="text-fg-muted">—</span>}</Td>
                </Tr>
              ));
            }
            const note = q?.isError ? t("data.explorer.statusShort.FAILED") : p ? t(`data.explorer.statusShort.${p.status}`) : "…";
            return (
              <Tr key={f.file_id}>
                {fileCell(f.path)}
                <Td colSpan={4} className="text-small text-fg-muted">
                  {note}
                </Td>
              </Tr>
            );
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
