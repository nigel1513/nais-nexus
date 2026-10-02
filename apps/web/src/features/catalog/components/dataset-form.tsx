"use client";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  Button, Checkbox, ConfirmDialog, FormField, IconButton, Input, Label, Radio, RadioGroup, SegmentedControl, SelectMenu, Tag, Textarea, cn,
} from "@nais/ui";
import { CircleAlert, Plus, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState, type ComponentProps } from "react";
import { Controller, useFieldArray, useForm, useWatch, type Control, type FieldErrors } from "react-hook-form";
import { ENUMS } from "@/generated/contracts";
import { asApiError, fieldErrors } from "@/shared/api/errors";
import type { IdentityPublicProfile } from "@/shared/api/types";
import { useValidationText } from "@/shared/hooks/use-validation-text";
import { AccessLevelBadge } from "@/shared/ui/badges";
import { DateRangePicker } from "@/shared/ui/date-range-picker";
import { FormSection } from "@/shared/ui/form-section";
import { FormErrorSummary } from "@/shared/ui/form-error-summary";
import { ErrorView } from "@/shared/ui/state-views";
import { useListOrganizations } from "@/features/organizations/api";
import { datasetFormSchemaFor, policyChanged, type DatasetFormValues } from "../schemas";
import { ContributorsEditor } from "./contributors-editor";
import { Markdown } from "./markdown";
import { UserPicker, userLabel } from "./user-picker";
import { VocabularyPicker } from "./vocabulary-picker";

type Field = keyof DatasetFormValues;
const CLEARABLE = ["usage_policy"] as const;
/** Server field names that differ from the form's. */
const SERVER_FIELD: Record<string, Field> = { principal_investigator_id: "principal_investigator", data_steward_contact_id: "steward_contact" };

function FieldError({ id, message }: { id: string; message?: string }) {
  if (!message) return null;
  return (
    <p id={id} className="flex items-start gap-1.5 text-small text-danger">
      <CircleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" strokeWidth={2} />
      {message}
    </p>
  );
}

function SubtitleCount({ control }: { control: Control<DatasetFormValues> }) {
  const subtitle = useWatch({ control, name: "subtitle" });
  return <span className={cn("num block text-right", subtitle.length > 160 && "font-medium text-danger")}>{`${subtitle.length} / 160`}</span>;
}

function DescriptionPreview({ control, emptyText }: { control: Control<DatasetFormValues>; emptyText: string }) {
  const description = useWatch({ control, name: "description" });
  return (
    <div className="min-h-24 rounded-sm border border-border bg-bg-subtle px-3 py-2">
      {description.trim() ? <Markdown source={description} /> : <p className="text-small text-fg-muted">{emptyText}</p>}
    </div>
  );
}

function PeriodField({ control, ...props }: Omit<ComponentProps<typeof DateRangePicker>, "start" | "end"> & { control: Control<DatasetFormValues> }) {
  const [start, end] = useWatch({ control, name: ["temporal_start", "temporal_end"] });
  return <DateRangePicker start={start} end={end} {...props} />;
}

/** Right rail of the register page (canvas A1): how the data card will read, plus two short notes. */
function CardPreview({ control }: { control: Control<DatasetFormValues> }) {
  const t = useTranslations();
  const [title, subtitle, level, license] = useWatch({ control, name: ["title", "subtitle", "access_level", "license"] });
  return (
    <aside aria-label={t("data.form.previewTitle")} className="hidden min-[1360px]:block">
      <div className="sticky top-18 flex flex-col gap-4">
        <section className="flex flex-col gap-2 rounded-md border border-border bg-bg-panel p-4">
          <h2 className="text-caption text-fg-muted">{t("data.form.previewTitle")}</h2>
          <p className={cn("break-words text-heading", title.trim() ? "text-fg" : "text-fg-muted")}>{title.trim() || t("data.form.previewUntitled")}</p>
          {subtitle.trim() ? <p className="break-words text-small text-fg-muted">{subtitle}</p> : null}
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <AccessLevelBadge level={level} />
            {license.trim() ? <Tag>{license.trim()}</Tag> : null}
          </div>
        </section>
        <section className="flex flex-col gap-2 break-keep rounded-md border border-border bg-bg-subtle p-4 text-small text-fg-muted">
          <h2 className="text-small font-semibold text-fg">{t("data.form.guideTitle")}</h2>
          <p>{t("data.form.guideAccess")}</p>
          <p>{t("data.form.guideNext")}</p>
        </section>
      </div>
    </aside>
  );
}

export function DatasetForm({
  mode,
  defaultValues,
  ownerName,
  ownerOrganizationId,
  onSubmit,
  onCancel,
  layout = "page",
  onDirtyChange,
}: {
  mode: "create" | "edit";
  defaultValues: DatasetFormValues;
  ownerName: string;
  ownerOrganizationId: string;
  onSubmit: (values: DatasetFormValues) => Promise<unknown>;
  onCancel?: () => void;
  /** "page": sections + preview rail + action bar pinned to the viewport bottom. "sheet": single column, bar pinned to the sheet bottom. */
  layout?: "page" | "sheet";
  /** Reports unsaved changes (the edit sheet asks before discarding them). */
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const t = useTranslations();
  const tv = useValidationText();
  const form = useForm<DatasetFormValues>({ resolver: zodResolver(datasetFormSchemaFor(mode)), defaultValues });
  const publications = useFieldArray({ control: form.control, name: "related_publications" });
  const orgs = useListOrganizations();
  const [summary, setSummary] = useState<{ id: string; message: string }[]>([]);
  const [submitError, setSubmitError] = useState<unknown>(null);
  const [pendingPolicy, setPendingPolicy] = useState<DatasetFormValues | null>(null);
  const [descriptionView, setDescriptionView] = useState<"write" | "preview">("write");
  const { errors, isSubmitting, isDirty } = form.formState;
  // Latest props/picks, read from async handlers whose closures predate the re-render a successful PATCH causes.
  const defaultsRef = useRef(defaultValues);
  defaultsRef.current = defaultValues;
  const lastPerson = useRef({ principal_investigator: defaultValues.principal_investigator, steward_contact: defaultValues.steward_contact });
  const personProps = (field: "principal_investigator" | "steward_contact") => ({
    onChange: (u: IdentityPublicProfile | null) => {
      const value = u ? { user_id: u.user_id, label: userLabel(u), ntis: u.national_researcher_number ?? null } : null;
      if (value) lastPerson.current[field] = value;
      form.setValue(field, value, { shouldValidate: form.formState.isSubmitted, shouldDirty: true });
    },
    // Edit only: typed-over text without a pick goes back to the current person.
    onRevert:
      mode === "edit"
        ? () => {
            const p = lastPerson.current[field];
            if (!p) return null;
            form.setValue(field, p, { shouldValidate: form.formState.isSubmitted, shouldDirty: true });
            return p.label;
          }
        : undefined,
  });
  // useWatch per field: typing in a text field re-renders only the small parts that show it, not the whole form.
  const level = useWatch({ control: form.control, name: "access_level" });
  const collectingMode = useWatch({ control: form.control, name: "collecting_mode" });
  const [contributors, subjectCodes, methodCodes, materialCodes] = useWatch({ control: form.control, name: ["contributors", "subject_codes", "method_codes", "material_codes"] });
  const maxDays = level === "SENSITIVE" ? 30 : 365;
  const err = (k: Field) => tv(errors[k]?.message as string | undefined);
  const setList =
    <K extends "subject_codes" | "method_codes" | "material_codes" | "contributors">(k: K) =>
    (v: DatasetFormValues[K]) =>
      form.setValue(k, v as never, { shouldValidate: form.formState.isSubmitted, shouldDirty: true });

  useEffect(() => {
    onDirtyChange?.(isDirty);
  }, [isDirty, onDirtyChange]);

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
    const startKey = JSON.stringify(defaultValues);
    try {
      await onSubmit(values);
    } catch (e) {
      // PATCH succeeded but a later step failed: the dataset (our defaults) moved on, so rebase the form on it and keep only what is still unsaved (contributors).
      if (mode === "edit" && JSON.stringify(defaultsRef.current) !== startKey) form.reset({ ...defaultsRef.current, contributors: form.getValues("contributors") });
      const apiErr = asApiError(e);
      const raw = fieldErrors(apiErr);
      if (apiErr.code === "VALIDATION_FAILED" && Object.keys(raw).length) {
        // Backend reason codes (PERSON_NOT_ELIGIBLE, TEMPORAL_RANGE, ...) get localized texts in useValidationText; pydantic-style messages pass through.
        const fields = Object.entries(raw).map(([k, m]) => [SERVER_FIELD[k] ?? (k.startsWith("contributors") ? "contributors" : (k as Field)), m] as const);
        for (const [k, m] of fields) if (k in labels) form.setError(k, { message: m });
        setSummary(fields.map(([k, m]) => ({ id: `dataset-${k}`, message: `${labels[k] ?? k}: ${tv(m)}` })));
      } else setSubmitError(apiErr);
    }
  };

  const toSummary = (errs: FieldErrors<DatasetFormValues>) =>
    (Object.keys(errs) as Field[]).map((k) => ({ id: `dataset-${k}`, message: `${labels[k]}: ${tv((errs[k] as { message?: string } | undefined)?.message) ?? ""}` }));

  const sheet = layout === "sheet";
  const purposesError = err("allowed_purposes");

  const fields = (
    <>
      <FormSection id="dataset-section-basic" title={t("data.form.sectionBasic")} description={t("data.form.sectionBasicHint")}>
        <FormField id="dataset-title" label={labels.title} required requiredLabel={t("common.required")} hint={t("data.form.titleHint")} error={err("title")}>
          {(a11y) => <Input {...a11y} {...form.register("title")} />}
        </FormField>
        <FormField
          id="dataset-subtitle"
          label={labels.subtitle}
          hint={<SubtitleCount control={form.control} />}
          error={err("subtitle")}
        >
          {(a11y) => <Input {...a11y} {...form.register("subtitle")} />}
        </FormField>
        <div className="flex flex-col gap-1.5">
          <div className="flex items-end justify-between gap-2">
            <Label htmlFor="dataset-description">{labels.description}</Label>
            <SegmentedControl
              aria-label={t("data.form.descriptionView")}
              value={descriptionView}
              onValueChange={(v) => setDescriptionView(v as "write" | "preview")}
              items={[
                { value: "write", label: t("data.form.descriptionWrite") },
                { value: "preview", label: t("data.form.descriptionPreview") },
              ]}
            />
          </div>
          <Textarea
            id="dataset-description"
            rows={8}
            aria-describedby={errors.description ? "dataset-description-error dataset-description-hint" : "dataset-description-hint"}
            aria-invalid={errors.description ? true : undefined}
            className={cn(descriptionView === "preview" && "hidden")}
            {...form.register("description")}
          />
          {descriptionView === "preview" ? <DescriptionPreview control={form.control} emptyText={t("data.form.descriptionEmpty")} /> : null}
          <p id="dataset-description-hint" className="text-small text-fg-muted">
            {t("data.form.descriptionHint")}
          </p>
          <FieldError id="dataset-description-error" message={err("description")} />
        </div>
      </FormSection>

      <FormSection id="dataset-section-people" title={t("data.form.sectionPeople")} description={t("data.form.peopleHint")}>
        <div className="grid grid-cols-1 gap-4 @xl/form:grid-cols-2">
          <UserPicker
            id="dataset-principal_investigator"
            label={labels.principal_investigator}
            organizationId={ownerOrganizationId}
            required
            chip
            initialPerson={defaultValues.principal_investigator}
            error={err("principal_investigator")}
            footer={<span className="break-keep">{t("data.form.ownerMembersOnly", { org: ownerName })}</span>}
            {...personProps("principal_investigator")}
          />
          <div className="flex flex-col gap-2">
            <UserPicker
              id="dataset-steward_contact"
              label={labels.steward_contact}
              organizationId={ownerOrganizationId}
              required
              chip
              initialPerson={defaultValues.steward_contact}
              error={err("steward_contact")}
              footer={<span className="break-keep">{t("data.form.ownerMembersOnly", { org: ownerName })}</span>}
              {...personProps("steward_contact")}
            />
            <label className="flex cursor-pointer items-start gap-2 text-small text-fg">
              <Checkbox id="dataset-contact_email_public" className="mt-0.5" {...form.register("contact_email_public")} />
              <span>
                {labels.contact_email_public}
                <span className="block text-fg-muted">{t("data.form.contactEmailPublicHint")}</span>
              </span>
            </label>
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="text-small font-medium text-fg">{labels.contributors}</span>
          <ContributorsEditor id="dataset-contributors" value={contributors} onChange={setList("contributors")} error={err("contributors")} />
        </div>
      </FormSection>

      <FormSection id="dataset-section-context" title={t("data.form.sectionContext")} description={t("data.form.sectionContextHint")}>
        <FormField id="dataset-project_title" label={labels.project_title} error={err("project_title")}>
          {(a11y) => <Input {...a11y} {...form.register("project_title")} />}
        </FormField>
        <div className="grid grid-cols-1 gap-4 @xl/form:grid-cols-2">
          <FormField id="dataset-project_code" label={labels.project_code} error={err("project_code")}>
            {(a11y) => <Input {...a11y} className="font-mono text-mono" {...form.register("project_code")} />}
          </FormField>
          <FormField id="dataset-funding_agency" label={labels.funding_agency} error={err("funding_agency")}>
            {(a11y) => <Input {...a11y} {...form.register("funding_agency")} />}
          </FormField>
        </div>
      </FormSection>

      <FormSection id="dataset-section-data" title={t("data.form.sectionData")} description={t("data.form.sectionDataHint")}>
        <div className="grid grid-cols-1 gap-4 @xl/form:grid-cols-[minmax(0,1fr)_12rem]">
          <PeriodField
            control={form.control}
            id="dataset-temporal"
            startId="dataset-temporal_start"
            endId="dataset-temporal_end"
            label={t("data.form.period")}
            startLabel={labels.temporal_start}
            endLabel={labels.temporal_end}
            startProps={form.register("temporal_start")}
            endProps={form.register("temporal_end")}
            startError={err("temporal_start")}
            endError={err("temporal_end")}
            onPick={(s, e) => {
              const opts = { shouldValidate: form.formState.isSubmitted, shouldDirty: true };
              form.setValue("temporal_start", s, opts);
              form.setValue("temporal_end", e, opts);
            }}
          />
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="dataset-update_frequency">{labels.update_frequency}</Label>
            <Controller
              control={form.control}
              name="update_frequency"
              render={({ field }) => (
                <SelectMenu
                  id="dataset-update_frequency"
                  value={field.value || null}
                  onValueChange={(v) => field.onChange(v ?? "")}
                  placeholder={<span className="text-fg-muted">{t("data.form.selectPlaceholder")}</span>}
                  options={ENUMS.UpdateFrequency.map((f) => ({ value: f, label: t(`enums.UpdateFrequency.${f}`) }))}
                />
              )}
            />
            <FieldError id="dataset-update_frequency-error" message={err("update_frequency")} />
          </div>
        </div>
        <div id="dataset-collecting_mode" className="flex flex-col gap-2">
          <span id="dataset-collecting_mode-label" className="text-small font-medium text-fg">
            {labels.collecting_mode}
          </span>
          <Controller
            control={form.control}
            name="collecting_mode"
            render={({ field }) => (
              <RadioGroup orientation="horizontal" aria-labelledby="dataset-collecting_mode-label" value={field.value} onValueChange={field.onChange}>
                {(["none", "council", "external"] as const).map((m) => (
                  <Radio key={m} value={m} label={t(`data.form.collecting${m === "council" ? "Council" : m === "external" ? "External" : "None"}`)} />
                ))}
              </RadioGroup>
            )}
          />
          {collectingMode === "council" ? (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="dataset-collecting_organization_id" className="sr-only">
                {t("data.form.collectingCouncilSelect")}
              </Label>
              <Controller
                control={form.control}
                name="collecting_organization_id"
                render={({ field }) => (
                  <SelectMenu
                    id="dataset-collecting_organization_id"
                    value={field.value || null}
                    onValueChange={(v) => field.onChange(v ?? "")}
                    placeholder={<span className="text-fg-muted">{t("data.form.collectingCouncilSelect")}</span>}
                    aria-invalid={errors.collecting_organization_id ? true : undefined}
                    aria-describedby={errors.collecting_organization_id ? "dataset-collecting_organization_id-error" : undefined}
                    options={(orgs.data?.items ?? []).map((o) => ({ value: o.organization_id, label: o.name }))}
                  />
                )}
              />
              <FieldError id="dataset-collecting_organization_id-error" message={err("collecting_organization_id")} />
            </div>
          ) : null}
          {collectingMode === "external" ? (
            <FormField id="dataset-collecting_organization_name" label={labels.collecting_organization_name} error={err("collecting_organization_name")}>
              {(a11y) => <Input {...a11y} {...form.register("collecting_organization_name")} />}
            </FormField>
          ) : null}
        </div>
        <FormField id="dataset-method_detail" label={labels.method_detail} hint={t("data.form.methodDetailHint")} error={err("method_detail")}>
          {(a11y) => <Textarea {...a11y} rows={3} {...form.register("method_detail")} />}
        </FormField>
      </FormSection>

      <FormSection id="dataset-section-classify" title={t("data.form.sectionClassify")} description={t("data.form.sectionClassifyHint")}>
        <VocabularyPicker id="dataset-subject_codes" scheme="SUBJECT" legend={labels.subject_codes} max={5} value={subjectCodes} onChange={setList("subject_codes")} error={err("subject_codes")} />
        <VocabularyPicker id="dataset-method_codes" scheme="METHOD" legend={labels.method_codes} max={10} value={methodCodes} onChange={setList("method_codes")} error={err("method_codes")} />
        <VocabularyPicker id="dataset-material_codes" scheme="MATERIAL" legend={labels.material_codes} max={20} value={materialCodes} onChange={setList("material_codes")} error={err("material_codes")} />
        <FormField id="dataset-keywords" label={labels.keywords} hint={t("projects.form.keywordsHint")} error={err("keywords")}>
          {(a11y) => <Input {...a11y} {...form.register("keywords")} />}
        </FormField>
      </FormSection>

      <FormSection id="dataset-section-terms" title={t("data.form.sectionTerms")} description={mode === "edit" ? t("data.form.sectionTermsEditHint") : t("data.form.sectionTermsHint")}>
        <div id="dataset-access_level" className="flex flex-col gap-2">
          <span id="dataset-access_level-label" className="text-small font-medium text-fg">
            {labels.access_level}
          </span>
          <Controller
            control={form.control}
            name="access_level"
            render={({ field }) => (
              <RadioGroup aria-labelledby="dataset-access_level-label" value={field.value} onValueChange={field.onChange} className="grid grid-cols-1 gap-2 @lg/form:grid-cols-2">
                {ENUMS.AccessLevel.map((v) => (
                  <Radio
                    key={v}
                    value={v}
                    className={cn(
                      "items-start rounded-md border border-border bg-bg-panel p-3 [&>[role=radio]]:mt-0.5",
                      "[&>[role=radio][data-checked]]:border-accent [&>[role=radio][data-checked]]:bg-accent",
                      "hover:border-border-strong has-[[data-checked]]:border-accent has-[[data-checked]]:bg-accent-soft",
                    )}
                    label={
                      <span className="flex min-w-0 flex-col gap-0.5">
                        <span className="text-body font-medium">{t(`enums.AccessLevel.${v}`)}</span>
                        <span className="break-keep text-small text-fg-muted">{t(`data.form.accessLevelHelp.${v}`)}</span>
                      </span>
                    }
                  />
                ))}
              </RadioGroup>
            )}
          />
        </div>
        <div id="dataset-allowed_purposes" role="group" aria-labelledby="dataset-allowed_purposes-label" aria-describedby={purposesError ? "dataset-allowed_purposes-error" : undefined} className="flex flex-col gap-2">
          <span id="dataset-allowed_purposes-label" className="text-small font-medium text-fg">
            {labels.allowed_purposes} <span className="font-normal text-fg-muted">{t("common.required")}</span>
          </span>
          <div className="flex flex-wrap gap-2">
            {ENUMS.Purpose.map((p) => (
              <label
                key={p}
                className={cn(
                  "press flex h-8 cursor-pointer select-none items-center gap-2 rounded-sm border border-border bg-bg-panel px-2.5 text-small text-fg",
                  "hover:border-border-strong has-[:checked]:border-accent has-[:checked]:bg-accent-soft",
                )}
              >
                <Checkbox value={p} aria-invalid={purposesError ? true : undefined} {...form.register("allowed_purposes")} />
                {t(`enums.Purpose.${p}`)}
              </label>
            ))}
          </div>
          <FieldError id="dataset-allowed_purposes-error" message={purposesError} />
        </div>
        <div className="grid grid-cols-1 gap-4 @xl/form:grid-cols-[10rem_minmax(0,1fr)]">
          <FormField
            id="dataset-max_grant_days"
            label={labels.max_grant_days}
            required
            requiredLabel={t("common.required")}
            hint={level === "SENSITIVE" ? t("data.form.sensitiveHint") : t("data.form.maxGrantDaysHint")}
            error={err("max_grant_days")}
          >
            {(a11y) => <Input {...a11y} type="number" min={1} max={maxDays} className="num" {...form.register("max_grant_days", { valueAsNumber: true })} />}
          </FormField>
          <FormField id="dataset-license" label={labels.license} required requiredLabel={t("common.required")} hint={t("data.form.licenseHint")} error={err("license")}>
            {(a11y) => <Input {...a11y} {...form.register("license")} />}
          </FormField>
        </div>
        <FormField id="dataset-usage_policy" label={labels.usage_policy} hint={t("data.form.usagePolicyHint")} error={err("usage_policy")}>
          {(a11y) => <Textarea {...a11y} rows={3} {...form.register("usage_policy")} />}
        </FormField>
      </FormSection>

      <FormSection id="dataset-section-publications" title={t("data.form.relatedPublications")} description={t("data.form.sectionPublicationsHint")}>
        <div id="dataset-related_publications" className="flex flex-col gap-2">
          {publications.fields.length ? (
            <ul aria-label={labels.related_publications} className="overflow-hidden rounded-md border border-border bg-bg-panel">
              {publications.fields.map((f, i) => {
                const rowErr = errors.related_publications?.[i];
                return (
                  <li key={f.id} className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-2 gap-y-3 border-b border-border p-3 last:border-b-0">
                    <FormField id={`dataset-pub-${i}-title`} label={t("data.form.publicationTitle")} required requiredLabel={t("common.required")} error={tv(rowErr?.title?.message)}>
                      {(a11y) => <Input {...a11y} {...form.register(`related_publications.${i}.title`)} />}
                    </FormField>
                    <IconButton size="sm" className="mt-6" label={t("data.form.publicationRemoveNumbered", { n: i + 1 })} onClick={() => publications.remove(i)}>
                      <X aria-hidden="true" />
                    </IconButton>
                    <div className="col-span-2 grid grid-cols-1 gap-3 @xl/form:grid-cols-2">
                      <FormField id={`dataset-pub-${i}-doi`} label={t("data.form.publicationDoi")} error={tv(rowErr?.doi?.message)}>
                        {(a11y) => <Input {...a11y} placeholder="10.xxxx/…" className="font-mono text-mono" {...form.register(`related_publications.${i}.doi`)} />}
                      </FormField>
                      <FormField id={`dataset-pub-${i}-url`} label={t("data.form.publicationUrl")} error={tv(rowErr?.url?.message)}>
                        {(a11y) => <Input {...a11y} placeholder="https://" className="font-mono text-mono" {...form.register(`related_publications.${i}.url`)} />}
                      </FormField>
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="text-small text-fg-muted">{t("data.form.publicationsEmpty")}</p>
          )}
          <FieldError id="dataset-related_publications-error" message={typeof errors.related_publications?.message === "string" ? tv(errors.related_publications.message) : undefined} />
          <Button
            variant="ghost"
            size="sm"
            className="self-start border border-dashed border-border-strong"
            disabled={publications.fields.length >= 20}
            onClick={() => publications.append({ title: "", doi: "", url: "" })}
          >
            <Plus aria-hidden="true" />
            {t("data.form.publicationAdd")}
          </Button>
        </div>
      </FormSection>
    </>
  );

  const actionBar = (
    <div
      className={cn(
        "sticky bottom-0 z-[var(--z-sticky)] flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-border py-3",
        sheet ? "-mx-5 bg-bg-panel px-5" : "bg-bg",
      )}
    >
      <p className="min-w-0 text-small text-fg-muted">
        {t("data.form.owner")} <span className="font-medium text-fg">{ownerName}</span>
        {mode === "edit" && isDirty ? (
          <span className="ml-3 inline-flex items-center gap-1.5">
            <span aria-hidden="true" className="size-1.5 rounded-full bg-warning-solid" />
            {t("data.form.unsaved")}
          </span>
        ) : null}
      </p>
      <div className="flex items-center gap-2">
        {onCancel ? (
          <Button variant="ghost" onClick={onCancel}>
            {t("common.cancel")}
          </Button>
        ) : null}
        <Button variant="primary" type="submit" disabled={isSubmitting}>
          {mode === "create" ? t("data.new.submit") : t("common.save")}
        </Button>
      </div>
    </div>
  );

  const preview = <CardPreview control={form.control} />;

  return (
    <form
      noValidate
      className={cn(sheet ? "@container/form flex flex-col px-5 pt-4" : "grid grid-cols-1 gap-10 min-[1360px]:grid-cols-[minmax(0,1fr)_18rem]")}
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
      <div className={cn("flex min-w-0 flex-col", !sheet && "@container/form max-w-[52rem]")}>
        {summary.length || submitError ? (
          <div className="mb-6 flex flex-col gap-3">
            <FormErrorSummary errors={summary} onNavigate={(id) => id === "dataset-description" && setDescriptionView("write")} />
            {submitError ? <ErrorView error={submitError} /> : null}
          </div>
        ) : null}
        {fields}
        {actionBar}
      </div>
      {sheet ? null : preview}
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
