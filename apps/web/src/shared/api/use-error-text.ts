"use client";
import { useTranslations } from "next-intl";
import { asApiError, errorMessageKey } from "./errors";

export function useErrorText(): (error: unknown, params?: Record<string, string | number>) => string {
  const t = useTranslations();
  return (error: unknown, params) => t(errorMessageKey(asApiError(error).code), params);
}
