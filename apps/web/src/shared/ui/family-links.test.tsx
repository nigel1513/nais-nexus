import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "../../../tests/render";
import { FamilySiteMenu, ParentHomeLink, SidebarFamilyLinks } from "./family-links";

afterEach(() => vi.unstubAllEnvs());

function expectExternal(link: HTMLElement, href: string) {
  expect(link).toHaveAttribute("href", href);
  expect(link).toHaveAttribute("target", "_blank");
  expect(link.getAttribute("rel")?.split(" ")).toContain("noopener");
}

describe("family links", () => {
  it("국가과학AI연구센터 홈 ↗ opens the parent site in a new tab and says so", () => {
    renderWithProviders(<ParentHomeLink />);
    const link = screen.getByRole("link", { name: "국가과학AI연구센터 홈 (새 탭에서 열림)" });
    expectExternal(link, "http://192.168.0.3:21050/");
  });

  it("follows NEXT_PUBLIC_PARENT_SITE_URL", () => {
    vi.stubEnv("NEXT_PUBLIC_PARENT_SITE_URL", "https://nais.example.kr/");
    renderWithProviders(<ParentHomeLink />);
    expectExternal(screen.getByRole("link", { name: /국가과학AI연구센터 홈/ }), "https://nais.example.kr/");
  });

  it.each(["field", "landing", "icon"] as const)("패밀리사이트 (%s) lists the family sites as new-tab links", async (variant) => {
    renderWithProviders(<FamilySiteMenu variant={variant} />);
    await userEvent.click(screen.getByRole("button", { name: "패밀리사이트" }));
    const menu = await screen.findByRole("menu");
    const item = within(menu).getByRole("menuitem", { name: /국가과학AI연구센터/ });
    expectExternal(item, "http://192.168.0.3:21050/");
    expect(item).toHaveTextContent("새 탭에서 열림");
    // The icon rail hides the copyright line, so its menu carries it.
    if (variant === "icon") expect(within(menu).getByText("© 2026 NAIS 국가과학AI연구센터")).toBeInTheDocument();
  });

  it("the sidebar foot shows home link, 패밀리사이트 and the copyright; the rail keeps only the menu", () => {
    const { unmount } = renderWithProviders(<SidebarFamilyLinks compact={false} />);
    expect(screen.getByRole("link", { name: /국가과학AI연구센터 홈/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "패밀리사이트" })).toBeInTheDocument();
    expect(screen.getByText("© 2026 NAIS 국가과학AI연구센터")).toBeInTheDocument();
    unmount();
    renderWithProviders(<SidebarFamilyLinks compact />);
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "패밀리사이트" })).toBeInTheDocument();
  });
});
