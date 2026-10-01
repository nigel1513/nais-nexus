import { cookies, headers } from "next/headers";
import { getRequestConfig } from "next-intl/server";
import { LOCALE_COOKIE } from "@/shared/config";
import { resolveLocale } from "./locale";
import { loadMessages } from "./messages";

export default getRequestConfig(async () => {
  const locale = resolveLocale((await cookies()).get(LOCALE_COOKIE)?.value, (await headers()).get("accept-language"));
  return { locale, messages: loadMessages(locale), timeZone: "Asia/Seoul" };
});
