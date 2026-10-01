import { setupServer } from "msw/node";
import { handlers } from "@/mocks/handlers";
import { checkResponse } from "./contract";

export const server = setupServer(...handlers);

/** Contract violations found in responses served by the default mock handlers during the current test. */
export const contractViolations: string[] = [];

server.events.on("response:mocked", async ({ request, response }) => {
  // Tests that install ad-hoc overrides (server.use) intentionally return arbitrary payloads.
  if (server.listHandlers().length !== handlers.length) return;
  const url = new URL(request.url);
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
});
