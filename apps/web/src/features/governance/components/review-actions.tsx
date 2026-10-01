"use client";
import { Button, Checkbox, ConfirmDialog, FormField, Input, Textarea } from "@nais/ui";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { asApiError } from "@/shared/api/errors";
import { useErrorText } from "@/shared/api/use-error-text";
import type { AccessRequest, Operation } from "@/shared/api/types";
import { useToast } from "@/shared/ui/toast";
import { useApproveAccessRequest, useGetAccessRequest, useRejectAccessRequest, useRequestAccessChanges } from "../api";
import { ReasonDialog, useServerFieldError } from "./reason-dialog";

/** Reviewer decisions (M10 §7.10). ACCESS_REQUEST_INVALID_STATE → "someone else handled it" + refetch. */
export function ReviewActions({ request, maxGrantDays }: { request: AccessRequest; maxGrantDays: number }) {
  const t = useTranslations();
  const toast = useToast();
  const errorText = useErrorText();
  const fieldError = useServerFieldError();
  const id = request.access_request_id;
  const current = useGetAccessRequest(id);
  const approve = useApproveAccessRequest(id);
  const reject = useRejectAccessRequest(id);
  const changes = useRequestAccessChanges(id);
  const cap = Math.min(request.requested_days, maxGrantDays);
  const [dialog, setDialog] = useState<"approve" | "reject" | "changes" | null>(null);
  const [days, setDays] = useState(cap);
  const [ops, setOps] = useState<Operation[]>(request.operations);
  const [note, setNote] = useState("");
  const [serverErrors, setServerErrors] = useState<Record<string, string | undefined>>({});

  const openDialog = (next: "approve" | "reject" | "changes") => {
    // The cap can change after the policy loaded, so every opening starts from the current values.
    setDays(cap);
    setOps(request.operations);
    setNote("");
    setServerErrors({});
    setDialog(next);
  };
  /** A server VALIDATION_FAILED for one of the dialog's fields stays inside the dialog; everything else closes it with a toast. */
  const failWith = (fields: string[]) => (e: unknown) => {
    const shown = Object.fromEntries(fields.map((f) => [f, fieldError(e, f)]));
    if (Object.values(shown).some(Boolean)) return setServerErrors(shown);
    setDialog(null);
    if (asApiError(e).code === "ACCESS_REQUEST_INVALID_STATE") {
      toast(t("access.detail.handledElsewhere"), "error");
      void current.refetch();
    } else toast(errorText(e), "error");
  };
  const done = (message: string) => () => {
    setDialog(null);
    toast(message);
  };
  const daysValid = Number.isInteger(days) && days >= 1 && days <= cap;

  return (
    <div className="flex flex-wrap gap-2">
      <Button variant="primary" onClick={() => openDialog("approve")}>{t("access.detail.approve")}</Button>
      <Button variant="outline" onClick={() => openDialog("changes")}>
        {t("access.detail.requestChanges")}
      </Button>
      <Button variant="destructive" onClick={() => openDialog("reject")}>
        {t("access.detail.reject")}
      </Button>

      <ConfirmDialog
        open={dialog === "approve"}
        onOpenChange={(o) => !o && setDialog(null)}
        title={t("access.detail.approveTitle")}
        description={t("access.detail.approveDescription", { max: cap })}
        confirmLabel={t("access.detail.approve")}
        cancelLabel={t("common.cancel")}
        closeLabel={t("common.close")}
        pending={approve.isPending}
        confirmDisabled={!daysValid || ops.length === 0}
        onConfirm={() =>
          approve.mutate({ grant_days: days, operations: ops, ...(note.trim() ? { note: note.trim() } : {}) }, { onSuccess: done(t("access.detail.approved")), onError: failWith(["grant_days", "operations", "note"]) })
        }
      >
        <FormField id="approve-days" label={t("access.detail.grantDays")} hint={t("access.detail.grantDaysHint", { max: cap })} error={daysValid ? (serverErrors.grant_days) : t("validation.grantDays", { max: cap })}>
          {(a11y) => <Input {...a11y} type="number" min={1} max={cap} value={Number.isNaN(days) ? "" : days} onChange={(e) => setDays(e.target.valueAsNumber)} />}
        </FormField>
        <fieldset className="flex flex-col gap-1" aria-describedby={serverErrors.operations ? "approve-operations-error" : undefined}>
          <legend className="text-sm font-medium">{t("access.request.operations")}</legend>
          {request.operations.map((op) => (
            <label key={op} className="flex items-center gap-2 text-sm">
              <Checkbox checked={ops.includes(op)} onChange={(e) => setOps(e.target.checked ? [...ops, op] : ops.filter((o) => o !== op))} />
              {t(`enums.Operation.${op}`)}
            </label>
          ))}
          {serverErrors.operations ? (
            <p id="approve-operations-error" role="alert" className="text-sm text-danger">
              {serverErrors.operations}
            </p>
          ) : null}
        </fieldset>
        <FormField id="approve-note" label={t("access.detail.note")} error={serverErrors.note}>
          {(a11y) => <Textarea {...a11y} rows={3} maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)} />}
        </FormField>
      </ConfirmDialog>

      <ReasonDialog
        open={dialog === "reject"}
        onOpenChange={(o) => !o && setDialog(null)}
        title={t("access.detail.rejectTitle")}
        label={t("access.detail.rejectReason")}
        confirmLabel={t("access.detail.reject")}
        destructive
        pending={reject.isPending}
        error={serverErrors.reason}
        onConfirm={(reason) => reject.mutate({ reason }, { onSuccess: done(t("access.detail.rejected")), onError: failWith(["reason"]) })}
      />
      <ReasonDialog
        open={dialog === "changes"}
        onOpenChange={(o) => !o && setDialog(null)}
        title={t("access.detail.requestChangesTitle")}
        label={t("access.detail.changesComment")}
        confirmLabel={t("access.detail.requestChanges")}
        pending={changes.isPending}
        error={serverErrors.comment}
        onConfirm={(comment) => changes.mutate({ comment }, { onSuccess: done(t("access.detail.changesRequested")), onError: failWith(["comment"]) })}
      />
    </div>
  );
}
