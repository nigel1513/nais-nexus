"use client";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { PageHeader } from "@/shared/ui/page-header";
import { notify } from "@/shared/ui/toast";
import { useCreateProject } from "./api";
import { ProjectForm } from "./components/project-form";
import { emptyProjectForm, toProjectCreate } from "./schemas";
import { useBreadcrumbs } from "@/shared/ui/breadcrumbs";

export function ProjectNewScreen() {
  const t = useTranslations();
  useBreadcrumbs([{ label: t("projects.new.title") }]);
  const router = useRouter();
  const create = useCreateProject();
  return (
    <>
      <PageHeader title={t("projects.new.title")} description={t("projects.new.description")} />
      <ProjectForm
        defaultValues={emptyProjectForm}
        submitLabel={t("projects.new.submit")}
        onCancel={() => router.push("/commons/projects")}
        onSubmit={async (values) => {
          const project = await create.mutateAsync(toProjectCreate(values));
          notify.success(t("projects.new.created"));
          router.push(`/commons/projects/${project.project_id}`);
        }}
      />
    </>
  );
}
