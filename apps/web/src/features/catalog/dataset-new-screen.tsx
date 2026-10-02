"use client";
import { useRouter } from "next/navigation";
import { Badge, cn } from "@nais/ui";
import { useTranslations } from "next-intl";
import { api, unwrap } from "@/shared/api/client";
import { useMeData } from "@/shared/hooks/use-me";
import { PageHeader } from "@/shared/ui/page-header";
import { RequireRole } from "@/shared/ui/require-role";
import { notify } from "@/shared/ui/toast";
import { useCreateDataset } from "./api";
import { DatasetForm } from "./components/dataset-form";
import { emptyDatasetForm, toDatasetCreate } from "./schemas";
import { useBreadcrumbs } from "@/shared/ui/breadcrumbs";

function NewDataset() {
  const t = useTranslations();
  const me = useMeData();
  const router = useRouter();
  const create = useCreateDataset();
  const defaults = {
    ...emptyDatasetForm,
    // The creating steward is a valid default contact (an active member of the owner organization).
    steward_contact: { user_id: me.user_id, label: `${me.display_name} (${me.organization.name})`, ntis: me.national_researcher_number ?? null },
  };
  return (
    <DatasetForm
      mode="create"
      defaultValues={defaults}
      onCancel={() => router.push("/commons/data")}
      ownerName={me.organization.name}
      ownerOrganizationId={me.organization.organization_id}
      onSubmit={async (values) => {
        // owner_organization_id is always the steward's own organization (M10 §7.5).
        const ds = await create.mutateAsync(toDatasetCreate(values, me.organization.organization_id));
        notify.success(t("data.new.created"));
        if (values.contributors.length) {
          try {
            // The dataset id exists only now, so this uses the client directly instead of usePutDatasetContributors(datasetId).
            await unwrap(
              api.PUT("/datasets/{dataset_id}/contributors", {
                params: { path: { dataset_id: ds.dataset_id } },
                body: { contributors: values.contributors.map((c) => ({ user_id: c.user_id, role: c.role })) },
              }),
            );
          } catch {
            notify.error(t("data.form.contributorsSaveFailed"));
          }
        }
        router.push(`/commons/data/${ds.dataset_id}?created=1`);
      }}
    />
  );
}

/**
 * Where registration sits in the whole flow (canvas A1): this form is step 1; files and publishing happen on the
 * dataset's version page afterwards. The processing log is stage 2 and shows as planned.
 */
function RegistrationSteps() {
  const t = useTranslations();
  const steps = [
    { key: "stepInfo", state: "current" },
    { key: "stepUpload", state: "next" },
    { key: "stepProcessing", state: "planned" },
    { key: "stepPublish", state: "next" },
  ] as const;
  return (
    <ol aria-label={t("data.new.stepsLabel")} className="mb-8 flex flex-wrap items-center gap-x-2 gap-y-2 border-b border-border pb-4 text-small">
      {steps.map((s, i) => (
        <li key={s.key} aria-current={s.state === "current" ? "step" : undefined} className="flex items-center gap-2">
          {i > 0 ? <span aria-hidden="true" className="mr-2 h-px w-6 bg-border-strong" /> : null}
          <span
            aria-hidden="true"
            className={cn(
              "num flex size-5.5 items-center justify-center rounded-full text-caption",
              s.state === "current" ? "bg-primary text-primary-fg" : "border border-border-strong text-fg-muted",
            )}
          >
            {i + 1}
          </span>
          <span className={cn(s.state === "current" ? "font-semibold text-fg" : "text-fg-muted")}>{t(`data.new.${s.key}`)}</span>
          {s.state === "planned" ? <Badge tone="neutral">{t("data.new.stepPlanned")}</Badge> : null}
        </li>
      ))}
    </ol>
  );
}

export function DatasetNewScreen() {
  const t = useTranslations();
  useBreadcrumbs([{ label: t("data.new.title") }]);
  return (
    <>
      <PageHeader title={t("data.new.title")} description={t("data.new.description")} />
      <RequireRole anyOf={["DATA_STEWARD"]}>
        <RegistrationSteps />
        <NewDataset />
      </RequireRole>
    </>
  );
}
