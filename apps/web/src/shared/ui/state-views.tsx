"use client";
import { Button, ErrorState, Skeleton } from "@nais/ui";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { asApiError, errorMessageKey } from "@/shared/api/errors";

export function ErrorView({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const t = useTranslations();
  const e = asApiError(error);
  return (
    <ErrorState
      title={t("common.errorTitle")}
      message={t(errorMessageKey(e.code))}
      traceId={e.traceId}
      traceIdLabel={t("common.traceId")}
      copyLabel={t("common.copyTraceId")}
      copiedLabel={t("common.copied")}
      copyFailedLabel={t("common.copyFailed")}
      retryLabel={t("common.retry")}
      onRetry={onRetry}
    />
  );
}

/** Layout-preserving skeleton that only appears if loading takes ≥300ms (M10 §7 — no flicker). */
export function DelayedSkeleton({ lines = 3, delayMs = 300 }: { lines?: number; delayMs?: number }) {
  const t = useTranslations();
  const [show, setShow] = useState(false);
  useEffect(() => {
    const id = setTimeout(() => setShow(true), delayMs);
    return () => clearTimeout(id);
  }, [delayMs]);
  return (
    <div role="status" aria-label={t("common.loading")} className="flex flex-col gap-2">
      {show ? Array.from({ length: lines }, (_, i) => <Skeleton key={i} className="h-6 w-full" />) : null}
    </div>
  );
}

export function LoadMore({
  hasNextPage,
  isFetchingNextPage,
  fetchNextPage,
}: {
  hasNextPage: boolean | undefined;
  isFetchingNextPage: boolean;
  fetchNextPage: () => unknown;
}) {
  const t = useTranslations();
  if (!hasNextPage) return null;
  return (
    <div className="mt-4 flex justify-center">
      <Button variant="outline" onClick={() => fetchNextPage()} disabled={isFetchingNextPage}>
        {isFetchingNextPage ? t("common.loading") : t("common.loadMore")}
      </Button>
    </div>
  );
}
