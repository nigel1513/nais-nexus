import { Check, ChevronDown, CircleAlert } from "lucide-react";
import * as React from "react";
import { cn } from "./cn";
import { field, iconStroke } from "./styles";

/** 32px text input (spec §4 Input). Error state comes from aria-invalid (FormField sets it). */
export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...props }, ref) {
  return <input ref={ref} className={cn(field, className)} {...props} />;
});

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea(
  { className, ...props },
  ref,
) {
  return <textarea ref={ref} className={cn(field, "h-auto min-h-24 py-1.5 leading-[22px]", className)} {...props} />;
});

/**
 * Native <select>, restyled: keeps react-hook-form `register`, the platform picker on phones and form submission.
 * `className` goes on the wrapper (width). For a styled listbox use SelectMenu.
 */
export const Select = React.forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(function Select(
  { className, ...props },
  ref,
) {
  return (
    <span className={cn("relative block w-full", className)}>
      <select ref={ref} className={cn(field, "cursor-pointer appearance-none pr-8")} {...props} />
      <ChevronDown aria-hidden="true" strokeWidth={iconStroke} className="pointer-events-none absolute right-2.5 top-1/2 size-4 -translate-y-1/2 text-fg-muted" />
    </span>
  );
});

/**
 * Native checkbox, drawn as a 16px box (spec §4). The real input covers a 24px target over the box, so it stays
 * clickable and keyboard/form compatible; checked = --primary face.
 */
export const Checkbox = React.forwardRef<HTMLInputElement, Omit<React.InputHTMLAttributes<HTMLInputElement>, "type">>(function Checkbox(
  { className, ...props },
  ref,
) {
  return (
    <span className={cn("relative inline-flex size-4 shrink-0 align-middle", className)}>
      <input ref={ref} type="checkbox" className="peer absolute -inset-1 z-10 m-0 cursor-pointer appearance-none opacity-0 disabled:cursor-not-allowed" {...props} />
      <span
        aria-hidden="true"
        className={cn(
          "pointer-events-none flex size-4 items-center justify-center rounded-xs border border-border-strong bg-bg-panel text-primary-fg",
          "peer-checked:border-primary peer-checked:bg-primary peer-disabled:opacity-50",
          "peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-focus",
          "peer-aria-[invalid=true]:border-danger [&>svg]:invisible peer-checked:[&>svg]:visible",
        )}
      >
        <Check className="size-3" strokeWidth={3} />
      </span>
    </span>
  );
});

export function Label({ className, ...props }: React.LabelHTMLAttributes<HTMLLabelElement>) {
  // eslint-disable-next-line jsx-a11y/label-has-associated-control -- htmlFor is passed by callers
  return <label className={cn("text-small font-medium text-fg", className)} {...props} />;
}

export type FieldA11y = { id: string; "aria-describedby"?: string; "aria-invalid"?: boolean; "aria-required"?: boolean };

/** Label, control, hint and error wired together; the error is read with the control (aria-describedby). */
export function FormField({
  id,
  label,
  required,
  requiredLabel,
  hint,
  error,
  children,
  className,
}: {
  id: string;
  label: string;
  required?: boolean;
  requiredLabel?: string;
  hint?: React.ReactNode;
  error?: string;
  children: (a11y: FieldA11y) => React.ReactNode;
  className?: string;
}) {
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [errorId, hintId].filter(Boolean).join(" ") || undefined;
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <Label htmlFor={id}>
        {label}
        {required && requiredLabel ? <span className="ml-1 font-normal text-fg-muted">{requiredLabel}</span> : null}
      </Label>
      {children({ id, "aria-describedby": describedBy, "aria-invalid": error ? true : undefined, "aria-required": required || undefined })}
      {hint ? (
        <p id={hintId} className="text-small text-fg-muted">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} className="flex items-start gap-1.5 text-small text-danger">
          <CircleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" strokeWidth={2} />
          {error}
        </p>
      ) : null}
    </div>
  );
}
