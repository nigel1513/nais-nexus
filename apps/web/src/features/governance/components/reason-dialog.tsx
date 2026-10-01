"use client";
import { ConfirmDialog, FormField, Textarea } from "@nais/ui";
import { useTranslations } from "next-intl";
import { useEffect, useId, useState } from "react";
import { asApiError, fieldErrors } from "@/shared/api/errors";
import { useValidationText } from "@/shared/hooks/use-validation-text";

/** Localized text for a server VALIDATION_FAILED reason on `field` (validation.reason.* with a generic fallback), else undefined. */
export function useServerFieldError() {
  const tv = useValidationText();
  return (error: unknown, field: string): string | undefined => {
    const e = asApiError(error);
    if (e.code !== "VALIDATION_FAILED") return undefined;
    const reason = fieldErrors(e)[field];
    return reason === undefined ? undefined : (tv(reason || "GENERIC") ?? undefined);
  };
}

export function ReasonDialog({
  open,
  onOpenChange,
  title,
  description,
  label,
  confirmLabel,
  destructive,
  pending,
  error,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: string;
  description?: string;
  label: string;
  confirmLabel: string;
  destructive?: boolean;
  pending: boolean;
  /** Localized server field error for the reason text (the dialog stays open). */
  error?: string | undefined;
  onConfirm: (text: string) => void;
}) {
  const t = useTranslations();
  const id = useId();
  const [text, setText] = useState("");
  useEffect(() => {
    if (!open) setText("");
  }, [open]);
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={description}
      confirmLabel={confirmLabel}
      cancelLabel={t("common.cancel")}
      closeLabel={t("common.close")}
      destructive={destructive}
      pending={pending}
      confirmDisabled={!text.trim()}
      onConfirm={() => onConfirm(text.trim())}
    >
      <FormField id={`reason-${id}`} label={label} required requiredLabel={t("common.required")} hint={t("access.reasonHint")} error={error}>
        {(a11y) => <Textarea {...a11y} rows={4} maxLength={2000} value={text} onChange={(e) => setText(e.target.value)} />}
      </FormField>
    </ConfirmDialog>
  );
}
