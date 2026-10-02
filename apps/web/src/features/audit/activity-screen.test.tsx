import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { getDb } from "@/mocks/db";
import { DATASET, ORG, PROJECT, USER } from "@/mocks/fixtures";
import { recordAudit } from "@/mocks/http";
import type { AuditEvent } from "@/shared/api/types";
import { formatDate } from "@/shared/lib/format";
import { server } from "../../../tests/msw";
import { router, setLocation } from "../../../tests/navigation";
import { renderScreen } from "../../../tests/render";
import { ActivityScreen } from "./activity-screen";
import { ActivityTimeline } from "./components/audit-timeline";

/** Collects the URLs of audit-events requests until the returned stop() is called. */
function watchAuditRequests() {
  const seen: string[] = [];
  const listener = ({ request }: { request: Request }) => void (request.url.includes("/audit-events") && seen.push(request.url));
  server.events.on("request:start", listener);
  return { seen, stop: () => server.events.removeListener("request:start", listener) };
}

describe("ActivityScreen", () => {
  const timeline = () => screen.getByRole("region", { name: "활동 목록" });
  const open = (user: string, path = "/commons/activity") => renderScreen(<ActivityScreen />, { user, path });

  it("shows the caller's own events as verb phrases and the scope note", async () => {
    open(USER.aResearcher);
    await screen.findByRole("region", { name: "활동 목록" });
    expect((await within(timeline()).findAllByText("프로젝트를 만들었습니다")).length).toBeGreaterThan(0);
    expect(within(timeline()).getAllByText("접근을 요청했습니다").length).toBeGreaterThan(0);
    expect(screen.getByText("본인이 수행한 활동만 표시됩니다.")).toBeInTheDocument();
  });

  it("groups entries under sticky date headers; an entry has a mono time, the actor with organization and a target link", async () => {
    open(USER.aResearcher);
    await screen.findByRole("region", { name: "활동 목록" });
    const header = within(timeline()).getAllByRole("heading", { level: 2 })[0]!;
    expect(header).toHaveClass("sticky");
    expect(header).toHaveTextContent("오늘");
    // A single day: the result count above already says how many, so the header carries no count.
    expect(header).not.toHaveTextContent(/\d+건/);
    const entry = (await within(timeline()).findAllByText("프로젝트를 만들었습니다"))[0]!.closest("li")!;
    const time = entry.querySelector("time")!;
    expect(time).toHaveClass("font-mono", "num");
    expect(time.textContent).toMatch(/^\d{2}:\d{2}$/);
    expect(entry).toHaveTextContent("김민준");
    expect(await within(entry).findByText("한국에너지기술연구원")).toBeInTheDocument();
    expect(within(entry).getByRole("link")).toHaveAttribute("href", `/commons/projects/${PROJECT.seed}`);
    expect(await within(entry).findByText("차세대 이차전지 소재 공동연구")).toBeInTheDocument();
  });

  it("filters by action kind (URL-synced) and reveals trace details on demand", async () => {
    open(USER.aResearcher);
    await screen.findByRole("region", { name: "활동 목록" });
    await userEvent.click(screen.getByRole("button", { name: "행동 종류" }));
    await userEvent.click(await screen.findByRole("checkbox", { name: "프로젝트 생성" }));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/commons/activity?action=PROJECT_CREATED", { scroll: false }));
    await waitFor(() => expect(within(timeline()).queryAllByText("접근을 요청했습니다")).toHaveLength(0));
    await userEvent.keyboard("{Escape}");
    const toggle = within(timeline()).getAllByRole("button", { name: "상세 보기" })[0]!;
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(document.getElementById(toggle.getAttribute("aria-controls")!)).toHaveTextContent("추적 ID");
  });

  it("derives every filter from the URL, including on Back/Forward", async () => {
    open(USER.aResearcher, "/commons/activity?action=PROJECT_CREATED&resource_type=PROJECT");
    await screen.findByRole("region", { name: "활동 목록" });
    expect(screen.getByRole("button", { name: "행동 종류 (1개 선택)" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "대상 종류" })).toHaveTextContent("프로젝트");
    await waitFor(() => expect(within(timeline()).queryAllByText("접근을 요청했습니다")).toHaveLength(0));
    act(() => setLocation("/commons/activity"));
    await waitFor(() => expect(screen.getByRole("button", { name: "행동 종류" })).toBeInTheDocument());
    expect(screen.getByRole("combobox", { name: "대상 종류" })).toHaveTextContent("모든 대상");
    await screen.findByRole("region", { name: "활동 목록" });
    expect((await within(timeline()).findAllByText("접근을 요청했습니다")).length).toBeGreaterThan(0);
  });

  it("the period select writes a Seoul from-date for a preset and shows date fields for a custom range", async () => {
    open(USER.aResearcher);
    await screen.findByRole("region", { name: "활동 목록" });
    await userEvent.click(screen.getByRole("combobox", { name: "기간" }));
    await userEvent.click(await screen.findByRole("option", { name: "최근 7일" }));
    const from = formatDate(new Date(Date.now() - 6 * 86_400_000).toISOString());
    await waitFor(() => expect(router.replace).toHaveBeenLastCalledWith(`/commons/activity?from=${from}`, { scroll: false }));
    expect(screen.getByRole("combobox", { name: "기간" })).toHaveTextContent("최근 7일");
    await userEvent.click(screen.getByRole("combobox", { name: "기간" }));
    await userEvent.click(await screen.findByRole("option", { name: "직접 지정" }));
    await waitFor(() => expect(router.replace).toHaveBeenLastCalledWith(`/commons/activity?from=${from}&period=custom`, { scroll: false }));
    expect(await screen.findByLabelText("시작일")).toHaveValue(from);
    expect(screen.getByLabelText("종료일")).toHaveValue("");
    // Back to the preset URL: the custom fields go away (the choice is URL-derived, not component state).
    act(() => setLocation(`/commons/activity?from=${from}`));
    await waitFor(() => expect(screen.queryByLabelText("시작일")).not.toBeInTheDocument());
    expect(screen.getByRole("combobox", { name: "기간" })).toHaveTextContent("최근 7일");
  });

  it("the target search narrows the loaded rows and keeps the term in the URL", async () => {
    open(USER.aResearcher, "/commons/activity?q=이차전지");
    await screen.findByRole("region", { name: "활동 목록" });
    expect(screen.getByRole("searchbox", { name: "행위자·대상 검색" })).toHaveValue("이차전지");
    await waitFor(() => expect(within(timeline()).queryAllByText("접근을 요청했습니다")).toHaveLength(0));
    expect(within(timeline()).getAllByText("프로젝트를 만들었습니다").length).toBeGreaterThan(0);
    expect(screen.getByText(/건 표시 중 · 불러온 \d+건에서 검색/)).toBeInTheDocument();
    await userEvent.click(screen.getAllByRole("button", { name: "필터 초기화" })[0]!);
    expect(router.replace).toHaveBeenLastCalledWith("/commons/activity", { scroll: false });
  });

  it("a search with nothing in the loaded rows offers to load more instead of claiming there is nothing", async () => {
    open(USER.admin, "/commons/activity?q=nothing-matches-this");
    expect(await screen.findByText("불러온 활동 중 일치하는 항목이 없습니다.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "더 불러오기" })).toBeInTheDocument();
  });

  it("collapses a run of identical consecutive events into one expandable row", async () => {
    open(USER.admin);
    const run = await within(await screen.findByRole("region", { name: "활동 목록" })).findByText(/^AI-Ready 검증 \d+건을 마쳤습니다$/);
    const count = Number(run.textContent!.match(/\d+/)![0]);
    expect(count).toBeGreaterThan(1);
    const row = run.closest("li")!;
    expect(within(row).queryByText("AI-Ready 검증을 마쳤습니다")).not.toBeInTheDocument();
    await userEvent.click(within(row).getByRole("button", { name: `${count}건 펼치기` }));
    expect(within(row).getAllByRole("listitem")).toHaveLength(count);
  });

  it("shows the reason recorded on a successful event (a rejection) muted, and in the details", async () => {
    const steward = getDb().users.find((u) => u.user_id === USER.bSteward)!;
    recordAudit(getDb(), {
      action: "ACCESS_REJECTED",
      actor: steward,
      resource: { type: "ACCESS_REQUEST", id: "00000000-0000-7000-8000-00000000a001", owner_organization_id: ORG.b },
      reason: "목적이 데이터 정책과 맞지 않습니다",
    });
    getDb().audit.at(-1)!.occurred_at = new Date(Date.now() + 60_000).toISOString(); // newest, so it is on the first page
    open(USER.bSteward);
    const verb = (await within(await screen.findByRole("region", { name: "활동 목록" })).findAllByText("접근 요청을 거절했습니다"))[0]!;
    const entry = verb.closest("li")!;
    const reason = within(entry).getByText(/목적이 데이터 정책과 맞지 않습니다/, { selector: "p" });
    expect(reason).toHaveClass("text-fg-muted");
    expect(reason).not.toHaveClass("text-danger");
    expect(within(entry).queryByText("거부")).not.toBeInTheDocument();
    await userEvent.click(within(entry).getByRole("button", { name: "상세 보기" }));
    expect(within(entry).getByText("사유", { selector: "dt" }).nextElementSibling).toHaveTextContent("목적이 데이터 정책과 맞지 않습니다");
  });

  it("an empty filtered result says so and offers a reset", async () => {
    open(USER.aResearcher, "/commons/activity?q=nothing-matches-this");
    expect(await screen.findByText("조건에 맞는 활동이 없습니다.")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "필터 초기화" }).length).toBe(2);
  });

  it("ignores malformed URL filter values instead of crashing or sending them", async () => {
    const { seen, stop } = watchAuditRequests();
    open(USER.aResearcher, "/commons/activity?action=NOPE&resource_type=BOGUS&from=2026-02-30&to=2026-13-45");
    await waitFor(() => expect(seen.length).toBeGreaterThan(0));
    stop();
    expect(seen.length).toBeGreaterThan(0);
    for (const url of seen) expect(url).not.toMatch(/action=|resource_type=|from=|to=/);
  });

  it("the end date is inclusive: `to` is sent as the start of the next Seoul day (server `to` is exclusive)", async () => {
    const { seen, stop } = watchAuditRequests();
    open(USER.aResearcher, "/commons/activity?from=2026-01-01&to=2026-01-02");
    await waitFor(() => expect(seen.length).toBeGreaterThan(0));
    stop();
    const q = new URL(seen.at(-1)!).searchParams;
    expect(q.get("from")).toBe("2025-12-31T15:00:00.000Z");
    expect(q.get("to")).toBe("2026-01-02T15:00:00.000Z");
  });

  it("stewards see the organization scope note", async () => {
    open(USER.bSteward);
    expect(await screen.findByText("우리 기관과 관련된 활동이 표시됩니다.")).toBeInTheDocument();
  });

  it("platform admins see the platform scope note", async () => {
    open(USER.admin);
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
    const { unmount } = open(USER.aSteward);
    const denied = await within(await screen.findByRole("region", { name: "활동 목록" })).findAllByText("다운로드가 거부되었습니다");
    expect(denied.length).toBeGreaterThan(0);
    const deniedRow = denied[0]!.closest("li")!;
    expect(within(deniedRow).getByText("거부")).toBeInTheDocument();
    expect(within(deniedRow).getByText(/승인된 접근 권한이 없습니다|ACCESS_NOT_GRANTED/, { selector: "p" })).toHaveClass("text-danger");
    unmount();
    open(USER.aResearcher);
    await screen.findByRole("region", { name: "활동 목록" });
    expect(screen.queryByText("다운로드가 거부되었습니다")).not.toBeInTheDocument();
  });

  it("a server 403 (e.g. foreign project in the URL) is shown as an error, not an empty list", async () => {
    server.use(http.get("*/mock-api/v1/audit-events", () => HttpResponse.json({ error: { code: "FORBIDDEN", message: "x", details: {} } }, { status: 403 })));
    open(USER.aResearcher, "/commons/activity?project_id=00000000-0000-7000-8000-00000000ffff");
    expect(await screen.findByRole("alert")).toHaveTextContent("이 작업을 수행할 권한이 없습니다.");
    expect(screen.queryByRole("region", { name: "활동 목록" })).not.toBeInTheDocument();
  });

  it("announces the result count politely", async () => {
    open(USER.aResearcher);
    await screen.findByRole("region", { name: "활동 목록" });
    expect(screen.getByText(/^\d+건 표시 중/)).toHaveAttribute("aria-live", "polite");
  });
});

describe("ActivityTimeline", () => {
  it("virtualizes above 1,000 entries", async () => {
    const base = getDb().audit[0]!;
    const events: AuditEvent[] = Array.from({ length: 1200 }, (_, i) => ({
      ...base,
      audit_event_id: `e-${i}`,
      // Alternate the action so no two neighbours collapse into a run.
      action: i % 2 ? "DATASET_CREATED" : "PROJECT_CREATED",
      occurred_at: new Date(Date.now() - i * 3_600_000).toISOString(),
    }));
    renderScreen(<ActivityTimeline events={events} label="활동 목록" />, { user: USER.admin, path: "/commons/activity" });
    const region = await screen.findByRole("region", { name: "활동 목록" });
    await waitFor(() => expect(region.querySelectorAll("time").length).toBeGreaterThan(0));
    expect(region.querySelectorAll("time").length).toBeLessThan(100);
  });
});
