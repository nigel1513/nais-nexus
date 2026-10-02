"use client";
import { cn } from "@nais/ui";
import { BookOpen, BookText, Braces, Database, FileCode2, FileText, Files, FolderOpen, Sheet, Workflow, type LucideIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import type { DatasetFile } from "@/shared/api/types";
import { formatBytes } from "@/shared/lib/format";
import { isTabular } from "../lib/tabular";

/** Role groups in display order (Stage 3 file roles); files without a role fall into one "파일" group. */
const ROLE_ORDER = ["RAW", "PROCESSED", "DOCS"];
const ROLE_ICON: Record<string, LucideIcon> = { RAW: Database, PROCESSED: Workflow, DOCS: BookOpen };

/** What a file is for, read from its name: a data table, a codebook, a schema, a readme, or other. */
export function fileKind(path: string): { icon: LucideIcon; tone: string } {
  const name = path.split("/").at(-1)!.toLowerCase();
  if (/codebook/.test(name)) return { icon: BookText, tone: "text-fg-muted" };
  if (/schema/.test(name) || name.endsWith(".json")) return { icon: Braces, tone: "text-fg-muted" };
  if (/^readme/.test(name) || name.endsWith(".md")) return { icon: FileCode2, tone: "text-fg-muted" };
  if (isTabular(path)) return { icon: Sheet, tone: "text-chart-2" };
  return { icon: FileText, tone: "text-fg-muted" };
}

type Dir = { dirs: Map<string, Dir>; files: DatasetFile[] };
const newDir = (): Dir => ({ dirs: new Map(), files: [] });

function build(files: DatasetFile[]): Dir {
  const root = newDir();
  for (const f of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    const parts = f.path.split("/");
    let node = root;
    for (const part of parts.slice(0, -1)) {
      if (!node.dirs.has(part)) node.dirs.set(part, newDir());
      node = node.dirs.get(part)!;
    }
    node.files.push(f);
  }
  return root;
}

/**
 * Explorer file tree (reference A): caption-labelled role groups, folders as quiet rows with a 1px guide, files as
 * mono names (the size shows above the open file). The selected file is the accent row. Each file button is named by its full path.
 */
export function FileTree({ files, currentId, onSelect }: { files: DatasetFile[]; currentId?: string; onSelect: (id: string) => void }) {
  const t = useTranslations();
  const roleOf = (f: DatasetFile) => (f as DatasetFile & { role?: string | null }).role ?? null;
  const rank = (r: string | null) => (r === null ? 99 : ROLE_ORDER.includes(r) ? ROLE_ORDER.indexOf(r) : 50);
  const roles = [...new Set(files.map(roleOf))].sort((a, b) => rank(a) - rank(b));

  const fileRow = (f: DatasetFile) => {
    const selected = f.file_id === currentId;
    const name = f.path.split("/").at(-1)!;
    const { icon: Icon, tone } = fileKind(f.path);
    return (
      <li key={f.file_id}>
        <button
          type="button"
          aria-current={selected ? "true" : undefined}
          aria-label={`${f.path}, ${formatBytes(f.size_bytes)}`}
          title={f.path}
          onClick={() => onSelect(f.file_id)}
          className={cn(
            "flex h-7 w-full cursor-pointer items-center gap-2 rounded-sm px-2 text-left outline-none transition-colors duration-150 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus",
            selected ? "bg-accent-soft text-accent-fg" : "text-fg hover:bg-bg-hover",
          )}
        >
          <Icon aria-hidden="true" strokeWidth={1.75} className={cn("size-3.5 shrink-0", selected ? "text-accent-fg" : tone)} />
          <span className="min-w-0 flex-1 truncate font-mono text-mono">{name}</span>
          {/* The open file's size is in the path bar above the view, which leaves its name the room. */}
          {selected ? null : (
            <span aria-hidden="true" className="num shrink-0 font-mono text-micro text-fg-muted">
              {formatBytes(f.size_bytes)}
            </span>
          )}
        </button>
      </li>
    );
  };
  const dir = (node: Dir, nested: boolean): ReactNode => (
    <ul className={cn("flex flex-col gap-px", nested && "ml-3.5 border-l border-border pl-1.5")}>
      {[...node.dirs].map(([name, child]) => (
        <li key={`d:${name}`}>
          <span className="flex h-7 items-center gap-2 px-2 text-small text-fg-muted">
            <FolderOpen aria-hidden="true" strokeWidth={1.75} className="size-3.5 shrink-0" />
            <span className="truncate font-mono text-mono">{name}/</span>
          </span>
          {dir(child, true)}
        </li>
      ))}
      {node.files.map(fileRow)}
    </ul>
  );

  return (
    <div role="list" aria-label={t("data.explorer.files")} className="flex flex-col gap-3">
        {roles.map((role) => (
          <div role="listitem" key={role ?? "none"} className="flex flex-col gap-1">
            <p className="flex items-center gap-1.5 px-2 pb-0.5 text-caption font-semibold text-fg-muted">
              {(() => {
                const RoleIcon = (role && ROLE_ICON[role]) || Files;
                return <RoleIcon aria-hidden="true" strokeWidth={1.75} className="size-3.5" />;
              })()}
              {role ?? t("data.explorer.otherGroup")}
            </p>
            {dir(build(files.filter((f) => roleOf(f) === role)), false)}
          </div>
        ))}
    </div>
  );
}
