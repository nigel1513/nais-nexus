"use client";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { ColumnProfiles } from "./column-profiles";

const KEYS = ["access", "data", "project"] as const;
const ADVANCE_MS = 6000;
/** How far each window drifts toward the pointer, in px; the centre one moves least so it reads as nearest. */
const DEPTH = [10, 5, 10];

function AccessWindow() {
  const t = useTranslations("landing");
  return (
    <>
      <div className="lp-ui-head">
        <div className="lp-crumbs">{t("sample.accessCrumb")}</div>
        <div className="lp-ui-title">{t("sample.dataset")}</div>
        <div className="lp-ui-meta">{t("sample.requester")}</div>
      </div>
      <dl className="lp-dl">
        <dt>{t("ui.purpose")}</dt>
        <dd>{t("sample.purpose")}</dd>
        <dt>{t("ui.period")}</dt>
        <dd className="lp-mono">{t("sample.period")}</dd>
        <dt>{t("ui.scope")}</dt>
        <dd>{t("sample.scopeShort")}</dd>
      </dl>
      <div className="lp-actions">
        <span className="lp-chip" data-tone="warn">
          {t("ui.pending")}
        </span>
      </div>
    </>
  );
}

function DataWindow() {
  const t = useTranslations("landing");
  return (
    <>
      <div className="lp-ui-head">
        <div className="lp-crumbs">{t("sample.dataCrumb")}</div>
        <div className="lp-ui-title">{t("sample.dataset")}</div>
        <div className="lp-ui-meta">
          <span className="lp-mono">v3</span>
          <span>{t("sample.files")}</span>
          <span className="lp-chip" data-tone="accent">
            {t("sample.aiReady")}
          </span>
        </div>
      </div>
      <ColumnProfiles grow="mount" label={t("data.profiles")} />
    </>
  );
}

function ProjectWindow() {
  const t = useTranslations("landing");
  const people: Array<[string, "a" | "b" | undefined, string]> = [
    ["이소재", "a", t("sample.orgA")],
    ["김연구", "b", t("sample.orgB")],
    ["박분석", undefined, t("sample.orgB")],
  ];
  return (
    <>
      <div className="lp-ui-head">
        <div className="lp-crumbs">{t("sample.projectCrumb")}</div>
        <div className="lp-ui-title">{t("sample.project")}</div>
        <div className="lp-ui-meta">{t("sample.projectMetaShort")}</div>
      </div>
      <table className="lp-rows">
        <tbody>
          {people.map(([name, org, inst]) => (
            <tr key={name}>
              <td>
                <span className="lp-who">
                  <span className="lp-av" data-org={org} aria-hidden>
                    {name[0]}
                  </span>
                  {name}
                </span>
              </td>
              <td>{inst}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

const BODIES = { access: AccessWindow, data: DataWindow, project: ProjectWindow };

/**
 * Three product windows hanging over the hero's edge (Observable home). One is in focus: tabs and dots pick it,
 * and it advances every 6s unless the pointer or keyboard focus is in the stage or the tab is hidden. On desktop
 * the windows drift a few px toward the pointer. Reduced motion: no auto-advance, no drift.
 */
export function HeroWindows() {
  const t = useTranslations("landing.windows");
  const [focus, setFocus] = useState(1);
  const [swap, setSwap] = useState(0);
  const paused = useRef(false);
  const stage = useRef<HTMLDivElement>(null);
  const wins = useRef<Array<HTMLDivElement | null>>([]);
  const [tick, setTick] = useState(0); // restarts the auto-advance timer after a manual pick

  const pick = (i: number) => {
    setFocus(i);
    setSwap((n) => n + 1);
    setTick((n) => n + 1);
  };

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const id = window.setInterval(() => {
      if (paused.current || document.hidden) return;
      setFocus((f) => (f + 1) % KEYS.length);
      setSwap((n) => n + 1);
    }, ADVANCE_MS);
    return () => window.clearInterval(id);
  }, [tick]);

  useEffect(() => {
    const el = stage.current;
    const hero = el?.closest<HTMLElement>(".lp-hero");
    if (!el || !hero) return;
    if (!window.matchMedia("(hover: hover) and (pointer: fine)").matches || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let tx = 0, ty = 0, x = 0, y = 0, raf = 0;
    const step = () => {
      x += (tx - x) * 0.08;
      y += (ty - y) * 0.08;
      wins.current.forEach((w, k) => {
        if (w) w.style.transform = `translate3d(${(x * DEPTH[k]!).toFixed(2)}px, ${(y * DEPTH[k]! * 0.6).toFixed(2)}px, 0)`;
      });
      raf = Math.abs(tx - x) + Math.abs(ty - y) > 0.001 ? requestAnimationFrame(step) : 0;
    };
    const move = (e: PointerEvent) => {
      const r = hero.getBoundingClientRect();
      tx = ((e.clientX - r.left) / r.width) * 2 - 1;
      ty = ((e.clientY - r.top) / r.height) * 2 - 1;
      if (!raf) raf = requestAnimationFrame(step);
    };
    const leave = () => {
      tx = 0;
      ty = 0;
      if (!raf) raf = requestAnimationFrame(step);
    };
    hero.addEventListener("pointermove", move);
    hero.addEventListener("pointerleave", leave);
    return () => {
      hero.removeEventListener("pointermove", move);
      hero.removeEventListener("pointerleave", leave);
      cancelAnimationFrame(raf);
    };
  }, []);

  return (
    <div
      ref={stage}
      className="lp-stage"
      onPointerEnter={() => (paused.current = true)}
      onPointerLeave={() => (paused.current = false)}
      onFocus={() => (paused.current = true)}
      onBlur={() => (paused.current = false)}
    >
      <div className="lp-wrap">
        <div className="lp-shelf">
          {KEYS.map((key, i) => {
            const Body = BODIES[key];
            return (
              <div
                key={key}
                ref={(el) => {
                  wins.current[i] = el;
                }}
                className="lp-win"
                data-focus={focus === i ? "" : undefined}
                data-swap={focus === i && swap > 0 ? "" : undefined}
              >
                <div className="lp-win-card">
                  <button type="button" className="lp-win-tab" aria-pressed={focus === i} onClick={() => pick(i)}>
                    <i aria-hidden />
                    {t(key)}
                  </button>
                  <div className="lp-win-body lp-ui">
                    <Body />
                  </div>
                </div>
              </div>
            );
          })}
        </div>
        <div className="lp-dots" role="group" aria-label={t("pick")}>
          {KEYS.map((key, i) => (
            <button key={key} type="button" aria-pressed={focus === i} aria-label={t(key)} onClick={() => pick(i)}>
              <span aria-hidden />
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
