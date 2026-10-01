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
import { OrganizationScreen } from "./organization-screen";
import { SettingsScreen } from "./settings-screen";

const apiError = (status: number, code: string) => HttpResponse.json({ error: { code, message: code, details: {} } }, { status });

describe("SettingsScreen", () => {
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

  it("disabling a member warns that all their grants are revoked", async () => {
    renderScreen(<OrganizationScreen />, { user: USER.aAdmin, path: "/settings/organization" });
    const row = (await screen.findAllByRole("group", { name: "A Researcher" }))[0]!;
    await userEvent.click(within(row).getByRole("checkbox", { name: "활성" }));
    await userEvent.click(within(row).getByRole("button", { name: "변경 저장" }));
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent("이 사용자의 모든 데이터 접근 권한이 회수됩니다");
    await userEvent.click(within(dialog).getByRole("button", { name: "변경" }));
    await waitFor(() => expect(getDb().users.find((u) => u.user_id === USER.aResearcher)?.membership_status).toBe("DISABLED"));
    expect(getDb().grants.find((g) => g.access_grant_id === GRANT.seed)?.status).toBe("REVOKED");
  });

  it("granting a role saves, confirms with a toast and leaves the save button disabled again", async () => {
    renderScreen(<OrganizationScreen />, { user: USER.aAdmin, path: "/settings/organization" });
    const row = (await screen.findAllByRole("group", { name: "A Researcher" }))[0]!;
    const save = within(row).getByRole("button", { name: "변경 저장" });
    expect(save).toBeDisabled();
    await userEvent.click(within(row).getByRole("checkbox", { name: "데이터 관리자" }));
    expect(save).toBeEnabled();
    await userEvent.click(save);
    const dialog = screen.getByRole("dialog");
    expect(dialog).not.toHaveTextContent("회수됩니다");
    await userEvent.click(within(dialog).getByRole("button", { name: "변경" }));
    expect(await screen.findByText("변경했습니다.")).toBeInTheDocument();
    expect(getDb().users.find((u) => u.user_id === USER.aResearcher)?.org_roles).toEqual(["DATA_STEWARD"]);
    await waitFor(() => expect(within(screen.getAllByRole("group", { name: "A Researcher" })[0]!).getByRole("button", { name: "변경 저장" })).toBeDisabled());
  });

  it("an ORG_ADMIN cannot change their own ORG_ADMIN role or status (M01): the controls are disabled with a hint", async () => {
    renderScreen(<OrganizationScreen />, { user: USER.aAdmin, path: "/settings/organization" });
    const row = (await screen.findAllByRole("group", { name: "A Admin" }))[0]!;
    expect(within(row).getByRole("checkbox", { name: "기관 관리자" })).toBeDisabled();
    expect(within(row).getByRole("checkbox", { name: "활성" })).toBeDisabled();
    expect(within(row).getByText("본인의 기관 관리자 역할과 상태는 직접 변경할 수 없습니다.")).toBeInTheDocument();
    expect(within(row).getByRole("checkbox", { name: "데이터 관리자" })).toBeEnabled();
  });

  it("a server rejection (ROLE_NOT_ASSIGNABLE) is localized and the dialog closes", async () => {
    server.use(http.patch("*/mock-api/v1/organizations/:id/members/:uid", () => apiError(422, "ROLE_NOT_ASSIGNABLE"), { once: true }));
    renderScreen(<OrganizationScreen />, { user: USER.aAdmin, path: "/settings/organization" });
    const row = (await screen.findAllByRole("group", { name: "A Researcher" }))[0]!;
    await userEvent.click(within(row).getByRole("checkbox", { name: "데이터 관리자" }));
    await userEvent.click(within(row).getByRole("button", { name: "변경 저장" }));
    await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "변경" }));
    expect(await screen.findByText("이 범위에서 지정할 수 없는 역할입니다.")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("a PLATFORM_ADMIN removing their own ORG_ADMIN role needs a second confirmation", async () => {
    renderScreen(<OrganizationScreen />, { user: USER.admin, path: "/settings/organization" });
    const row = (await screen.findAllByRole("group", { name: "NAIS Admin" }))[0]!;
    await userEvent.click(within(row).getByRole("checkbox", { name: "기관 관리자" }));
    await userEvent.click(within(row).getByRole("button", { name: "변경 저장" }));
    await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "변경" }));
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
