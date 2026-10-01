"use client";
import { useTranslations } from "next-intl";
import { asApiError, errorMessageKey } from "./errors";

export function useErrorText(): (error: unknown) => string {
  const t = useTranslations();
  return (error: unknown) => t(errorMessageKey(asApiError(error).code));
}
