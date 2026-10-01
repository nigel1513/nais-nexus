"use client";
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
    <div ref={ref} tabIndex={-1} role="alert" className="rounded-md border border-danger p-3">
      <p className="font-medium text-danger">{t("common.formErrors", { count: errors.length })}</p>
      <ul className="mt-1 list-disc pl-5 text-sm">
        {errors.map((e) => (
          <li key={e.id}>
            <a href={`#${e.id}`} className="underline">
              {e.message}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}
