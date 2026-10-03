"use client";
import { Button, buttonClass, DataTable, Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle, EmptyState, FormField, Input, Select } from "@nais/ui";
import { Plus, Workflow } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import { useErrorText } from "@/shared/api/use-error-text";
import { DateTime } from "@/shared/ui/date-text";
import { DelayedSkeleton, ErrorView } from "@/shared/ui/state-views";
import { PanelHead } from "@/shared/ui/work-hero";
import { useCreateRecipe, useProjectInputs, useRecipes, type Recipe } from "./api";
import { RunsList } from "./runs-list";
import { projectHref, useWorkspace } from "./workspace-layout";

/**
 * 변환: the project's recipes (ordered steps over pinned inputs, saved as numbered versions) and every run. A recipe
 * opens in its editor; 새 레시피 creates an empty one on a base input and opens it.
 */
export function RecipesTab() {
  const t = useTranslations();
  const { project, canWrite } = useWorkspace();
  const projectId = project.project_id;
  const recipes = useRecipes(projectId);
  const inputs = useProjectInputs(projectId);
  const [creating, setCreating] = useState(false);
  const rows = recipes.data?.items ?? [];
  const noInputs = inputs.isSuccess && !inputs.data.items.length;

  return (
    <div className="flex flex-col gap-10">
      <section aria-labelledby="ws-recipes">
        <PanelHead
          id="ws-recipes"
          crumb={t("workspace.tabs.recipes")}
          title={t("workspace.recipes.title")}
          count={recipes.data ? rows.length : undefined}
          right={
            canWrite && !noInputs ? (
              <Button variant="primary" onClick={() => setCreating(true)} disabled={!inputs.isSuccess}>
                <Plus aria-hidden="true" strokeWidth={1.75} />
                {t("workspace.recipes.new")}
              </Button>
            ) : null
          }
          className="mb-3"
        />
        <p className="mb-4 max-w-[72ch] text-small text-fg-muted">{t("workspace.recipes.hint")}</p>
        {recipes.isPending ? (
          <DelayedSkeleton />
        ) : recipes.isError ? (
          <ErrorView error={recipes.error} onRetry={() => void recipes.refetch()} />
        ) : (
          <DataTable<Recipe>
            caption={t("workspace.recipes.title")}
            rows={rows}
            rowKey={(r) => r.recipe_id}
            empty={
              <EmptyState
                icon={Workflow}
                title={t("workspace.recipes.empty")}
                description={noInputs ? t("workspace.recipes.needInputs") : t("workspace.recipes.emptyHint")}
                action={
                  noInputs && canWrite ? (
                    <Link href={projectHref(projectId, "data")} className={buttonClass("secondary", "sm")}>
                      {t("workspace.addInput.title")}
                    </Link>
                  ) : undefined
                }
              />
            }
            columns={[
              {
                key: "name",
                header: t("workspace.recipes.name"),
                cell: (r) => (
                  <Link href={`${projectHref(projectId, "recipes")}/${r.recipe_id}`} className="font-medium text-fg underline-offset-4 hover:underline">
                    {r.name}
                  </Link>
                ),
              },
              { key: "inputs", header: t("workspace.recipes.inputs"), numeric: true, cell: (r) => r.input_ids.length },
              { key: "steps", header: t("workspace.recipes.steps"), numeric: true, cell: (r) => r.steps.length },
              { key: "version", header: t("workspace.recipes.version"), cell: (r) => <span className="num font-mono text-mono">v{r.version}</span> },
              { key: "updated", header: t("workspace.recipes.updated"), numeric: true, cell: (r) => <DateTime value={r.updated_at} /> },
            ]}
          />
        )}
      </section>
      <section aria-labelledby="ws-runs-all">
        <PanelHead id="ws-runs-all" crumb={t("workspace.recipe.runsKicker")} title={t("workspace.runs.title")} className="mb-3" />
        <RunsList projectId={projectId} caption={t("workspace.runs.title")} />
      </section>
      {creating && inputs.data ? <NewRecipeDialog projectId={projectId} inputs={inputs.data.items} onClose={() => setCreating(false)} /> : null}
    </div>
  );
}

function NewRecipeDialog({ projectId, inputs, onClose }: { projectId: string; inputs: { input_id: string; dataset_title: string; version_label: string }[]; onClose: () => void }) {
  const t = useTranslations();
  const errorText = useErrorText();
  const router = useRouter();
  const id = useId();
  const create = useCreateRecipe(projectId);
  const [name, setName] = useState("");
  const [base, setBase] = useState(inputs[0]?.input_id ?? "");
  const [error, setError] = useState<unknown>(null);
  return (
    <Dialog open onOpenChange={(o) => (o ? undefined : onClose())}>
      <DialogContent closeLabel={t("common.close")} className="max-w-lg">
        <DialogTitle>{t("workspace.recipes.new")}</DialogTitle>
        <DialogDescription>{t("workspace.recipes.newDescription")}</DialogDescription>
        <form
          className="mt-4 flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!name.trim() || !base) return;
            setError(null);
            create.mutate(
              { name: name.trim(), input_ids: [base], steps: [] },
              {
                onSuccess: (r) => {
                  onClose();
                  router.push(`${projectHref(projectId, "recipes")}/${r.recipe_id}`);
                },
                onError: setError,
              },
            );
          }}
        >
          <FormField id={`${id}-name`} label={t("workspace.recipe.name")} error={error ? errorText(error) : undefined}>
            {(a11y) => <Input {...a11y} value={name} maxLength={200} onChange={(e) => setName(e.target.value)} />}
          </FormField>
          <FormField id={`${id}-base`} label={t("workspace.recipe.base")} hint={t("workspace.recipe.baseHint")}>
            {(a11y) => (
              <Select {...a11y} value={base} onChange={(e) => setBase(e.target.value)}>
                {inputs.map((i) => (
                  <option key={i.input_id} value={i.input_id}>
                    {i.dataset_title} · {i.version_label}
                  </option>
                ))}
              </Select>
            )}
          </FormField>
          <DialogFooter className="mt-2">
            <Button variant="ghost" onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" variant="primary" disabled={!name.trim() || !base || create.isPending}>
              {t("workspace.recipes.create")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
