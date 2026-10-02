import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { getDb } from "@/mocks/db";
import { GRANT, USER } from "@/mocks/fixtures";
import { server } from "../../../tests/msw";
import { router } from "../../../tests/navigation";
import { renderScreen } from "../../../tests/render";
import { ReservedScreen } from "../shell/reserved-screen";
import { ThemeProvider } from "@/shared/ui/theme";
import { OrganizationScreen } from "./organization-screen";
import { SettingsScreen } from "./settings-screen";

const apiError = (status: number, code: string) => HttpResponse.json({ error: { code, message: code, details: {} } }, { status });

/** Opens a member's row menu (the DataTable renders a desktop table and a phone list; the first is the table). */
async function openMemberMenu(name: string) {
  await userEvent.click((await screen.findAllByRole("button", { name: `${name} 관리` }))[0]!);
  return screen.findByRole("menu");
}

async function openRolesDialog(name: string) {
  const menu = await openMemberMenu(name);
  await userEvent.click(within(menu).getByRole("menuitem", { name: "역할 변경" }));
  return screen.findByRole("dialog", { name: `${name} 역할 변경` });
}

describe("SettingsScreen", () => {
  it("uses the settings template: a sub-nav to each section, 기관 관리 only for admins", async () => {
    const { unmount } = renderScreen(<SettingsScreen />, { user: USER.aResearcher, path: "/settings" });
    const nav = await screen.findByRole("navigation", { name: "설정 메뉴" });
    expect(within(nav).getByRole("link", { name: "프로필" })).toHaveAttribute("href", "#profile");
    expect(within(nav).getByRole("link", { name: "연구자 번호" })).toHaveAttribute("href", "#researcher-number");
    expect(within(nav).getByRole("link", { name: "화면 테마" })).toHaveAttribute("href", "#theme");
    expect(within(nav).queryByRole("link", { name: "기관 관리" })).not.toBeInTheDocument();
    for (const name of ["내 정보", "연구자 번호", "화면 테마", "언어", "알림"]) expect(screen.getByRole("region", { name })).toBeInTheDocument();
    unmount();
    renderScreen(<SettingsScreen />, { user: USER.aAdmin, path: "/settings" });
    const adminNav = await screen.findByRole("navigation", { name: "설정 메뉴" });
    expect(within(adminNav).getByRole("link", { name: "기관 관리" })).toHaveAttribute("href", "/settings/organization");
  });

  it("the theme section is a radio group bound to the stored theme choice", async () => {
    renderScreen(
      <ThemeProvider>
        <SettingsScreen />
      </ThemeProvider>,
      { user: USER.aResearcher, path: "/settings" },
    );
    const group = await screen.findByRole("radiogroup", { name: "화면 테마" });
    expect(within(group).getByRole("radio", { name: "시스템" })).toBeChecked();
    await userEvent.click(within(group).getByRole("radio", { name: "다크" }));
    await waitFor(() => expect(within(group).getByRole("radio", { name: "다크" })).toBeChecked());
    expect(localStorage.getItem("nais-theme")).toBe("dark");
    expect(document.documentElement).toHaveClass("dark");
    await userEvent.click(within(group).getByRole("radio", { name: "라이트" }));
    await waitFor(() => expect(localStorage.getItem("nais-theme")).toBe("light"));
    localStorage.removeItem("nais-theme");
    document.documentElement.removeAttribute("class");
    document.documentElement.removeAttribute("style");
  });

  it("shows my read-only profile, manages notifications and switches language", async () => {
    renderScreen(<SettingsScreen />, { user: USER.aResearcher, path: "/settings" });
    expect(await screen.findByText("a.researcher@inst-a.local")).toBeInTheDocument();
    const list = await screen.findByRole("list", { name: "알림 목록" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(1);
    await userEvent.click(within(list).getByRole("button", { name: "읽음 처리" }));
    await waitFor(() => expect(getDb().notifications.filter((n) => n.user_id === USER.aResearcher && !n.read)).toHaveLength(0));
    await userEvent.click(screen.getByRole("radio", { name: "English" }));
    expect(document.cookie).toContain("NEXT_LOCALE=en");
    expect(router.refresh).toHaveBeenCalled();
  });

  it("marks all notifications read and only links to same-origin paths", async () => {
    const db = getDb();
    const own = db.notifications.find((n) => n.user_id === USER.aResearcher)!;
    own.link = "/commons/access";
    db.notifications.push({ ...own, notification_id: "00000000-0000-7000-8000-000000007fff", link: "//evil.example/steal", read: false });
    renderScreen(<SettingsScreen />, { user: USER.aResearcher, path: "/settings" });
    const list = await screen.findByRole("list", { name: "알림 목록" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    expect(within(list).getAllByRole("link", { name: "열기" })).toHaveLength(1);
    expect(within(list).getByRole("link", { name: "열기" })).toHaveAttribute("href", "/commons/access");
    await userEvent.click(screen.getByRole("button", { name: "모두 읽음" }));
    await waitFor(() => expect(db.notifications.filter((n) => n.user_id === USER.aResearcher && !n.read)).toHaveLength(0));
  });

  it("shows an error with retry when notifications fail to load, keeping the profile", async () => {
    server.use(http.get("*/mock-api/v1/notifications", () => apiError(500, "INTERNAL_ERROR")));
    renderScreen(<SettingsScreen />, { user: USER.aResearcher, path: "/settings" });
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.getByText("a.researcher@inst-a.local")).toBeInTheDocument();
  });
});

describe("OrganizationScreen", () => {
  it("is ORG_ADMIN only", async () => {
    renderScreen(<OrganizationScreen />, { user: USER.aResearcher, path: "/settings/organization" });
    expect(await screen.findByRole("alert")).toHaveTextContent("이 작업을 수행할 권한이 없습니다.");
  });

  it("a server 403 on the member list is shown instead of an empty list", async () => {
    server.use(http.get("*/mock-api/v1/organizations/:id/members", () => apiError(403, "FORBIDDEN")));
    renderScreen(<OrganizationScreen />, { user: USER.aAdmin, path: "/settings/organization" });
    expect(await screen.findByRole("alert")).toHaveTextContent("이 작업을 수행할 권한이 없습니다.");
  });

  it("lists members in a table with role badges and status", async () => {
    renderScreen(<OrganizationScreen />, { user: USER.bAdmin, path: "/settings/organization" });
    const table = await screen.findByRole("table", { name: "기관 멤버" });
    const row = within(table).getByRole("row", { name: /B Steward/ });
    expect(within(row).getByText("데이터 관리자")).toBeInTheDocument();
    expect(within(row).getByText("활성")).toBeInTheDocument();
    expect(within(within(table).getByRole("row", { name: /B Disabled/ })).getByText("비활성")).toBeInTheDocument();
    expect(within(within(table).getByRole("row", { name: /B Admin/ })).getByText("나")).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "설정 메뉴" })).toBeInTheDocument();
    expect(within(screen.getByRole("navigation", { name: "설정 메뉴" })).getByRole("link", { name: "기관 관리" })).toHaveAttribute("aria-current", "page");
  });

  it("disabling a member warns that all their grants are revoked", async () => {
    renderScreen(<OrganizationScreen />, { user: USER.aAdmin, path: "/settings/organization" });
    const menu = await openMemberMenu("A Researcher");
    await userEvent.click(within(menu).getByRole("menuitem", { name: "비활성화" }));
    const dialog = await screen.findByRole("dialog", { name: "A Researcher 비활성화" });
    expect(dialog).toHaveTextContent("이 사용자의 모든 데이터 접근 권한이 회수됩니다");
    await userEvent.click(within(dialog).getByRole("button", { name: "비활성화" }));
    await waitFor(() => expect(getDb().users.find((u) => u.user_id === USER.aResearcher)?.membership_status).toBe("DISABLED"));
    expect(getDb().grants.find((g) => g.access_grant_id === GRANT.seed)?.status).toBe("REVOKED");
  });

  it("a disabled member can be re-enabled from the row menu", async () => {
    renderScreen(<OrganizationScreen />, { user: USER.bAdmin, path: "/settings/organization" });
    const menu = await openMemberMenu("B Disabled");
    await userEvent.click(within(menu).getByRole("menuitem", { name: "다시 활성화" }));
    const dialog = await screen.findByRole("dialog", { name: "B Disabled 다시 활성화" });
    expect(dialog).not.toHaveTextContent("회수됩니다");
    await userEvent.click(within(dialog).getByRole("button", { name: "다시 활성화" }));
    await waitFor(() => expect(getDb().users.find((u) => u.user_id === USER.bDisabled)?.membership_status).toBe("ACTIVE"));
  });

  it("granting a role saves, confirms with a toast and closes the dialog", async () => {
    renderScreen(<OrganizationScreen />, { user: USER.aAdmin, path: "/settings/organization" });
    const dialog = await openRolesDialog("A Researcher");
    const save = within(dialog).getByRole("button", { name: "변경 저장" });
    expect(save).toBeDisabled();
    await userEvent.click(within(dialog).getByRole("checkbox", { name: "데이터 관리자" }));
    expect(save).toBeEnabled();
    await userEvent.click(save);
    expect(await screen.findByText("변경했습니다.")).toBeInTheDocument();
    expect(getDb().users.find((u) => u.user_id === USER.aResearcher)?.org_roles).toEqual(["DATA_STEWARD"]);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(within(screen.getByRole("row", { name: /A Researcher/ })).getByText("데이터 관리자")).toBeInTheDocument());
  });

  it("an ORG_ADMIN cannot change their own ORG_ADMIN role or status (M01): the controls are disabled with a hint", async () => {
    renderScreen(<OrganizationScreen />, { user: USER.aAdmin, path: "/settings/organization" });
    const menu = await openMemberMenu("A Admin");
    expect(within(menu).getByRole("menuitem", { name: "비활성화" })).toHaveAttribute("aria-disabled", "true");
    expect(within(menu).getByText("본인의 기관 관리자 역할과 상태는 직접 변경할 수 없습니다.")).toBeInTheDocument();
    await userEvent.click(within(menu).getByRole("menuitem", { name: "역할 변경" }));
    const dialog = await screen.findByRole("dialog", { name: "A Admin 역할 변경" });
    expect(within(dialog).getByRole("checkbox", { name: "기관 관리자" })).toBeDisabled();
    expect(within(dialog).getByText("본인의 기관 관리자 역할과 상태는 직접 변경할 수 없습니다.")).toBeInTheDocument();
    expect(within(dialog).getByRole("checkbox", { name: "데이터 관리자" })).toBeEnabled();
  });

  it("the status control is disabled on one's own row even for a PLATFORM_ADMIN (ORG_ADMIN role stays editable)", async () => {
    renderScreen(<OrganizationScreen />, { user: USER.admin, path: "/settings/organization" });
    const menu = await openMemberMenu("NAIS Admin");
    expect(within(menu).getByRole("menuitem", { name: "비활성화" })).toHaveAttribute("aria-disabled", "true");
    expect(within(menu).getByText("본인의 상태는 직접 변경할 수 없습니다.")).toBeInTheDocument();
    await userEvent.click(within(menu).getByRole("menuitem", { name: "역할 변경" }));
    const dialog = await screen.findByRole("dialog", { name: "NAIS Admin 역할 변경" });
    expect(within(dialog).getByRole("checkbox", { name: "기관 관리자" })).toBeEnabled();
  });

  it("removing the last ORG_ADMIN of someone else shows the specific message", async () => {
    getDb().users.find((u) => u.user_id === USER.aResearcher)!.org_roles = ["ORG_ADMIN"];
    server.use(http.patch("*/mock-api/v1/organizations/:id/members/:uid", () => apiError(422, "ROLE_NOT_ASSIGNABLE"), { once: true }));
    renderScreen(<OrganizationScreen />, { user: USER.aAdmin, path: "/settings/organization" });
    const dialog = await openRolesDialog("A Researcher");
    await userEvent.click(within(dialog).getByRole("checkbox", { name: "기관 관리자" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "변경 저장" }));
    expect(await screen.findByText("기관의 마지막 기관 관리자는 플랫폼 관리자만 해제할 수 있습니다.")).toBeInTheDocument();
  });

  it("a server rejection (ROLE_NOT_ASSIGNABLE) is localized and the dialog closes", async () => {
    server.use(http.patch("*/mock-api/v1/organizations/:id/members/:uid", () => apiError(422, "ROLE_NOT_ASSIGNABLE"), { once: true }));
    renderScreen(<OrganizationScreen />, { user: USER.aAdmin, path: "/settings/organization" });
    const dialog = await openRolesDialog("A Researcher");
    await userEvent.click(within(dialog).getByRole("checkbox", { name: "데이터 관리자" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "변경 저장" }));
    expect(await screen.findByText("이 범위에서 지정할 수 없는 역할입니다.")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("a PLATFORM_ADMIN removing their own ORG_ADMIN role needs a second confirmation", async () => {
    renderScreen(<OrganizationScreen />, { user: USER.admin, path: "/settings/organization" });
    const dialog = await openRolesDialog("NAIS Admin");
    await userEvent.click(within(dialog).getByRole("checkbox", { name: "기관 관리자" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "변경 저장" }));
    const second = await screen.findByRole("dialog", { name: "본인 권한 해제 확인" });
    expect(getDb().users.find((u) => u.user_id === USER.admin)?.org_roles).toEqual(["ORG_ADMIN"]);
    await userEvent.click(within(second).getByRole("button", { name: "해제" }));
    await waitFor(() => expect(getDb().users.find((u) => u.user_id === USER.admin)?.org_roles).toEqual([]));
  });
});

describe("ReservedScreen", () => {
  it.each(["marketplace", "compute"] as const)("%s shows the coming-soon notice without development wording", async (name) => {
    renderScreen(<ReservedScreen name={name} />, { user: USER.aResearcher, path: `/${name}` });
    expect(await screen.findByRole("heading", { level: 1 })).toBeInTheDocument();
    expect(screen.getByText("준비 중인 기능입니다.")).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/P1|Wave|개발|예정/);
  });
});

describe("NTIS number and institute transfer (Wave 1.5)", () => {
  it("saves the NTIS researcher number and reports duplicates", async () => {
    renderScreen(<SettingsScreen />, { user: USER.aAdmin, path: "/settings" });
    const input = await screen.findByLabelText("국가연구자번호 (NTIS)");
    await userEvent.type(input, "1234");
    await userEvent.click(screen.getByRole("button", { name: "번호 저장" }));
    expect(await screen.findByText("8자리 숫자로 입력하세요.")).toBeInTheDocument();
    await userEvent.clear(input);
    await userEvent.type(input, "10000002"); // b.researcher's number in the seed
    await userEvent.click(screen.getByRole("button", { name: "번호 저장" }));
    expect(await screen.findByText("이미 다른 사용자가 등록한 번호입니다.")).toBeInTheDocument();
    await userEvent.clear(input);
    await userEvent.type(input, "12345678");
    await userEvent.click(screen.getByRole("button", { name: "번호 저장" }));
    expect(await screen.findByText("저장했습니다.")).toBeInTheDocument();
    expect(getDb().users.find((u) => u.user_id === USER.aAdmin)?.national_researcher_number).toBe("12345678");
  });

  it("deleting the number sends null (not an empty string)", async () => {
    renderScreen(<SettingsScreen />, { user: USER.aResearcher, path: "/settings" });
    expect(await screen.findByLabelText("국가연구자번호 (NTIS)")).toHaveValue("10000001");
    await userEvent.click(screen.getByRole("button", { name: "번호 삭제" }));
    expect(await screen.findByText("저장했습니다.")).toBeInTheDocument();
    expect(getDb().users.find((u) => u.user_id === USER.aResearcher)?.national_researcher_number).toBeNull();
    await waitFor(() => expect(screen.queryByRole("button", { name: "번호 삭제" })).not.toBeInTheDocument());
  });

  it("platform admin moves a user to another institute", async () => {
    renderScreen(<OrganizationScreen />, { user: USER.admin, path: "/settings/organization" });
    const card = await screen.findByRole("region", { name: "기관 이동" });
    expect(within(card).getByText(/이전 기관의 역할과 접근 권한은 종료되고/)).toBeInTheDocument();
    expect(within(card).getByRole("button", { name: "이동" })).toBeDisabled();
    await userEvent.type(within(card).getByRole("combobox", { name: /사용자/ }), "A R");
    await userEvent.click(await within(card).findByRole("option", { name: /A Researcher/ }));
    await userEvent.selectOptions(within(card).getByLabelText("이동할 기관"), "Institute B");
    await userEvent.click(within(card).getByRole("button", { name: "이동" }));
    const confirm = await screen.findByRole("dialog", { name: "A Researcher 님을 Institute B(으)로 이동" });
    expect(confirm).toHaveTextContent("다시 로그인해야 합니다");
    await userEvent.click(within(confirm).getByRole("button", { name: "이동 확인" }));
    expect(await screen.findByText(/A Researcher 님을 Institute B\(으\)로 옮겼습니다/)).toBeInTheDocument();
  });

  it("a 503 from the transfer shows a retry message", async () => {
    server.use(http.post("*/mock-api/v1/users/:id/transfer", () => apiError(503, "DEPENDENCY_UNAVAILABLE")));
    renderScreen(<OrganizationScreen />, { user: USER.admin, path: "/settings/organization" });
    const card = await screen.findByRole("region", { name: "기관 이동" });
    await userEvent.type(within(card).getByRole("combobox", { name: /사용자/ }), "A R");
    await userEvent.click(await within(card).findByRole("option", { name: /A Researcher/ }));
    await userEvent.selectOptions(within(card).getByLabelText("이동할 기관"), "Institute B");
    await userEvent.click(within(card).getByRole("button", { name: "이동" }));
    await userEvent.click(await screen.findByRole("button", { name: "이동 확인" }));
    expect(await within(card).findByRole("alert")).toHaveTextContent("다시 시도하세요");
  });

  it("a PLATFORM_ADMIN without ORG_ADMIN still sees the transfer card", async () => {
    getDb().users.find((u) => u.user_id === USER.admin)!.org_roles = [];
    renderScreen(<OrganizationScreen />, { user: USER.admin, path: "/settings/organization" });
    expect(await screen.findByRole("region", { name: "기관 이동" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "멤버" })).not.toBeInTheDocument();
  });

  it("non-platform-admins do not see the transfer card", async () => {
    renderScreen(<OrganizationScreen />, { user: USER.aAdmin, path: "/settings/organization" });
    await screen.findByRole("heading", { name: "멤버" });
    expect(screen.queryByRole("region", { name: "기관 이동" })).not.toBeInTheDocument();
  });
});
