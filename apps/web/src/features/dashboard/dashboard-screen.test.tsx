import { screen, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { DATASET, USER } from "@/mocks/fixtures";
import { server } from "../../../tests/msw";
import { renderScreen } from "../../../tests/render";
import { DashboardScreen } from "./dashboard-screen";

const API = "http://localhost:3000/mock-api/v1";

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
  it("shows projects, open requests and expiring grants for a researcher (no review card)", async () => {
    renderScreen(<DashboardScreen />, { user: USER.aResearcher });
    expect(await screen.findByRole("heading", { level: 1, name: "대시보드" })).toBeInTheDocument();
    const projects = screen.getByRole("region", { name: "내 프로젝트" });
    expect(await within(projects).findByRole("link", { name: "Seed: Battery Materials Joint Study" })).toHaveAttribute(
      "href",
      "/commons/projects/00000000-0000-7000-8000-000000001001",
    );
    const grants = screen.getByRole("region", { name: "내 권한" });
    expect(await within(grants).findByText("Battery Cycling Measurements")).toBeInTheDocument();
    expect(within(grants).getByText(/후 만료/)).toHaveClass("text-warning");
    expect(screen.queryByRole("region", { name: "검토 대기" })).not.toBeInTheDocument();
  });

  it("shows the review queue to DATA_STEWARD and the first-project CTA when empty", async () => {
    await seedPendingSensorRequest();
    renderScreen(<DashboardScreen />, { user: USER.aSteward });
    const review = await screen.findByRole("region", { name: "검토 대기" });
    expect(await within(review).findByText("Facility Sensor Streams")).toBeInTheDocument();
    expect(within(review).getByText("B Researcher 요청")).toBeInTheDocument();
    const projects = screen.getByRole("region", { name: "내 프로젝트" });
    expect(await within(projects).findByRole("link", { name: "첫 공동 프로젝트 만들기" })).toHaveAttribute("href", "/commons/projects/new");
  });

  it("isolates a failing card: the projects card shows an error with retry while the others still render", async () => {
    server.use(http.get("*/mock-api/v1/projects", () => HttpResponse.json({ error: { code: "INTERNAL_ERROR", message: "x", trace_id: "t-1" } }, { status: 500 })));
    renderScreen(<DashboardScreen />, { user: USER.aResearcher });
    const projects = await screen.findByRole("region", { name: "내 프로젝트" });
    expect(await within(projects).findByRole("button", { name: "다시 시도" })).toBeInTheDocument();
    expect(await within(screen.getByRole("region", { name: "내 권한" })).findByText("Battery Cycling Measurements")).toBeInTheDocument();
  });
});
