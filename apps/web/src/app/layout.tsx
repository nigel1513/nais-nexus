import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = { title: "NAIS Research Commons", description: "NAIS AI-OS Research Commons" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
