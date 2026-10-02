"use client";
import { CommandMenu, Kbd } from "@nais/ui";
import { Database, FolderKanban, Moon, Plus, Search, ShieldCheck, Sun } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useTheme } from "next-themes";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useSearchDatasets } from "@/features/catalog/api";
import { useListProjects } from "@/features/projects/api";
import type { Me } from "@/shared/api/types";
import { useDebouncedValue } from "@/shared/hooks/use-debounced-value";
import { hasOrgRole } from "@/shared/hooks/use-me";
import { useDestinations } from "./nav";

type PaletteApi = { open: boolean; setOpen: (open: boolean) => void };
const PaletteContext = createContext<PaletteApi>({ open: false, setOpen: () => {} });

export function useCommandPalette(): PaletteApi {
  return useContext(PaletteContext);
}

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName);
}

/** A dialog, sheet, menu or listbox is open: `/` belongs to it (e.g. type-ahead), not to the palette. */
function overlayOpen(): boolean {
  return !!document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]');
}

/**
 * ⌘K / Ctrl+K toggles the palette anywhere; `/` opens it when focus is not in a field (spec §3).
 * Opens and closes with no animation: it is used many times a day (spec §2.6).
 */
export function CommandPaletteProvider({ me, children }: { me: Me; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      } else if (e.key === "/" && !e.metaKey && !e.ctrlKey && !e.altKey && !isTyping(e.target) && !overlayOpen()) {
        e.preventDefault();
        setOpen(true);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  const api = useMemo(() => ({ open, setOpen }), [open]);
  return (
    <PaletteContext.Provider value={api}>
      {children}
      <CommandPalette me={me} open={open} onOpenChange={setOpen} />
    </PaletteContext.Provider>
  );
}

function CommandPalette({ me, open, onOpenChange }: { me: Me; open: boolean; onOpenChange: (open: boolean) => void }) {
  const t = useTranslations();
  return (
    <CommandMenu.Dialog open={open} onOpenChange={onOpenChange} label={t("shell.commandLabel")} shouldFilter={false}>
      {/* Mounted only while open: the query and the server searches start fresh each time. */}
      <PaletteBody me={me} close={() => onOpenChange(false)} />
    </CommandMenu.Dialog>
  );
}

const norm = (s: string) => s.toLocaleLowerCase("ko-KR").replace(/\s+/g, " ").trim();
const matches = (q: string, ...fields: (string | null | undefined)[]) => !q || fields.some((f) => !!f && norm(f).includes(q));

function PaletteBody({ me, close }: { me: Me; close: () => void }) {
  const t = useTranslations();
  const router = useRouter();
  const { resolvedTheme, setTheme } = useTheme();
  const [input, setInput] = useState("");
  const q = norm(input);
  const debounced = useDebouncedValue(input.trim(), 150);
  const destinations = useDestinations(me);
  const steward = hasOrgRole(me, "DATA_STEWARD");

  const datasets = useSearchDatasets({ q: debounced, limit: 8 }, { enabled: debounced.length > 0 });
  const projects = useListProjects({ scope: "mine", limit: 100 });

  const go = useCallback(
    (href: string) => {
      close();
      router.push(href);
    },
    [close, router],
  );

  const dark = resolvedTheme === "dark";
  const actions = [
    ...(steward ? [{ id: "new-dataset", label: t("shell.newDataset"), icon: Plus, run: () => go("/commons/data/new") }] : []),
    { id: "new-project", label: t("shell.newProject"), icon: Plus, run: () => go("/commons/projects/new") },
    { id: "access", label: t("shell.viewAccessRequests"), icon: ShieldCheck, run: () => go("/commons/access") },
    {
      id: "theme",
      label: dark ? t("shell.themeToLight") : t("shell.themeToDark"),
      icon: dark ? Sun : Moon,
      run: () => {
        setTheme(dark ? "light" : "dark");
        close();
      },
    },
  ].filter((a) => matches(q, a.label));

  const places = destinations.filter((d) => matches(q, d.label, d.href));
  // Hits for an older query stay until the new ones arrive (keepPreviousData), so the list does not flicker.
  const hits = debounced ? (datasets.data?.pages[0]?.items ?? []).slice(0, 8) : [];
  const myProjects = q ? (projects.data?.pages.flatMap((p) => p.items) ?? []).filter((p) => matches(q, p.name)).slice(0, 5) : [];

  return (
    <>
      <CommandMenu.Input value={input} onValueChange={setInput} placeholder={t("shell.commandPlaceholder")} />
      <CommandMenu.List>
        <CommandMenu.Empty>{t("shell.commandEmpty")}</CommandMenu.Empty>
        {places.length ? (
          <CommandMenu.Group heading={t("shell.commandGo")}>
            {places.map((d) => (
              <CommandMenu.Item key={d.href} value={`go:${d.href}`} icon={<d.icon aria-hidden="true" strokeWidth={1.75} />} onSelect={() => go(d.href)}>
                {d.label}
              </CommandMenu.Item>
            ))}
          </CommandMenu.Group>
        ) : null}
        {q ? (
          <CommandMenu.Group heading={t("shell.commandDatasets")}>
            <CommandMenu.Item
              value="search-all"
              icon={<Search aria-hidden="true" strokeWidth={1.75} />}
              onSelect={() => go(`/commons/data?q=${encodeURIComponent(input.trim())}`)}
            >
              {t("shell.commandSearchAll", { q: input.trim() })}
            </CommandMenu.Item>
            {hits.map((h) => (
              <CommandMenu.Item
                key={h.dataset_id}
                value={`dataset:${h.dataset_id}`}
                icon={<Database aria-hidden="true" strokeWidth={1.75} />}
                hint={h.owner_organization_name}
                onSelect={() => go(`/commons/data/${h.dataset_id}`)}
              >
                {h.title}
              </CommandMenu.Item>
            ))}
          </CommandMenu.Group>
        ) : null}
        {myProjects.length ? (
          <CommandMenu.Group heading={t("shell.commandProjects")}>
            {myProjects.map((p) => (
              <CommandMenu.Item
                key={p.project_id}
                value={`project:${p.project_id}`}
                icon={<FolderKanban aria-hidden="true" strokeWidth={1.75} />}
                onSelect={() => go(`/commons/projects/${p.project_id}`)}
              >
                {p.name}
              </CommandMenu.Item>
            ))}
          </CommandMenu.Group>
        ) : null}
        {actions.length ? (
          <CommandMenu.Group heading={t("shell.commandActions")}>
            {actions.map((a) => (
              <CommandMenu.Item key={a.id} value={`action:${a.id}`} icon={<a.icon aria-hidden="true" strokeWidth={1.75} />} onSelect={a.run}>
                {a.label}
              </CommandMenu.Item>
            ))}
          </CommandMenu.Group>
        ) : null}
      </CommandMenu.List>
      {/* Keyboard legend; decorative, the keys themselves are standard for a listbox. */}
      <div aria-hidden="true" className="flex h-9 shrink-0 items-center gap-4 border-t border-border px-3 text-caption text-fg-muted">
        <span className="flex items-center gap-1.5">
          <Kbd>↑</Kbd>
          <Kbd>↓</Kbd>
          {t("shell.hintMove")}
        </span>
        <span className="flex items-center gap-1.5">
          <Kbd>↵</Kbd>
          {t("shell.hintOpen")}
        </span>
        <span className="flex items-center gap-1.5">
          <Kbd>esc</Kbd>
          {t("shell.hintClose")}
        </span>
      </div>
    </>
  );
}
