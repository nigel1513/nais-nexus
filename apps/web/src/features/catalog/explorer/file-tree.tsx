"use client";
import { useTranslations } from "next-intl";
import type { DatasetFile } from "@/shared/api/types";
import { formatBytes } from "@/shared/lib/format";

export function FileTree({ files, currentId, onSelect }: { files: DatasetFile[]; currentId?: string; onSelect: (id: string) => void }) {
  const t = useTranslations();
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
  const seenDirs = new Set<string>();
  return (
    <ul aria-label={t("data.explorer.files")} className="flex flex-col gap-1 text-sm">
      {sorted.map((f) => {
        const parts = f.path.split("/");
        const heads: { dir: string; depth: number }[] = [];
        for (let i = 1; i < parts.length; i++) {
          const dir = parts.slice(0, i).join("/");
          if (!seenDirs.has(dir)) {
            seenDirs.add(dir);
            heads.push({ dir: parts[i - 1]!, depth: i - 1 });
          }
        }
        const selected = f.file_id === currentId;
        return (
          <li key={f.file_id} className="contents">
            {heads.map((h) => (
              <span key={`${f.file_id}-${h.dir}-${h.depth}`} aria-hidden="true" className="mt-1 text-xs text-muted-foreground" style={{ paddingLeft: `${h.depth * 0.75}rem` }}>
                {h.dir}/
              </span>
            ))}
            <button
              type="button"
              aria-current={selected ? "true" : undefined}
              onClick={() => onSelect(f.file_id)}
              style={{ marginLeft: `${(parts.length - 1) * 0.75}rem` }}
              className={`flex flex-col rounded-md border px-2 py-1 text-left hover:bg-muted ${selected ? "border-primary bg-muted" : "border-transparent"}`}
            >
              <span className="break-all font-mono">{f.path}</span>
              <span className="text-xs text-muted-foreground">{formatBytes(f.size_bytes)}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
