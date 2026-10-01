"use client";
import { zodResolver } from "@hookform/resolvers/zod";
import { Button, Checkbox, ConfirmDialog, FormField, Input, Textarea } from "@nais/ui";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { useFieldArray, useForm, type FieldErrors } from "react-hook-form";
import { ENUMS } from "@/generated/contracts";
import { asApiError, fieldErrors } from "@/shared/api/errors";
import { useValidationText } from "@/shared/hooks/use-validation-text";
import { FormErrorSummary } from "@/shared/ui/form-error-summary";
import { ErrorView } from "@/shared/ui/state-views";
import { useListOrganizations } from "@/features/organizations/api";
import { datasetFormSchemaFor, policyChanged, type DatasetFormValues } from "../schemas";
import { ContributorsEditor } from "./contributors-editor";
import { UserPicker, userLabel } from "./user-picker";
import { VocabularyPicker } from "./vocabulary-picker";

type Field = keyof DatasetFormValues;
const CLEARABLE = ["usage_policy"] as const;
/** Server field names that differ from the form's. */
const SERVER_FIELD: Record<string, Field> = { principal_investigator_id: "principal_investigator", data_steward_contact_id: "steward_contact" };

const selectClass = "h-10 rounded-md border border-border bg-background px-2";

export function DatasetForm({
  mode,
  defaultValues,
  ownerName,
  ownerOrganizationId,
  onSubmit,
  onCancel,
}: {
  mode: "create" | "edit";
  defaultValues: DatasetFormValues;
  ownerName: string;
  ownerOrganizationId: string;
  onSubmit: (values: DatasetFormValues) => Promise<unknown>;
  onCancel?: () => void;
}) {
  const t = useTranslations();
  const tv = useValidationText();
  const form = useForm<DatasetFormValues>({ resolver: zodResolver(datasetFormSchemaFor(mode)), defaultValues });
  const publications = useFieldArray({ control: form.control, name: "related_publications" });
  const orgs = useListOrganizations();
  const [summary, setSummary] = useState<{ id: string; message: string }[]>([]);
  const [submitError, setSubmitError] = useState<unknown>(null);
  const [pendingPolicy, setPendingPolicy] = useState<DatasetFormValues | null>(null);
  const { errors, isSubmitting } = form.formState;
  const level = form.watch("access_level");
  const collectingMode = form.watch("collecting_mode");
  const maxDays = level === "SENSITIVE" ? 30 : 365;
  const err = (k: Field) => tv(errors[k]?.message as string | undefined);

  useEffect(() => {
    // M10 §7.5: SENSITIVE caps max_grant_days at 30 before the server has to say INVALID_POLICY.
    if (level === "SENSITIVE" && form.getValues("max_grant_days") > 30) form.setValue("max_grant_days", 30, { shouldValidate: true });
  }, [form, level]);

  const labels: Record<Field, string> = {
    title: t("data.form.title"),
    subtitle: t("data.form.subtitle"),
    description: t("data.form.description"),
    keywords: t("data.form.keywords"),
    principal_investigator: t("data.form.principalInvestigator"),
    steward_contact: t("data.form.stewardContact"),
    contact_email_public: t("data.form.contactEmailPublic"),
    contributors: t("data.form.contributors"),
    project_title: t("data.form.projectTitle"),
    project_code: t("data.form.projectCode"),
    funding_agency: t("data.form.fundingAgency"),
    subject_codes: t("data.form.subjects"),
    method_codes: t("data.form.methods"),
    material_codes: t("data.form.materials"),
    method_detail: t("data.form.methodDetail"),
    temporal_start: t("data.form.temporalStart"),
    temporal_end: t("data.form.temporalEnd"),
    collecting_mode: t("data.form.collectingOrganization"),
    collecting_organization_id: t("data.form.collectingOrganization"),
    collecting_organization_name: t("data.form.collectingExternalName"),
    access_level: t("data.form.accessLevel"),
    license: t("data.form.license"),
    usage_policy: t("data.form.usagePolicy"),
    allowed_purposes: t("data.form.allowedPurposes"),
    max_grant_days: t("data.form.maxGrantDays"),
    update_frequency: t("data.form.updateFrequency"),
    related_publications: t("data.form.relatedPublications"),
  };

  const submit = async (values: DatasetFormValues) => {
    setSubmitError(null);
    setSummary([]);
    try {
      await onSubmit(values);
    } catch (e) {
      const apiErr = asApiError(e);
      const raw = fieldErrors(apiErr);
      if (apiErr.code === "VALIDATION_FAILED" && Object.keys(raw).length) {
        // Backend reason codes (PERSON_NOT_ELIGIBLE, TEMPORAL_RANGE, ...) get localized texts in useValidationText; pydantic-style messages pass through.
        const fields = Object.entries(raw).map(([k, m]) => [SERVER_FIELD[k] ?? (k as Field), m] as const);
        for (const [k, m] of fields) if (k in labels) form.setError(k, { message: m });
        setSummary(fields.map(([k, m]) => ({ id: `dataset-${k}`, message: `${labels[k] ?? k}: ${tv(m)}` })));
      } else setSubmitError(apiErr);
    }
  };

  const toSummary = (errs: FieldErrors<DatasetFormValues>) =>
    (Object.keys(errs) as Field[]).map((k) => ({ id: `dataset-${k}`, message: `${labels[k]}: ${tv((errs[k] as { message?: string } | undefined)?.message) ?? ""}` }));

  return (
    <form
      noValidate
      className="flex max-w-3xl flex-col gap-4"
      onSubmit={form.handleSubmit(async (values) => {
        // The API has no way to clear an optional field (null is rejected), so block it instead of silently keeping the old value.
        if (mode === "edit") {
          const cleared = CLEARABLE.filter((k) => defaultValues[k].trim() && !values[k].trim());
          if (cleared.length) {
            for (const k of cleared) form.setError(k, { message: "validation.notClearable" });
            setSummary(cleared.map((k) => ({ id: `dataset-${k}`, message: `${labels[k]}: ${tv("validation.notClearable")}` })));
            return;
          }
        }
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

      <fieldset className="flex flex-col gap-4">
        <legend className="mb-2 text-base font-semibold">{t("data.form.sectionBasic")}</legend>
        <FormField id="dataset-title" label={labels.title} required requiredLabel={t("common.required")} error={err("title")}>
          {(a11y) => <Input {...a11y} {...form.register("title")} />}
        </FormField>
        <FormField id="dataset-subtitle" label={labels.subtitle} error={err("subtitle")}>
          {(a11y) => <Input {...a11y} {...form.register("subtitle")} />}
        </FormField>
        <FormField id="dataset-description" label={labels.description} hint={t("data.form.descriptionHint")} error={err("description")}>
          {(a11y) => <Textarea {...a11y} rows={5} {...form.register("description")} />}
        </FormField>
        <FormField id="dataset-keywords" label={labels.keywords} hint={t("projects.form.keywordsHint")} error={err("keywords")}>
          {(a11y) => <Input {...a11y} {...form.register("keywords")} />}
        </FormField>
      </fieldset>

      <fieldset className="flex flex-col gap-4">
        <legend className="mb-2 text-base font-semibold">{t("data.form.sectionPeople")}</legend>
        <p className="text-xs text-muted-foreground">{t("data.form.peopleHint")}</p>
        <div className="grid gap-4 sm:grid-cols-2">
          <UserPicker
            id="dataset-principal_investigator"
            label={labels.principal_investigator}
            organizationId={ownerOrganizationId}
            required
            initialText={defaultValues.principal_investigator?.label}
            error={err("principal_investigator")}
            onChange={(u) => form.setValue("principal_investigator", u ? { user_id: u.user_id, label: userLabel(u) } : null, { shouldValidate: form.formState.isSubmitted })}
          />
          <UserPicker
            id="dataset-steward_contact"
            label={labels.steward_contact}
            organizationId={ownerOrganizationId}
            required
            initialText={defaultValues.steward_contact?.label}
            error={err("steward_contact")}
            onChange={(u) => form.setValue("steward_contact", u ? { user_id: u.user_id, label: userLabel(u) } : null, { shouldValidate: form.formState.isSubmitted })}
          />
        </div>
        <label className="flex items-start gap-2">
          <Checkbox id="dataset-contact_email_public" {...form.register("contact_email_public")} />
          <span>
            {labels.contact_email_public}
            <span className="block text-xs text-muted-foreground">{t("data.form.contactEmailPublicHint")}</span>
          </span>
        </label>
        <div className="flex flex-col gap-1">
          <p className="text-sm font-medium">{labels.contributors}</p>
          <ContributorsEditor id="dataset-contributors" value={form.watch("contributors")} onChange={(v) => form.setValue("contributors", v, { shouldValidate: form.formState.isSubmitted })} error={err("contributors")} />
        </div>
      </fieldset>

      <fieldset className="flex flex-col gap-4">
        <legend className="mb-2 text-base font-semibold">{t("data.form.sectionContext")}</legend>
        <FormField id="dataset-project_title" label={labels.project_title} error={err("project_title")}>
          {(a11y) => <Input {...a11y} {...form.register("project_title")} />}
        </FormField>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField id="dataset-project_code" label={labels.project_code} error={err("project_code")}>
            {(a11y) => <Input {...a11y} {...form.register("project_code")} />}
          </FormField>
          <FormField id="dataset-funding_agency" label={labels.funding_agency} error={err("funding_agency")}>
            {(a11y) => <Input {...a11y} {...form.register("funding_agency")} />}
          </FormField>
        </div>
      </fieldset>

      <fieldset className="flex flex-col gap-4">
        <legend className="mb-2 text-base font-semibold">{t("data.form.sectionData")}</legend>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField id="dataset-temporal_start" label={labels.temporal_start} error={err("temporal_start")}>
            {(a11y) => <Input {...a11y} type="date" {...form.register("temporal_start")} />}
          </FormField>
          <FormField id="dataset-temporal_end" label={labels.temporal_end} error={err("temporal_end")}>
            {(a11y) => <Input {...a11y} type="date" {...form.register("temporal_end")} />}
          </FormField>
        </div>
        <fieldset id="dataset-collecting_mode" className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-medium">{labels.collecting_mode}</legend>
          {(["council", "external", "none"] as const).map((m) => (
            <label key={m} className="flex items-center gap-2">
              <input type="radio" value={m} className="h-5 w-5" {...form.register("collecting_mode")} />
              {t(`data.form.collecting${m === "council" ? "Council" : m === "external" ? "External" : "None"}`)}
            </label>
          ))}
          {collectingMode === "council" ? (
            <FormField id="dataset-collecting_organization_id" label={t("data.form.collectingCouncilSelect")} error={err("collecting_organization_id")}>
              {(a11y) => (
                <select {...a11y} className={selectClass} {...form.register("collecting_organization_id")}>
                  <option value="">{t("data.form.selectPlaceholder")}</option>
                  {(orgs.data?.items ?? []).map((o) => (
                    <option key={o.organization_id} value={o.organization_id}>
                      {o.name}
                    </option>
                  ))}
                </select>
              )}
            </FormField>
          ) : null}
          {collectingMode === "external" ? (
            <FormField id="dataset-collecting_organization_name" label={labels.collecting_organization_name} error={err("collecting_organization_name")}>
              {(a11y) => <Input {...a11y} {...form.register("collecting_organization_name")} />}
            </FormField>
          ) : null}
        </fieldset>
        <VocabularyPicker
          id="dataset-method_codes"
          scheme="METHOD"
          legend={labels.method_codes}
          max={10}
          value={form.watch("method_codes")}
          onChange={(v) => form.setValue("method_codes", v, { shouldValidate: form.formState.isSubmitted })}
          error={err("method_codes")}
        />
        <FormField id="dataset-method_detail" label={labels.method_detail} error={err("method_detail")}>
          {(a11y) => <Textarea {...a11y} rows={3} {...form.register("method_detail")} />}
        </FormField>
        <VocabularyPicker
          id="dataset-material_codes"
          scheme="MATERIAL"
          legend={labels.material_codes}
          max={20}
          value={form.watch("material_codes")}
          onChange={(v) => form.setValue("material_codes", v, { shouldValidate: form.formState.isSubmitted })}
          error={err("material_codes")}
        />
        <VocabularyPicker
          id="dataset-subject_codes"
          scheme="SUBJECT"
          legend={labels.subject_codes}
          max={5}
          value={form.watch("subject_codes")}
          onChange={(v) => form.setValue("subject_codes", v, { shouldValidate: form.formState.isSubmitted })}
          error={err("subject_codes")}
        />
      </fieldset>

      <fieldset className="flex flex-col gap-4">
        <legend className="mb-2 text-base font-semibold">{t("data.form.sectionUsage")}</legend>
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
              {err("allowed_purposes")}
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
            error={err("max_grant_days")}
          >
            {(a11y) => <Input {...a11y} type="number" min={1} max={maxDays} {...form.register("max_grant_days", { valueAsNumber: true })} />}
          </FormField>
          <FormField id="dataset-license" label={labels.license} required requiredLabel={t("common.required")} hint={t("data.form.licenseHint")} error={err("license")}>
            {(a11y) => <Input {...a11y} {...form.register("license")} />}
          </FormField>
        </div>
        <FormField id="dataset-usage_policy" label={labels.usage_policy} error={err("usage_policy")}>
          {(a11y) => <Textarea {...a11y} rows={3} {...form.register("usage_policy")} />}
        </FormField>
        <FormField id="dataset-update_frequency" label={labels.update_frequency} error={err("update_frequency")}>
          {(a11y) => (
            <select {...a11y} className={selectClass} {...form.register("update_frequency")}>
              {/* The contract cannot clear an existing frequency (not nullable on update). */}
              {defaultValues.update_frequency ? null : <option value="">{t("data.form.selectPlaceholder")}</option>}
              {ENUMS.UpdateFrequency.map((f) => (
                <option key={f} value={f}>
                  {t(`enums.UpdateFrequency.${f}`)}
                </option>
              ))}
            </select>
          )}
        </FormField>
        <fieldset id="dataset-related_publications" className="flex flex-col gap-3">
          <legend className="mb-1 text-sm font-medium">{labels.related_publications}</legend>
          {publications.fields.map((f, i) => {
            const rowErr = errors.related_publications?.[i];
            return (
              <div key={f.id} className="grid gap-2 rounded-md border border-border p-3 sm:grid-cols-3">
                <FormField id={`dataset-pub-${i}-title`} label={t("data.form.publicationTitle")} required requiredLabel={t("common.required")} error={tv(rowErr?.title?.message)}>
                  {(a11y) => <Input {...a11y} {...form.register(`related_publications.${i}.title`)} />}
                </FormField>
                <FormField id={`dataset-pub-${i}-doi`} label={t("data.form.publicationDoi")} error={tv(rowErr?.doi?.message)}>
                  {(a11y) => <Input {...a11y} {...form.register(`related_publications.${i}.doi`)} />}
                </FormField>
                <FormField id={`dataset-pub-${i}-url`} label={t("data.form.publicationUrl")} error={tv(rowErr?.url?.message)}>
                  {(a11y) => <Input {...a11y} {...form.register(`related_publications.${i}.url`)} />}
                </FormField>
                <Button variant="outline" size="sm" className="sm:col-span-3 sm:justify-self-start" onClick={() => publications.remove(i)}>
                  {t("data.form.publicationRemove")}
                </Button>
              </div>
            );
          })}
          {typeof errors.related_publications?.message === "string" ? <p className="text-sm text-danger">{tv(errors.related_publications.message)}</p> : null}
          <Button variant="outline" className="self-start" disabled={publications.fields.length >= 20} onClick={() => publications.append({ title: "", doi: "", url: "" })}>
            {t("data.form.publicationAdd")}
          </Button>
        </fieldset>
      </fieldset>
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
