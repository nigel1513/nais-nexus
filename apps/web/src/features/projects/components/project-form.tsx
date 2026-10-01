"use client";
import { zodResolver } from "@hookform/resolvers/zod";
import { Button, FormField, Input, Textarea } from "@nais/ui";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { useForm, type FieldErrors } from "react-hook-form";
import { asApiError, fieldErrors } from "@/shared/api/errors";
import { useValidationText } from "@/shared/hooks/use-validation-text";
import { FormErrorSummary } from "@/shared/ui/form-error-summary";
import { ErrorView } from "@/shared/ui/state-views";
import { projectFormSchema, type ProjectFormValues } from "../schemas";

type Field = keyof ProjectFormValues;

export function ProjectForm({
  defaultValues,
  submitLabel,
  onSubmit,
  onCancel,
  visibilityLocked = false,
}: {
  defaultValues: ProjectFormValues;
  submitLabel: string;
  onSubmit: (values: ProjectFormValues) => Promise<unknown>;
  onCancel?: () => void;
  /** Only the project OWNER may change visibility. */
  visibilityLocked?: boolean;
}) {
  const t = useTranslations();
  const tv = useValidationText();
  const form = useForm<ProjectFormValues>({ resolver: zodResolver(projectFormSchema), defaultValues });
  const [summary, setSummary] = useState<{ id: string; message: string }[]>([]);
  const [submitError, setSubmitError] = useState<unknown>(null);
  const { errors, isSubmitting } = form.formState;
  const labels: Record<Field, string> = {
    name: t("projects.form.name"),
    description: t("projects.form.description"),
    visibility: t("projects.form.visibility"),
    keywords: t("projects.form.keywords"),
    start_date: t("projects.form.startDate"),
    end_date: t("projects.form.endDate"),
  };
  const toSummary = (errs: FieldErrors<ProjectFormValues>) =>
    (Object.keys(errs) as Field[]).map((k) => ({ id: `project-${k}`, message: `${labels[k]}: ${tv(errs[k]?.message) ?? ""}` }));

  return (
    <form
      noValidate
      className="flex max-w-2xl flex-col gap-4"
      onSubmit={form.handleSubmit(
        async (values) => {
          setSubmitError(null);
          setSummary([]);
          try {
            await onSubmit(values);
          } catch (e) {
            const err = asApiError(e);
            const fields = fieldErrors(err);
            if (err.code === "VALIDATION_FAILED" && Object.keys(fields).length) {
              for (const [k, m] of Object.entries(fields)) if (k in labels) form.setError(k as Field, { message: m });
              setSummary(Object.entries(fields).map(([k, m]) => ({ id: `project-${k}`, message: `${labels[k as Field] ?? k}: ${tv(m)}` })));
            } else setSubmitError(err);
          }
        },
        (errs) => setSummary(toSummary(errs)),
      )}
    >
      <FormErrorSummary errors={summary} />
      {submitError ? <ErrorView error={submitError} /> : null}
      <FormField id="project-name" label={labels.name} required requiredLabel={t("common.required")} error={tv(errors.name?.message)}>
        {(a11y) => <Input {...a11y} autoComplete="off" {...form.register("name")} />}
      </FormField>
      <FormField id="project-description" label={labels.description} hint={t("projects.form.descriptionHint")} error={tv(errors.description?.message)}>
        {(a11y) => <Textarea {...a11y} rows={5} {...form.register("description")} />}
      </FormField>
      <fieldset id="project-visibility" className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-medium">{labels.visibility}</legend>
        {visibilityLocked ? <p className="text-sm text-muted-foreground">{t("projects.form.visibilityOwnerOnly")}</p> : null}
        {(["PRIVATE", "PUBLIC"] as const).map((v) => (
          <label key={v} className="flex items-start gap-2">
            <input type="radio" value={v} disabled={visibilityLocked} className="mt-1 h-5 w-5" {...form.register("visibility")} />
            <span>
              <span className="font-medium">{t(`enums.ProjectVisibility.${v}`)}</span>
              <span className="block text-sm text-muted-foreground">{t(`projects.form.visibilityHelp.${v}`)}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <FormField id="project-keywords" label={labels.keywords} hint={t("projects.form.keywordsHint")} error={tv(errors.keywords?.message)}>
        {(a11y) => <Input {...a11y} {...form.register("keywords")} />}
      </FormField>
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField id="project-start_date" label={labels.start_date} error={tv(errors.start_date?.message)}>
          {(a11y) => <Input {...a11y} type="date" {...form.register("start_date")} />}
        </FormField>
        <FormField id="project-end_date" label={labels.end_date} error={tv(errors.end_date?.message)}>
          {(a11y) => <Input {...a11y} type="date" {...form.register("end_date")} />}
        </FormField>
      </div>
      <div className="flex gap-2">
        <Button variant="primary" type="submit" disabled={isSubmitting}>
          {submitLabel}
        </Button>
        {onCancel ? (
          <Button variant="outline" onClick={onCancel}>
            {t("common.cancel")}
          </Button>
        ) : null}
      </div>
    </form>
  );
}
