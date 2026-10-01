import { NextResponse, type NextRequest } from "next/server";
import { loginRedirect } from "./mock-middleware";
import { isProtected } from "./redirects";

/** Real-mode route protection; `req.auth` is the Auth.js session attached by `auth(...)`. */
export function authGate(req: NextRequest & { auth?: { error?: string } | null }): NextResponse {
  if (!isProtected(req.nextUrl.pathname)) return NextResponse.next();
  if (req.auth && !req.auth.error) return NextResponse.next();
  return loginRedirect(req, "/web-auth/signin");
}
