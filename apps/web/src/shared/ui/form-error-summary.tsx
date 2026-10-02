"use client";
import { CircleAlert } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useRef } from "react";

/** WCAG 3.3.1: summary of all errors, focused on failed submit, each item links to its field. */
export function FormErrorSummary({ errors }: { errors: { id: string; message: string }[] }) {
  const t = useTranslations();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (errors.length) ref.current?.focus();
  }, [errors]);
  if (!errors.length) return null;
  return (
    <div
      ref={ref}
      tabIndex={-1}
      role="alert"
      className="flex gap-3 rounded-md border border-danger-line bg-danger-soft p-3 outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
    >
      <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-danger" strokeWidth={1.75} />
      <div className="min-w-0">
        <p className="text-body font-semibold text-danger">{t("common.formErrors", { count: errors.length })}</p>
        <ul className="mt-1 flex flex-col gap-0.5 text-small">
          {errors.map((e) => (
            <li key={e.id}>
              <a href={`#${e.id}`} className="text-fg underline decoration-danger-line underline-offset-2 hover:decoration-danger">
                {e.message}
              </a>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
