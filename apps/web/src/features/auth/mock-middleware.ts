import { NextResponse, type NextRequest } from "next/server";
import { MOCK_USER_COOKIE } from "@/shared/config";
import { isProtected } from "./redirects";

export function loginRedirect(req: NextRequest, loginPath: string): NextResponse {
  const callbackUrl = req.nextUrl.pathname + req.nextUrl.search;
  // Relative Location: resolved by the browser against whatever origin it used (no host reflection).
  return new NextResponse(null, { status: 307, headers: { location: `${loginPath}?callbackUrl=${encodeURIComponent(callbackUrl)}` } });
}

export function mockMiddleware(req: NextRequest): NextResponse {
  if (!isProtected(req.nextUrl.pathname)) return NextResponse.next();
  if (req.cookies.get(MOCK_USER_COOKIE)?.value) return NextResponse.next();
  return loginRedirect(req, "/mock-login");
}
