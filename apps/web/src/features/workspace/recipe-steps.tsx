"use client";
import { Button, Checkbox, Input, Label, Select, Tag } from "@nais/ui";
import { Plus, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ENUMS } from "@/generated/contracts";
import type { Schemas } from "@/shared/api/types";
import type { RecipeStep } from "./api";

export type StepType = Schemas["RecipeStepType"];
export const STEP_TYPES = ENUMS.RecipeStepType as readonly StepType[];
const FILTER_OPS = ENUMS.RecipeFilterOp as readonly Schemas["RecipeFilterOp"][];
const CAST_TYPES = ENUMS.RecipeCastType as readonly Schemas["RecipeCastType"][];
const AGG_FNS = ENUMS.RecipeAggregateFn as readonly Schemas["RecipeAggregateFn"][];
const JOIN_HOWS = ENUMS.RecipeJoinHow as readonly Schemas["RecipeJoinHow"][];

type Scalar = string | number | boolean;

/** A new step of a type with empty parameters (the editor checks them before sending). */
export function newStep(type: StepType, joinable: string[]): RecipeStep {
  switch (type) {
    case "select_columns":
      return { type, columns: [] };
    case "filter_rows":
      return { type, column: "", op: "eq", value: "" };
    case "drop_missing":
      return { type, columns: null };
    case "fill_missing":
      return { type, column: "", value: "" };
    case "cast_type":
      return { type, column: "", to: "float" };
    case "convert_unit":
      return { type, column: "", factor: 1, offset: 0, unit_label: "" };
    case "aggregate":
      return { type, group_by: [], metrics: [{ column: "", fn: "mean" }] };
    case "join":
      return { type, right_input_id: joinable[0] ?? "", on: [], how: "left" };
    case "sort":
      return { type, by: [], descending: false };
    case "limit":
      return { type, n: 1000 };
  }
}

/**
 * Typed text → JSON value, as the step needs it: integers and decimals become numbers, true/false booleans, and
 * anything in double quotes stays text ("300" compares with a text column).
 */
export function parseScalar(text: string): Scalar {
  const s = text.trim();
  if (/^".*"$/.test(s) && s.length >= 2) return s.slice(1, -1);
  if (/^-?(0|[1-9][0-9]*)$/.test(s) && Number.isSafeInteger(Number(s))) return Number(s);
  if (/^-?(0|[1-9][0-9]*)?\.[0-9]+$|^-?(0|[1-9][0-9]*)(\.[0-9]+)?[eE][+-]?[0-9]+$/.test(s)) return Number(s);
  if (/^(true|false)$/i.test(s)) return s.toLowerCase() === "true";
  return text;
}

export type ColumnType = Schemas["ColumnProfile"]["type"];

/**
 * Typed text → value for a column of a known type (the catalog's column profile): text and date columns take text,
 * integer/number columns numbers, boolean columns true/false. Double quotes always force text. Unknown type (no
 * profile): the parseScalar heuristic.
 */
export function parseFor(type: ColumnType | undefined): (text: string) => Scalar {
  return (text) => {
    const s = text.trim();
    if (/^".*"$/.test(s) && s.length >= 2) return s.slice(1, -1);
    if (!type) return parseScalar(text);
    if (type === "integer" || type === "number") return s !== "" && Number.isFinite(Number(s)) ? Number(s) : text;
    if (type === "boolean") return /^(true|false)$/i.test(s) ? s.toLowerCase() === "true" : text;
    return text;
  };
}

export const formatScalar = (v: unknown): string => (v === null || v === undefined ? "" : Array.isArray(v) ? v.map(formatScalar).join(", ") : String(v));

/** Missing parameters, checked before a preview or a save (the server checks the rest against the data). */
export function stepProblem(step: RecipeStep, recipeInputIds: string[]): string | null {
  const blank = (s: string) => !s.trim();
  switch (step.type) {
    case "select_columns":
      return step.columns.length ? null : "columns";
    case "filter_rows":
      if (blank(step.column)) return "column";
      if (step.op === "is_null" || step.op === "not_null") return null;
      if (step.op === "in") return Array.isArray(step.value) && step.value.length ? null : "value";
      return step.value === "" || step.value === undefined || step.value === null ? "value" : null;
    case "drop_missing":
      return step.columns && !step.columns.length ? "columns" : null;
    case "fill_missing":
      if (blank(step.column)) return "column";
      return step.value === "" ? "value" : null;
    case "cast_type":
      return blank(step.column) ? "column" : null;
    case "convert_unit":
      if (blank(step.column)) return "column";
      if (!Number.isFinite(step.factor) || !Number.isFinite(step.offset)) return "number";
      return blank(step.unit_label) ? "unit" : null;
    case "aggregate":
      return step.metrics.length && step.metrics.every((m) => !blank(m.column)) ? null : "metrics";
    case "join":
      if (!step.right_input_id || !recipeInputIds.includes(step.right_input_id) || step.right_input_id === recipeInputIds[0]) return "right";
      return step.on.length ? null : "on";
    case "sort":
      return step.by.length ? null : "by";
    case "limit":
      return Number.isInteger(step.n) && step.n >= 1 && step.n <= 5_000_000 ? null : "n";
  }
}

/** One labelled control in a step form. */
function Field({ id, label, children, wide }: { id: string; label: string; children: ReactNode; wide?: boolean }) {
  return (
    <div className={wide ? "flex min-w-0 flex-col gap-1.5 sm:col-span-2" : "flex min-w-0 flex-col gap-1.5"}>
      <Label htmlFor={id}>{label}</Label>
      {children}
    </div>
  );
}

/** Text field that keeps what was typed and reports the parsed value (so "3." or "-" can be typed on the way). */
function TextValue({
  id,
  value,
  onChange,
  disabled,
  inputMode,
  parse,
  rule = "",
}: {
  id: string;
  value: unknown;
  onChange: (v: never) => void;
  disabled?: boolean;
  inputMode?: "decimal" | "numeric";
  parse: (s: string) => unknown;
  /** Names the parse rule (the column's type); when it changes, the typed text is read again under the new rule. */
  rule?: string;
}) {
  const [text, setText] = useState(formatScalar(value));
  const lastRule = useRef(rule);
  useEffect(() => {
    if (lastRule.current === rule) return;
    lastRule.current = rule;
    if (text.trim() !== "") (onChange as (v: unknown) => void)(parse(text));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when the rule changes
  }, [rule]);
  return (
    <Input
      id={id}
      value={text}
      disabled={disabled}
      inputMode={inputMode}
      autoComplete="off"
      onChange={(e) => {
        setText(e.target.value);
        (onChange as (v: unknown) => void)(parse(e.target.value));
      }}
    />
  );
}

const toNumber = (s: string) => (s.trim() === "" ? Number.NaN : Number(s));

/** One column name, with the known columns as suggestions. */
function ColumnField({ id, label, value, onChange, columnsListId, disabled }: { id: string; label: string; value: string; onChange: (v: string) => void; columnsListId: string; disabled?: boolean }) {
  return (
    <Field id={id} label={label}>
      <Input id={id} value={value} list={columnsListId} autoComplete="off" spellCheck={false} disabled={disabled} className="font-mono text-mono" onChange={(e) => onChange(e.target.value)} />
    </Field>
  );
}

/** Several column names: the chosen ones as removable tags and a field (with suggestions) to add one more. */
function ColumnsField({ id, label, value, onChange, columnsListId, disabled }: { id: string; label: string; value: string[]; onChange: (v: string[]) => void; columnsListId: string; disabled?: boolean }) {
  const t = useTranslations();
  const [draft, setDraft] = useState("");
  const add = () => {
    const names = draft.split(",").map((s) => s.trim()).filter((s) => s && !value.includes(s));
    if (names.length) onChange([...value, ...names]);
    setDraft("");
  };
  return (
    <div className="flex min-w-0 flex-col gap-1.5 sm:col-span-2">
      <Label htmlFor={id}>{label}</Label>
      {value.length ? (
        <ul className="flex flex-wrap gap-1.5" aria-label={label}>
          {value.map((c) => (
            <li key={c}>
              <Tag className="font-mono text-mono" onRemove={disabled ? undefined : () => onChange(value.filter((x) => x !== c))} removeLabel={t("workspace.recipe.removeColumn", { column: c })}>
                {c}
              </Tag>
            </li>
          ))}
        </ul>
      ) : null}
      {disabled ? null : (
        <div className="flex gap-2">
          <Input
            id={id}
            value={draft}
            list={columnsListId}
            autoComplete="off"
            spellCheck={false}
            className="font-mono text-mono"
            placeholder={t("workspace.recipe.addColumnPlaceholder")}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                add();
              }
            }}
          />
          <Button variant="secondary" onClick={add} disabled={!draft.trim()}>
            {t("workspace.recipe.addColumn")}
          </Button>
        </div>
      )}
    </div>
  );
}

function EnumSelect<T extends string>({ id, label, value, options, enumName, onChange, disabled }: { id: string; label: string; value: T; options: readonly T[]; enumName: string; onChange: (v: T) => void; disabled?: boolean }) {
  const t = useTranslations();
  return (
    <Field id={id} label={label}>
      <Select id={id} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value as T)}>
        {options.map((o) => (
          <option key={o} value={o}>
            {(t as (k: string) => string)(`enums.${enumName}.${o}`)}
          </option>
        ))}
      </Select>
    </Field>
  );
}

/**
 * The parameters of one step, as a small form per step type (contract RecipeStep). `inputName` labels the recipe's
 * other inputs for a join.
 */
export function StepForm({
  step,
  onChange,
  columnsListId,
  joinable,
  inputName,
  columnType = () => undefined,
  disabled,
}: {
  step: RecipeStep;
  onChange: (step: RecipeStep) => void;
  columnsListId: string;
  joinable: string[];
  inputName: (inputId: string) => string;
  /** The column's type from the inputs' column profiles, when known. */
  columnType?: (column: string) => ColumnType | undefined;
  disabled?: boolean;
}) {
  const t = useTranslations();
  const id = useId();
  const f = (k: string) => `${id}-${k}`;
  const common = { columnsListId, disabled };
  const grid = (children: ReactNode) => <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">{children}</div>;

  switch (step.type) {
    case "select_columns":
      return grid(<ColumnsField id={f("columns")} label={t("workspace.recipe.field.keepColumns")} value={step.columns} onChange={(columns) => onChange({ ...step, columns })} {...common} />);
    case "filter_rows": {
      const noValue = step.op === "is_null" || step.op === "not_null";
      return grid(
        <>
          <ColumnField id={f("column")} label={t("workspace.recipe.field.column")} value={step.column} onChange={(column) => onChange({ ...step, column })} {...common} />
          <EnumSelect
            id={f("op")}
            label={t("workspace.recipe.field.op")}
            value={step.op}
            options={FILTER_OPS}
            enumName="RecipeFilterOp"
            disabled={disabled}
            onChange={(op) => {
              const { value: _old, ...rest } = step;
              void _old;
              if (op === "is_null" || op === "not_null") onChange({ ...rest, op });
              else if (op === "in") onChange({ ...rest, op, value: Array.isArray(step.value) ? step.value : step.value === undefined || step.value === null || step.value === "" ? [] : [step.value as string | number] });
              else onChange({ ...rest, op, value: Array.isArray(step.value) ? (step.value[0] ?? "") : (step.value ?? "") });
            }}
          />
          {noValue ? null : (
            <Field id={f("value")} label={step.op === "in" ? t("workspace.recipe.field.values") : t("workspace.recipe.field.value")} wide>
              <TextValue
                key={step.op === "in" ? "list" : "one"}
                id={f("value")}
                value={step.value}
                disabled={disabled}
                rule={columnType(step.column) ?? ""}
                parse={(s) => {
                  const read = parseFor(columnType(step.column));
                  return step.op === "in"
                    ? s.split(",").map((x) => x.trim()).filter(Boolean).map((x) => {
                        const v = read(x);
                        return typeof v === "boolean" ? x : v;
                      })
                    : s.trim() === ""
                      ? ""
                      : read(s);
                }}
                onChange={((value: Schemas["RecipeStepFilterRows"]["value"]) => onChange({ ...step, value })) as (v: never) => void}
              />
              <p className="text-small text-fg-muted">
                {[step.op === "in" ? t("workspace.recipe.valuesHint") : null, columnType(step.column) ? t("workspace.recipe.columnType", { type: t(`workspace.recipe.type.${columnType(step.column)}`) }) : t("workspace.recipe.valueHint")]
                  .filter(Boolean)
                  .join(" ")}
              </p>
            </Field>
          )}
        </>,
      );
    }
    case "drop_missing":
      return grid(
        <>
          <div className="flex items-center gap-2 sm:col-span-2">
            <Checkbox id={f("any")} checked={step.columns === null} disabled={disabled} onChange={(e) => onChange({ ...step, columns: e.target.checked ? null : [] })} />
            <Label htmlFor={f("any")} className="font-normal">
              {t("workspace.recipe.field.anyColumn")}
            </Label>
          </div>
          {step.columns === null ? null : <ColumnsField id={f("columns")} label={t("workspace.recipe.field.missingIn")} value={step.columns} onChange={(columns) => onChange({ ...step, columns })} {...common} />}
        </>,
      );
    case "fill_missing":
      return grid(
        <>
          <ColumnField id={f("column")} label={t("workspace.recipe.field.column")} value={step.column} onChange={(column) => onChange({ ...step, column })} {...common} />
          <Field id={f("value")} label={t("workspace.recipe.field.fillWith")}>
            <TextValue
              id={f("value")}
              value={step.value}
              disabled={disabled}
              rule={columnType(step.column) ?? ""}
              parse={(s) => (s.trim() === "" ? "" : parseFor(columnType(step.column))(s))}
              onChange={((value: Scalar) => onChange({ ...step, value })) as (v: never) => void}
            />
          </Field>
        </>,
      );
    case "cast_type":
      return grid(
        <>
          <ColumnField id={f("column")} label={t("workspace.recipe.field.column")} value={step.column} onChange={(column) => onChange({ ...step, column })} {...common} />
          <EnumSelect id={f("to")} label={t("workspace.recipe.field.castTo")} value={step.to} options={CAST_TYPES} enumName="RecipeCastType" disabled={disabled} onChange={(to) => onChange({ ...step, to })} />
        </>,
      );
    case "convert_unit":
      return (
        <div className="flex flex-col gap-2">
          {grid(
            <>
              <ColumnField id={f("column")} label={t("workspace.recipe.field.column")} value={step.column} onChange={(column) => onChange({ ...step, column })} {...common} />
              <Field id={f("unit")} label={t("workspace.recipe.field.unitLabel")}>
                <Input id={f("unit")} value={step.unit_label} maxLength={32} disabled={disabled} onChange={(e) => onChange({ ...step, unit_label: e.target.value })} />
              </Field>
              <Field id={f("factor")} label={t("workspace.recipe.field.factor")}>
                <TextValue id={f("factor")} value={step.factor} inputMode="decimal" disabled={disabled} parse={toNumber} onChange={((factor: number) => onChange({ ...step, factor })) as (v: never) => void} />
              </Field>
              <Field id={f("offset")} label={t("workspace.recipe.field.offset")}>
                <TextValue id={f("offset")} value={step.offset} inputMode="decimal" disabled={disabled} parse={toNumber} onChange={((offset: number) => onChange({ ...step, offset })) as (v: never) => void} />
              </Field>
            </>,
          )}
          <p className="text-small text-fg-muted">{t("workspace.recipe.convertHint")}</p>
        </div>
      );
    case "aggregate":
      return grid(
        <>
          <ColumnsField id={f("group")} label={t("workspace.recipe.field.groupBy")} value={step.group_by} onChange={(group_by) => onChange({ ...step, group_by })} {...common} />
          <fieldset className="flex min-w-0 flex-col gap-2 sm:col-span-2">
            <legend className="mb-1.5 text-small font-medium text-fg">{t("workspace.recipe.field.metrics")}</legend>
            {step.metrics.map((m, i) => (
              <div key={i} className="flex flex-wrap items-end gap-2">
                <div className="min-w-0 flex-1 basis-40">
                  <ColumnField
                    id={f(`m${i}-col`)}
                    label={t("workspace.recipe.field.metricColumn", { n: i + 1 })}
                    value={m.column}
                    onChange={(column) => onChange({ ...step, metrics: step.metrics.map((x, j) => (j === i ? { ...x, column } : x)) })}
                    {...common}
                  />
                </div>
                <div className="w-36">
                  <EnumSelect
                    id={f(`m${i}-fn`)}
                    label={t("workspace.recipe.field.fn", { n: i + 1 })}
                    value={m.fn}
                    options={AGG_FNS}
                    enumName="RecipeAggregateFn"
                    disabled={disabled}
                    onChange={(fn) => onChange({ ...step, metrics: step.metrics.map((x, j) => (j === i ? { ...x, fn } : x)) })}
                  />
                </div>
                {step.metrics.length > 1 && !disabled ? (
                  <Button variant="ghost" aria-label={t("workspace.recipe.removeMetric", { n: i + 1 })} onClick={() => onChange({ ...step, metrics: step.metrics.filter((_, j) => j !== i) })}>
                    <X aria-hidden="true" strokeWidth={1.75} />
                  </Button>
                ) : null}
              </div>
            ))}
            {disabled ? null : (
              <Button variant="ghost" size="sm" className="self-start" onClick={() => onChange({ ...step, metrics: [...step.metrics, { column: "", fn: "mean" }] })}>
                <Plus aria-hidden="true" strokeWidth={1.75} />
                {t("workspace.recipe.addMetric")}
              </Button>
            )}
          </fieldset>
        </>,
      );
    case "join":
      return (
        <div className="flex flex-col gap-2">
          {grid(
            <>
              <Field id={f("right")} label={t("workspace.recipe.field.right")}>
                <Select id={f("right")} value={step.right_input_id} disabled={disabled || !joinable.length} onChange={(e) => onChange({ ...step, right_input_id: e.target.value })}>
                  {joinable.includes(step.right_input_id) ? null : <option value={step.right_input_id}>{step.right_input_id ? inputName(step.right_input_id) : t("workspace.recipe.field.pickInput")}</option>}
                  {joinable.map((i) => (
                    <option key={i} value={i}>
                      {inputName(i)}
                    </option>
                  ))}
                </Select>
              </Field>
              <EnumSelect id={f("how")} label={t("workspace.recipe.field.how")} value={step.how} options={JOIN_HOWS} enumName="RecipeJoinHow" disabled={disabled} onChange={(how) => onChange({ ...step, how })} />
              <ColumnsField id={f("on")} label={t("workspace.recipe.field.on")} value={step.on} onChange={(on) => onChange({ ...step, on })} {...common} />
            </>,
          )}
          {joinable.length ? null : <p className="text-small text-fg-muted">{t("workspace.recipe.joinHint")}</p>}
        </div>
      );
    case "sort":
      return grid(
        <>
          <ColumnsField id={f("by")} label={t("workspace.recipe.field.sortBy")} value={step.by} onChange={(by) => onChange({ ...step, by })} {...common} />
          <div className="flex items-center gap-2 sm:col-span-2">
            <Checkbox id={f("desc")} checked={step.descending} disabled={disabled} onChange={(e) => onChange({ ...step, descending: e.target.checked })} />
            <Label htmlFor={f("desc")} className="font-normal">
              {t("workspace.recipe.field.descending")}
            </Label>
          </div>
        </>,
      );
    case "limit":
      return grid(
        <Field id={f("n")} label={t("workspace.recipe.field.n")}>
          <TextValue id={f("n")} value={step.n} inputMode="numeric" disabled={disabled} parse={(s) => (/^\d+$/.test(s.trim()) ? Number(s.trim()) : Number.NaN)} onChange={((n: number) => onChange({ ...step, n })) as (v: never) => void} />
        </Field>,
      );
  }
}
