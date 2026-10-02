import { buttonClass } from "@nais/ui";
import { FileQuestion } from "lucide-react";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { StatusPage } from "@/shared/ui/status-page";

export default async function NotFound() {
  const t = await getTranslations();
  return (
    <StatusPage
      icon={FileQuestion}
      code="404"
      title={t("notFound.title")}
      message={t("errors.NOT_FOUND")}
      help={t("notFound.help")}
      actions={
        <>
          <Link href="/commons" className={buttonClass("primary")}>
            {t("notFound.home")}
          </Link>
          <Link href="/commons/data" className={buttonClass("secondary")}>
            {t("notFound.search")}
          </Link>
        </>
      }
    />
  );
}
