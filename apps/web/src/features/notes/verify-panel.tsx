"use client";
import { Button } from "@nais/ui";
import { CircleCheck, CircleX, RefreshCw, TriangleAlert } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useId } from "react";
import { useErrorText } from "@/shared/api/use-error-text";
import { DateTime } from "@/shared/ui/date-text";
import type { Schemas } from "@/shared/api/types";
import { useVerifyNote } from "./api";

function Verdict({ ok, okLabel, badLabel }: { ok: boolean; okLabel: string; badLabel: string }) {
  const Icon = ok ? CircleCheck : CircleX;
  return (
    <p className={ok ? "flex items-center gap-1.5 font-medium text-success" : "flex items-center gap-1.5 font-medium text-danger"}>
      <Icon aria-hidden="true" strokeWidth={1.75} className="size-4 shrink-0" />
      <span>{ok ? okLabel : badLabel}</span>
    </p>
  );
}

/**
 * 무결성 검증: the server recomputes the note's content hash from what is stored (valid: it equals the hash fixed at
 * submit / sign) and rebuilds the project × organization chain of SIGNED notes (chain_valid). A SUBMITTED note is not in
 * the chain yet, so for it chain_valid speaks for the other signed notes only. Runs when opened and on 다시 검증.
 */
export function VerifyPanel({ noteId, status }: { noteId: string; status: Schemas["NoteStatus"] }) {
  const t = useTranslations();
  const errorText = useErrorText();
  const headingId = useId();
  const verify = useVerifyNote(noteId);
  const { mutate } = verify;
  useEffect(() => mutate(), [mutate]);
  const r = verify.data;
  const ok = r ? r.valid && r.chain_valid : null;
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3 rounded-md border border-border bg-bg-panel p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id={headingId} className="text-heading text-fg">
          {t("notes.verify.title")}
        </h2>
        <Button size="sm" loading={verify.isPending} onClick={() => mutate()}>
          <RefreshCw aria-hidden="true" strokeWidth={1.75} />
          {t("notes.verify.again")}
        </Button>
      </div>
      {verify.isError ? (
        <p role="alert" className="flex items-start gap-2 text-small text-fg">
          <TriangleAlert aria-hidden="true" strokeWidth={1.75} className="mt-0.5 size-4 shrink-0 text-danger" />
          {errorText(verify.error)}
        </p>
      ) : null}
      <div role="status" className={r && !verify.isPending ? "flex flex-col gap-1.5" : "sr-only"}>
        {r && !verify.isPending ? (
          <>
            <div className="flex flex-wrap gap-x-6 gap-y-1 text-body">
              <Verdict ok={r.valid} okLabel={t("notes.verify.contentOk")} badLabel={t("notes.verify.contentBad")} />
              <Verdict ok={r.chain_valid} okLabel={t("notes.verify.chainOk")} badLabel={t("notes.verify.chainBad")} />
            </div>
            <p className="text-small text-fg-muted">
              {r.valid ? t(status === "SIGNED" ? "notes.verify.explainContentOkSigned" : "notes.verify.explainContentOkSubmitted") : t("notes.verify.explainContentBad")}{" "}
              {r.chain_valid ? t(status === "SIGNED" ? "notes.verify.explainChainOk" : "notes.verify.explainChainOkSubmitted") : t("notes.verify.explainChainBad")}
              {ok ? null : ` ${t("notes.verify.report")}`}
            </p>
          </>
        ) : null}
      </div>
      {r && !verify.isPending ? (
        <>
          <dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-small md:grid-cols-[10rem_1fr]">
            <dt className="text-fg-muted">{t("notes.verify.stored")}</dt>
            <dd className="font-mono text-mono text-fg [overflow-wrap:anywhere]">{r.content_hash}</dd>
            <dt className="text-fg-muted">{t("notes.verify.recomputed")}</dt>
            <dd className="font-mono text-mono text-fg [overflow-wrap:anywhere]">{r.recomputed_hash}</dd>
            <dt className="text-fg-muted">{t("notes.verify.checkedAt")}</dt>
            <dd className="text-fg">
              <DateTime value={r.checked_at} />
            </dd>
          </dl>
        </>
      ) : null}
    </section>
  );
}
