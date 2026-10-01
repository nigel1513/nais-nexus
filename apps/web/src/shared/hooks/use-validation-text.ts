"use client";
import { useTranslations } from "next-intl";

/** Zod messages are `validation.*` keys; server field messages are shown as-is. */
export function useValidationText() {
  const t = useTranslations();
  return (message?: string, values?: Record<string, string | number>) => {
    if (!message) return undefined;
    return message.startsWith("validation.") ? t(message, values) : message;
  };
}
