import { setupServer } from "msw/node";
import { handlers } from "@/mocks/handlers";
import { checkResponse } from "./contract";

export const server = setupServer(...handlers);

/** Contract violations found in responses served by the default mock handlers during the current test. */
export const contractViolations: string[] = [];

/** In-flight response checks; the per-test teardown awaits them all. */
export const pendingChecks: Promise<void>[] = [];

async function check(request: Request, response: Response): Promise<void> {
  // Tests that install ad-hoc overrides (server.use) intentionally return arbitrary payloads.
  if (server.listHandlers().length !== handlers.length) return;
  const url = new URL(request.url);
  if (!url.pathname.includes("/mock-api/v1")) return; // mock storage (/mock-storage) is not part of the openapi contract
  const apiPath = url.pathname.replace(/^.*\/mock-api\/v1/, "");
  const text = await response.clone().text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  contractViolations.push(...checkResponse(request.method, apiPath, response.status, body));
}

server.events.on("response:mocked", ({ request, response }) => {
  pendingChecks.push(check(request, response));
});
