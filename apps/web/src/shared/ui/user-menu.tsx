"use client";
import { Button, buttonClass } from "@nais/ui";
import { User } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { SignOutButton } from "@/features/auth/components/sign-out-button";
import type { Me } from "@/shared/api/types";
import { useOutsideDismiss } from "@/shared/hooks/use-dismiss";

export function UserMenu({ me }: { me: Me }) {
  const t = useTranslations();
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useOutsideDismiss(open, rootRef, close);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <div ref={rootRef} className="relative">
      <Button ref={buttonRef} variant="ghost" aria-expanded={open} aria-controls={menuId} onClick={() => setOpen((o) => !o)}>
        <User aria-hidden="true" className="h-4 w-4" />
        <span className="max-w-32 truncate">{me.display_name}</span>
        <span className="sr-only">{t("shell.userMenu")}</span>
      </Button>
      {open ? (
        <div id={menuId} className="absolute right-0 z-40 mt-1 flex w-60 flex-col gap-1 rounded-md border border-border bg-background p-2 shadow-lg">
          <p className="px-2 text-xs text-muted-foreground break-all">{me.email}</p>
          <Link href="/settings" className={buttonClass("ghost", "sm", "justify-start")} onClick={() => setOpen(false)}>
            {t("nav.settings")}
          </Link>
          <SignOutButton className="w-full justify-start" />
        </div>
      ) : null}
    </div>
  );
}
