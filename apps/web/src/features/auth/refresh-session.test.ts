import { http, HttpResponse } from "msw";
import { afterEach, describe, expect, it, vi } from "vitest";
import { server } from "../../../tests/msw";
import { api, setAccessTokenGetter, unwrap } from "@/shared/api/client";
import { makeQueryClient } from "@/shared/api/query-client";
import { USER } from "@/mocks/fixtures";
import { setMockUser } from "../../../tests/render";
import { applyRefreshedToken } from "./refresh-session";

describe("applyRefreshedToken", () => {
  afterEach(() => setAccessTokenGetter(() => undefined));

  it("installs the new token before the invalidation retries, so retried requests carry it", async () => {
    setMockUser(USER.aResearcher);
    const seen: (string | null)[] = [];
    server.use(
      http.get("*/mock-api/v1/me", ({ request }) => {
        seen.push(request.headers.get("authorization"));
        return HttpResponse.json({});
      }),
    );
    setAccessTokenGetter(() => "old");
    const client = makeQueryClient({ retry: false });
    vi.spyOn(client, "invalidateQueries").mockImplementation(async () => {
      await unwrap(api.GET("/me")); // what an active query's refetch does
    });
    await applyRefreshedToken(client, "new");
    expect(seen).toEqual(["Bearer new"]);
  });
});
