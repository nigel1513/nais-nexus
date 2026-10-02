"use client";
import { useEffect, useRef, useState } from "react";

const DURATION = 900;
const easeOut = (t: number) => 1 - (1 - t) ** 3;

/**
 * A score that counts up once when first scrolled into view (explanation: the number is the sum of the checks below).
 * Already on screen at load, or reduced motion: shows the final value. Screen readers get the final value only.
 */
export function CountUp({ to, suffix = "" }: { to: number; suffix?: string }) {
  const el = useRef<HTMLSpanElement>(null);
  const [value, setValue] = useState(to);
  useEffect(() => {
    const node = el.current;
    if (!node || typeof IntersectionObserver === "undefined") return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches || node.getBoundingClientRect().top < window.innerHeight) return;
    setValue(0);
    let raf = 0;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (!entry!.isIntersecting) return;
        io.disconnect();
        const start = performance.now() + 200;
        const step = (now: number) => {
          const t = Math.min(1, Math.max(0, (now - start) / DURATION));
          setValue(Math.round(easeOut(t) * to));
          if (t < 1) raf = requestAnimationFrame(step);
        };
        raf = requestAnimationFrame(step);
      },
      { threshold: 0.4 },
    );
    io.observe(node);
    return () => {
      io.disconnect();
      cancelAnimationFrame(raf);
    };
  }, [to]);
  return (
    <span ref={el}>
      <span aria-hidden>
        {value}
        {suffix}
      </span>
      <span className="sr-only">
        {to}
        {suffix}
      </span>
    </span>
  );
}
