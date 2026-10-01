import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { MockLoginForm } from "@/features/auth/components/mock-login-form";
import { safeCallbackUrl } from "@/features/auth/redirects";
import { SEED_USERS } from "@/mocks/fixtures";
import { isMocking } from "@/shared/config";

export default async function MockLoginPage({ searchParams }: { searchParams: Promise<{ callbackUrl?: string }> }) {
  if (!isMocking()) notFound();
  const { callbackUrl } = await searchParams;
  const t = await getTranslations();
  return (
    <main id="main" className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-6 p-4">
      <h1 className="text-2xl font-bold">{t("auth.mockTitle")}</h1>
      <p className="text-sm text-muted-foreground">{t("auth.mockDescription")}</p>
      <MockLoginForm callbackUrl={safeCallbackUrl(callbackUrl)} users={SEED_USERS} />
    </main>
  );
}
