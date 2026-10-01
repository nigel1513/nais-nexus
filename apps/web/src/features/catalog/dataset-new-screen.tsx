"use client";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { api, unwrap } from "@/shared/api/client";
import { useMeData } from "@/shared/hooks/use-me";
import { PageHeader } from "@/shared/ui/page-header";
import { RequireRole } from "@/shared/ui/require-role";
import { useToast } from "@/shared/ui/toast";
import { useCreateDataset } from "./api";
import { DatasetForm } from "./components/dataset-form";
import { emptyDatasetForm, toDatasetCreate } from "./schemas";

function NewDataset() {
  const t = useTranslations();
  const me = useMeData();
  const router = useRouter();
  const toast = useToast();
  const create = useCreateDataset();
  const defaults = {
    ...emptyDatasetForm,
    // The creating steward is a valid default contact (an active member of the owner organization).
    steward_contact: { user_id: me.user_id, label: `${me.display_name} (${me.organization.name})` },
  };
  return (
    <DatasetForm
      mode="create"
      defaultValues={defaults}
      ownerName={me.organization.name}
      ownerOrganizationId={me.organization.organization_id}
      onSubmit={async (values) => {
        // owner_organization_id is always the steward's own organization (M10 §7.5).
        const ds = await create.mutateAsync(toDatasetCreate(values, me.organization.organization_id));
        toast(t("data.new.created"));
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
            toast(t("data.form.contributorsSaveFailed"));
          }
        }
        router.push(`/commons/data/${ds.dataset_id}?created=1`);
      }}
    />
  );
}

export function DatasetNewScreen() {
  const t = useTranslations();
  return (
    <>
      <PageHeader title={t("data.new.title")} description={t("data.new.description")} />
      <RequireRole anyOf={["DATA_STEWARD"]}>
        <NewDataset />
      </RequireRole>
    </>
  );
}
