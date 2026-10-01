"use client";
import { zodResolver } from "@hookform/resolvers/zod";
import { Button, Checkbox, ConfirmDialog, FormField, Input, Textarea } from "@nais/ui";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { useForm, type FieldErrors } from "react-hook-form";
import { ENUMS } from "@/generated/contracts";
import { asApiError, fieldErrors } from "@/shared/api/errors";
import { useValidationText } from "@/shared/hooks/use-validation-text";
import { FormErrorSummary } from "@/shared/ui/form-error-summary";
import { ErrorView } from "@/shared/ui/state-views";
import { datasetFormSchema, policyChanged, type DatasetFormValues } from "../schemas";

type Field = keyof DatasetFormValues;

export function DatasetForm({
  mode,
  defaultValues,
  ownerName,
  onSubmit,
  onCancel,
}: {
  mode: "create" | "edit";
  defaultValues: DatasetFormValues;
  ownerName: string;
  onSubmit: (values: DatasetFormValues) => Promise<unknown>;
  onCancel?: () => void;
}) {
  const t = useTranslations();
  const tv = useValidationText();
  const form = useForm<DatasetFormValues>({ resolver: zodResolver(datasetFormSchema), defaultValues });
  const [summary, setSummary] = useState<{ id: string; message: string }[]>([]);
  const [submitError, setSubmitError] = useState<unknown>(null);
  const [pendingPolicy, setPendingPolicy] = useState<DatasetFormValues | null>(null);
  const { errors, isSubmitting } = form.formState;
  const level = form.watch("access_level");
  const maxDays = level === "SENSITIVE" ? 30 : 365;

  useEffect(() => {
    // M10 §7.5: SENSITIVE caps max_grant_days at 30 before the server has to say INVALID_POLICY.
    if (level === "SENSITIVE" && form.getValues("max_grant_days") > 30) form.setValue("max_grant_days", 30, { shouldValidate: true });
  }, [form, level]);

  const labels: Record<Field, string> = {
    title: t("data.form.title"),
    description: t("data.form.description"),
    keywords: t("data.form.keywords"),
    domain: t("data.form.domain"),
    access_level: t("data.form.accessLevel"),
    license: t("data.form.license"),
    usage_policy: t("data.form.usagePolicy"),
    allowed_purposes: t("data.form.allowedPurposes"),
    max_grant_days: t("data.form.maxGrantDays"),
    contact_email: t("data.form.contactEmail"),
    provenance: t("data.form.provenance"),
  };

  const submit = async (values: DatasetFormValues) => {
    setSubmitError(null);
    setSummary([]);
    try {
      await onSubmit(values);
    } catch (e) {
      const err = asApiError(e);
      const fields = fieldErrors(err);
      if (err.code === "VALIDATION_FAILED" && Object.keys(fields).length) {
        for (const [k, m] of Object.entries(fields)) if (k in labels) form.setError(k as Field, { message: m });
        setSummary(Object.entries(fields).map(([k, m]) => ({ id: `dataset-${k}`, message: `${labels[k as Field] ?? k}: ${m}` })));
      } else setSubmitError(err);
    }
  };

  const toSummary = (errs: FieldErrors<DatasetFormValues>) =>
    (Object.keys(errs) as Field[]).map((k) => ({ id: `dataset-${k}`, message: `${labels[k]}: ${tv(errs[k]?.message) ?? ""}` }));

  return (
    <form
      noValidate
      className="flex max-w-3xl flex-col gap-4"
      onSubmit={form.handleSubmit(async (values) => {
        if (mode === "edit" && policyChanged(defaultValues, values)) setPendingPolicy(values);
        else await submit(values);
      }, (errs) => setSummary(toSummary(errs)))}
    >
      <FormErrorSummary errors={summary} />
      {submitError ? <ErrorView error={submitError} /> : null}
      <p className="text-sm">
        <span className="text-muted-foreground">{t("data.form.owner")}: </span>
        <span className="font-medium">{ownerName}</span>
      </p>
      <FormField id="dataset-title" label={labels.title} required requiredLabel={t("common.required")} error={tv(errors.title?.message)}>
        {(a11y) => <Input {...a11y} {...form.register("title")} />}
      </FormField>
      <FormField id="dataset-description" label={labels.description} error={tv(errors.description?.message)}>
        {(a11y) => <Textarea {...a11y} rows={5} {...form.register("description")} />}
      </FormField>
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField id="dataset-keywords" label={labels.keywords} hint={t("projects.form.keywordsHint")} error={tv(errors.keywords?.message)}>
          {(a11y) => <Input {...a11y} {...form.register("keywords")} />}
        </FormField>
        <FormField id="dataset-domain" label={labels.domain} hint={t("data.form.domainHint")} error={tv(errors.domain?.message)}>
          {(a11y) => <Input {...a11y} {...form.register("domain")} />}
        </FormField>
      </div>
      <fieldset id="dataset-access_level" className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-medium">{labels.access_level}</legend>
        {ENUMS.AccessLevel.map((v) => (
          <label key={v} className="flex items-start gap-2">
            <input type="radio" value={v} className="mt-1 h-5 w-5" {...form.register("access_level")} />
            <span>
              <span className="font-medium">{t(`enums.AccessLevel.${v}`)}</span>
              <span className="block text-sm text-muted-foreground">{t(`data.form.accessLevelHelp.${v}`)}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <fieldset id="dataset-allowed_purposes" className="flex flex-col gap-2" aria-describedby={errors.allowed_purposes ? "dataset-allowed_purposes-error" : undefined}>
        <legend className="mb-1 text-sm font-medium">
          {labels.allowed_purposes} <span className="text-muted-foreground">{t("common.required")}</span>
        </legend>
        {ENUMS.Purpose.map((p) => (
          <label key={p} className="flex items-center gap-2">
            <Checkbox value={p} {...form.register("allowed_purposes")} />
            {t(`enums.Purpose.${p}`)}
          </label>
        ))}
        {errors.allowed_purposes ? (
          <p id="dataset-allowed_purposes-error" className="text-sm text-danger">
            {tv(errors.allowed_purposes.message)}
          </p>
        ) : null}
      </fieldset>
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField
          id="dataset-max_grant_days"
          label={labels.max_grant_days}
          required
          requiredLabel={t("common.required")}
          hint={level === "SENSITIVE" ? t("data.form.sensitiveHint") : t("data.form.maxGrantDaysHint")}
          error={tv(errors.max_grant_days?.message)}
        >
          {(a11y) => <Input {...a11y} type="number" min={1} max={maxDays} {...form.register("max_grant_days", { valueAsNumber: true })} />}
        </FormField>
        <FormField id="dataset-license" label={labels.license} required requiredLabel={t("common.required")} hint={t("data.form.licenseHint")} error={tv(errors.license?.message)}>
          {(a11y) => <Input {...a11y} {...form.register("license")} />}
        </FormField>
      </div>
      <FormField id="dataset-usage_policy" label={labels.usage_policy} error={tv(errors.usage_policy?.message)}>
        {(a11y) => <Textarea {...a11y} rows={3} {...form.register("usage_policy")} />}
      </FormField>
      <FormField id="dataset-provenance" label={labels.provenance} hint={t("data.form.provenanceHint")} error={tv(errors.provenance?.message)}>
        {(a11y) => <Textarea {...a11y} rows={3} {...form.register("provenance")} />}
      </FormField>
      <FormField id="dataset-contact_email" label={labels.contact_email} error={tv(errors.contact_email?.message)}>
        {(a11y) => <Input {...a11y} type="email" {...form.register("contact_email")} />}
      </FormField>
      <div className="flex gap-2">
        <Button type="submit" disabled={isSubmitting}>
          {mode === "create" ? t("data.new.submit") : t("common.save")}
        </Button>
        {onCancel ? (
          <Button variant="outline" onClick={onCancel}>
            {t("common.cancel")}
          </Button>
        ) : null}
      </div>
      <ConfirmDialog
        open={!!pendingPolicy}
        onOpenChange={(o) => !o && setPendingPolicy(null)}
        title={t("data.detail.policyChangeTitle")}
        description={t("data.detail.policyChangeWarning")}
        confirmLabel={t("data.detail.policyChangeConfirm")}
        cancelLabel={t("common.cancel")}
        closeLabel={t("common.close")}
        pending={isSubmitting}
        onConfirm={async () => {
          const values = pendingPolicy;
          setPendingPolicy(null);
          if (values) await submit(values);
        }}
      />
    </form>
  );
}
