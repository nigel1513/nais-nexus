"use client";
import { useTranslations } from "next-intl";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";

type Tone = "info" | "error";
type Item = { id: number; message: string; tone: Tone };
type Push = (message: string, tone?: Tone) => void;

const ToastContext = createContext<Push>(() => {});
let seq = 0;

/** info toasts time out; error toasts stay until dismissed (they carry what the user must act on). */
export function ToastProvider({ children }: { children: ReactNode }) {
  const t = useTranslations();
  const [items, setItems] = useState<Item[]>([]);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  useEffect(() => {
    const live = timers.current;
    return () => {
      live.forEach(clearTimeout);
      live.clear();
    };
  }, []);
  const dismiss = useCallback((id: number) => setItems((xs) => xs.filter((x) => x.id !== id)), []);
  const push = useCallback<Push>(
    (message, tone = "info") => {
      const id = ++seq;
      setItems((xs) => [...xs, { id, message, tone }]);
      if (tone !== "error") {
        const timer = setTimeout(() => {
          timers.current.delete(timer);
          dismiss(id);
        }, 6000);
        timers.current.add(timer);
      }
    },
    [dismiss],
  );
  const render = (tone: Tone) =>
    items
      .filter((i) => i.tone === tone)
      .map((i) => (
        <p key={i.id} className={`flex items-start gap-2 rounded-md border p-3 text-sm shadow ${tone === "error" ? "border-danger" : "border-border"} bg-background`}>
          <span className="flex-1">{i.message}</span>
          {tone === "error" ? (
            <button type="button" aria-label={t("common.close")} className="rounded px-1 leading-none hover:bg-muted" onClick={() => dismiss(i.id)}>
              <span aria-hidden="true">×</span>
            </button>
          ) : null}
        </p>
      ));
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="fixed bottom-4 right-4 z-50 flex max-w-sm flex-col gap-2">
        <div aria-live="polite">{render("info")}</div>
        <div aria-live="assertive">{render("error")}</div>
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): Push {
  return useContext(ToastContext);
}
