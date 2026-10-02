import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { getDb } from "@/mocks/db";
import { ORG, PROJECT, USER } from "@/mocks/fixtures";
import { server } from "../../../tests/msw";
import { router } from "../../../tests/navigation";
import { setLocation } from "../../../tests/navigation";
import { renderScreen } from "../../../tests/render";
import { ProjectDetailScreen } from "./project-detail-screen";
import { ProjectNewScreen } from "./project-new-screen";
import { ProjectsListScreen } from "./projects-list-screen";

const PUBLIC_PROJECT = "11111111-1111-4111-8111-111111111111";

/** The real seed has no PUBLIC project: add one owned by 한국재료연구원 through the mock db. */
function seedPublicProject() {
  const db = getDb();
  const seed = db.projects[0]!;
  db.projects.push({
    ...seed,
    project_id: PUBLIC_PROJECT,
    name: "Public Electrolyte Benchmark",
    visibility: "PUBLIC",
    lead_organization_id: ORG.b,
    description: "Open benchmark.",
    organizations: [{ organization_id: ORG.b, name: "한국재료연구원", role: "LEAD" }],
    created_by: USER.bResearcher,
  });
  db.projectMembers.push({ ...db.projectMembers[1]!, project_id: PUBLIC_PROJECT, role: "PROJECT_OWNER" });
}

describe("ProjectsListScreen", () => {
  it("lists my projects with lead organization, my role and member count", async () => {
    renderScreen(<ProjectsListScreen />, { user: USER.aResearcher, path: "/commons/projects" });
    const links = await screen.findAllByRole("link", { name: "차세대 이차전지 소재 공동연구" });
    expect(links[0]).toHaveAttribute("href", `/commons/projects/${PROJECT.seed}`);
    expect(screen.getAllByText("한국에너지기술연구원").length).toBeGreaterThan(0);
    expect(screen.getAllByText("소유자").length).toBeGreaterThan(0);
  });

  it("syncs the debounced search to the URL and shows the empty state", async () => {
    renderScreen(<ProjectsListScreen />, { user: USER.aResearcher, path: "/commons/projects" });
    await screen.findAllByRole("link", { name: /차세대 이차전지/ });
    await userEvent.type(screen.getByRole("searchbox", { name: "프로젝트 검색" }), "zzz");
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/commons/projects?q=zzz", { scroll: false }));
    expect(await screen.findByText("조건에 맞는 프로젝트가 없습니다.")).toBeInTheDocument();
  });

  it("discover tab lists PUBLIC projects", async () => {
    seedPublicProject();
    renderScreen(<ProjectsListScreen />, { user: USER.aResearcher, path: "/commons/projects" });
    await userEvent.click(await screen.findByRole("tab", { name: "공개 프로젝트" }));
    expect((await screen.findAllByRole("link", { name: "Public Electrolyte Benchmark" })).length).toBeGreaterThan(0);
    expect(router.replace).toHaveBeenCalledWith("/commons/projects?tab=discover", { scroll: false });
  });
});

describe("ProjectsListScreen URL state (Back/Forward)", () => {
  it("re-derives tab, search text and status when the URL changes under the screen", async () => {
    seedPublicProject();
    renderScreen(<ProjectsListScreen />, { user: USER.aResearcher, path: "/commons/projects?tab=discover&q=Public&status=ACTIVE" });
    expect(await screen.findByRole("tab", { name: "공개 프로젝트" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("searchbox", { name: "프로젝트 검색" })).toHaveValue("Public");
    expect(screen.getByLabelText("상태")).toHaveValue("ACTIVE");

    act(() => setLocation("/commons/projects"));
    await waitFor(() => expect(screen.getByRole("tab", { name: "내 프로젝트" })).toHaveAttribute("aria-selected", "true"));
    expect(screen.getByRole("searchbox", { name: "프로젝트 검색" })).toHaveValue("");
    expect(screen.getByLabelText("상태")).toHaveValue("");

    act(() => setLocation("/commons/projects?tab=discover&q=Public"));
    await waitFor(() => expect(screen.getByRole("searchbox", { name: "프로젝트 검색" })).toHaveValue("Public"));
    expect(screen.getByRole("tab", { name: "공개 프로젝트" })).toHaveAttribute("aria-selected", "true");
  });

  it("does not bounce the URL back after Back clears a typed query", async () => {
    renderScreen(<ProjectsListScreen />, { user: USER.aResearcher, path: "/commons/projects" });
    await screen.findAllByRole("link", { name: /차세대 이차전지/ });
    await userEvent.type(screen.getByRole("searchbox", { name: "프로젝트 검색" }), "zzz");
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/commons/projects?q=zzz", { scroll: false }));
    router.replace.mockClear();
    act(() => setLocation("/commons/projects"));
    await waitFor(() => expect(screen.getByRole("searchbox", { name: "프로젝트 검색" })).toHaveValue(""));
    await new Promise((r) => setTimeout(r, 450));
    expect(router.replace).not.toHaveBeenCalled();
  });
});

describe("ProjectNewScreen", () => {
  it.each([
    ["TOO_MANY", "항목이 너무 많습니다."],
    ["SOMETHING_NEW", "입력값을 확인해 주세요."],
  ])("localizes server reason %s instead of showing the raw code", async (reason, text) => {
    server.use(
      http.post("*/mock-api/v1/projects", () =>
        HttpResponse.json({ error: { code: "VALIDATION_FAILED", message: "x", trace_id: "t", details: { fields: [{ field: "keywords", reason }] } } }, { status: 422 }),
      ),
    );
    renderScreen(<ProjectNewScreen />, { user: USER.aResearcher, path: "/commons/projects/new" });
    await userEvent.type(await screen.findByLabelText(/^이름/), "Reason Test");
    await userEvent.click(screen.getByRole("button", { name: "프로젝트 만들기" }));
    expect((await screen.findAllByText(new RegExp(text))).length).toBeGreaterThan(0);
    expect(screen.queryByText(new RegExp(reason))).not.toBeInTheDocument();
  });

  it("maps server VALIDATION_FAILED onto the field (indexed keys normalised) and the summary", async () => {
    server.use(
      http.post("*/mock-api/v1/projects", () =>
        HttpResponse.json({ error: { code: "VALIDATION_FAILED", message: "x", trace_id: "t", details: { fields: [{ field: "keywords.3", message: "키워드가 너무 깁니다." }] } } }, { status: 422 }),
      ),
    );
    renderScreen(<ProjectNewScreen />, { user: USER.aResearcher, path: "/commons/projects/new" });
    await userEvent.type(await screen.findByLabelText(/^이름/), "Server Rejects");
    await userEvent.click(screen.getByRole("button", { name: "프로젝트 만들기" }));
    const summary = await screen.findByRole("alert");
    expect(summary).toHaveTextContent("키워드가 너무 깁니다.");
    expect(screen.getByLabelText(/^키워드/)).toHaveAttribute("aria-invalid", "true");
  });

  it("focuses the error summary, validates dates, then creates and navigates", async () => {
    renderScreen(<ProjectNewScreen />, { user: USER.aResearcher, path: "/commons/projects/new" });
    const submit = await screen.findByRole("button", { name: "프로젝트 만들기" });
    await userEvent.click(submit);
    const summary = await screen.findByRole("alert");
    expect(summary).toHaveFocus();
    expect(summary).toHaveTextContent("이름은 2자 이상 200자 이하로 입력하세요.");

    await userEvent.type(screen.getByLabelText(/^이름/), "E2E Joint Study");
    fireEvent.change(screen.getByLabelText("시작일"), { target: { value: "2026-10-10" } });
    fireEvent.change(screen.getByLabelText("종료일"), { target: { value: "2026-10-01" } });
    await userEvent.click(submit);
    expect((await screen.findAllByText(/종료일은 시작일과 같거나 이후여야 합니다/)).length).toBeGreaterThan(0);

    fireEvent.change(screen.getByLabelText("종료일"), { target: { value: "2026-12-31" } });
    await userEvent.click(submit);
    await waitFor(() => expect(router.push).toHaveBeenCalledWith(expect.stringMatching(/^\/commons\/projects\/[0-9a-f-]{36}$/)));
    expect(getDb().projects.some((p) => p.name === "E2E Joint Study")).toBe(true);
  });
});

describe("ProjectDetailScreen", () => {
  const open = (user: string, projectId: string = PROJECT.seed) =>
    renderScreen(<ProjectDetailScreen projectId={projectId} />, { user, path: `/commons/projects/${projectId}` });

  it("shows the overview and archives after a warning", async () => {
    open(USER.aResearcher);
    expect(await screen.findByRole("heading", { level: 1, name: "차세대 이차전지 소재 공동연구" })).toBeInTheDocument();
    expect(screen.getByText(/Seed project shared by 한국에너지기술연구원 and 한국재료연구원/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "보관" }));
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent("보관 시 이 프로젝트로 받은 모든 데이터 접근 권한이 즉시 회수됩니다");
    await userEvent.click(within(dialog).getByRole("button", { name: "보관" }));
    expect(await screen.findByText("보관된 프로젝트입니다. 모든 변경이 비활성화되었습니다.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "편집" })).not.toBeInTheDocument();
  });

  it("adds a member with the keyboard-operable user search", async () => {
    open(USER.aResearcher);
    await userEvent.click(await screen.findByRole("tab", { name: "멤버" }));
    const combo = await screen.findByRole("combobox", { name: "사용자 검색" });
    await userEvent.type(combo, "b.st");
    expect(await screen.findByRole("option", { name: "정현우 (한국재료연구원)" })).toBeInTheDocument();
    await userEvent.keyboard("{Enter}");
    await userEvent.selectOptions(screen.getByLabelText("추가할 역할"), "VIEWER");
    await userEvent.click(screen.getByRole("button", { name: "추가" }));
    expect((await screen.findAllByText("정현우")).length).toBeGreaterThan(0);
  });

  it("shows the server message when demoting the last owner", async () => {
    open(USER.aResearcher);
    await userEvent.click(await screen.findByRole("tab", { name: "멤버" }));
    const selects = await screen.findAllByLabelText("김민준 역할");
    await userEvent.selectOptions(selects[0]!, "RESEARCHER");
    expect(await screen.findByText("프로젝트에는 소유자가 최소 1명 있어야 합니다.")).toBeInTheDocument();
  });

  it("re-derives the active tab when the URL changes (Back/Forward)", async () => {
    renderScreen(<ProjectDetailScreen projectId={PROJECT.seed} />, { user: USER.aResearcher, path: `/commons/projects/${PROJECT.seed}?tab=members` });
    expect(await screen.findByRole("tab", { name: "멤버" })).toHaveAttribute("aria-selected", "true");
    act(() => setLocation(`/commons/projects/${PROJECT.seed}`));
    await waitFor(() => expect(screen.getByRole("tab", { name: "개요" })).toHaveAttribute("aria-selected", "true"));
  });

  it("the sole owner leaving gets the server's last-owner message and stays on the page", async () => {
    open(USER.aResearcher);
    await userEvent.click(await screen.findByRole("tab", { name: "멤버" }));
    await userEvent.click((await screen.findAllByRole("button", { name: "프로젝트 나가기" }))[0]!);
    await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "프로젝트 나가기" }));
    expect(await screen.findByText("프로젝트에는 소유자가 최소 1명 있어야 합니다.")).toBeInTheDocument();
    expect(router.push).not.toHaveBeenCalled();
  });

  it("removing a member rejected with PROJECT_LAST_OWNER shows the message", async () => {
    server.use(
      http.delete("*/mock-api/v1/projects/:project_id/members/:user_id", () =>
        HttpResponse.json({ error: { code: "PROJECT_LAST_OWNER", message: "x", trace_id: "t" } }, { status: 409 }),
      ),
    );
    open(USER.aResearcher);
    await userEvent.click(await screen.findByRole("tab", { name: "멤버" }));
    await userEvent.click((await screen.findAllByRole("button", { name: "제거" }))[0]!);
    await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "제거" }));
    expect(await screen.findByText("프로젝트에는 소유자가 최소 1명 있어야 합니다.")).toBeInTheDocument();
  });

  it("PUBLIC project, non-member: members-only notice with summary", async () => {
    seedPublicProject();
    open(USER.aResearcher, PUBLIC_PROJECT);
    expect(await screen.findByText("멤버만 상세를 볼 수 있습니다.")).toBeInTheDocument();
    expect(await screen.findByRole("heading", { level: 1, name: "Public Electrolyte Benchmark" })).toBeInTheDocument();
  });

  it("PRIVATE project, non-member: unified not-found message", async () => {
    open(USER.aSteward);
    expect(await screen.findByRole("alert")).toHaveTextContent("찾을 수 없거나 접근 권한이 없습니다.");
  });
});

describe("ProjectDetailScreen role rules", () => {
  const open = (user: string) => renderScreen(<ProjectDetailScreen projectId={PROJECT.seed} />, { user, path: `/commons/projects/${PROJECT.seed}` });
  const setRole = (user: string, role: "PROJECT_ADMIN" | "VIEWER") => {
    getDb().projectMembers.find((m) => m.user_id === user)!.role = role;
  };

  it("ADMIN manages only RESEARCHER/VIEWER: no controls for the OWNER row, no archive, visibility locked", async () => {
    setRole(USER.bResearcher, "PROJECT_ADMIN");
    open(USER.bResearcher);
    await screen.findByRole("heading", { level: 1, name: "차세대 이차전지 소재 공동연구" });
    expect(screen.queryByRole("button", { name: "보관" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "편집" }));
    for (const radio of screen.getAllByRole("radio")) expect(radio).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "취소" }));
    await userEvent.click(screen.getByRole("tab", { name: "멤버" }));
    await screen.findByRole("combobox", { name: "사용자 검색" });
    expect(screen.queryByLabelText("김민준 역할")).not.toBeInTheDocument();
    const add = screen.getByLabelText("추가할 역할");
    expect(within(add).queryByRole("option", { name: "소유자" })).not.toBeInTheDocument();
  });

  it("VIEWER sees no management controls but can leave", async () => {
    setRole(USER.bResearcher, "VIEWER");
    open(USER.bResearcher);
    await userEvent.click(await screen.findByRole("tab", { name: "멤버" }));
    await screen.findAllByText("김민준");
    expect(screen.queryByRole("combobox", { name: "사용자 검색" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "프로젝트 나가기" }).length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "제거" })).not.toBeInTheDocument();
  });

  it("archived project: read-only except self-leave", async () => {
    getDb().projects[0]!.status = "ARCHIVED";
    open(USER.aResearcher);
    await userEvent.click(await screen.findByRole("tab", { name: "멤버" }));
    await screen.findAllByText("김민준");
    expect(screen.queryByRole("combobox", { name: "사용자 검색" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("최유진 역할")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "제거" })).not.toBeInTheDocument();
    await userEvent.click(screen.getAllByRole("button", { name: "프로젝트 나가기" })[0]!);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});

describe("ProjectDetailScreen activity tab", () => {
  const open = () => renderScreen(<ProjectDetailScreen projectId={PROJECT.seed} />, { user: USER.aResearcher, path: `/commons/projects/${PROJECT.seed}?tab=activity` });

  it("members see the project's audit rows", async () => {
    open();
    expect(await screen.findByText("프로젝트 생성")).toBeInTheDocument();
    expect(screen.getByText("프로젝트 멤버 추가")).toBeInTheDocument();
  });

  it("a server 403 is shown as a localized error, not a crash", async () => {
    server.use(http.get("*/mock-api/v1/audit-events", () => HttpResponse.json({ error: { code: "FORBIDDEN", message: "x", trace_id: "t" } }, { status: 403 })));
    open();
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.queryByText("프로젝트 생성")).not.toBeInTheDocument();
  });
});
