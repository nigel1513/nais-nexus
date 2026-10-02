"use client";
import { useTranslations } from "next-intl";
import { useRef, useState } from "react";

export type Decision = "approve" | "change" | "reject";

const TONE = { approve: "ok", change: "warn", reject: "bad" } as const;
const CHIP = { approve: "approved", change: "changed", reject: "rejected" } as const;
const STEP = { approve: "logApproved", change: "logChanged", reject: "logRejected" } as const;

/**
 * The access-request panel as an owner sees it. The buttons only change this page: they show what each decision
 * leaves in the request history. New history rows rise in (260ms), the status chip's
 * colour cross-fades; focus moves to "처음으로" and back so keyboard users never lose their place.
 */
export function AccessDemo({ onDecide }: { onDecide?: (d: Decision | null) => void }) {
  const t = useTranslations("landing");
  const [decision, setDecision] = useState<Decision | null>(null);
  const resetRef = useRef<HTMLButtonElement>(null);
  const approveRef = useRef<HTMLButtonElement>(null);

  const decide = (d: Decision | null) => {
    setDecision(d);
    onDecide?.(d);
    requestAnimationFrame(() => (d ? resetRef.current : approveRef.current)?.focus({ preventScroll: true }));
  };

  return (
    <div className="lp-panel lp-ui">
      <div className="lp-ui-head">
        <div className="lp-crumbs">{t("sample.requestNo")}</div>
        <div className="lp-ui-title sm">{t("sample.dataset")} · v3</div>
        <div className="lp-ui-meta">{t("sample.route")}</div>
      </div>
      <dl className="lp-dl">
        <dt>{t("ui.purpose")}</dt>
        <dd>{t("sample.purpose")}</dd>
        <dt>{t("ui.period")}</dt>
        <dd className="lp-mono">{t("sample.period")}</dd>
        <dt>{t("ui.scope")}</dt>
        <dd>{t("sample.scope")}</dd>
        <dt>{t("ui.status")}</dt>
        <dd>
          <span className="lp-chip" data-tone={decision ? TONE[decision] : "warn"} role="status">
            {t(`ui.${decision ? CHIP[decision] : "pending"}`)}
          </span>
        </dd>
      </dl>
      <ol className="lp-timeline">
        <li data-state="done">
          <span>{t("ui.logSubmitted")}</span>
          <time>10-02 09:14</time>
        </li>
        {decision ? (
          <li key={decision} data-state="done" data-enter="">
            <span>{t(`ui.${STEP[decision]}`)}</span>
            <time>{t("ui.justNow")}</time>
          </li>
        ) : (
          <li data-state="now">
            <span>{t("ui.logReview")}</span>
            <time>{t("ui.inProgress")}</time>
          </li>
        )}
        {decision === "approve" ? (
          <li data-enter="">
            <span>{t("ui.logAutoClose")}</span>
            <time>03-31</time>
          </li>
        ) : null}
        {decision === "change" ? (
          <li data-state="now" data-enter="">
            <span>{t("ui.logAwaitFix")}</span>
            <time>{t("ui.inProgress")}</time>
          </li>
        ) : null}
      </ol>
      <div className="lp-actions">
        {decision ? (
          <button ref={resetRef} type="button" className="lp-btn lp-btn-sm lp-btn-sec" onClick={() => decide(null)}>
            {t("ui.reset")}
          </button>
        ) : (
          <>
            <button ref={approveRef} type="button" className="lp-btn lp-btn-sm lp-btn-pri" onClick={() => decide("approve")}>
              {t("ui.approve")}
            </button>
            <button type="button" className="lp-btn lp-btn-sm lp-btn-sec" onClick={() => decide("change")}>
              {t("ui.change")}
            </button>
            <button type="button" className="lp-btn lp-btn-sm lp-btn-dan" onClick={() => decide("reject")}>
              {t("ui.reject")}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
