import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterAll, afterEach, beforeAll } from "vitest";
import { server } from "./msw";

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  server.resetHandlers();
  cleanup();
  document.cookie = "nais_mock_user=; max-age=0; path=/";
  window.history.replaceState({}, "", "/");
});
afterAll(() => server.close());
