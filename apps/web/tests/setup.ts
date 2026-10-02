import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, expect, vi } from "vitest";
import { resetDb } from "@/mocks/db";
import { notify } from "@nais/ui";
import { contractViolations, pendingChecks, server } from "./msw";
import { resetNavigation } from "./navigation";
import { mockViewport } from "./viewport";

vi.mock("next/navigation", async () => (await import("./navigation")).navigationMock);

// jsdom lacks these; cmdk, Base UI positioning and Sonner call them (same shims as packages/ui/tests/setup.ts).
if (typeof window !== "undefined") {
  class RO {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  globalThis.ResizeObserver ??= RO as unknown as typeof ResizeObserver;
  Element.prototype.scrollIntoView ??= function scrollIntoView() {};
  if (typeof globalThis.PointerEvent === "undefined") {
    class PointerEventShim extends MouseEvent {
      pointerId: number;
      pointerType: string;
      constructor(type: string, init: PointerEventInit = {}) {
        super(type, init);
        this.pointerId = init.pointerId ?? 0;
        this.pointerType = init.pointerType ?? "mouse";
      }
    }
    globalThis.PointerEvent = PointerEventShim as unknown as typeof PointerEvent;
  }
  Element.prototype.setPointerCapture ??= function setPointerCapture() {};
  Element.prototype.releasePointerCapture ??= function releasePointerCapture() {};
  Element.prototype.hasPointerCapture ??= function hasPointerCapture() {
    return false;
  };
}

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => {
  if (typeof window !== "undefined") mockViewport(1280);
  resetDb();
  contractViolations.length = 0;
});
afterEach(async () => {
  await Promise.all(pendingChecks.splice(0)); // let every async response:mocked check settle
  const violations = [...contractViolations];
  contractViolations.length = 0;
  server.resetHandlers();
  if (typeof window !== "undefined") notify.dismiss(); // Sonner's store is global: no toast leaks into the next test
  cleanup();
  resetNavigation();
  if (typeof document !== "undefined") {
    document.cookie = "nais_mock_user=; max-age=0; path=/";
    window.history.replaceState({}, "", "/");
  }
  expect(violations, "mock responses must validate against openapi 1.2.0").toEqual([]);
});
afterAll(() => server.close());
