import { http, HttpResponse } from "msw";
import { getDb } from "../db";

let etagSeq = 0;

/** Stand-in for presigned S3 URLs (same origin, so no CORS): PUT returns an ETag, GET returns a small text body. */
export const storageHandlers = [
  http.put("*/mock-storage/*", async ({ request }) => {
    const data = await request.arrayBuffer();
    // Single-PUT uploads (`.../uploads/<file_id>`, no part segment) of ≤ 2 MiB are kept so publish can profile them.
    const match = /\/uploads\/([^/]+)$/.exec(new URL(request.url).pathname);
    if (match && data.byteLength <= 2 * 1024 * 1024) getDb().objects[match[1]!] = new TextDecoder().decode(data);
    // Workspace output objects (`<bucket>/workspace/<project>/outputs/<output>/<name>`): completeOutputUpload re-checks size and sha256.
    const workspace = /\/mock-storage\/([^/]+\/workspace\/.+)$/.exec(new URL(request.url).pathname);
    if (workspace) {
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
      getDb().blobs[decodeURIComponent(workspace[1]!)] = { size_bytes: data.byteLength, sha256: Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("") };
    }
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
