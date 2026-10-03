import { isMocking } from "@/shared/config";

export const dynamic = "force-dynamic";

/**
 * Mock-only test hook (NEXT_PUBLIC_API_MOCKING=enabled only, 404 otherwise; not part of openapi.yaml): seeds one saved
 * Jupyter notebook into the NotebookActivityPort stand-in so e2e can exercise AI drafting. The body is a NotebookActivity
 * without ids (src/mocks/types.ts); `day` is the Asia/Seoul date of the note to draft.
 */
export async function POST(request: Request): Promise<Response> {
  if (!isMocking()) return new Response("Not Found", { status: 404 });
  const { seedNotebookActivity } = await import("@/mocks/notebook-activity");
  const body = (await request.json()) as Parameters<typeof seedNotebookActivity>[0];
  if (!body?.user_id || !body.project_id || !body.day || !body.title || !Array.isArray(body.cells)) {
    return Response.json({ error: "user_id, project_id, day, title and cells are required" }, { status: 400 });
  }
  return Response.json(seedNotebookActivity({ ...body, saved_at: body.saved_at ?? new Date().toISOString() }), { status: 201 });
}
