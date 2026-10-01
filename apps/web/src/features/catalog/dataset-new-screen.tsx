"use client";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
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
  return (
    <DatasetForm
      mode="create"
      defaultValues={emptyDatasetForm}
      ownerName={me.organization.name}
      onSubmit={async (values) => {
        // owner_organization_id is always the steward's own organization (M10 §7.5).
        // Stage 1 web plan replaces this with pickers (the creating steward is a valid default).
        const ds = await create.mutateAsync(
          toDatasetCreate(values, me.organization.organization_id, { principalInvestigatorId: me.user_id, stewardContactId: me.user_id }),
        );
        toast(t("data.new.created"));
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
