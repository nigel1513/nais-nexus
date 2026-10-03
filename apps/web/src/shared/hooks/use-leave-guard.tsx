"use client";
import { ConfirmDialog } from "@nais/ui";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

/** The in-app target of a plain left click on a same-origin link, or null (new tab, download, other origin, hash only). */
export function linkTarget(e: MouseEvent): string | null {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return null;
  const a = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
  if (!a || a.target === "_blank" || a.hasAttribute("download")) return null;
  const url = new URL(a.href, window.location.href);
  if (url.origin !== window.location.origin) return null;
  return `${url.pathname}${url.search}`;
}

/** While `active`, the browser asks before unloading the page (reload, close, typed URL). */
export function useBeforeUnload(active: boolean) {
  useEffect(() => {
    if (!active) return;
    const onUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, [active]);
}

/**
 * In-app navigation guard. While the page reports unsaved changes (`setDirty(true)`), links anywhere on the page and
 * the page's own `navigate()` calls ask "저장하지 않은 변경이 있습니다" first; `description` says what would be lost.
 * Render `dialog` once. Pair it with useBeforeUnload for reloads and closing the tab.
 */
export function useNavigationGuard(description: string): { setDirty: (dirty: boolean) => void; navigate: (href: string) => void; dialog: ReactNode } {
  const t = useTranslations();
  const router = useRouter();
  const dirtyRef = useRef(false);
  const [leaving, setLeaving] = useState<string | null>(null);
  const setDirty = useCallback((d: boolean) => {
    dirtyRef.current = d;
  }, []);
  const navigate = useCallback(
    (href: string) => {
      if (dirtyRef.current) setLeaving(href);
      else router.push(href);
    },
    [router],
  );
  // Capture phase on the document: runs before Next's Link handler, so a guarded click never starts the navigation.
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (!dirtyRef.current) return;
      const href = linkTarget(e);
      if (!href || href === `${window.location.pathname}${window.location.search}`) return;
      e.preventDefault();
      e.stopPropagation();
      setLeaving(href);
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, []);

  const dialog = (
    <ConfirmDialog
      open={leaving !== null}
      onOpenChange={(o) => (o ? undefined : setLeaving(null))}
      title={t("common.leave.title")}
      description={description}
      confirmLabel={t("common.leave.leave")}
      cancelLabel={t("common.leave.stay")}
      closeLabel={t("common.close")}
      onConfirm={() => {
        const href = leaving;
        dirtyRef.current = false;
        setLeaving(null);
        if (href) router.push(href);
      }}
    />
  );
  return { setDirty, navigate, dialog };
}
