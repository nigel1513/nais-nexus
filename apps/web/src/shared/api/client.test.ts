import { http, HttpResponse } from "msw";
import { afterEach, describe, expect, it } from "vitest";
import { server } from "../../../tests/msw";
import { setMockUser } from "../../../tests/render";
import { api, readCookie, setAccessTokenGetter, unwrap } from "./client";
import { ApiError } from "./errors";

const me = {
  user_id: "00000000-0000-7000-8000-000000000a02",
  display_name: "김민준",
  email: "a.researcher@inst-a.local",
  status: "ACTIVE",
  organization: { organization_id: "00000000-0000-7000-8000-00000000000a", code: "inst-a", name: "한국에너지기술연구원", type: "RESEARCH_INSTITUTE" },
  org_roles: [],
  platform_roles: [],
};

afterEach(() => setAccessTokenGetter(() => undefined));

describe("api client", () => {
  it("calls the mock API base with X-Request-Id, Bearer token and the mock user", async () => {
    let seen: Headers | undefined;
    let url = "";
    server.use(
      http.get("*/mock-api/v1/me", ({ request }) => {
        seen = request.headers;
        url = request.url;
        return HttpResponse.json(me);
      }),
    );
    setAccessTokenGetter(() => "tok-1");
    setMockUser(me.user_id);
    const data = await unwrap(api.GET("/me"));
    expect(data.display_name).toBe("김민준");
    expect(url).toBe("http://localhost:3000/mock-api/v1/me");
    expect(seen?.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
    expect(seen?.get("authorization")).toBe("Bearer tok-1");
    expect(seen?.get("x-mock-user")).toBe(me.user_id);
  });

  it("forwards ?mock_error= from the page URL (dev-only error injection)", async () => {
    let injected: string | null = null;
    server.use(
      http.get("*/mock-api/v1/me", ({ request }) => {
        injected = request.headers.get("x-mock-error");
        return HttpResponse.json(me);
      }),
    );
    window.history.replaceState({}, "", "/commons?mock_error=POLICY_ENGINE_UNAVAILABLE");
    await unwrap(api.GET("/me"));
    expect(injected).toBe("POLICY_ENGINE_UNAVAILABLE");
  });

  it("serializes array query params as repeated keys (style=form, explode=true)", async () => {
    let search = "";
    server.use(
      http.get("*/mock-api/v1/access-requests", ({ request }) => {
        search = new URL(request.url).search;
        return HttpResponse.json({ items: [], page: { has_more: false, next_cursor: null } });
      }),
    );
    await unwrap(api.GET("/access-requests", { params: { query: { role: "requester", status: ["SUBMITTED", "UNDER_REVIEW"] } } }));
    expect(search).toBe("?role=requester&status=SUBMITTED&status=UNDER_REVIEW");
  });

  it("throws ApiError from the envelope", async () => {
    server.use(
      http.get("*/mock-api/v1/me", () =>
        HttpResponse.json({ error: { code: "MEMBERSHIP_DISABLED", message: "disabled", trace_id: "tr-1" } }, { status: 403 }),
      ),
    );
    await expect(unwrap(api.GET("/me"))).rejects.toMatchObject({ status: 403, code: "MEMBERSHIP_DISABLED", traceId: "tr-1" });
  });

  it("maps a non-JSON 502 to DEPENDENCY_UNAVAILABLE", async () => {
    server.use(http.get("*/mock-api/v1/me", () => new HttpResponse("<html>Bad Gateway</html>", { status: 502 })));
    await expect(unwrap(api.GET("/me"))).rejects.toMatchObject({ code: "DEPENDENCY_UNAVAILABLE", status: 502 });
  });

  it("maps a network failure to ApiError(0, DEPENDENCY_UNAVAILABLE)", async () => {
    server.use(http.get("*/mock-api/v1/me", () => HttpResponse.error()));
    const err = await unwrap(api.GET("/me")).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 0, code: "DEPENDENCY_UNAVAILABLE" });
  });

  it("treats 204 as success", async () => {
    server.use(http.post("*/mock-api/v1/notifications/read-all", () => new HttpResponse(null, { status: 204 })));
    await expect(unwrap(api.POST("/notifications/read-all"))).resolves.not.toBeInstanceOf(ApiError);
  });

  it("reads cookies", () => {
    expect(readCookie("a", "x=1; a=hello%20world; b=2")).toBe("hello world");
    expect(readCookie("zz", "x=1")).toBeUndefined();
  });
});
