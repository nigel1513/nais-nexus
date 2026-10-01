import { auth } from "@/auth";
import { authGate } from "@/features/auth/auth-middleware";
import { mockMiddleware } from "@/features/auth/mock-middleware";
import { isMocking } from "@/shared/config";

export default isMocking() ? mockMiddleware : auth(authGate);

export const config = { matcher: ["/commons/:path*", "/settings/:path*"] };
