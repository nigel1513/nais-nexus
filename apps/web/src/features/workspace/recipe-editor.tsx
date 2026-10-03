"use client";
import { Badge, Button, Checkbox, ConfirmDialog, FormField, IconButton, Input, Label, Menu, Select, Table, TBody, Td, Th, THead, Tr, cn, focusRing } from "@nais/ui";
import { ArrowDown, ArrowUp, Ellipsis, Eye, Play, Plus, Save, Trash2, TriangleAlert } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useId, useMemo, useRef, useState } from "react";
import { ApiError, asApiError } from "@/shared/api/errors";
import { useErrorText } from "@/shared/api/use-error-text";
import { DelayedSkeleton, ErrorView } from "@/shared/ui/state-views";
import { notify } from "@/shared/ui/toast";
import { PanelHead } from "@/shared/ui/work-hero";
import {
  useDeleteRecipe, useInputColumns, usePreviewRecipe, useProjectInputs, useRecipe, useStartRun, useUpdateRecipe,
  type ProjectInput, type Recipe, type RecipePreview, type RecipeStep, type RecipeWrite,
} from "./api";
import { TargetDiscussion } from "./discussion-tab";
import { newStep, STEP_TYPES, stepProblem, StepForm, type ColumnType, type StepType } from "./recipe-steps";
import { RunsList } from "./runs-list";
import { projectHref, useDetailCrumb, useLeaveGuard, useWorkspace } from "./workspace-layout";

type Draft = { key: string; step: RecipeStep };
/** A problem shown at a step: from the client check (missing parameter) or the server's RECIPE_INVALID. */
type StepIssue = { message: string };

const KNOWN_REASONS = new Set([
  "UNKNOWN_COLUMN", "TYPE_MISMATCH", "INVALID_VALUE", "DUPLICATE_COLUMN", "UNKNOWN_INPUT", "STEP_FAILED", "TOO_MANY_ROWS", "CAST_FAILED",
  "INPUT_UNAVAILABLE", "INPUT_NOT_TABULAR", "INPUT_UNREADABLE", "INPUT_TOO_LARGE",
]);

let seq = 0;
const draftOf = (step: RecipeStep): Draft => ({ key: `s${++seq}`, step });
const writeOf = (name: string, inputIds: string[], drafts: Draft[]): RecipeWrite => ({ name: name.trim(), input_ids: inputIds, steps: drafts.map((d) => d.step) });

/** 레시피 편집: load the recipe, then edit it (remounted on 최신 버전 불러오기). */
export function RecipeEditor({ recipeId }: { recipeId: string }) {
  const { project } = useWorkspace();
  const recipe = useRecipe(project.project_id, recipeId);
  const [loads, setLoads] = useState(0);
  useDetailCrumb(recipe.data ? { label: recipe.data.name } : null);
  if (recipe.isPending) return <DelayedSkeleton lines={6} />;
  if (recipe.isError) return <ErrorView error={recipe.error} onRetry={() => void recipe.refetch()} />;
  return (
    <EditorBody
      key={`${recipe.data.recipe_id}:${loads}`}
      recipe={recipe.data}
      onReload={async () => {
        await recipe.refetch();
        setLoads((n) => n + 1);
      }}
    />
  );
}

function EditorBody({ recipe, onReload }: { recipe: Recipe; onReload: () => Promise<void> }) {
  const t = useTranslations();
  const errorText = useErrorText();
  const router = useRouter();
  const { project, canWrite } = useWorkspace();
  const projectId = project.project_id;
  const id = useId();
  const columnsListId = `${id}-columns`;
  const inputs = useProjectInputs(projectId);
  const save = useUpdateRecipe(projectId, recipe.recipe_id);
  const preview = usePreviewRecipe(projectId, recipe.recipe_id);
  const start = useStartRun(projectId, recipe.recipe_id);
  const remove = useDeleteRecipe(projectId, recipe.recipe_id);

  const [saved, setSaved] = useState(recipe);
  const [name, setName] = useState(recipe.name);
  const [inputIds, setInputIds] = useState(recipe.input_ids);
  const [drafts, setDrafts] = useState<Draft[]>(() => recipe.steps.map(draftOf));
  const [issues, setIssues] = useState<Record<string, StepIssue>>({});
  const [generalIssue, setGeneralIssue] = useState<string | null>(null);
  const [conflict, setConflict] = useState<number | null>(null);
  const [actionError, setActionError] = useState<ApiError | null>(null);
  const [result, setResult] = useState<RecipePreview | null>(null);
  const [addType, setAddType] = useState<StepType>("filter_rows");
  const [deleting, setDeleting] = useState(false);
  const stepRefs = useRef(new Map<string, HTMLLIElement>());

  const projectInputs = inputs.data?.items ?? [];
  const byId = new Map(projectInputs.map((i) => [i.input_id, i]));
  const inputName = (inputId: string) => {
    const i = byId.get(inputId);
    return i ? `${i.dataset_title} · ${i.version_label}` : t("workspace.recipe.removedInput");
  };
  const baseId = inputIds[0] ?? "";
  const joinable = inputIds.slice(1);
  const dirty = JSON.stringify(writeOf(name, inputIds, drafts)) !== JSON.stringify(writeOf(saved.name, saved.input_ids, saved.steps.map((s) => ({ key: "", step: s }))));
  const readOnly = !canWrite;
  const lapsed = inputIds.filter((i) => byId.get(i)?.access_lapsed);
  useLeaveGuard(dirty && !readOnly);
  const [confirmReload, setConfirmReload] = useState(false);

  // Column suggestions and types: every recipe input's column profile (base first), plus the last preview's result columns.
  const profiled = useInputColumns(inputIds.map((i) => byId.get(i)).filter((i): i is ProjectInput => !!i));
  const columnTypes = useMemo(() => {
    const m = new Map<string, ColumnType>();
    for (const i of inputIds) for (const c of profiled.get(i) ?? []) if (!m.has(c.name)) m.set(c.name, c.type);
    return m;
  }, [inputIds, profiled]);
  const columns = useMemo(() => [...new Set([...columnTypes.keys(), ...(result?.header ?? [])])], [columnTypes, result?.header]);

  const edit = (fn: (d: Draft[]) => Draft[]) => {
    setDrafts(fn);
    setConflict(null);
  };
  const updateStep = (key: string, step: RecipeStep) => {
    edit((ds) => ds.map((d) => (d.key === key ? { ...d, step } : d)));
    setIssues(({ [key]: _gone, ...rest }) => (void _gone, rest));
  };
  const move = (index: number, by: -1 | 1) =>
    edit((ds) => {
      const next = [...ds];
      const [d] = next.splice(index, 1);
      next.splice(index + by, 0, d!);
      return next;
    });

  /** Client check before sending; marks each step missing a parameter. */
  const check = (): boolean => {
    setActionError(null);
    setGeneralIssue(null);
    const found: Record<string, StepIssue> = {};
    drafts.forEach((d) => {
      const p = stepProblem(d.step, inputIds);
      if (p) found[d.key] = { message: t(`workspace.recipe.missing.${p}`) };
    });
    setIssues(found);
    const first = drafts.find((d) => found[d.key]);
    if (first) {
      stepRefs.current.get(first.key)?.querySelector<HTMLElement>("[data-step-title]")?.focus();
      return false;
    }
    if (!name.trim()) {
      setGeneralIssue(t("workspace.recipe.missing.name"));
      return false;
    }
    if (!baseId) {
      setGeneralIssue(t("workspace.recipe.missing.base"));
      return false;
    }
    return true;
  };

  /** RECIPE_INVALID → the message at its step (or above the steps for an input problem); true when handled. */
  const showRecipeInvalid = (error: unknown): boolean => {
    const e = asApiError(error);
    if (e.code !== "RECIPE_INVALID") return false;
    const reason = typeof e.details.reason === "string" && KNOWN_REASONS.has(e.details.reason) ? e.details.reason : null;
    const column = typeof e.details.column === "string" ? e.details.column : "";
    const base = reason ? t(`workspace.recipe.reason.${reason}`, { column }) : t("errors.RECIPE_INVALID");
    // Without the column's type the value was guessed (number/true/false): say how to compare as text.
    const message = reason === "TYPE_MISMATCH" && column && !columnTypes.has(column) ? `${base} ${t("workspace.recipe.quoteHint")}` : base;
    const index = typeof e.details.step_index === "number" ? e.details.step_index : null;
    const target = index !== null ? drafts[index] : undefined;
    if (target) {
      setIssues({ [target.key]: { message } });
      stepRefs.current.get(target.key)?.querySelector<HTMLElement>("[data-step-title]")?.focus();
    } else {
      const inputId = typeof e.details.input_id === "string" ? e.details.input_id : null;
      setGeneralIssue(inputId ? `${inputName(inputId)}: ${message}` : message);
    }
    return true;
  };

  const runPreview = () => {
    if (!check()) return;
    preview.mutate(
      { input_ids: inputIds, steps: drafts.map((d) => d.step) },
      {
        onSuccess: setResult,
        onError: (e) => {
          setResult(null);
          if (!showRecipeInvalid(e)) setActionError(asApiError(e));
        },
      },
    );
  };

  const runSave = () => {
    if (!check()) return;
    save.mutate(
      { version: saved.version, body: writeOf(name, inputIds, drafts) },
      {
        onSuccess: (r) => {
          setSaved(r);
          setConflict(null);
          notify.success(t("workspace.recipe.saved", { version: r.version }));
        },
        onError: (e) => {
          const err = asApiError(e);
          if (err.code === "CONFLICT") setConflict(typeof err.details.current_version === "number" ? err.details.current_version : saved.version + 1);
          else if (!showRecipeInvalid(e)) setActionError(err);
        },
      },
    );
  };

  const runStart = () => {
    setActionError(null);
    start.mutate(undefined, {
      onSuccess: (run) => notify.success(t("workspace.recipe.runStarted", { version: run.recipe_version })),
      onError: (e) => setActionError(asApiError(e)),
    });
  };

  return (
    <div className="flex flex-col gap-10">
      <datalist id={columnsListId}>
        {columns.map((c) => (
          <option key={c} value={c} />
        ))}
      </datalist>

      <section aria-labelledby={`${id}-title`} className="flex flex-col gap-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-1">
            <span className="sv-kicker" aria-hidden="true">
              {t("workspace.recipe.kicker")}
            </span>
            <h2 id={`${id}-title`} className="sv-h2 break-keep">
              {saved.name}
            </h2>
            <p className="flex flex-wrap items-center gap-2 text-small text-fg-muted">
              <span className="num font-mono text-mono">v{saved.version}</span>
              {dirty ? <Badge tone="warning">{t("workspace.recipe.unsaved")}</Badge> : null}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={runPreview} disabled={preview.isPending}>
              <Eye aria-hidden="true" strokeWidth={1.75} />
              {preview.isPending ? t("workspace.recipe.previewing") : t("workspace.recipe.preview")}
            </Button>
            {readOnly ? null : (
              <>
                <Button onClick={runSave} disabled={!dirty || save.isPending}>
                  <Save aria-hidden="true" strokeWidth={1.75} />
                  {t("common.save")}
                </Button>
                <Button variant="primary" onClick={runStart} disabled={dirty || start.isPending || lapsed.length > 0} aria-describedby={dirty || lapsed.length ? `${id}-run-hint` : undefined}>
                  <Play aria-hidden="true" strokeWidth={1.75} />
                  {t("workspace.recipe.run")}
                </Button>
                <Menu.Root>
                  <Menu.Trigger aria-label={t("workspace.recipe.more")} className={cn("inline-flex size-8 items-center justify-center rounded-md border border-border text-fg-muted hover:bg-bg-hover hover:text-fg", focusRing)}>
                    <Ellipsis aria-hidden="true" strokeWidth={1.75} className="size-4" />
                  </Menu.Trigger>
                  <Menu.Content align="end">
                    <Menu.Item tone="danger" icon={<Trash2 aria-hidden="true" />} onClick={() => setDeleting(true)}>
                      {t("workspace.recipe.deleteEllipsis")}
                    </Menu.Item>
                  </Menu.Content>
                </Menu.Root>
              </>
            )}
          </div>
        </div>
        {!readOnly && (dirty || lapsed.length) ? (
          <p id={`${id}-run-hint`} className="text-small text-fg-muted">
            {lapsed.length ? t("workspace.recipe.lapsedHint") : t("workspace.recipe.saveFirst")}
          </p>
        ) : null}
        {conflict !== null ? (
          <div role="alert" className="flex flex-col items-start gap-2 rounded-md border border-warning-line bg-warning-soft p-3 text-small text-fg">
            <p className="flex items-start gap-2">
              <TriangleAlert aria-hidden="true" strokeWidth={1.75} className="mt-0.5 size-4 shrink-0 text-warning" />
              {t("workspace.recipe.conflict", { version: conflict })}
            </p>
            <Button size="sm" onClick={() => (dirty ? setConfirmReload(true) : void onReload())}>
              {t("workspace.recipe.reload")}
            </Button>
          </div>
        ) : null}
        {actionError ? (
          <p role="alert" className="flex items-start gap-2 rounded-md border border-danger-line bg-danger-soft p-3 text-small text-fg">
            <TriangleAlert aria-hidden="true" strokeWidth={1.75} className="mt-0.5 size-4 shrink-0 text-danger" />
            {errorText(actionError)}
          </p>
        ) : null}

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <FormField id={`${id}-name`} label={t("workspace.recipe.name")}>
            {(a11y) => <Input {...a11y} value={name} maxLength={200} disabled={readOnly} onChange={(e) => setName(e.target.value)} />}
          </FormField>
          <FormField id={`${id}-base`} label={t("workspace.recipe.base")} hint={t("workspace.recipe.baseHint")}>
            {(a11y) => (
              <Select
                {...a11y}
                value={baseId}
                disabled={readOnly || inputs.isPending}
                onChange={(e) => {
                  const next = e.target.value;
                  setInputIds((ids) => [next, ...ids.slice(1).filter((x) => x !== next)]);
                }}
              >
                {byId.has(baseId) || !baseId ? null : <option value={baseId}>{t("workspace.recipe.removedInput")}</option>}
                {baseId ? null : <option value="">{t("workspace.recipe.field.pickInput")}</option>}
                {projectInputs.map((i) => (
                  <option key={i.input_id} value={i.input_id}>
                    {i.dataset_title} · {i.version_label}
                  </option>
                ))}
              </Select>
            )}
          </FormField>
        </div>
        {projectInputs.length > 1 ? (
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1.5 text-small font-medium text-fg">{t("workspace.recipe.joinInputs")}</legend>
            <ul className="flex flex-col gap-1.5">
              {projectInputs
                .filter((i) => i.input_id !== baseId)
                .map((i: ProjectInput) => (
                  <li key={i.input_id} className="flex items-center gap-2">
                    <Checkbox
                      id={`${id}-join-${i.input_id}`}
                      checked={inputIds.includes(i.input_id)}
                      disabled={readOnly}
                      onChange={(e) => setInputIds((ids) => (e.target.checked ? [...ids, i.input_id] : ids.filter((x) => x !== i.input_id)))}
                    />
                    <Label htmlFor={`${id}-join-${i.input_id}`} className="font-normal">
                      {i.dataset_title} · {i.version_label}
                    </Label>
                    {i.access_lapsed ? <Badge tone="danger">{t("workspace.inputs.lapsed")}</Badge> : null}
                  </li>
                ))}
            </ul>
          </fieldset>
        ) : null}
        {lapsed.length ? (
          <p role="status" className="flex items-start gap-2 text-small text-fg">
            <TriangleAlert aria-hidden="true" strokeWidth={1.75} className="mt-0.5 size-4 shrink-0 text-warning" />
            {t("workspace.recipe.lapsed", { inputs: lapsed.map(inputName).join(", ") })}
          </p>
        ) : null}
      </section>

      <section aria-labelledby={`${id}-steps`} className="flex flex-col gap-3">
        <PanelHead id={`${id}-steps`} crumb={t("workspace.recipe.stepsKicker")} title={t("workspace.recipe.steps")} count={drafts.length} />
        {generalIssue ? (
          <p role="alert" className="flex items-start gap-2 text-small text-danger">
            <TriangleAlert aria-hidden="true" strokeWidth={1.75} className="mt-0.5 size-4 shrink-0" />
            {generalIssue}
          </p>
        ) : null}
        {drafts.length ? (
          <ol className="flex flex-col gap-3">
            {drafts.map((d, i) => {
              const issue = issues[d.key];
              const titleId = `${id}-step-${d.key}`;
              return (
                <li
                  key={d.key}
                  ref={(el) => {
                    if (el) stepRefs.current.set(d.key, el);
                    else stepRefs.current.delete(d.key);
                  }}
                  aria-labelledby={titleId}
                  className={cn("flex flex-col gap-3 rounded-md border bg-bg-panel p-3 sm:p-4", issue ? "border-danger" : "border-border")}
                >
                  <div className="flex items-center justify-between gap-2">
                    <h3 id={titleId} data-step-title tabIndex={-1} className="flex items-baseline gap-2 text-body font-semibold text-fg outline-none">
                      <span className="num font-mono text-mono text-fg-muted">{String(i + 1).padStart(2, "0")}</span>
                      {t(`enums.RecipeStepType.${d.step.type}`)}
                    </h3>
                    {readOnly ? null : (
                      <span className="flex gap-1">
                        <IconButton label={t("workspace.recipe.moveUp", { n: i + 1 })} size="sm" disabled={i === 0} onClick={() => move(i, -1)}>
                          <ArrowUp />
                        </IconButton>
                        <IconButton label={t("workspace.recipe.moveDown", { n: i + 1 })} size="sm" disabled={i === drafts.length - 1} onClick={() => move(i, 1)}>
                          <ArrowDown />
                        </IconButton>
                        <IconButton
                          label={t("workspace.recipe.removeStep", { n: i + 1 })}
                          size="sm"
                          onClick={() => {
                            edit((ds) => ds.filter((x) => x.key !== d.key));
                            setIssues(({ [d.key]: _gone, ...rest }) => (void _gone, rest));
                          }}
                        >
                          <Trash2 />
                        </IconButton>
                      </span>
                    )}
                  </div>
                  {issue ? (
                    <p role="alert" className="flex items-start gap-1.5 text-small text-danger">
                      <TriangleAlert aria-hidden="true" strokeWidth={1.75} className="mt-0.5 size-3.5 shrink-0" />
                      {issue.message}
                    </p>
                  ) : null}
                  <StepForm
                    step={d.step}
                    onChange={(s) => updateStep(d.key, s)}
                    columnsListId={columnsListId}
                    joinable={joinable}
                    inputName={inputName}
                    columnType={(c) => columnTypes.get(c)}
                    disabled={readOnly}
                  />
                </li>
              );
            })}
          </ol>
        ) : (
          <p className="text-small text-fg-muted">{t("workspace.recipe.noSteps")}</p>
        )}
        {readOnly ? null : (
          <div className="flex flex-wrap items-end gap-2">
            <div className="w-56">
              <FormField id={`${id}-add`} label={t("workspace.recipe.stepType")}>
                {(a11y) => (
                  <Select {...a11y} value={addType} onChange={(e) => setAddType(e.target.value as StepType)}>
                    {STEP_TYPES.map((s) => (
                      <option key={s} value={s}>
                        {t(`enums.RecipeStepType.${s}`)}
                      </option>
                    ))}
                  </Select>
                )}
              </FormField>
            </div>
            <Button onClick={() => edit((ds) => [...ds, draftOf(newStep(addType, joinable))])}>
              <Plus aria-hidden="true" strokeWidth={1.75} />
              {t("workspace.recipe.addStep")}
            </Button>
          </div>
        )}
      </section>

      <section aria-labelledby={`${id}-preview`} className="flex flex-col gap-3">
        <PanelHead id={`${id}-preview`} crumb={t("workspace.recipe.previewKicker")} title={t("workspace.recipe.previewTitle")} />
        {result ? (
          <>
            <p className="num text-small text-fg-muted">
              {t("workspace.recipe.previewMeta", { read: result.input_rows_read, rows: result.output_rows, shown: result.rows.length })}
              {result.rows_truncated ? ` · ${t("workspace.recipe.previewTruncated")}` : ""}
            </p>
            {result.header.length ? (
              <Table caption={t("workspace.recipe.previewTitle")} frameClassName="max-h-[480px] overflow-y-auto">
                <THead>
                  <Tr>
                    {result.header.map((h) => (
                      <Th key={h} className="whitespace-nowrap font-mono text-mono">
                        {h}
                      </Th>
                    ))}
                  </Tr>
                </THead>
                <TBody>
                  {result.rows.map((row, r) => (
                    <Tr key={r}>
                      {row.map((cell, c) => (
                        <Td key={c} className="max-w-[24ch] truncate whitespace-nowrap font-mono text-mono">
                          {cell === null ? <span className="text-fg-muted">∅</span> : cell}
                        </Td>
                      ))}
                    </Tr>
                  ))}
                </TBody>
              </Table>
            ) : (
              <p className="text-small text-fg-muted">{t("workspace.recipe.previewNoColumns")}</p>
            )}
          </>
        ) : (
          <p className="text-small text-fg-muted">{t("workspace.recipe.previewHint")}</p>
        )}
      </section>

      <section aria-labelledby={`${id}-runs`} className="flex flex-col gap-3">
        <PanelHead id={`${id}-runs`} crumb={t("workspace.recipe.runsKicker")} title={t("workspace.runs.title")} />
        <RunsList projectId={projectId} recipeId={recipe.recipe_id} caption={t("workspace.runs.title")} />
      </section>

      <TargetDiscussion scope="RECIPE" targetId={recipe.recipe_id} />

      <ConfirmDialog
        open={confirmReload}
        onOpenChange={setConfirmReload}
        title={t("workspace.leave.title")}
        description={t("workspace.leave.reloadDescription")}
        confirmLabel={t("workspace.leave.leave")}
        cancelLabel={t("workspace.leave.stay")}
        closeLabel={t("common.close")}
        onConfirm={() => {
          setConfirmReload(false);
          void onReload();
        }}
      />
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={t("workspace.recipe.deleteTitle")}
        description={t("workspace.recipe.deleteWarning")}
        confirmLabel={t("workspace.recipe.delete")}
        cancelLabel={t("common.cancel")}
        closeLabel={t("common.close")}
        destructive
        pending={remove.isPending}
        onConfirm={() =>
          remove.mutate(undefined, {
            onSuccess: () => {
              setDeleting(false);
              notify.success(t("workspace.recipe.deleted"));
              router.push(projectHref(projectId, "recipes"));
            },
            onError: (e) => {
              setDeleting(false);
              notify.error(errorText(e));
            },
          })
        }
      />
    </div>
  );
}
