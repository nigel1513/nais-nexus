import { getResponse } from "msw";
import { isMocking } from "@/shared/config";

export const dynamic = "force-dynamic";

async function handle(request: Request): Promise<Response> {
  if (!isMocking()) return new Response("Not Found", { status: 404 });
  const { storageHandlers } = await import("@/mocks/handlers/storage");
  return (await getResponse(storageHandlers, request)) ?? new Response("Not Found", { status: 404 });
}

export { handle as GET, handle as PUT };
