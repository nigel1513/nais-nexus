"use client";
import { useEffect, useRef } from "react";

/** The public header: translucent, with its hairline drawn only once content scrolls under it (apple-design §12). */
export function StickyBar({ children }: { children: React.ReactNode }) {
  const bar = useRef<HTMLElement>(null);
  useEffect(() => {
    const onScroll = () => bar.current?.toggleAttribute("data-scrolled", window.scrollY > 4);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  return (
    <header ref={bar} className="lp-bar">
      {children}
    </header>
  );
}
