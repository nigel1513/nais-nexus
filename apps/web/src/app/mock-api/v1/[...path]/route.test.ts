import { describe, expect, it } from "vitest";
import { checkResponse } from "../../../../../tests/contract";
import { USER } from "@/mocks/fixtures";
import { GET } from "./route";

const get = (path: string, user: string = USER.bSteward) => GET(new Request(`http://localhost:3000/mock-api/v1${path}`, { headers: { cookie: `nais_mock_user=${user}` } }));

describe("/mock-api route handler", () => {
  it("answers from the MSW handlers using the mock-session cookie", async () => {
    const res = await get("/me");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ display_name: "B Steward" });
    expect(checkResponse("GET", "/me", 200, body)).toEqual([]);
  });

  it("returns a NOT_FOUND envelope for unknown paths", async () => {
    const res = await get("/nope");
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("NOT_FOUND");
  });
});

describe("contract checker", () => {
  it("is on openapi 1.2.0 and rejects non-conforming bodies", () => {
    expect(checkResponse("GET", "/me", 200, { user_id: "not-a-uuid" })).not.toEqual([]);
    expect(checkResponse("GET", "/no/such", 200, {})).toEqual(["GET /no/such: path not in openapi"]);
  });
});
