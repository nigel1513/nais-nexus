import type { Metadata, Viewport } from "next";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getMessages, getTranslations } from "next-intl/server";
import { SITE_NAME } from "@/shared/config";
import { Providers } from "./providers";
import "./globals.css";

/**
 * Absolute base for the share image URLs: the deployment's own origin, taken from AUTH_URL (already set per deployment
 * for sign-in). Without it Next falls back to localhost, which only matters to link-preview crawlers.
 */
function siteOrigin(): URL | undefined {
  try {
    return process.env.AUTH_URL ? new URL(new URL(process.env.AUTH_URL).origin) : undefined;
  } catch {
    return undefined;
  }
}

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  const locale = await getLocale();
  const title = t("meta.title");
  const description = t("meta.description");
  // icon.svg, favicon.ico, apple-icon.png, opengraph-image.png, twitter-image.png and manifest.ts in this folder add
  // their own tags. A page's title reads "데이터 허브 · NAIS Commons".
  return {
    metadataBase: siteOrigin(),
    title: { default: title, template: `%s · ${SITE_NAME}` },
    description,
    applicationName: SITE_NAME,
    appleWebApp: { title: SITE_NAME, statusBarStyle: "default" },
    openGraph: { type: "website", siteName: SITE_NAME, title, description, locale: locale === "en" ? "en_US" : "ko_KR" },
    twitter: { card: "summary_large_image", title, description },
  };
}

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#fcfcfd" },
    { media: "(prefers-color-scheme: dark)", color: "#111113" },
  ],
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const locale = await getLocale();
  const messages = await getMessages();
  return (
    <html lang={locale} suppressHydrationWarning>
      <body className="min-h-screen antialiased">
        <NextIntlClientProvider locale={locale} messages={messages} timeZone="Asia/Seoul">
          <Providers>{children}</Providers>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
