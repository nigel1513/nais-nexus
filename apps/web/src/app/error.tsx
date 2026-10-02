"use client";
import { Button, buttonClass, PathText } from "@nais/ui";
import { ServerCrash } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { StatusPage } from "@/shared/ui/status-page";

/** Unexpected render error (500): the EmptyState pattern with the error digest as a copyable trace id. */
export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const t = useTranslations();
  return (
    <StatusPage
      icon={ServerCrash}
      tone="danger"
      code="500"
      title={t("common.errorTitle")}
      message={<p role="alert">{t("errorPage.message")}</p>}
      help={
        error.digest ? (
          <span className="mt-2 flex min-w-0 items-center gap-2">
            <span className="shrink-0">{t("common.traceId")}</span>
            <PathText value={error.digest} copyLabel={t("common.copyTraceId")} copiedLabel={t("common.copied")} className="min-w-0" />
          </span>
        ) : undefined
      }
      actions={
        <>
          <Button variant="primary" onClick={reset}>
            {t("common.retry")}
          </Button>
          <Link href="/commons" className={buttonClass("secondary")}>
            {t("notFound.home")}
          </Link>
        </>
      }
    />
  );
}
