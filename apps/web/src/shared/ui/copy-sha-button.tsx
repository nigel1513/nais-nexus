"use client";
import { Button, copyText } from "@nais/ui";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { useToast } from "./toast";

/** Copy button for a SHA-256: clipboard (with non-secure-origin fallback); if everything fails the full value is shown to select by hand. */
export function CopyShaButton({ path, sha }: { path: string; sha: string }) {
  const t = useTranslations();
  const toast = useToast();
  const [manual, setManual] = useState(false);
  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        aria-label={t("download.copyShaFor", { path })}
        onClick={async () => {
          if (await copyText(sha)) {
            setManual(false);
            toast(t("download.copiedSha"));
          } else {
            setManual(true);
            toast(t("download.copyFailed"), "error");
          }
        }}
      >
        {t("download.copySha")}
      </Button>
      {manual ? <code className="break-all select-all">{sha}</code> : null}
    </>
  );
}
