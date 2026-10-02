import { screen, waitFor, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { DATASET, USER } from "@/mocks/fixtures";
import { server } from "../../../tests/msw";
import { renderScreen } from "../../../tests/render";
import { DashboardScreen } from "./dashboard-screen";

const API = "http://localhost:3000/mock-api/v1";

/** A dashboard block by its heading (the heading also carries a count; table frames reuse the caption as a region name). */
const block = async (name: string) => (await screen.findAllByRole("region", { name: new RegExp(`^${name}`) }))[0]!;

/** The real seed has no pending request: B Researcher files one against A's sensor dataset through the mock API. */
async function seedPendingSensorRequest() {
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
    requested_days: 30,
  });
}

describe("DashboardScreen", () => {
  it("leads with facts (no greeting) and a stat row of tabular figures", async () => {
    renderScreen(<DashboardScreen />, { user: USER.aResearcher });
    expect(await screen.findByRole("heading", { level: 1, name: "대시보드" })).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/님,|환영|Welcome/);
    expect(await screen.findByRole("link", { name: "7일 내 만료 권한 1건" })).toHaveAttribute("href", "/commons/access?tab=grants");
    expect(screen.getByRole("link", { name: /진행 중 요청 \d+건/ })).toBeInTheDocument();
    const stats = within(screen.getByRole("list", { name: "요약" })).getAllByRole("link");
    expect(stats.map((l) => l.querySelector(".text-caption")?.textContent)).toEqual(["내 프로젝트", "검토 대기", "활성 권한", "7일 내 만료"]);
    for (const s of stats) expect(s.querySelector(".num")).not.toBeNull();
    await waitFor(() => expect(stats[2]!.querySelector(".num")).toHaveTextContent("1"));
    expect(stats[3]!.querySelector(".num")).toHaveTextContent("1");
  });

  it("shows projects, open requests, grants, activity and the institute's datasets for a researcher (no review queue)", async () => {
    renderScreen(<DashboardScreen />, { user: USER.aResearcher });
    const projects = await block("내 프로젝트");
    expect((await within(projects).findAllByRole("link", { name: "Seed: Battery Materials Joint Study" }))[0]).toHaveAttribute(
      "href",
      "/commons/projects/00000000-0000-7000-8000-000000001001",
    );
    const grants = await block("내 권한");
    expect((await within(grants).findAllByText("Battery Cycling Measurements"))[0]).toBeInTheDocument();
    expect(within(grants).getAllByText(/후 만료/)[0]).toHaveClass("text-warning");
    expect(await block("진행 중인 내 요청")).toBeInTheDocument();
    expect(await block("최근 활동")).toBeInTheDocument();
    const datasets = await block("Institute A 데이터셋 최근 버전");
    expect((await within(datasets).findAllByRole("link", { name: "Facility Sensor Streams" }))[0]).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: /검토할 요청/ })).not.toBeInTheDocument();
  });

  it("shows the review queue to DATA_STEWARD and a next action on every empty block", async () => {
    await seedPendingSensorRequest();
    renderScreen(<DashboardScreen />, { user: USER.aSteward });
    const review = await block("검토할 요청");
    expect((await within(review).findAllByText("Facility Sensor Streams"))[0]).toBeInTheDocument();
    expect(within(review).getAllByText("B Researcher 요청")[0]).toBeInTheDocument();
    expect(await screen.findByRole("link", { name: "검토 대기 1건" })).toHaveAttribute("href", "/commons/access?tab=review");
    const projects = await block("내 프로젝트");
    expect(await within(projects).findByRole("link", { name: "첫 공동 프로젝트 만들기" })).toHaveAttribute("href", "/commons/projects/new");
    const grants = await block("내 권한");
    expect(await within(grants).findByRole("link", { name: "데이터 찾기" })).toHaveAttribute("href", "/commons/data");
  });

  it("isolates a failing block: projects show an error with retry while the others still render", async () => {
    server.use(http.get("*/mock-api/v1/projects", () => HttpResponse.json({ error: { code: "INTERNAL_ERROR", message: "x", trace_id: "t-1" } }, { status: 500 })));
    renderScreen(<DashboardScreen />, { user: USER.aResearcher });
    const projects = await block("내 프로젝트");
    expect(await within(projects).findByRole("button", { name: "다시 시도" })).toBeInTheDocument();
    expect((await within(await block("내 권한")).findAllByText("Battery Cycling Measurements"))[0]).toBeInTheDocument();
  });
});
