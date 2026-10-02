"use client";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { api, unwrap } from "@/shared/api/client";
import { useMeData } from "@/shared/hooks/use-me";
import { ScreenTitle, StepTrack } from "@/shared/ui/screen-v2";
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
 * Where registration sits in the whole flow (canvas A1), as the start page's numbered steps: this form is step 1; files
 * and publishing happen on the dataset's version page afterwards. The processing log is stage 2 and shows as planned.
 */
function RegistrationSteps() {
  const t = useTranslations();
  return (
    <StepTrack
      label={t("data.new.stepsLabel")}
      steps={[
        { label: t("data.new.stepInfo"), hint: t("data.new.stepInfoHint"), state: "now" },
        { label: t("data.new.stepUpload"), hint: t("data.new.stepUploadHint"), state: "next" },
        { label: t("data.new.stepProcessing"), hint: t("data.new.stepProcessingHint"), state: "planned", plannedLabel: t("data.new.stepPlanned") },
        { label: t("data.new.stepPublish"), hint: t("data.new.stepPublishHint"), state: "next" },
      ]}
    />
  );
}

export function DatasetNewScreen() {
  const t = useTranslations();
  const me = useMeData();
  useBreadcrumbs([{ label: t("data.new.title") }]);
  return (
    <>
      <ScreenTitle context={[t("data.new.context"), me.organization.name]} title={t("data.new.title")} description={t("data.new.description")} />
      <RequireRole anyOf={["DATA_STEWARD"]}>
        <RegistrationSteps />
        <NewDataset />
      </RequireRole>
    </>
  );
}
