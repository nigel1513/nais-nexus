"use client";
import { zodResolver } from "@hookform/resolvers/zod";
import { Button, FormField, Input, Radio, RadioGroup, Textarea, cn } from "@nais/ui";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { Controller, useForm, useWatch, type FieldErrors } from "react-hook-form";
import { asApiError, fieldErrors } from "@/shared/api/errors";
import { useValidationText } from "@/shared/hooks/use-validation-text";
import { DateRangePicker } from "@/shared/ui/date-range-picker";
import { FormErrorSummary } from "@/shared/ui/form-error-summary";
import { FormSection } from "@/shared/ui/form-section";
import { ErrorView } from "@/shared/ui/state-views";
import { projectFormSchema, type ProjectFormValues } from "../schemas";

type Field = keyof ProjectFormValues;

/** Project create/edit on the form template (spec §5): titled sections, sticky action bar, error summary on top. */
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
  const [start, end] = useWatch({ control: form.control, name: ["start_date", "end_date"] });
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
      className="@container/form flex max-w-[52rem] flex-col"
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
      {summary.length || submitError ? (
        <div className="mb-6 flex flex-col gap-3">
          <FormErrorSummary errors={summary} />
          {submitError ? <ErrorView error={submitError} /> : null}
        </div>
      ) : null}

      <FormSection id="project-section-basic" title={t("projects.form.sectionBasic")} description={t("projects.form.sectionBasicHint")}>
        <FormField id="project-name" label={labels.name} required requiredLabel={t("common.required")} error={tv(errors.name?.message)}>
          {(a11y) => <Input {...a11y} autoComplete="off" {...form.register("name")} />}
        </FormField>
        <FormField id="project-description" label={labels.description} hint={t("projects.form.descriptionHint")} error={tv(errors.description?.message)}>
          {(a11y) => <Textarea {...a11y} rows={5} {...form.register("description")} />}
        </FormField>
        <FormField id="project-keywords" label={labels.keywords} hint={t("projects.form.keywordsHint")} error={tv(errors.keywords?.message)}>
          {(a11y) => <Input {...a11y} {...form.register("keywords")} />}
        </FormField>
      </FormSection>

      <FormSection
        id="project-section-visibility"
        title={labels.visibility}
        description={visibilityLocked ? t("projects.form.visibilityOwnerOnly") : t("projects.form.sectionVisibilityHint")}
      >
        <div id="project-visibility">
          <Controller
            control={form.control}
            name="visibility"
            render={({ field }) => (
              <RadioGroup aria-label={labels.visibility} value={field.value} onValueChange={field.onChange} disabled={visibilityLocked} className="grid grid-cols-1 gap-2 @lg/form:grid-cols-2">
                {(["PRIVATE", "PUBLIC"] as const).map((v) => (
                  <Radio
                    key={v}
                    value={v}
                    disabled={visibilityLocked}
                    className={cn(
                      "items-start rounded-md border border-border bg-bg-panel p-3 [&>[role=radio]]:mt-0.5",
                      "[&>[role=radio][data-checked]]:border-accent [&>[role=radio][data-checked]]:bg-accent",
                      "has-[[data-checked]]:border-accent has-[[data-checked]]:bg-accent-soft has-[[data-disabled]]:opacity-70",
                    )}
                    label={
                      <span className="flex min-w-0 flex-col gap-0.5">
                        <span className="text-body font-medium text-fg">{t(`enums.ProjectVisibility.${v}`)}</span>
                        <span className="break-keep text-small text-fg-muted">{t(`projects.form.visibilityHelp.${v}`)}</span>
                      </span>
                    }
                  />
                ))}
              </RadioGroup>
            )}
          />
        </div>
      </FormSection>

      <FormSection id="project-section-period" title={t("projects.detail.period")} description={t("projects.form.sectionPeriodHint")}>
        <div className="max-w-md">
          <DateRangePicker
            id="project-period"
            startId="project-start_date"
            endId="project-end_date"
            label={t("projects.detail.period")}
            startLabel={labels.start_date}
            endLabel={labels.end_date}
            start={start}
            end={end}
            startProps={form.register("start_date")}
            endProps={form.register("end_date")}
            startError={tv(errors.start_date?.message)}
            endError={tv(errors.end_date?.message)}
            onPick={(s, e) => {
              const opts = { shouldValidate: form.formState.isSubmitted, shouldDirty: true };
              form.setValue("start_date", s, opts);
              form.setValue("end_date", e, opts);
            }}
          />
        </div>
      </FormSection>

      <div className="sticky bottom-0 z-[var(--z-sticky)] flex items-center justify-end gap-2 border-t border-border bg-bg py-3">
        {onCancel ? (
          <Button variant="ghost" onClick={onCancel}>
            {t("common.cancel")}
          </Button>
        ) : null}
        <Button variant="primary" type="submit" disabled={isSubmitting}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}
