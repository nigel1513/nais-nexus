"use client";
import { useTranslations } from "next-intl";

const REASON_CODE = /^[A-Z][A-Z0-9_]*$/;

/**
 * Zod messages are `validation.*` keys; server field reasons (UPPER_SNAKE codes) map to `validation.reason.*`
 * with a localized generic fallback; any other server text is shown as-is.
 */
export function useValidationText() {
  const t = useTranslations();
  return (message?: string, values?: Record<string, string | number>) => {
    if (!message) return undefined;
    if (message.startsWith("validation.")) return t(message, values);
    if (REASON_CODE.test(message)) return t.has(`validation.reason.${message}`) ? t(`validation.reason.${message}`) : t("validation.reason.generic");
    return message;
  };
}
