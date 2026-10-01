import { afterEach, describe, expect, it, vi } from "vitest";
import { notFound } from "next/navigation";
import MockLoginPage from "./page";

vi.mock("next-intl/server", () => ({ getTranslations: async () => (k: string) => k }));

describe("/mock-login page", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("is not found unless mocking is enabled", async () => {
    vi.stubEnv("NEXT_PUBLIC_API_MOCKING", "disabled");
    await MockLoginPage({ searchParams: Promise.resolve({}) });
    expect(notFound).toHaveBeenCalled();
  });

  it("renders when mocking is enabled", async () => {
    vi.mocked(notFound).mockClear();
    await MockLoginPage({ searchParams: Promise.resolve({ callbackUrl: "//evil" }) });
    expect(notFound).not.toHaveBeenCalled();
  });
});
