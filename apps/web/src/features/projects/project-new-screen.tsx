"use client";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { PageHeader } from "@/shared/ui/page-header";
import { useToast } from "@/shared/ui/toast";
import { useCreateProject } from "./api";
import { ProjectForm } from "./components/project-form";
import { emptyProjectForm, toProjectCreate } from "./schemas";

export function ProjectNewScreen() {
  const t = useTranslations();
  const router = useRouter();
  const toast = useToast();
  const create = useCreateProject();
  return (
    <>
      <PageHeader title={t("projects.new.title")} description={t("projects.new.description")} />
      <ProjectForm
        defaultValues={emptyProjectForm}
        submitLabel={t("projects.new.submit")}
        onSubmit={async (values) => {
          const project = await create.mutateAsync(toProjectCreate(values));
          toast(t("projects.new.created"));
          router.push(`/commons/projects/${project.project_id}`);
        }}
      />
    </>
  );
}
