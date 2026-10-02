"use client";
import { Button, PathText, Skeleton } from "@nais/ui";
import { TriangleAlert } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { asApiError, errorMessageKey } from "@/shared/api/errors";

/**
 * Inline error for one block or screen: icon, title, the localized message, the trace id (mono, shortened in the
 * middle, copyable on plain http) and a retry action. role="alert" so it is announced.
 */
export function ErrorView({ error, onRetry, params }: { error: unknown; onRetry?: () => void; params?: Record<string, string | number> }) {
  const t = useTranslations();
  const e = asApiError(error);
  return (
    <div role="alert" className="flex gap-3 rounded-md border border-border bg-bg-panel p-4">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-danger-soft text-danger">
        <TriangleAlert aria-hidden="true" strokeWidth={1.75} className="size-4" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className="text-body font-semibold text-fg">{t("common.errorTitle")}</p>
        <p className="text-body text-fg-muted">{t(errorMessageKey(e.code), params)}</p>
        {e.traceId ? (
          <p className="mt-1 flex min-w-0 items-center gap-2 text-small text-fg-muted">
            <span className="shrink-0">{t("common.traceId")}</span>
            <PathText value={e.traceId} copyLabel={t("common.copyTraceId")} copiedLabel={t("common.copied")} className="min-w-0" />
          </p>
        ) : null}
        {onRetry ? (
          <div className="mt-2">
            <Button size="sm" variant="secondary" onClick={onRetry}>
              {t("common.retry")}
            </Button>
          </div>
        ) : null}
      </div>
    </div>
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
      <Button variant="secondary" onClick={() => fetchNextPage()} disabled={isFetchingNextPage}>
        {isFetchingNextPage ? t("common.loading") : t("common.loadMore")}
      </Button>
    </div>
  );
}
