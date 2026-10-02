"use client";
import { cn, focusRing } from "@nais/ui";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";

export const CARD_SECTIONS = ["overview", "files", "schema", "meta"] as const;
export type CardSection = (typeof CARD_SECTIONS)[number];
export const sectionId = (s: CardSection) => `card-${s}`;

/**
 * In-page section nav under the tabs (개요 · 파일·분포 · 스키마 · 메타데이터). Sticks below the top bar; the section in the
 * upper part of the viewport is the current one (IntersectionObserver, nothing per scroll frame). A click jumps
 * without a smooth scroll and moves focus to the section, so keyboard and screen-reader users land where they asked.
 */
export function SectionNav() {
  const t = useTranslations();
  const [active, setActive] = useState<CardSection>("overview");
  const [stuck, setStuck] = useState(false);
  const sentinel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const els = CARD_SECTIONS.map((s) => document.getElementById(sectionId(s))).filter((e): e is HTMLElement => !!e);
    let atEnd = false;
    // Current = the last section whose top has passed 45% of the viewport (the band's lower edge); the band observer
    // below only says when that can have changed, so nothing runs per scroll frame.
    const pick = () => {
      const line = window.innerHeight * 0.45;
      const current = atEnd ? CARD_SECTIONS.at(-1) : [...CARD_SECTIONS].reverse().find((s) => (document.getElementById(sectionId(s))?.getBoundingClientRect().top ?? Infinity) < line);
      setActive(current ?? "overview");
    };
    const band = new IntersectionObserver(pick, { rootMargin: "-112px 0px -55% 0px" });
    els.forEach((el) => band.observe(el));
    // The last section may be too short to reach the band: reaching the end of the card makes it current.
    const end = document.getElementById("card-end");
    const tail = new IntersectionObserver((entries) => {
      atEnd = window.scrollY > 0 && entries.some((e) => e.isIntersecting);
      pick();
    });
    if (end) tail.observe(end);
    // Once the nav sticks under the top bar it gets a rule, so content scrolling under it reads as underneath.
    const stick = new IntersectionObserver(([e]) => setStuck(!!e && !e.isIntersecting && e.boundingClientRect.top < 64), { rootMargin: "-48px 0px 0px 0px" });
    if (sentinel.current) stick.observe(sentinel.current);
    return () => {
      band.disconnect();
      tail.disconnect();
      stick.disconnect();
    };
  }, []);

  const go = (s: CardSection) => (e: React.MouseEvent<HTMLAnchorElement>) => {
    const el = document.getElementById(sectionId(s));
    if (!el) return;
    e.preventDefault();
    el.scrollIntoView?.({ block: "start", behavior: "instant" });
    el.focus({ preventScroll: true });
    setActive(s);
  };

  return (
    <>
      <div ref={sentinel} aria-hidden="true" className="h-px" />
      <nav
        aria-label={t("data.card.sectionNav")}
        data-stuck={stuck ? "" : undefined}
        className="sticky top-12 z-[var(--z-sticky)] -mx-1 border-b border-transparent bg-bg px-1 py-2 data-[stuck]:border-border"
      >
        <ul className="flex gap-1 overflow-x-auto [scrollbar-width:none]">
          {CARD_SECTIONS.map((s) => (
            <li key={s} className="shrink-0">
              <a
                href={`#${sectionId(s)}`}
                onClick={go(s)}
                aria-current={active === s ? "location" : undefined}
                className={cn(
                  "flex h-7 items-center rounded-full px-3 text-caption whitespace-nowrap text-fg-muted transition-colors duration-[var(--dur-fast)] hover:text-fg",
                  "aria-[current=location]:bg-accent-soft aria-[current=location]:text-accent-fg",
                  focusRing,
                )}
              >
                {t(`data.card.nav.${s}`)}
              </a>
            </li>
          ))}
        </ul>
      </nav>
    </>
  );
}
