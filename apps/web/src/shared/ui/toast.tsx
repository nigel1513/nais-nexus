"use client";
import { createContext, useCallback, useContext, useState, type ReactNode } from "react";

type Tone = "info" | "error";
type Item = { id: number; message: string; tone: Tone };
type Push = (message: string, tone?: Tone) => void;

const ToastContext = createContext<Push>(() => {});
let seq = 0;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Item[]>([]);
  const push = useCallback<Push>((message, tone = "info") => {
    const id = ++seq;
    setItems((xs) => [...xs, { id, message, tone }]);
    setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== id)), 6000);
  }, []);
  const render = (tone: Tone) =>
    items
      .filter((i) => i.tone === tone)
      .map((i) => (
        <p key={i.id} className={`rounded-md border p-3 text-sm shadow ${tone === "error" ? "border-danger" : "border-border"} bg-background`}>
          {i.message}
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
