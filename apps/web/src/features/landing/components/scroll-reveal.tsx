"use client";
import { useEffect, useRef } from "react";

/**
 * Once-only scroll reveal for `.lp-reveal` descendants (marketing surface only). Only elements still below the fold
 * at load are hidden, so nothing readable ever waits on an observer; `data-delay` staggers siblings, and
 * `data-shown` lets CSS start a one-off detail animation (the score meter) when its panel arrives.
 */
export function ScrollReveal({ children }: { children: React.ReactNode }) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const scope = root.current;
    if (!scope || typeof IntersectionObserver === "undefined") return;
    const below = [...scope.querySelectorAll<HTMLElement>(".lp-reveal")].filter((el) => el.getBoundingClientRect().top > window.innerHeight);
    below.forEach((el) => el.setAttribute("data-pre", ""));
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const el = entry.target as HTMLElement;
          io.unobserve(el);
          el.style.transitionDelay = `${el.dataset.delay ?? 0}ms`;
          el.removeAttribute("data-pre");
          el.setAttribute("data-shown", "");
          el.addEventListener("transitionend", () => (el.style.transitionDelay = ""), { once: true });
        }
      },
      { threshold: 0.15, rootMargin: "0px 0px -6% 0px" },
    );
    below.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, []);
  return <div ref={root}>{children}</div>;
}
