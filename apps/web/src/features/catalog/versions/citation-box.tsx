"use client";
import { Button, cn, copyText, Skeleton, Tabs, TabsContent, TabsList, TabsTrigger } from "@nais/ui";
import { Copy } from "lucide-react";
import { useTranslations } from "next-intl";
import { useId, useRef, useState } from "react";
import { useErrorText } from "@/shared/api/use-error-text";
import { notify } from "@/shared/ui/toast";
import { useCitation, type CitationStyle } from "./api";

const STYLES: CitationStyle[] = ["text", "bibtex", "datacite-json"];

/** DataCite JSON comes compact from the API; show it indented. */
const pretty = (style: CitationStyle, content: string) => {
  if (style !== "datacite-json") return content;
  try {
    return JSON.stringify(JSON.parse(content), null, 2);
  } catch {
    return content;
  }
};

/**
 * "이 버전 인용하기" (spec §3.3b R12): the citation of one PUBLISHED version in the contract's styles (text, BibTeX,
 * DataCite JSON), pinned to that version's identifier. Copy works on plain http too (`copyText` falls back to
 * execCommand); when every path fails the text is selected so it can be copied by hand.
 */
export function CitationBox({ versionId, label }: { versionId: string; label: string }) {
  const t = useTranslations("data.versioning.citation");
  const te = useTranslations("enums.CitationStyle");
  const errorText = useErrorText();
  const [style, setStyle] = useState<CitationStyle>("text");
  const citation = useCitation(versionId, style);
  const titleId = useId();
  const pre = useRef<HTMLPreElement>(null);
  const content = citation.data ? pretty(style, citation.data.content) : "";

  const selectAll = () => {
    const el = pre.current;
    if (!el) return;
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  };

  const copyButton = (
    <Button
      variant="secondary"
      size="sm"
      disabled={!content}
      onClick={async () => {
        if (await copyText(content)) notify.success(t("copied"));
        else {
          notify.error(t("copyFailed"));
          selectAll();
        }
      }}
    >
      <Copy aria-hidden="true" strokeWidth={1.75} />
      {t("copy")}
    </Button>
  );
  const panel = citation.isPending ? (
    <div className="flex flex-col gap-2 px-4 pb-4">
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-2/3" />
    </div>
  ) : citation.isError ? (
    <p role="alert" className="px-4 pb-4 text-small text-danger">
      {errorText(citation.error)}
    </p>
  ) : (
    // Focusable so keyboard users can scroll it and select the text after a failed copy.
    <pre
      ref={pre}
      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
      tabIndex={0}
      className={cn(
        "mx-4 mb-4 max-h-72 select-all overflow-auto whitespace-pre-wrap break-words rounded-sm bg-bg-subtle p-3.5 leading-relaxed text-fg outline-none focus-visible:outline-2 focus-visible:outline-focus",
        style === "text" ? "font-sans text-body" : "font-mono text-[12.5px]",
      )}
    >
      {content}
    </pre>
  );

  // Same frame as the neighbouring download and readiness panels: a bordered card with its heading row on top.
  return (
    <section aria-labelledby={titleId} className="min-w-0 rounded-md border border-border bg-bg-panel">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
        <h2 id={titleId} className="text-heading text-fg">
          {t("title")}
        </h2>
        {copyButton}
      </div>
      <p className="break-keep px-4 pt-3 text-small text-fg-muted">{t.rich("pinned", { label, v: (c) => <span className="font-mono text-[12.5px] font-medium text-fg">{c}</span> })}</p>
      <Tabs value={style} onValueChange={(v) => setStyle(STYLES.includes(v as CitationStyle) ? (v as CitationStyle) : "text")}>
        <TabsList aria-label={t("formats")} className="mx-4 mb-3 gap-5">
          {STYLES.map((s) => (
            <TabsTrigger key={s} value={s} className="h-9 text-small">
              {te(s)}
            </TabsTrigger>
          ))}
        </TabsList>
        {STYLES.map((s) => (
          <TabsContent key={s} value={s} className="pt-0">
            {s === style ? panel : null}
          </TabsContent>
        ))}
      </Tabs>
    </section>
  );
}
