import { buttonClass } from "@nais/ui";
import Link from "next/link";
import { getTranslations } from "next-intl/server";

export default async function LandingPage() {
  const t = await getTranslations();
  return (
    <>
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-background focus:p-2">
        {t("common.skipToContent")}
      </a>
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-5xl items-center justify-between p-4">
          <span className="text-lg font-bold">{t("common.appName")}</span>
          <Link href="/commons" className={buttonClass("outline", "sm")}>
            {t("landing.signIn")}
          </Link>
        </div>
      </header>
      <main id="main" className="mx-auto flex max-w-5xl flex-col gap-10 p-4 py-12">
        <section className="flex flex-col gap-4">
          <h1 className="text-3xl font-bold md:text-4xl">{t("landing.title")}</h1>
          <p className="max-w-2xl text-lg text-muted-foreground">{t("landing.subtitle")}</p>
          <div>
            <Link href="/commons" className={buttonClass("default", "lg")}>
              {t("landing.cta")}
            </Link>
          </div>
        </section>
        <section aria-labelledby="landing-features" className="grid gap-4 md:grid-cols-3">
          <h2 id="landing-features" className="sr-only">
            {t("landing.featuresTitle")}
          </h2>
          {(["projects", "data", "governance"] as const).map((k) => (
            <div key={k} className="rounded-lg border border-border p-4">
              <h3 className="font-semibold">{t(`landing.features.${k}.title`)}</h3>
              <p className="mt-1 text-sm text-muted-foreground">{t(`landing.features.${k}.body`)}</p>
            </div>
          ))}
        </section>
        <section aria-labelledby="landing-about" className="grid gap-4 md:grid-cols-3">
          <h2 id="landing-about" className="text-xl font-semibold md:col-span-3">
            {t("landing.aboutTitle")}
          </h2>
          {(["about", "research", "news"] as const).map((k) => (
            <div key={k} className="rounded-lg bg-muted p-4">
              <h3 className="font-semibold">{t(`landing.placeholder.${k}`)}</h3>
              <p className="mt-1 text-sm text-muted-foreground">{t("landing.placeholder.body")}</p>
            </div>
          ))}
        </section>
      </main>
      <footer className="border-t border-border p-4 text-center text-sm text-muted-foreground">{t("landing.footer")}</footer>
    </>
  );
}
