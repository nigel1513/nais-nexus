import { buttonClass } from "@nais/ui";
import Link from "next/link";
import { getTranslations } from "next-intl/server";

export default async function NotFound() {
  const t = await getTranslations();
  return (
    <main id="main" className="mx-auto flex min-h-screen max-w-lg flex-col justify-center gap-4 p-4">
      <h1 className="text-2xl font-bold">{t("notFound.title")}</h1>
      <p>{t("errors.NOT_FOUND")}</p>
      <Link href="/commons" className={buttonClass("primary")}>
        {t("notFound.home")}
      </Link>
    </main>
  );
}
