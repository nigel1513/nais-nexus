import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, expect, vi } from "vitest";
import { resetDb } from "@/mocks/db";
import { contractViolations, pendingChecks, server } from "./msw";
import { resetNavigation } from "./navigation";

vi.mock("next/navigation", async () => (await import("./navigation")).navigationMock);

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => {
  resetDb();
  contractViolations.length = 0;
});
afterEach(async () => {
  await Promise.all(pendingChecks.splice(0)); // let every async response:mocked check settle
  const violations = [...contractViolations];
  contractViolations.length = 0;
  server.resetHandlers();
  cleanup();
  resetNavigation();
  if (typeof document !== "undefined") {
    document.cookie = "nais_mock_user=; max-age=0; path=/";
    window.history.replaceState({}, "", "/");
  }
  expect(violations, "mock responses must validate against openapi 1.2.0").toEqual([]);
});
afterAll(() => server.close());
