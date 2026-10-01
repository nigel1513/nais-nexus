import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { loginRedirect, mockMiddleware } from "@/features/auth/mock-middleware";
import { isProtected } from "@/features/auth/redirects";
import { isMocking } from "@/shared/config";

const authMiddleware = auth((req) => {
  if (!isProtected(req.nextUrl.pathname)) return NextResponse.next();
  if (req.auth && !req.auth.error) return NextResponse.next();
  return loginRedirect(req, "/web-auth/signin");
});

export default isMocking() ? mockMiddleware : authMiddleware;

export const config = { matcher: ["/commons/:path*", "/settings/:path*"] };
