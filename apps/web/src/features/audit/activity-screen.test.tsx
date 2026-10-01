import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { getDb } from "@/mocks/db";
import { DATASET, ORG, USER } from "@/mocks/fixtures";
import { recordAudit } from "@/mocks/http";
import { server } from "../../../tests/msw";
import { router, setLocation } from "../../../tests/navigation";
import { renderScreen } from "../../../tests/render";
import { ActivityScreen } from "./activity-screen";

/** Collects the URLs of audit-events requests until the returned stop() is called. */
function watchAuditRequests() {
  const seen: string[] = [];
  const listener = ({ request }: { request: Request }) => void (request.url.includes("/audit-events") && seen.push(request.url));
  server.events.on("request:start", listener);
  return { seen, stop: () => server.events.removeListener("request:start", listener) };
}

describe("ActivityScreen", () => {
  const table = () => screen.getByRole("table", { name: "활동 · 감사 로그" });

  it("shows the caller's own events with Korean action labels and the scope note", async () => {
    renderScreen(<ActivityScreen />, { user: USER.aResearcher, path: "/commons/activity" });
    await screen.findByRole("table", { name: "활동 · 감사 로그" });
    expect((await within(table()).findAllByText("프로젝트 생성")).length).toBeGreaterThan(0);
    expect(within(table()).getAllByText("접근 요청").length).toBeGreaterThan(0);
    expect(screen.getByText("본인이 수행한 활동만 표시됩니다.")).toBeInTheDocument();
  });

  it("filters by action (URL-synced) and reveals trace details on demand", async () => {
    renderScreen(<ActivityScreen />, { user: USER.aResearcher, path: "/commons/activity" });
    await screen.findByRole("table", { name: "활동 · 감사 로그" });
    await userEvent.click(screen.getByText("행위 선택", { selector: "summary" }));
    await userEvent.click(screen.getByRole("checkbox", { name: "프로젝트 생성" }));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/commons/activity?action=PROJECT_CREATED", { scroll: false }));
    await waitFor(() => expect(within(table()).queryAllByText("접근 요청")).toHaveLength(0));
    const summary = within(table()).getAllByText("상세 보기")[0]!;
    await userEvent.click(summary);
    expect(within(summary.closest("details")!).getByText(/추적 ID/)).toBeInTheDocument();
  });

  it("derives every filter from the URL, including on Back/Forward", async () => {
    renderScreen(<ActivityScreen />, { user: USER.aResearcher, path: "/commons/activity?action=PROJECT_CREATED&resource_type=PROJECT" });
    await screen.findByRole("table", { name: "활동 · 감사 로그" });
    expect(screen.getByText("행위 선택 (1)", { selector: "summary" })).toBeInTheDocument();
    expect(screen.getByLabelText("대상 종류")).toHaveValue("PROJECT");
    await waitFor(() => expect(within(table()).queryAllByText("접근 요청")).toHaveLength(0));
    act(() => setLocation("/commons/activity"));
    await waitFor(() => expect(screen.getByText("행위 선택", { selector: "summary" })).toBeInTheDocument());
    expect(screen.getByLabelText("대상 종류")).toHaveValue("");
    await screen.findByRole("table", { name: "활동 · 감사 로그" });
    expect((await within(table()).findAllByText("접근 요청")).length).toBeGreaterThan(0);
  });

  it("ignores malformed URL filter values instead of crashing or sending them", async () => {
    const { seen, stop } = watchAuditRequests();
    renderScreen(<ActivityScreen />, { user: USER.aResearcher, path: "/commons/activity?action=NOPE&resource_type=BOGUS&from=garbage&to=2026-13-45" });
    await waitFor(() => expect(seen.length).toBeGreaterThan(0));
    stop();
    expect(seen.length).toBeGreaterThan(0);
    for (const url of seen) expect(url).not.toMatch(/action=|resource_type=|from=|to=/);
  });

  it("the end date is inclusive: `to` is sent as the start of the next Seoul day (server `to` is exclusive)", async () => {
    const { seen, stop } = watchAuditRequests();
    renderScreen(<ActivityScreen />, { user: USER.aResearcher, path: "/commons/activity?from=2026-01-01&to=2026-01-02" });
    await waitFor(() => expect(seen.length).toBeGreaterThan(0));
    stop();
    const q = new URL(seen.at(-1)!).searchParams;
    expect(q.get("from")).toBe("2025-12-31T15:00:00.000Z");
    expect(q.get("to")).toBe("2026-01-02T15:00:00.000Z");
  });

  it("stewards see the organization scope note", async () => {
    renderScreen(<ActivityScreen />, { user: USER.bSteward, path: "/commons/activity" });
    expect(await screen.findByText("우리 기관과 관련된 활동이 표시됩니다.")).toBeInTheDocument();
  });

  it("platform admins see the platform scope note", async () => {
    renderScreen(<ActivityScreen />, { user: USER.admin, path: "/commons/activity" });
    expect(await screen.findByText("플랫폼 전체 활동이 표시됩니다.")).toBeInTheDocument();
  });

  it("shows DOWNLOAD_DENIED rows exactly as the server returns them (owner staff yes, plain member no)", async () => {
    recordAudit(getDb(), {
      action: "DOWNLOAD_DENIED",
      actor: getDb().users.find((u) => u.user_id === USER.bResearcher)!,
      resource: { type: "DATASET", id: DATASET.sensors, owner_organization_id: ORG.a },
      result: "DENIED",
      reason: "ACCESS_NOT_GRANTED",
    });
    const { unmount } = renderScreen(<ActivityScreen />, { user: USER.aSteward, path: "/commons/activity" });
    const denied = await within(await screen.findByRole("table", { name: "활동 · 감사 로그" })).findAllByText("다운로드 거부");
    expect(denied.length).toBeGreaterThan(0);
    expect(screen.getAllByText("거부").length).toBeGreaterThan(0);
    unmount();
    renderScreen(<ActivityScreen />, { user: USER.aResearcher, path: "/commons/activity" });
    await screen.findByRole("table", { name: "활동 · 감사 로그" });
    expect(screen.queryByText("다운로드 거부", { selector: "td, dd, span" })).not.toBeInTheDocument();
  });

  it("a server 403 (e.g. foreign project in the URL) is shown as an error, not an empty list", async () => {
    server.use(http.get("*/mock-api/v1/audit-events", () => HttpResponse.json({ error: { code: "FORBIDDEN", message: "x", details: {} } }, { status: 403 })));
    renderScreen(<ActivityScreen />, { user: USER.aResearcher, path: "/commons/activity?project_id=00000000-0000-7000-8000-00000000ffff" });
    expect(await screen.findByRole("alert")).toHaveTextContent("이 작업을 수행할 권한이 없습니다.");
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("announces the result count politely", async () => {
    renderScreen(<ActivityScreen />, { user: USER.aResearcher, path: "/commons/activity" });
    await screen.findByRole("table", { name: "활동 · 감사 로그" });
    expect(screen.getByText(/^\d+건 표시 중/)).toHaveAttribute("aria-live", "polite");
  });
});
