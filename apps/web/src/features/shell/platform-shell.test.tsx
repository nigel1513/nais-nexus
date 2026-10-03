import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/mocks/db";
import { DATASET, USER } from "@/mocks/fixtures";
import { ThemeProvider } from "@/shared/ui/theme";
import { useBreadcrumbs } from "@/shared/ui/breadcrumbs";
import { router, setLocation } from "../../../tests/navigation";
import { mockViewport, renderWithProviders } from "../../../tests/render";
import { server } from "../../../tests/msw";
import { PlatformShell } from "./platform-shell";

const page = <h1>본문</h1>;
const API = "http://localhost:3000/mock-api/v1";

/** The seed has no pending request: 최유진 files one against A's sensor dataset, so 이서연 has one to review. */
async function seedPending() {
  const send = async (path: string, body: unknown) => {
    const res = await fetch(`${API}${path}`, { method: "POST", headers: { "content-type": "application/json", "x-mock-user": USER.bResearcher }, body: JSON.stringify(body) });
    expect(res.status).toBe(201);
    return res.json();
  };
  const project = await send("/projects", { name: "B Study", description: "B 기관 연구" });
  await send("/access-requests", {
    dataset_id: DATASET.sensors,
    project_id: project.project_id,
    purpose: "ACADEMIC_RESEARCH",
    purpose_detail: "센서 스트림 분석을 위한 충분히 긴 목적 상세 설명입니다.",
    operations: ["READ"],
    requested_days: 14,
  });
}

afterEach(() => vi.restoreAllMocks());

describe("PlatformShell: sidebar", () => {
  it("renders landmarks, grouped nav with the current page, org; skip link is the first tab stop", async () => {
    setLocation("/commons/projects");
    renderWithProviders(<PlatformShell>{page}</PlatformShell>, { user: USER.aResearcher });
    const nav = await screen.findByRole("navigation", { name: "주 메뉴" });
    expect(within(nav).getAllByRole("link").map((l) => l.textContent)).toEqual(["대시보드", "데이터 허브", "전체 데이터", "프로젝트", "연구노트", "접근 관리", "활동"]);
    expect(within(nav).getByRole("link", { name: "데이터 허브" })).toHaveAttribute("href", "/commons/hub");
    expect(within(nav).getByRole("link", { name: "연구노트" })).toHaveAttribute("href", "/commons/notes");
    expect(within(nav).getByRole("link", { name: "프로젝트" })).toHaveAttribute("aria-current", "page");
    expect(within(nav).getByRole("link", { name: "대시보드" })).not.toHaveAttribute("aria-current");
    // Groups: 작업 / 거버넌스; 관리 only with a role that can use it.
    expect(within(nav).getByRole("list", { name: "작업" })).toBeInTheDocument();
    expect(within(nav).getByRole("list", { name: "거버넌스" })).toBeInTheDocument();
    expect(within(nav).queryByRole("list", { name: "관리" })).not.toBeInTheDocument();
    // Notebooks are announced but not a link yet (no dead link).
    const notebooks = within(nav).getByText("노트북").closest("[aria-disabled]");
    expect(notebooks).toHaveAttribute("aria-disabled", "true");
    expect(within(notebooks as HTMLElement).getByText("예정")).toBeInTheDocument();

    expect(screen.getByRole("banner")).toBeInTheDocument();
    expect(screen.getByRole("main")).toContainElement(screen.getByRole("heading", { name: "본문" }));
    expect(screen.getAllByText("한국에너지기술연구원").length).toBeGreaterThan(0);
    await userEvent.tab();
    expect(screen.getByRole("link", { name: "본문으로 건너뛰기" })).toHaveFocus();
  });

  it("adds 관리 > 기관 관리 for ORG_ADMIN and for PLATFORM_ADMIN", async () => {
    const { unmount } = renderWithProviders(<PlatformShell>{page}</PlatformShell>, { user: USER.aAdmin });
    let nav = await screen.findByRole("navigation", { name: "주 메뉴" });
    expect(within(within(nav).getByRole("list", { name: "관리" })).getByRole("link", { name: "기관 관리" })).toHaveAttribute("href", "/settings/organization");
    unmount();
    renderWithProviders(<PlatformShell>{page}</PlatformShell>, { user: USER.admin });
    nav = await screen.findByRole("navigation", { name: "주 메뉴" });
    expect(within(nav).getByRole("link", { name: "기관 관리" })).toBeInTheDocument();
  });

  it("shows the steward's review count next to 접근 관리", async () => {
    await seedPending();
    renderWithProviders(<PlatformShell>{page}</PlatformShell>, { user: USER.aSteward });
    const nav = await screen.findByRole("navigation", { name: "주 메뉴" });
    const access = within(nav).getByRole("link", { name: /^접근 관리/ });
    await waitFor(() => expect(access).toHaveAccessibleName("접근 관리 (검토 대기 1건)"));
  });

  it("collapses to an icon rail and remembers it", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const { unmount } = renderWithProviders(<PlatformShell>{page}</PlatformShell>, { user: USER.aResearcher });
    await userEvent.click(await screen.findByRole("button", { name: "사이드바 접기" }));
    expect(screen.getByRole("button", { name: "사이드바 펼치기" })).toBeInTheDocument();
    expect(setItem).toHaveBeenCalledWith("nais-sidebar-collapsed", "1");
    // Labels stay as accessible names in the rail.
    expect(within(screen.getByRole("navigation", { name: "주 메뉴" })).getByRole("link", { name: "전체 데이터" })).toBeInTheDocument();
    unmount();
    renderWithProviders(<PlatformShell>{page}</PlatformShell>, { user: USER.aResearcher });
    expect(await screen.findByRole("button", { name: "사이드바 펼치기" })).toBeInTheDocument();
    window.localStorage.removeItem("nais-sidebar-collapsed");
  });

  it("still collapses when storage throws (private mode, blocked site data)", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    renderWithProviders(<PlatformShell>{page}</PlatformShell>, { user: USER.aResearcher });
    await userEvent.click(await screen.findByRole("button", { name: "사이드바 접기" }));
    expect(screen.getByRole("button", { name: "사이드바 펼치기" })).toBeInTheDocument();
  });

  it("on a phone, 메뉴 opens the navigation sheet and a link closes it", async () => {
    mockViewport(390);
    renderWithProviders(<PlatformShell>{page}</PlatformShell>, { user: USER.aResearcher });
    await userEvent.click(await screen.findByRole("button", { name: "메뉴" }));
    const sheet = await screen.findByRole("dialog", { name: "메뉴" });
    await userEvent.click(within(sheet).getByRole("link", { name: "전체 데이터" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "메뉴" })).not.toBeInTheDocument());
  });
});

describe("PlatformShell: top bar", () => {
  it("breadcrumbs: section from the path, then what the screen adds; the last is the current page", async () => {
    setLocation(`/commons/data/${DATASET.battery}`);
    function Detail() {
      useBreadcrumbs([{ label: "리튬이온 배터리 셀 사이클 시험 데이터" }]);
      return page;
    }
    renderWithProviders(
      <PlatformShell>
        <Detail />
      </PlatformShell>,
      { user: USER.aResearcher },
    );
    const crumbs = await screen.findByRole("navigation", { name: "현재 위치" });
    await waitFor(() => expect(within(crumbs).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["전체 데이터", "리튬이온 배터리 셀 사이클 시험 데이터"]));
    expect(within(crumbs).getByRole("link", { name: "전체 데이터" })).toHaveAttribute("href", "/commons/data");
    expect(within(crumbs).getByText("리튬이온 배터리 셀 사이클 시험 데이터")).toHaveAttribute("aria-current", "page");
  });

  it("notification bell shows the unread count and opens the linked page (marking it read)", async () => {
    renderWithProviders(<PlatformShell>{page}</PlatformShell>, { user: USER.aResearcher });
    const bell = await screen.findByRole("button", { name: "알림 1개 읽지 않음" });
    await userEvent.click(bell);
    const panel = await screen.findByRole("dialog", { name: "알림" });
    await userEvent.click(within(panel).getByRole("button", { name: /접근 권한이 .* 만료됩니다/ }));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith("/commons/access?tab=grants"));
    expect(getDb().notifications.find((n) => n.link === "/commons/access?tab=grants")?.read).toBe(true);
  });

  it("모두 읽음 clears the unread count; read items stay listed", async () => {
    renderWithProviders(<PlatformShell>{page}</PlatformShell>, { user: USER.aResearcher });
    await userEvent.click(await screen.findByRole("button", { name: "알림 1개 읽지 않음" }));
    const panel = await screen.findByRole("dialog", { name: "알림" });
    await userEvent.click(within(panel).getByRole("button", { name: "모두 읽음" }));
    expect(await screen.findByRole("button", { name: "알림" })).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: /접근 권한이 .* 만료됩니다/ })).toBeInTheDocument();
    expect(within(panel).queryByRole("button", { name: "모두 읽음" })).not.toBeInTheDocument();
  });

  it("shows an assertive error toast when marking a notification read fails, and never follows an unsafe link", async () => {
    getDb().notifications.find((n) => n.link === "/commons/access?tab=grants")!.link = "/\\evil.com";
    server.use(http.post("*/mock-api/v1/notifications/:id/read", () => HttpResponse.json({ error: { code: "INTERNAL_ERROR", message: "x", trace_id: "t" } }, { status: 500 })));
    renderWithProviders(<PlatformShell>{page}</PlatformShell>, { user: USER.aResearcher });
    await userEvent.click(await screen.findByRole("button", { name: "알림 1개 읽지 않음" }));
    await userEvent.click(await screen.findByRole("button", { name: /접근 권한이 .* 만료됩니다/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("알림을 읽음 처리하지 못했습니다.");
    expect(router.push).not.toHaveBeenCalled();
  });

  it("closes the notification panel and the user menu on an outside click", async () => {
    renderWithProviders(<PlatformShell>{page}</PlatformShell>, { user: USER.aResearcher });
    await userEvent.click(await screen.findByRole("button", { name: "알림 1개 읽지 않음" }));
    expect(await screen.findByRole("dialog", { name: "알림" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("heading", { name: "본문" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "알림" })).not.toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: /김민준/ }));
    expect(await screen.findByRole("menuitem", { name: "설정" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("heading", { name: "본문" }));
    await waitFor(() => expect(screen.queryByRole("menuitem", { name: "설정" })).not.toBeInTheDocument());
  });
});

describe("PlatformShell: user menu", () => {
  it("shows who and where, settings, a theme choice and sign-out; Escape returns focus", async () => {
    renderWithProviders(
      <ThemeProvider>
        <PlatformShell>{page}</PlatformShell>
      </ThemeProvider>,
      { user: USER.aResearcher },
    );
    const menuButton = await screen.findByRole("button", { name: /김민준/ });
    await userEvent.click(menuButton);
    const menu = await screen.findByRole("menu");
    expect(within(menu).getByText("a.researcher@inst-a.local")).toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: "설정" })).toHaveAttribute("href", "/settings");
    expect(within(menu).getAllByRole("menuitemradio").map((r) => r.textContent)).toEqual(["시스템", "라이트", "다크"]);
    expect(within(menu).getByRole("menuitemradio", { name: "시스템" })).toHaveAttribute("aria-checked", "true");
    await userEvent.click(within(menu).getByRole("menuitemradio", { name: "다크" }));
    await waitFor(() => expect(within(menu).getByRole("menuitemradio", { name: "다크" })).toHaveAttribute("aria-checked", "true"));
    expect(document.documentElement).toHaveClass("dark");
    expect(within(menu).getByRole("menuitem", { name: "로그아웃" })).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
    expect(menuButton).toHaveFocus();
    act(() => document.documentElement.classList.remove("dark"));
    window.localStorage.removeItem("nais-theme");
  });

  it("로그아웃 in mock mode clears the mock user and goes home", async () => {
    renderWithProviders(<PlatformShell>{page}</PlatformShell>, { user: USER.aResearcher });
    await userEvent.click(await screen.findByRole("button", { name: /김민준/ }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "로그아웃" }));
    expect(router.push).toHaveBeenCalledWith("/");
    expect(document.cookie).not.toContain(USER.aResearcher);
  });
});

describe("PlatformShell: gate and shortcuts", () => {
  it("sends disabled members to /blocked", async () => {
    router.replace.mockImplementationOnce(() => {}); // the real shell unmounts on redirect; don't re-enter it here
    renderWithProviders(<PlatformShell>{page}</PlatformShell>, { user: USER.bDisabled });
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/blocked?code=MEMBERSHIP_DISABLED"));
    expect(screen.queryByRole("heading", { name: "본문" })).not.toBeInTheDocument();
  });

  it("sends signed-out users to the mock login with a callback", async () => {
    setLocation("/commons/data?q=x");
    router.replace.mockImplementationOnce(() => {});
    renderWithProviders(<PlatformShell>{page}</PlatformShell>);
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/mock-login?callbackUrl=%2Fcommons%2Fdata%3Fq%3Dx"));
  });

  it("keeps the page when a background getMe refetch fails (error view only without cached data)", async () => {
    const { queryClient } = renderWithProviders(<PlatformShell>{page}</PlatformShell>, { user: USER.aResearcher });
    await screen.findByRole("heading", { name: "본문" });
    server.use(http.get("*/mock-api/v1/me", () => HttpResponse.json({ error: { code: "INTERNAL_ERROR", message: "x", trace_id: "t" } }, { status: 500 })));
    await queryClient.invalidateQueries({ queryKey: ["getMe", {}] });
    await waitFor(() => expect(queryClient.getQueryState(["getMe", {}])?.status).toBe("error"));
    expect(screen.getByRole("heading", { name: "본문" })).toBeInTheDocument();
  });

  it("/ opens the command palette unless the user is typing or a menu is open", async () => {
    renderWithProviders(
      <PlatformShell>
        <label>
          메모
          <input />
        </label>
      </PlatformShell>,
      { user: USER.aResearcher },
    );
    const input = await screen.findByLabelText("메모");
    fireEvent.keyDown(input, { key: "/" });
    expect(screen.queryByRole("dialog", { name: "명령 팔레트" })).not.toBeInTheDocument();
    // A menu is open: `/` is its business (type-ahead), not the palette's.
    await userEvent.click(screen.getByRole("button", { name: /김민준/ }));
    await screen.findByRole("menu");
    fireEvent.keyDown(document.body, { key: "/" });
    expect(screen.queryByRole("dialog", { name: "명령 팔레트" })).not.toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
    fireEvent.keyDown(document.body, { key: "/" });
    expect(await screen.findByRole("dialog", { name: "명령 팔레트" })).toBeInTheDocument();
  });
});
