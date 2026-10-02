"use client";
import { Input, Popover, PopoverContent, PopoverTrigger, buttonClass, cn } from "@nais/ui";
import { CalendarDays, CircleAlert } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { forwardRef, type InputHTMLAttributes } from "react";
import { DayPicker, type DateRange } from "react-day-picker";
import { enUS, ko } from "react-day-picker/locale";

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const pad = (n: number) => String(n).padStart(2, "0");
export const toIsoDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export function parseIsoDate(s: string): Date | undefined {
  if (!DATE.test(s)) return undefined;
  const [y, m, d] = s.split("-").map(Number) as [number, number, number];
  const date = new Date(y, m - 1, d);
  return date.getMonth() === m - 1 ? date : undefined;
}
/** Inclusive day count of a valid, ordered range; null otherwise. */
export function rangeDays(start: string, end: string): number | null {
  const a = parseIsoDate(start);
  const b = parseIsoDate(end);
  if (!a || !b || b < a) return null;
  return Math.round((Date.UTC(b.getFullYear(), b.getMonth(), b.getDate()) - Date.UTC(a.getFullYear(), a.getMonth(), a.getDate())) / 86_400_000) + 1;
}

type InputProps = Omit<InputHTMLAttributes<HTMLInputElement>, "id" | "type">;

const DateInput = forwardRef<HTMLInputElement, InputProps & { id: string; label: string; invalid?: boolean; describedBy?: string }>(function DateInput(
  { id, label, invalid, describedBy, className, ...props },
  ref,
) {
  return (
    <>
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <Input
        ref={ref}
        id={id}
        type="text"
        inputMode="numeric"
        autoComplete="off"
        placeholder="YYYY-MM-DD"
        maxLength={10}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        className={cn("font-mono text-mono", className)}
        {...props}
      />
    </>
  );
});

/**
 * Two typeable YYYY-MM-DD inputs plus a calendar popover (react-day-picker, range mode) — spec §4 DateRangePicker.
 * The inputs stay the source of truth (react-hook-form `register` props go straight onto them); the calendar writes
 * both through `onPick`. Shows the inclusive day count once both ends are valid.
 */
export function DateRangePicker({
  id,
  label,
  startLabel,
  endLabel,
  start,
  end,
  startProps,
  endProps,
  startError,
  endError,
  onPick,
}: {
  id: string;
  label: string;
  startLabel: string;
  endLabel: string;
  start: string;
  end: string;
  startProps: InputProps & { ref?: React.Ref<HTMLInputElement> };
  endProps: InputProps & { ref?: React.Ref<HTMLInputElement> };
  startError?: string;
  endError?: string;
  onPick: (start: string, end: string) => void;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const from = parseIsoDate(start);
  const to = parseIsoDate(end);
  const days = rangeDays(start, end);
  const startId = `${id}-start`;
  const endId = `${id}-end`;
  const errors = [startError ? [`${startId}-error`, startError] : null, endError && endError !== startError ? [`${endId}-error`, endError] : null].filter(
    (x): x is [string, string] => !!x,
  );
  const navButton = buttonClass("ghost", "sm", "w-7 px-0");

  return (
    <div role="group" aria-labelledby={`${id}-label`} className="flex flex-col gap-1.5">
      <span id={`${id}-label`} className="text-small font-medium text-fg">
        {label}
      </span>
      <div className="flex items-center gap-1.5">
        <DateInput {...startProps} id={startId} label={startLabel} invalid={!!startError} describedBy={startError ? `${startId}-error` : undefined} />
        <span aria-hidden="true" className="shrink-0 text-fg-muted">
          →
        </span>
        <DateInput {...endProps} id={endId} label={endLabel} invalid={!!endError} describedBy={endError ? `${endError === startError ? startId : endId}-error` : undefined} />
        <Popover>
          <PopoverTrigger aria-label={t("data.form.periodCalendar")} className={buttonClass("secondary", "md", "w-8 shrink-0 px-0")}>
            <CalendarDays aria-hidden="true" strokeWidth={1.75} />
          </PopoverTrigger>
          <PopoverContent align="end" className="p-3">
            <DayPicker
              mode="range"
              locale={locale === "en" ? enUS : ko}
              selected={{ from, to } as DateRange}
              defaultMonth={from ?? to}
              onSelect={(r) => onPick(r?.from ? toIsoDate(r.from) : "", r?.to ? toIsoDate(r.to) : "")}
              classNames={{
                root: "text-small text-fg",
                months: "relative flex flex-col",
                month: "flex flex-col gap-2",
                month_caption: "flex h-7 items-center justify-center px-8 text-small font-semibold",
                nav: "absolute inset-x-0 top-0 flex items-center justify-between",
                button_previous: navButton,
                button_next: navButton,
                chevron: "size-4 fill-fg-muted",
                month_grid: "border-collapse",
                weekday: "size-8 text-caption font-normal text-fg-muted",
                day: "size-8 p-0 text-center",
                day_button: "num size-8 cursor-pointer rounded-sm text-small outline-none hover:bg-bg-hover focus-visible:outline-2 focus-visible:outline-focus",
                today: "font-semibold text-accent-fg",
                outside: "text-fg-subtle",
                disabled: "text-fg-subtle",
                selected: "[&>button]:bg-primary [&>button]:text-primary-fg [&>button]:hover:bg-primary-hover",
                range_middle: "bg-accent-soft [&>button]:!bg-transparent [&>button]:!text-fg [&>button]:hover:!bg-bg-hover",
                range_start: "rounded-l-sm bg-accent-soft",
                range_end: "rounded-r-sm bg-accent-soft",
              }}
            />
          </PopoverContent>
        </Popover>
      </div>
      {days !== null ? (
        <p className="num text-small text-fg-muted" aria-live="polite">
          {t("data.form.periodDays", { count: days })}
        </p>
      ) : null}
      {errors.map(([eid, msg]) => (
        <p key={eid} id={eid} className="flex items-start gap-1.5 text-small text-danger">
          <CircleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" strokeWidth={2} />
          {msg}
        </p>
      ))}
    </div>
  );
}
