import { isMocking } from "@/shared/config";

export const dynamic = "force-dynamic";

type Seed = Parameters<typeof import("@/mocks/notebook-activity").seedNotebookActivity>[0];

const isText = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function isCell(c: unknown): boolean {
  return (
    isObject(c) &&
    (c.type === "code" || c.type === "markdown") &&
    typeof c.source_head === "string" &&
    Array.isArray(c.output_kinds) &&
    c.output_kinds.every((k) => typeof k === "string") &&
    Number.isInteger(c.output_count) &&
    (c.output_count as number) >= 0 &&
    typeof c.has_error === "boolean"
  );
}

/** Minimal shape check of one NotebookActivity without ids (the hook is test-only, but a typo should fail loudly). */
function isActivity(a: unknown): a is Seed {
  return (
    isObject(a) &&
    isText(a.user_id) &&
    isText(a.project_id) &&
    typeof a.day === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(a.day) &&
    isText(a.title) &&
    (a.saved_at === undefined || typeof a.saved_at === "string") &&
    Array.isArray(a.cells) &&
    a.cells.every(isCell)
  );
}

const badRequest = () =>
  Response.json(
    {
      error:
        "expected a NotebookActivity (user_id, project_id, day YYYY-MM-DD, title, cells[{ type: code|markdown, source_head, output_kinds[], output_count >= 0, has_error }]) or a non-empty array of them",
    },
    { status: 400 },
  );

/**
 * Mock-only test hook (NEXT_PUBLIC_API_MOCKING=enabled only, 404 otherwise; not part of openapi.yaml): seeds saved
 * Jupyter notebooks into the NotebookActivityPort stand-in so e2e can exercise AI drafting. The body is one
 * NotebookActivity without ids (src/mocks/types.ts) or a non-empty array of them; `day` is the Asia/Seoul date of the
 * note to draft. Nothing is seeded unless every item has the expected shape.
 */
export async function POST(request: Request): Promise<Response> {
  if (!isMocking()) return new Response("Not Found", { status: 404 });
  const { seedNotebookActivity } = await import("@/mocks/notebook-activity");
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequest();
  }
  const items: unknown[] = Array.isArray(body) ? body : [body];
  if (!items.length || !items.every(isActivity)) return badRequest();
  const seeded = (items as Seed[]).map((a) => seedNotebookActivity({ ...a, saved_at: a.saved_at ?? new Date().toISOString() }));
  return Response.json(Array.isArray(body) ? seeded : seeded[0], { status: 201 });
}
