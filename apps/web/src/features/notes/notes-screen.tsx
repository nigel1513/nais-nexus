"use client";
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle, FormField, Input, Select, Tabs, TabsContent, TabsList, TabsTrigger } from "@nais/ui";
import { NotebookPen, Search, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useId, useState, type FormEvent } from "react";
import { useListProjects } from "@/features/projects/api";
import { flattenPages } from "@/shared/api/pagination";
import { useErrorText } from "@/shared/api/use-error-text";
import { useMeData } from "@/shared/hooks/use-me";
import { useUrlQuery } from "@/shared/hooks/use-url-query";
import { ScreenTitle } from "@/shared/ui/screen-v2";
import { DelayedSkeleton, ErrorView } from "@/shared/ui/state-views";
import { useNoteSearch, useTodayNote } from "./api";
import { NoteTable } from "./note-table";

/**
 * /commons/notes: 오늘 노트 쓰기 (pick a project), search over the notes I may read, and two lists — 내 노트 (latest
 * version per day) and 확인할 노트 (notes submitted to me as witness).
 */
export function NotesScreen() {
  const t = useTranslations();
  const me = useMeData();
  const [params, setParams] = useUrlQuery();
  const tab = params.get("tab") === "witness" ? "witness" : "mine";
  const q = params.get("q") ?? "";
  const [writing, setWriting] = useState(false);
  return (
    <>
      <ScreenTitle
        context={[t("notes.context"), me.organization.name]}
        title={t("notes.title")}
        description={t("notes.description")}
        actions={
          <Button variant="primary" onClick={() => setWriting(true)}>
            <NotebookPen aria-hidden="true" strokeWidth={1.75} />
            {t("notes.today")}
          </Button>
        }
      />
      <div className="flex flex-col gap-8">
        <SearchBox value={q} onSearch={(text) => setParams({ q: text || null })} />
        {q ? <SearchResults q={q} onClear={() => setParams({ q: null })} /> : null}
        <Tabs value={tab} onValueChange={(v) => setParams({ tab: v === "witness" ? "witness" : null })}>
          <TabsList aria-label={t("notes.tabsLabel")}>
            <TabsTrigger value="mine">{t("notes.mine")}</TabsTrigger>
            <TabsTrigger value="witness">{t("notes.witness")}</TabsTrigger>
          </TabsList>
          <TabsContent value="mine">{tab === "mine" ? <NoteTable query={{ role: "recorder" }} caption={t("notes.mine")} /> : null}</TabsContent>
          <TabsContent value="witness">{tab === "witness" ? <NoteTable query={{ role: "witness" }} caption={t("notes.witness")} /> : null}</TabsContent>
        </Tabs>
      </div>
      {writing ? <TodayDialog onClose={() => setWriting(false)} /> : null}
    </>
  );
}

function SearchBox({ value, onSearch }: { value: string; onSearch: (q: string) => void }) {
  const t = useTranslations();
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onSearch(text.trim());
  };
  return (
    <form role="search" aria-label={t("notes.search.form")} onSubmit={submit} className="flex w-full max-w-2xl flex-col gap-1.5">
      <div className="flex gap-2">
        <div className="relative min-w-0 flex-1">
          <Search aria-hidden="true" strokeWidth={1.75} className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-fg-muted" />
          <Input type="search" aria-label={t("notes.search.label")} placeholder={t("notes.search.placeholder")} maxLength={500} value={text} onChange={(e) => setText(e.target.value)} className="pl-8" />
        </div>
        <Button type="submit">{t("notes.search.submit")}</Button>
      </div>
      <p className="text-caption text-fg-muted">{t("notes.search.hint")}</p>
    </form>
  );
}

/** Hits best first (score only orders them; it is never shown): project · day as the link, the snippet below. */
function SearchResults({ q, onClear }: { q: string; onClear: () => void }) {
  const t = useTranslations();
  const headingId = useId();
  const search = useNoteSearch(q);
  const hits = search.data ?? [];
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="sv-h2">
          <span id={headingId}>{t("notes.search.results")}</span>
          {search.data ? <span className="sv-count ml-2">{hits.length}</span> : null}
        </h2>
        <Button variant="ghost" size="sm" onClick={onClear}>
          <X aria-hidden="true" strokeWidth={1.75} />
          {t("notes.search.clear")}
        </Button>
      </div>
      {search.isPending ? (
        <DelayedSkeleton />
      ) : search.isError ? (
        <ErrorView error={search.error} onRetry={() => void search.refetch()} />
      ) : hits.length ? (
        <ol className="flex flex-col divide-y divide-border rounded-md border border-border">
          {hits.map((h) => (
            <li key={h.note_id} className="flex min-w-0 flex-col gap-1 px-3 py-2.5">
              <Link href={`/commons/notes/${h.note_id}`} className="w-fit break-keep font-medium text-fg underline-offset-4 hover:underline">
                {h.project_name} · <span className="num font-mono text-mono">{h.note_date}</span>
              </Link>
              {h.snippet ? <p className="text-small text-fg-muted [overflow-wrap:anywhere]">{h.snippet}</p> : null}
            </li>
          ))}
        </ol>
      ) : (
        <p className="text-small text-fg-muted">{t("notes.search.empty")}</p>
      )}
    </section>
  );
}

/** 오늘 노트 쓰기 from the list: pick one of my active projects; today's note there opens (created when missing). */
function TodayDialog({ onClose }: { onClose: () => void }) {
  const t = useTranslations();
  const errorText = useErrorText();
  const router = useRouter();
  const id = useId();
  const projects = useListProjects({ scope: "mine", status: "ACTIVE" });
  const rows = flattenPages(projects.data);
  const [picked, setPicked] = useState("");
  const projectId = picked || rows[0]?.project_id || "";
  const today = useTodayNote();
  return (
    <Dialog open onOpenChange={(o) => (o ? undefined : onClose())}>
      <DialogContent closeLabel={t("common.close")}>
        <DialogTitle>{t("notes.today")}</DialogTitle>
        <DialogDescription>{t("notes.todayDescription")}</DialogDescription>
        {projects.isPending ? (
          <div className="mt-4">
            <DelayedSkeleton lines={2} />
          </div>
        ) : projects.isError ? (
          <div className="mt-4">
            <ErrorView error={projects.error} onRetry={() => void projects.refetch()} />
          </div>
        ) : rows.length ? (
          <form
            className="mt-4 flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (!projectId) return;
              today.mutate(projectId, { onSuccess: (n) => router.push(`/commons/notes/${n.note_id}`) });
            }}
          >
            <FormField id={`${id}-project`} label={t("notes.project")} error={today.isError ? errorText(today.error) : undefined}>
              {(a11y) => (
                <Select {...a11y} value={projectId} onChange={(e) => setPicked(e.target.value)}>
                  {rows.map((p) => (
                    <option key={p.project_id} value={p.project_id}>
                      {p.name}
                    </option>
                  ))}
                </Select>
              )}
            </FormField>
            <DialogFooter>
              <Button variant="secondary" onClick={onClose}>
                {t("common.cancel")}
              </Button>
              <Button type="submit" variant="primary" loading={today.isPending}>
                {t("notes.open")}
              </Button>
            </DialogFooter>
          </form>
        ) : (
          <p className="mt-4 text-small text-fg-muted">{t("notes.noProjects")}</p>
        )}
      </DialogContent>
    </Dialog>
  );
}
