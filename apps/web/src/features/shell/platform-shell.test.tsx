import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { getDb } from "@/mocks/db";
import { USER } from "@/mocks/fixtures";
import { router, setLocation } from "../../../tests/navigation";
import { renderWithProviders } from "../../../tests/render";
import { server } from "../../../tests/msw";
import { PlatformShell } from "./platform-shell";

const page = <h1>본문</h1>;

describe("PlatformShell", () => {
  it("renders landmarks, nav with current page, org badge; skip link is the first tab stop", async () => {
    setLocation("/commons/projects");
    renderWithProviders(<PlatformShell>{page}</PlatformShell>, { user: USER.aResearcher });
    const nav = await screen.findByRole("navigation", { name: "주 메뉴" });
    expect(within(nav).getAllByRole("link").map((l) => l.textContent)).toEqual(["대시보드", "프로젝트", "데이터", "접근 관리", "활동"]);
    expect(within(nav).getByRole("link", { name: "프로젝트" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("banner")).toBeInTheDocument();
    expect(screen.getByRole("main")).toContainElement(screen.getByRole("heading", { name: "본문" }));
    expect(screen.getByText("Institute A")).toBeInTheDocument();
    await userEvent.tab();
    expect(screen.getByRole("link", { name: "본문으로 건너뛰기" })).toHaveFocus();
  });

  it("adds 기관 관리 for ORG_ADMIN", async () => {
    renderWithProviders(<PlatformShell>{page}</PlatformShell>, { user: USER.aAdmin });
    const nav = await screen.findByRole("navigation", { name: "주 메뉴" });
    expect(within(nav).getByRole("link", { name: "기관 관리" })).toHaveAttribute("href", "/settings/organization");
  });

  it("sends disabled members to /blocked", async () => {
    renderWithProviders(<PlatformShell>{page}</PlatformShell>, { user: USER.bDisabled });
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/blocked?code=MEMBERSHIP_DISABLED"));
    expect(screen.queryByRole("heading", { name: "본문" })).not.toBeInTheDocument();
  });

  it("sends signed-out users to the mock login with a callback", async () => {
    setLocation("/commons/data?q=x");
    renderWithProviders(<PlatformShell>{page}</PlatformShell>);
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/mock-login?callbackUrl=%2Fcommons%2Fdata%3Fq%3Dx"));
  });

  it("global search goes to data search with q", async () => {
    renderWithProviders(<PlatformShell>{page}</PlatformShell>, { user: USER.aResearcher });
    const box = await screen.findByRole("searchbox", { name: "데이터 검색" });
    await userEvent.type(box, "battery{Enter}");
    expect(router.push).toHaveBeenCalledWith("/commons/data?q=battery");
  });

  it("notification bell shows the unread count and opens the linked page (marking it read)", async () => {
    renderWithProviders(<PlatformShell>{page}</PlatformShell>, { user: USER.aResearcher });
    const bell = await screen.findByRole("button", { name: "알림 1개 읽지 않음" });
    await userEvent.click(bell);
    await userEvent.click(screen.getByRole("button", { name: /접근 권한이 .* UTC에 만료됩니다/ }));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith("/commons/access?tab=grants"));
    expect(getDb().notifications.find((n) => n.link === "/commons/access?tab=grants")?.read).toBe(true);
  });

  it("closes the user menu with Escape and returns focus", async () => {
    renderWithProviders(<PlatformShell>{page}</PlatformShell>, { user: USER.aResearcher });
    const menuButton = await screen.findByRole("button", { name: /A Researcher/ });
    await userEvent.click(menuButton);
    expect(screen.getByRole("link", { name: "설정" })).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("link", { name: "설정" })).not.toBeInTheDocument();
    expect(menuButton).toHaveFocus();
  });

  it("keeps the page when a background getMe refetch fails (error view only without cached data)", async () => {
    const { queryClient } = renderWithProviders(<PlatformShell>{page}</PlatformShell>, { user: USER.aResearcher });
    await screen.findByRole("heading", { name: "본문" });
    server.use(http.get("*/mock-api/v1/me", () => HttpResponse.json({ error: { code: "INTERNAL_ERROR", message: "x", trace_id: "t" } }, { status: 500 })));
    await queryClient.invalidateQueries({ queryKey: ["getMe", {}] });
    await waitFor(() => expect(queryClient.getQueryState(["getMe", {}])?.status).toBe("error"));
    expect(screen.getByRole("heading", { name: "본문" })).toBeInTheDocument();
  });

  it("shows a toast when marking a notification read fails, and still never follows an unsafe link", async () => {
    getDb().notifications.find((n) => n.link === "/commons/access?tab=grants")!.link = "/\\evil.com";
    server.use(http.post("*/mock-api/v1/notifications/:id/read", () => HttpResponse.json({ error: { code: "INTERNAL_ERROR", message: "x", trace_id: "t" } }, { status: 500 })));
    renderWithProviders(<PlatformShell>{page}</PlatformShell>, { user: USER.aResearcher });
    await userEvent.click(await screen.findByRole("button", { name: "알림 1개 읽지 않음" }));
    await userEvent.click(screen.getByRole("button", { name: /접근 권한이 .* UTC에 만료됩니다/ }));
    expect(await screen.findByText("알림을 읽음 처리하지 못했습니다.")).toBeInTheDocument();
    expect(router.push).not.toHaveBeenCalled();
  });

  it("closes the notification panel and the user menu on an outside click", async () => {
    renderWithProviders(<PlatformShell>{page}</PlatformShell>, { user: USER.aResearcher });
    await userEvent.click(await screen.findByRole("button", { name: "알림 1개 읽지 않음" }));
    expect(screen.getByText("읽지 않은 알림")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("heading", { name: "본문" }));
    expect(screen.queryByText("읽지 않은 알림")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /A Researcher/ }));
    expect(screen.getByRole("link", { name: "설정" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("heading", { name: "본문" }));
    expect(screen.queryByRole("link", { name: "설정" })).not.toBeInTheDocument();
  });
});
