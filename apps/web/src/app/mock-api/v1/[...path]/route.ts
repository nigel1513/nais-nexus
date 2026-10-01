import { getResponse } from "msw";
import { isMocking } from "@/shared/config";

export const dynamic = "force-dynamic";

/** Mock NAIS API served by the web server itself (NEXT_PUBLIC_API_MOCKING=enabled only). */
async function handle(request: Request): Promise<Response> {
  if (!isMocking()) return new Response("Not Found", { status: 404 });
  const { handlers } = await import("@/mocks/handlers");
  const response = await getResponse(handlers, request);
  return response ?? Response.json({ error: { code: "NOT_FOUND", message: "No mock handler", trace_id: "mock" } }, { status: 404 });
}

export { handle as DELETE, handle as GET, handle as PATCH, handle as POST, handle as PUT };
