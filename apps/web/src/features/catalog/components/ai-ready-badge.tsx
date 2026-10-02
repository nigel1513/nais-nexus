"use client";
import { cn, Popover, PopoverContent, PopoverTitle, PopoverTrigger, toneClass, type Tone } from "@nais/ui";
import { ChevronDown, Sparkles } from "lucide-react";
import { useTranslations } from "next-intl";
import { useGetReadiness } from "@/features/readiness/api";
import { CheckStatusBadge } from "@/shared/ui/badges";
import { aiReadyScore } from "../lib/ai-ready-score";
import "./v2.css";

const chip = "inline-flex h-6 items-center gap-1 whitespace-nowrap rounded-sm px-2 text-caption [&_svg]:size-3.5 [&_svg]:shrink-0";

/** Score → tone: a low score is information, not an error, so it never turns red (red is for blocking states). */
const toneOf = (score: number): Tone => (score >= 8 ? "success" : score >= 5 ? "warning" : "neutral");

/** AI-Ready score chip; opens the per-check results in a popover. Loading, error and unverified are inert chips. */
export function AiReadyBadge({ versionId }: { versionId: string }) {
  return <AiReady versionId={versionId} variant="chip" />;
}

/**
 * AI-Ready score as a compact meter (Data Card header): the score in mono, a 10-point bar in accent, and the same
 * per-check popover. The whole block is the trigger; its name reads "AI-ready 9.5/10".
 */
export function AiReadyMeter({ versionId }: { versionId: string }) {
  return <AiReady versionId={versionId} variant="meter" />;
}

function AiReady({ versionId, variant }: { versionId: string; variant: "chip" | "meter" }) {
  const t = useTranslations();
  const { data, isPending, isError } = useGetReadiness(versionId);
  const { score, checks } = aiReadyScore(data?.items ?? []);
  const label = isPending ? t("data.card.aiReadyLoading") : isError ? t("data.card.aiReadyError") : score === null ? t("data.card.aiReadyUnverified") : t("data.card.aiReady", { score: score.toFixed(1) });
  const inert = isPending || isError || score === null;
  // One trigger element in every state, so the chip is not swapped for another node when the score arrives.
  const trigger =
    variant === "chip" ? (
      <PopoverTrigger
        disabled={inert}
        className={cn(
          chip,
          toneClass[inert ? "neutral" : toneOf(score)],
          "outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus",
          inert ? "cursor-not-allowed" : "press cursor-pointer",
        )}
      >
        <Sparkles aria-hidden="true" strokeWidth={1.75} />
        <span className="num">{label}</span>
        {inert ? null : <ChevronDown aria-hidden="true" strokeWidth={1.75} />}
      </PopoverTrigger>
    ) : (
      <PopoverTrigger
        disabled={inert}
        aria-label={label}
        className={cn(
          "group -m-1.5 flex w-[calc(100%+0.75rem)] min-w-0 flex-col gap-1.5 rounded-sm p-1.5 text-left outline-none focus-visible:outline-2 focus-visible:outline-focus",
          inert ? "cursor-default" : "cursor-pointer hover:bg-bg-hover",
        )}
      >
        <span className="flex items-baseline gap-1.5">
          <span className="num font-mono text-[20px] leading-6 font-medium tracking-[-0.02em] text-fg">{score === null ? "—" : score.toFixed(1)}</span>
          <span className="num font-mono text-caption font-normal text-fg-muted">{t("data.card.hero.outOf")}</span>
          {inert ? (
            <span className="ml-auto truncate text-caption font-normal text-fg-muted">{label}</span>
          ) : (
            <ChevronDown aria-hidden="true" strokeWidth={1.75} className="ml-auto size-3.5 shrink-0 text-fg-muted transition-transform duration-150 group-data-[popup-open]:rotate-180" />
          )}
        </span>
        <span aria-hidden="true" className="block h-1.5 w-full overflow-hidden rounded-full bg-bg-active">
          {score !== null ? <span className="nx-meter-fill block h-full rounded-full bg-accent" style={{ width: `${score * 10}%` }} /> : null}
        </span>
      </PopoverTrigger>
    );
  return (
    <Popover>
      {trigger}
      <PopoverContent className="w-96">
        <PopoverTitle className="mb-3">{t("data.card.aiReadyChecks")}</PopoverTitle>
        <ul className="flex flex-col divide-y divide-border text-small">
          {checks.map((c) => (
            <li key={c.check_id} className="flex flex-col gap-1 py-2 first:pt-0 last:pb-0">
              <span className="flex items-center justify-between gap-2">
                <span className="font-medium text-fg">{t.has(`readiness.check.${c.check_id}`) ? t(`readiness.check.${c.check_id}`) : c.check_id}</span>
                <CheckStatusBadge status={c.status} />
              </span>
              {c.message ? <span className="text-fg-muted">{c.message}</span> : null}
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
