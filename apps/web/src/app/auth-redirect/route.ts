import { type NextRequest } from "next/server";
import { CALLBACK_HEADER, LOGIN_HEADER, LOGIN_PATHS, loginLocation } from "@/features/auth/login-redirect";

export const dynamic = "force-dynamic";

/**
 * Middleware cannot emit a relative Location (Next re-parses it as an absolute URL), so protected routes are rewritten
 * here and this handler answers with the RELATIVE redirect: it works on any origin the browser used and reflects no host.
 */
export function GET(req: NextRequest): Response {
  const login = req.headers.get(LOGIN_HEADER) ?? "";
  if (!LOGIN_PATHS.includes(login)) return new Response("Bad Request", { status: 400 });
  let callback: string | null = null;
  try {
    callback = decodeURIComponent(req.headers.get(CALLBACK_HEADER) ?? "");
  } catch {
    /* malformed: falls back to the default destination */
  }
  const location = loginLocation(login, callback);
  return new Response(null, { status: 307, headers: { location, "cache-control": "no-store" } });
}
