import { fireEvent, screen } from "@testing-library/react";
import { notFound } from "next/navigation";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "../../../tests/render";
import { router } from "../../../tests/navigation";
import MockLoginPage from "./page";

vi.mock("next-intl/server", () => ({ getTranslations: async () => (k: string) => k }));

describe("/mock-login page", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("is not found unless mocking is enabled", async () => {
    vi.stubEnv("NEXT_PUBLIC_API_MOCKING", "disabled");
    await MockLoginPage({ searchParams: Promise.resolve({}) });
    expect(notFound).toHaveBeenCalled();
  });

  it("renders the login form when mocking is enabled", async () => {
    vi.stubEnv("NEXT_PUBLIC_API_MOCKING", "enabled");
    vi.mocked(notFound).mockClear();
    renderWithProviders(await MockLoginPage({ searchParams: Promise.resolve({ callbackUrl: "//evil" }) }));
    expect(notFound).not.toHaveBeenCalled();
    expect(screen.getByLabelText("사용자")).toBeInTheDocument();
  });

  it("never pushes an external URL for a /.// callback bypass", async () => {
    vi.stubEnv("NEXT_PUBLIC_API_MOCKING", "enabled");
    router.push.mockClear();
    const { container } = renderWithProviders(await MockLoginPage({ searchParams: Promise.resolve({ callbackUrl: "/.//evil.com" }) }));
    fireEvent.submit(container.querySelector("form")!);
    expect(router.push).toHaveBeenCalledWith("/commons");
  });
});
