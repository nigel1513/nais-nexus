"use client";
import { zodResolver } from "@hookform/resolvers/zod";
import { buttonClass, Button, Checkbox, Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle, FormField, Input, Select, Textarea } from "@nais/ui";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { useListProjects } from "@/features/projects/api";
import { asApiError, fieldErrors } from "@/shared/api/errors";
import { flattenPages } from "@/shared/api/pagination";
import type { Dataset, Purpose } from "@/shared/api/types";
import { useValidationText } from "@/shared/hooks/use-validation-text";
import { DelayedSkeleton, ErrorView } from "@/shared/ui/state-views";
import { useToast } from "@/shared/ui/toast";
import { useCreateAccessRequest } from "../api";
import { accessRequestSchema, type AccessRequestFormValues } from "../schemas";

export function AccessRequestDialog({
  dataset,
  open,
  onOpenChange,
  onNotRequired,
}: {
  dataset: Dataset;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  /** The server says no grant is needed (ACCESS_NOT_REQUIRED): the caller switches its CTA to download. */
  onNotRequired?: () => void;
}) {
  const t = useTranslations();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent closeLabel={t("common.close")} className="max-w-xl">
        <DialogTitle>{t("access.request.title")}</DialogTitle>
        <DialogDescription>{t("access.request.description", { title: dataset.title })}</DialogDescription>
        {open ? (
          <RequestForm
            dataset={dataset}
            onNotRequired={() => {
              onOpenChange(false);
              onNotRequired?.();
            }}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function RequestForm({ dataset, onNotRequired }: { dataset: Dataset; onNotRequired: () => void }) {
  const t = useTranslations();
  const tv = useValidationText();
  const router = useRouter();
  const toast = useToast();
  const create = useCreateAccessRequest();
  const maxDays = dataset.policy.max_grant_days;
  const projects = useListProjects({ scope: "mine", status: "ACTIVE", limit: 100 });
  const eligible = flattenPages(projects.data).filter((p) => p.my_role && p.my_role !== "VIEWER");
  const [serverError, setServerError] = useState<unknown>(null);
  const form = useForm<AccessRequestFormValues>({
    resolver: zodResolver(accessRequestSchema(maxDays)),
    defaultValues: { project_id: "", purpose: dataset.policy.allowed_purposes[0] ?? "", purpose_detail: "", requested_days: Math.min(30, maxDays) },
  });
  const { errors, isSubmitting } = form.formState;
  const v0: Record<string, true> = { project_id: true, purpose: true, purpose_detail: true, requested_days: true };
  const detail = form.watch("purpose_detail") ?? "";

  if (projects.isPending) return <DelayedSkeleton />;
  if (projects.isError) return <ErrorView error={projects.error} onRetry={() => void projects.refetch()} />;
  if (!eligible.length) {
    return (
      <div className="mt-4 flex flex-col gap-3">
        <p>{t("access.request.noProject")}</p>
        <Link href="/commons/projects/new" className={buttonClass("primary")}>
          {t("projects.new.title")}
        </Link>
      </div>
    );
  }

  const duplicateId = (() => {
    const e = serverError ? asApiError(serverError) : null;
    const id = e?.code === "ACCESS_REQUEST_DUPLICATE" ? e.details.access_request_id : undefined;
    return typeof id === "string" ? id : undefined;
  })();

  return (
    <form
      noValidate
      className="mt-4 flex flex-col gap-4"
      onSubmit={form.handleSubmit(async (v) => {
        setServerError(null);
        try {
          const r = await create.mutateAsync({
            dataset_id: dataset.dataset_id,
            project_id: v.project_id,
            purpose: v.purpose as Purpose,
            purpose_detail: v.purpose_detail.trim(),
            operations: ["READ"],
            requested_days: v.requested_days,
          });
          toast(t("access.request.sent"));
          router.push(`/commons/access/${r.access_request_id}`);
        } catch (e) {
          const err = asApiError(e);
          if (err.code === "ACCESS_NOT_REQUIRED") return onNotRequired();
          const fields = fieldErrors(err);
          const mapped = Object.entries(fields).filter(([k]) => k in v0);
          if (err.code === "VALIDATION_FAILED" && mapped.length) {
            for (const [k, m] of mapped) form.setError(k as keyof AccessRequestFormValues, { message: m });
          } else setServerError(e);
        }
      })}
    >
      {serverError ? <ErrorView error={serverError} /> : null}
      {duplicateId ? (
        <Link href={`/commons/access/${duplicateId}`} className={buttonClass("link", "sm")}>
          {t("access.request.viewExisting")}
        </Link>
      ) : null}
      <FormField id="req-project" label={t("access.request.project")} required requiredLabel={t("common.required")} error={tv(errors.project_id?.message)}>
        {(a11y) => (
          <Select {...a11y} {...form.register("project_id")}>
            <option value="">{t("access.request.chooseProject")}</option>
            {eligible.map((p) => (
              <option key={p.project_id} value={p.project_id}>
                {p.name}
              </option>
            ))}
          </Select>
        )}
      </FormField>
      <FormField id="req-purpose" label={t("access.request.purpose")} required requiredLabel={t("common.required")} error={tv(errors.purpose?.message)}>
        {(a11y) => (
          <Select {...a11y} {...form.register("purpose")}>
            {dataset.policy.allowed_purposes.map((p) => (
              <option key={p} value={p}>
                {t(`enums.Purpose.${p}`)}
              </option>
            ))}
          </Select>
        )}
      </FormField>
      <FormField
        id="req-detail"
        label={t("access.request.detail")}
        required
        requiredLabel={t("common.required")}
        hint={t("access.request.detailCount", { count: detail.trim().length })}
        error={tv(errors.purpose_detail?.message)}
      >
        {(a11y) => <Textarea {...a11y} rows={5} maxLength={4000} {...form.register("purpose_detail")} />}
      </FormField>
      <fieldset className="flex flex-col gap-1">
        <legend className="mb-1 text-sm font-medium">{t("access.request.operations")}</legend>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked readOnly disabled />
          {t("enums.Operation.READ")}
        </label>
        {(["COMPUTE", "WRITE"] as const).map((op) => (
          <label key={op} className="flex items-center gap-2 text-sm text-muted-foreground">
            <Checkbox checked={false} readOnly disabled />
            {t(`enums.Operation.${op}`)} ({t("access.request.comingSoon")})
          </label>
        ))}
      </fieldset>
      <FormField
        id="req-days"
        label={t("access.request.days")}
        required
        requiredLabel={t("common.required")}
        hint={t("access.request.daysHint", { max: maxDays })}
        error={tv(errors.requested_days?.message, { max: maxDays })}
      >
        {(a11y) => <Input {...a11y} type="number" min={1} max={maxDays} {...form.register("requested_days", { valueAsNumber: true })} />}
      </FormField>
      <DialogFooter>
        <Button variant="primary" type="submit" disabled={isSubmitting}>
          {t("access.request.submit")}
        </Button>
      </DialogFooter>
    </form>
  );
}
