import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, expect } from "vitest";
import { resetDb } from "@/mocks/db";
import { contractViolations, server } from "./msw";

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => {
  resetDb();
  contractViolations.length = 0;
});
afterEach(async () => {
  await new Promise((resolve) => setTimeout(resolve, 0)); // let async response:mocked listeners settle
  const violations = [...contractViolations];
  contractViolations.length = 0;
  server.resetHandlers();
  cleanup();
  document.cookie = "nais_mock_user=; max-age=0; path=/";
  window.history.replaceState({}, "", "/");
  expect(violations, "mock responses must validate against openapi 1.2.0").toEqual([]);
});
afterAll(() => server.close());
