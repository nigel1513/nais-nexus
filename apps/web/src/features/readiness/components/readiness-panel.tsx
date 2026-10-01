"use client";
import { Button, Card, CardContent, CardHeader, CardTitle, EmptyState, FormField, Select, Table, TBody, Td, Th, THead, Tr } from "@nais/ui";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { useErrorText } from "@/shared/api/use-error-text";
import type { ReadinessValidation } from "@/shared/api/types";
import { CheckStatusBadge, ReadinessBadge, RunStatusBadge } from "@/shared/ui/badges";
import { DateTime } from "@/shared/ui/date-text";
import { DelayedSkeleton, ErrorView } from "@/shared/ui/state-views";
import { useToast } from "@/shared/ui/toast";
import { useGetReadiness, useListReadinessProfiles, useStartReadinessValidation } from "../api";

function ValidationCard({ v }: { v: ReadinessValidation }) {
  const t = useTranslations();
  const runErrorText = (error: string) => {
    const code = error.split(":")[0]!.trim();
    return /^[A-Z_]+$/.test(code) && t.has(`readiness.runError.${code}`) ? t(`readiness.runError.${code}`) : t("readiness.runError.generic");
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle as="h3">
          {v.profile_id} <span className="text-sm font-normal text-muted-foreground">v{v.profile_version}</span>
        </CardTitle>
        <div className="flex flex-wrap items-center gap-2">
          <RunStatusBadge status={v.run_status} />
          {v.overall_status ? <ReadinessBadge value={v.overall_status} /> : null}
          {v.completed_at ? (
            <span className="text-xs text-muted-foreground">
              <DateTime value={v.completed_at} />
            </span>
          ) : null}
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {v.summary && v.run_status === "COMPLETED" ? (
          <p className="text-sm">
            {t("readiness.summary", { pass: v.summary.pass ?? 0, warning: v.summary.warning ?? 0, fail: v.summary.fail ?? 0, na: v.summary.not_applicable ?? 0 })}
          </p>
        ) : null}
        {v.error ? <p className="text-sm text-danger">{runErrorText(v.error)}</p> : null}
        {v.checks?.length ? (
          <Table caption={t("readiness.checksCaption", { profile: v.profile_id })}>
            <THead>
              <Tr>
                <Th>{t("readiness.check")}</Th>
                <Th>{t("readiness.severityLabel")}</Th>
                <Th>{t("readiness.status")}</Th>
                <Th>{t("readiness.message")}</Th>
              </Tr>
            </THead>
            <TBody>
              {v.checks.map((c) => (
                <Tr key={c.check_id}>
                  <Td>
                    <code>{c.check_id}</code>
                  </Td>
                  <Td>{t(`readiness.severity.${c.severity}`)}</Td>
                  <Td>
                    <CheckStatusBadge status={c.status} />
                  </Td>
                  <Td>
                    {c.message}
                    {Object.keys(c.evidence ?? {}).length ? (
                      <details className="mt-1">
                        <summary className="cursor-pointer text-xs underline">{t("readiness.evidence")}</summary>
                        <pre className="mt-1 whitespace-pre-wrap break-all text-xs">{JSON.stringify(c.evidence, null, 2)}</pre>
                      </details>
                    ) : null}
                  </Td>
                </Tr>
              ))}
            </TBody>
          </Table>
        ) : null}
      </CardContent>
    </Card>
  );
}

export function ReadinessPanel({ versionId, published, steward, pollMs = 5000 }: { versionId: string; published: boolean; steward: boolean; pollMs?: number }) {
  const t = useTranslations();
  const toast = useToast();
  const errorText = useErrorText();
  const q = useGetReadiness(versionId, { enabled: published, intervalMs: pollMs });
  const profiles = useListReadinessProfiles();
  const start = useStartReadinessValidation(versionId);
  const [chosen, setChosen] = useState("");
  const profileItems = profiles.data?.items ?? [];
  const profile = chosen || profileItems[0]?.profile_id || "";
  const [announce, setAnnounce] = useState("");
  const items = q.data?.items ?? [];
  const pending = items.some((v) => v.run_status === "QUEUED" || v.run_status === "RUNNING");
  const wasPending = useRef(false);

  useEffect(() => {
    if (wasPending.current && !pending) setAnnounce(t("readiness.completedAnnounce"));
    wasPending.current = pending;
  }, [pending, t]);

  return (
    <section aria-labelledby="readiness-title" className="flex flex-col gap-3">
      <h2 id="readiness-title" className="text-lg font-semibold">
        {t("readiness.title")}
      </h2>
      {!published ? (
        <p className="text-sm text-muted-foreground">{t("readiness.notPublished")}</p>
      ) : q.isPending ? (
        <DelayedSkeleton lines={3} />
      ) : q.isError ? (
        <ErrorView error={q.error} onRetry={() => void q.refetch()} />
      ) : items.length === 0 ? (
        <EmptyState title={t("errors.READINESS_NOT_AVAILABLE")} />
      ) : (
        <div className="grid gap-4">
          {items.map((v) => (
            <ValidationCard key={v.validation_id} v={v} />
          ))}
        </div>
      )}
      {published && steward ? (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            start.mutate(profile, { onSuccess: () => toast(t("readiness.started")), onError: (err) => toast(errorText(err), "error") });
          }}
        >
          <FormField id="readiness-profile" label={t("readiness.profile")}>
            {(a11y) => (
              <Select {...a11y} value={profile} onChange={(e) => setChosen(e.target.value)}>
                {profileItems.map((p) => (
                  <option key={p.profile_id} value={p.profile_id}>
                    {p.name} ({p.profile_id})
                  </option>
                ))}
              </Select>
            )}
          </FormField>
          <Button variant="primary" type="submit" disabled={start.isPending || !profile}>
            {t("readiness.run")}
          </Button>
        </form>
      ) : null}
      <p className="sr-only" aria-live="polite">
        {announce}
      </p>
    </section>
  );
}
