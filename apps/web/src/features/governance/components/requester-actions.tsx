"use client";
import { zodResolver } from "@hookform/resolvers/zod";
import { Button, ConfirmDialog, FormField, Input, Select, Textarea } from "@nais/ui";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { asApiError, fieldErrors } from "@/shared/api/errors";
import { useErrorText } from "@/shared/api/use-error-text";
import type { AccessRequest, Purpose } from "@/shared/api/types";
import { useValidationText } from "@/shared/hooks/use-validation-text";
import { notify } from "@/shared/ui/toast";
import { useGetAccessRequest, useResubmitAccessRequest, useWithdrawAccessRequest } from "../api";
import { accessRequestSchema, type AccessRequestFormValues } from "../schemas";

/** ACCESS_REQUEST_INVALID_STATE → "someone else handled it" + refetch; anything else is a localized toast. */
function useRequesterError(id: string) {
  const t = useTranslations();
  const errorText = useErrorText();
  const current = useGetAccessRequest(id);
  return (e: unknown) => {
    if (asApiError(e).code === "ACCESS_REQUEST_INVALID_STATE") {
      notify.error(t("access.detail.handledElsewhere"));
      void current.refetch();
    } else notify.error(errorText(e));
  };
}

/** CHANGE_REQUESTED: the requester edits the request and sends it back to the queue. */
export function ResubmitForm({ request, allowedPurposes, maxGrantDays }: { request: AccessRequest; allowedPurposes: Purpose[]; maxGrantDays: number }) {
  const t = useTranslations();
  const tv = useValidationText();
  const id = request.access_request_id;
  const resubmit = useResubmitAccessRequest(id);
  const onError = useRequesterError(id);
  const form = useForm<AccessRequestFormValues>({
    resolver: zodResolver(accessRequestSchema(maxGrantDays)),
    defaultValues: { project_id: request.project_id, purpose: request.purpose, purpose_detail: request.purpose_detail, requested_days: request.requested_days },
  });
  const { errors, isSubmitting } = form.formState;
  const { reset } = form;
  // Another actor (or a refetch) changed the request: start the form from the current values, not stale text.
  useEffect(() => {
    reset({ project_id: request.project_id, purpose: request.purpose, purpose_detail: request.purpose_detail, requested_days: request.requested_days });
  }, [request.updated_at, request.project_id, request.purpose, request.purpose_detail, request.requested_days, reset]);

  return (
    <form
      noValidate
      aria-labelledby="resubmit-title"
      className="flex flex-col gap-4 rounded-md border border-border bg-bg-panel p-4"
      onSubmit={form.handleSubmit(async (v) => {
        try {
          await resubmit.mutateAsync({ purpose: v.purpose as Purpose, purpose_detail: v.purpose_detail.trim(), requested_days: v.requested_days });
          notify.success(t("access.detail.resubmitted"));
        } catch (e) {
          const err = asApiError(e);
          const mapped = Object.entries(fieldErrors(err)).filter(([k]) => k === "purpose" || k === "purpose_detail" || k === "requested_days");
          if (err.code === "VALIDATION_FAILED" && mapped.length) {
            for (const [k, m] of mapped) form.setError(k as keyof AccessRequestFormValues, { message: m });
          } else onError(e);
        }
      })}
    >
      <div>
        <h2 id="resubmit-title" className="text-heading text-fg">
          {t("access.detail.resubmitTitle")}
        </h2>
        <p className="mt-1 text-small text-fg-muted">{t("access.detail.resubmitHint")}</p>
      </div>
      <FormField id="resubmit-purpose" label={t("access.request.purpose")} error={tv(errors.purpose?.message)}>
        {(a11y) => (
          <Select {...a11y} {...form.register("purpose")}>
            {allowedPurposes.map((p) => (
              <option key={p} value={p}>
                {t(`enums.Purpose.${p}`)}
              </option>
            ))}
          </Select>
        )}
      </FormField>
      <FormField id="resubmit-detail" label={t("access.request.detail")} error={tv(errors.purpose_detail?.message)}>
        {(a11y) => <Textarea {...a11y} rows={5} maxLength={4000} {...form.register("purpose_detail")} />}
      </FormField>
      <FormField id="resubmit-days" label={t("access.request.days")} hint={t("access.request.daysHint", { max: maxGrantDays })} error={tv(errors.requested_days?.message, { max: maxGrantDays })}>
        {(a11y) => <Input {...a11y} type="number" min={1} max={maxGrantDays} {...form.register("requested_days", { valueAsNumber: true })} />}
      </FormField>
      <div className="flex justify-end">
        <Button variant="primary" type="submit" loading={isSubmitting}>
          {t("access.detail.resubmit")}
        </Button>
      </div>
    </form>
  );
}

/** Withdrawing is irreversible, so it always asks first. */
export function WithdrawAction({ request }: { request: AccessRequest }) {
  const t = useTranslations();
  const id = request.access_request_id;
  const withdraw = useWithdrawAccessRequest(id);
  const onError = useRequesterError(id);
  const [confirming, setConfirming] = useState(false);
  return (
    <>
      <Button variant="secondary" className="w-full" onClick={() => setConfirming(true)}>
        {t("access.detail.withdraw")}
      </Button>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t("access.detail.withdrawTitle")}
        description={t("access.detail.withdrawWarning")}
        confirmLabel={t("access.detail.withdraw")}
        cancelLabel={t("common.cancel")}
        closeLabel={t("common.close")}
        destructive
        pending={withdraw.isPending}
        onConfirm={() =>
          withdraw.mutate(undefined, {
            onSuccess: () => {
              setConfirming(false);
              notify.success(t("access.detail.withdrawn"));
            },
            onError: (e) => {
              setConfirming(false);
              onError(e);
            },
          })
        }
      />
    </>
  );
}
