import type { Metadata } from "next";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getMessages } from "next-intl/server";
import "./globals.css";

export const metadata: Metadata = { title: "NAIS Research Commons", description: "NAIS AI-OS Research Commons" };

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const locale = await getLocale();
  const messages = await getMessages();
  return (
    <html lang={locale}>
      <body className="min-h-screen antialiased">
        <NextIntlClientProvider locale={locale} messages={messages} timeZone="Asia/Seoul">
          {children}
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
