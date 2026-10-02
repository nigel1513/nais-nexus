"use client";
import { useState } from "react";
import { AccessDemo, type Decision } from "./access-demo";

/** Which of the four steps (요청 · 검토 · 이용 · 종료) the demo request is in after each decision. */
const STEP_OF: Record<"none" | Decision, number> = { none: 1, approve: 2, change: 0, reject: 3 };

/**
 * The access section's panel and its step list share one state: deciding in the demo lights the step the request
 * moves to, so the list explains the panel (colour change only, 200ms).
 */
export function AccessShowcase({ steps, caption }: { steps: React.ReactNode[]; caption: string }) {
  const [decision, setDecision] = useState<Decision | null>(null);
  const active = STEP_OF[decision ?? "none"];
  return (
    <div className="lp-grid" data-flip="">
      <div className="lp-panel-wrap lp-reveal" data-delay="160">
        <AccessDemo onDecide={setDecision} />
        <p className="lp-cap">{caption}</p>
      </div>
      <div className="lp-notes">
        <ol className="lp-steps">
          {steps.map((step, i) => (
            <li key={i} className="lp-reveal" data-delay={200 + i * 60} data-active={i === active ? "" : undefined} aria-current={i === active ? "step" : undefined}>
              <span>{step}</span>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}
