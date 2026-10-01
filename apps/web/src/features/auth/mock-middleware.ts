import { NextResponse, type NextRequest } from "next/server";
import { MOCK_USER_COOKIE } from "@/shared/config";
import { CALLBACK_HEADER, LOGIN_HEADER } from "./login-redirect";
import { isProtected } from "./redirects";

/** Rewrites to the /auth-redirect handler, which answers with a relative Location (see there). */
export function loginRedirect(req: NextRequest, loginPath: string): NextResponse {
  const target = req.nextUrl.clone();
  target.pathname = "/auth-redirect";
  target.search = "";
  const headers = new Headers(req.headers);
  headers.set(LOGIN_HEADER, loginPath);
  headers.set(CALLBACK_HEADER, encodeURIComponent(req.nextUrl.pathname + req.nextUrl.search));
  return NextResponse.rewrite(target, { request: { headers } });
}

export function mockMiddleware(req: NextRequest): NextResponse {
  if (!isProtected(req.nextUrl.pathname)) return NextResponse.next();
  if (req.cookies.get(MOCK_USER_COOKIE)?.value) return NextResponse.next();
  return loginRedirect(req, "/mock-login");
}
