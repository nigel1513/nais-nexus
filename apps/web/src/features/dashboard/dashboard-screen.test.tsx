import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it } from "vitest";
import { resetDb } from "@/mocks/db";
import { USER } from "@/mocks/fixtures";
import { PORTAL_USER } from "@/mocks/fixtures-portal";
import { server } from "../../../tests/msw";
import { renderScreen } from "../../../tests/render";
import { DashboardScreen } from "./dashboard-screen";

/** A panel by its heading (headings carry a count after the title). */
const panel = async (name: string) => (await screen.findAllByRole("region", { name: new RegExp(`^${name}`) }))[0]!;
const tiles = () => within(screen.getByRole("region", { name: "최근 30일 요약" })).getAllByRole("link");
/** The two-step title's context line ("기관 · 역할"), which the shared ScreenTitle splits into parts. */
const contextLine = (org: string, role: string) => (_: string, el: Element | null) => !!el?.classList.contains("sv-ctx") && el.textContent === `${org}·${role}`;
const tileValue = (link: HTMLElement) => link.querySelector("[data-kpi-value]")!;

describe("DashboardScreen (portal-volume mock seed)", () => {
  beforeEach(() => resetDb(new Date(), { portal: true }));

  it("steward: two-step title, five linked figures with trends, review queue with age and next action", async () => {
    renderScreen(<DashboardScreen />, { user: USER.bSteward });
    expect(await screen.findByRole("heading", { level: 1, name: "대시보드" })).toBeInTheDocument();
    expect(screen.getByText(contextLine("한국재료연구원", "데이터 관리자"))).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/님,|환영|Welcome/);
    const links = tiles();
    expect(links.map((l) => l.querySelector("span")?.textContent)).toEqual(["우리 기관 데이터셋", "발행 · 30일", "검토 대기", "우리 데이터 활성 권한", "우리 데이터 다운로드 · 30일"]);
    await waitFor(() => expect(tileValue(links[0]!)).toHaveTextContent("5"));
    await waitFor(() => expect(tileValue(links[2]!)).toHaveTextContent("4"));
    expect(links[2]).toHaveAttribute("href", "/commons/access?tab=review");
    await waitFor(() => expect(Number(tileValue(links[4]!).textContent)).toBeGreaterThan(0));

    const review = await panel("검토할 요청");
    const actions = await within(review).findAllByRole("link", { name: /^검토: / });
    expect(actions).toHaveLength(4);
    expect(within(review).getByText("6일째")).toHaveClass("text-warning");
    expect(within(review).getAllByText(/강다은 · 한국에너지기술연구원/)[0]).toBeInTheDocument();
  });

  it("steward: activity chart by kind with a keyboard day picker and a table twin", async () => {
    renderScreen(<DashboardScreen />, { user: USER.bSteward });
    const activity = await panel("기관 활동");
    const slider = await within(activity).findByRole("slider", { name: /기관 활동: 최근 30일 일별 건수/ });
    expect(slider).toHaveAttribute("aria-valuemax", "29");
    expect(within(activity).getByRole("table", { hidden: true })).toBeInTheDocument();
    slider.focus();
    fireEvent.keyDown(slider, { key: "ArrowLeft" });
    expect(slider).toHaveAttribute("aria-valuenow", "28");
    expect(slider.getAttribute("aria-valuetext")).toMatch(/다운로드 \d+, 접근 요청·결정 \d+, 등록·발행 \d+, AI-Ready 검증 \d+, 기타 \d+; 합계 \d+/);
    for (const k of ["다운로드", "접근 요청·결정", "등록·발행", "AI-Ready 검증"]) expect(within(activity).getAllByText(k)[0]).toBeInTheDocument();
  });

  it("steward: institute data health, readiness for the institute and the council, fields and the cross-institute feed", async () => {
    renderScreen(<DashboardScreen />, { user: USER.bSteward });
    const health = await panel("한국재료연구원 데이터 상태");
    const table = await within(health).findByRole("table", { name: "한국재료연구원 데이터 상태" });
    expect(await within(table).findByRole("link", { name: "고엔트로피 합금 인장시험 결과" })).toHaveAttribute("href", expect.stringMatching(/^\/commons\/data\//));
    expect((await within(table).findAllByText("9/9 통과")).length).toBeGreaterThan(0);
    expect(await within(table).findByText("생성 대기")).toBeInTheDocument();

    const readiness = await panel("데이터 준비 상태");
    expect(await within(readiness).findByRole("list", { name: "한국재료연구원: 통과 2, 경고 1, 실패 2, 미검증 0" })).toBeInTheDocument();
    expect(within(readiness).getByRole("list", { name: /^연구회 전체: / })).toBeInTheDocument();

    const fields = await panel("연구 분야별 데이터");
    expect(await within(fields).findByText("재료")).toBeInTheDocument();
    expect(within(fields).getAllByText(/^우리 기관 \d+, 다른 기관 \d+$/).length).toBeGreaterThan(2);

    const feed = await panel("최근 갱신된 데이터");
    expect(await within(feed).findByRole("link", { name: "촉매 후보 물질 DFT 계산 결과" })).toBeInTheDocument();
    expect(within(feed).getAllByText(/한국화학연구원/)[0]).toBeInTheDocument();

    const grants = await panel("우리 데이터 권한");
    expect((await within(grants).findByText("D-2")).closest("span")).toHaveClass("text-warning");
  });

  it("researcher: own requests with their next step, grants by expiry, recent decisions", async () => {
    renderScreen(<DashboardScreen />, { user: USER.aResearcher });
    expect(await screen.findByText(contextLine("한국에너지기술연구원", "연구자"))).toBeInTheDocument();
    const links = tiles();
    expect(links.map((l) => l.querySelector("span")?.textContent)).toEqual(["우리 기관 데이터셋", "진행 중인 내 요청", "내 활성 권한", "내 다운로드 · 30일", "참여 프로젝트"]);
    const queue = await panel("내 요청 진행");
    expect(await within(queue).findByRole("link", { name: "보완하기: 이차전지 양극재 SEM 이미지 라벨셋" })).toBeInTheDocument();
    expect(within(queue).getByText("보완해서 다시 제출")).toBeInTheDocument();
    expect(within(queue).getByText("최근 결정")).toBeInTheDocument();
    const grants = await panel("내 권한");
    expect((await within(grants).findByText("D-2")).closest("span")).toHaveClass("text-warning");
    expect(screen.queryByRole("region", { name: /^검토할 요청/ })).not.toBeInTheDocument();
    expect(await panel("내 활동")).toBeInTheDocument();
  });

  it("first day: zero personal activity still shows the institute and the council, with next steps", async () => {
    renderScreen(<DashboardScreen />, { user: PORTAL_USER.dNewcomer });
    expect(await screen.findByText(contextLine("한국화학연구원", "연구자"))).toBeInTheDocument();
    expect(await within(await panel("내 요청 진행")).findByText("진행 중인 요청이 없습니다.")).toBeInTheDocument();
    expect(await within(await panel("내 활동")).findByText("최근 30일 동안 기록된 활동이 없습니다")).toBeInTheDocument();
    const recent = await panel("최근 활동");
    expect(await within(recent).findByRole("link", { name: /데이터 찾기/ })).toHaveAttribute("href", "/commons/data");
    expect(await within(await panel("한국화학연구원 데이터 상태")).findByRole("link", { name: "촉매 후보 물질 DFT 계산 결과" })).toBeInTheDocument();
    expect((await within(await panel("최근 갱신된 데이터")).findAllByRole("link")).length).toBeGreaterThan(1);
  });

  it("isolates a failing panel: activity shows retry while the others still render", async () => {
    server.use(http.get("*/mock-api/v1/audit-events", () => HttpResponse.json({ error: { code: "INTERNAL_ERROR", message: "x", trace_id: "t-1" } }, { status: 500 })));
    renderScreen(<DashboardScreen />, { user: USER.bSteward });
    expect((await within(await panel("기관 활동")).findAllByRole("button", { name: "다시 시도" }))[0]).toBeInTheDocument();
    expect(await within(await panel("검토할 요청")).findAllByRole("link", { name: /^검토: / })).toHaveLength(4);
  });
});

describe("DashboardScreen (backend seed mirror)", () => {
  it("renders with the thin seed: the institute's datasets and the seeded grant", async () => {
    renderScreen(<DashboardScreen />, { user: USER.aResearcher });
    expect(await within(await panel("한국에너지기술연구원 데이터 상태")).findByRole("link", { name: "시험동 공조 설비 센서 스트림" })).toBeInTheDocument();
    expect(await within(await panel("내 권한")).findByText("리튬이온 배터리 셀 사이클 시험 데이터")).toBeInTheDocument();
  });
});
