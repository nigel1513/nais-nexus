import { http, HttpResponse } from "msw";

let etagSeq = 0;

/** Stand-in for presigned S3 URLs (same origin, so no CORS): PUT returns an ETag, GET returns a small text body. */
export const storageHandlers = [
  http.put("*/mock-storage/*", async ({ request }) => {
    await request.arrayBuffer();
    etagSeq += 1;
    return new HttpResponse(null, { status: 200, headers: { ETag: `"mock-etag-${etagSeq}"` } });
  }),
  http.get("*/mock-storage/*", ({ request }) => {
    const url = new URL(request.url);
    const name = url.pathname.split("/").pop() ?? "file";
    return new HttpResponse(`NAIS mock file: ${url.pathname}\n`, {
      status: 200,
      headers: { "Content-Type": "application/octet-stream", "Content-Disposition": `attachment; filename="${name}"` },
    });
  }),
];
