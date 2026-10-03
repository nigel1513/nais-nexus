import { configure, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { DATASET, ORG, PROJECT, USER } from "@/mocks/fixtures";
import { router } from "../../../tests/navigation";
import { renderScreen } from "../../../tests/render";
import { server } from "../../../tests/msw";
import { HubScreen } from "./hub-screen";

configure({ asyncUtilTimeout: 5000 });

const API = "http://localhost:3000/mock-api/v1";

/** 최유진 files a request against the sensor stream, so the trending rail has a card this week. */
async function requestSensors() {
  const res = await fetch(`${API}/access-requests`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-mock-user": USER.bResearcher },
    body: JSON.stringify({
      dataset_id: DATASET.sensors,
      project_id: PROJECT.seed,
      purpose: "ACADEMIC_RESEARCH",
      purpose_detail: "공조 설비 센서와 셀 온도의 상관을 확인하기 위한 요청입니다.",
      operations: ["READ"],
      requested_days: 30,
    }),
  });
  expect(res.status).toBe(201);
}

describe("Data hub home", () => {
  it("shows the three rails as card grids with a one-line meta and only real counts", async () => {
    await requestSensors();
    renderScreen(<HubScreen />, { user: USER.aResearcher, path: "/commons/hub" });
    expect(await screen.findByRole("heading", { level: 1, name: "데이터 허브" })).toBeInTheDocument();

    const trending = await screen.findByRole("region", { name: "이번 주 많이 요청된 데이터" });
    const recent = screen.getByRole("region", { name: "새로 공개된 데이터" });
    const used = screen.getByRole("region", { name: "많이 쓰인 데이터" });

    const sensors = within(trending).getByRole("link", { name: "시험동 공조 설비 센서 스트림" });
    expect(sensors).toHaveAttribute("href", `/commons/data/${DATASET.sensors}`);
    const sensorCard = sensors.closest("li")!;
    expect(within(sensorCard).getByText(/접근 요청 \d+건/)).toBeInTheDocument();
    // One meta line: 기관 · 분야 · 접근 등급 · AI-ready · 최근 갱신
    expect(within(sensorCard).getByText("한국에너지기술연구원")).toBeInTheDocument();
    expect(within(sensorCard).getByText("민감")).toBeInTheDocument();

    const battery = within(used).getByRole("link", { name: "리튬이온 배터리 셀 사이클 시험 데이터" }).closest("li")!;
    expect(within(battery).getByText("프로젝트 1곳에서 사용")).toBeInTheDocument();

    // recent has no figure (metric null): nothing is made up.
    const recentCards = within(recent).getAllByRole("listitem");
    expect(recentCards.length).toBeGreaterThan(0);
    expect(recentCards.length).toBeLessThanOrEqual(6);
    for (const card of recentCards) expect(within(card).queryByText(/건$|곳에서 사용$/)).toBeNull();
  });

  it("hides a rail with no cards", async () => {
    server.use(
      http.get(`${API}/hub/overview`, () =>
        HttpResponse.json({
          rails: {
            trending: [],
            recent: [
              { dataset_id: DATASET.openMaterials, title: "구조용 세라믹·초내열합금 물성 DB", owner_organization_name: "한국재료연구원", subject_labels: ["재료"], access_level: "PUBLIC", readiness_overall: null, updated_at: "2026-09-30T02:00:00Z", metric: null },
            ],
            most_used: [],
          },
          organizations: [],
        }),
      ),
    );
    renderScreen(<HubScreen />, { user: USER.aResearcher, path: "/commons/hub" });
    expect(await screen.findByRole("region", { name: "새로 공개된 데이터" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "이번 주 많이 요청된 데이터" })).toBeNull();
    expect(screen.queryByRole("region", { name: "많이 쓰인 데이터" })).toBeNull();
    // No readiness result: the AI-ready part of the meta line is left out.
    expect(screen.queryByText(/AI-ready/)).toBeNull();
  });

  it("searches and filters through the full data search", async () => {
    renderScreen(<HubScreen />, { user: USER.aResearcher, path: "/commons/hub" });
    const search = await screen.findByRole("searchbox", { name: "데이터 검색" });
    await userEvent.type(search, "배터리{Enter}");
    expect(router.push).toHaveBeenLastCalledWith("/commons/data?q=%EB%B0%B0%ED%84%B0%EB%A6%AC");

    const subjects = await screen.findByRole("list", { name: "분야" });
    expect(within(subjects).getByRole("link", { name: "에너지" })).toHaveAttribute("href", "/commons/data?subject=ENERGY");
    const orgs = await screen.findByRole("list", { name: "기관" });
    expect(within(orgs).getByRole("link", { name: "한국재료연구원" })).toHaveAttribute("href", `/commons/data?owner_organization_id=${ORG.b}`);
  });

  it("lists the institutes in a table", async () => {
    renderScreen(<HubScreen />, { user: USER.aResearcher, path: "/commons/hub" });
    const table = await screen.findByRole("table", { name: "기관별 데이터 현황" });
    const row = within(table).getByRole("link", { name: "한국재료연구원" }).closest("tr")!;
    expect(within(row).getAllByRole("cell").map((c) => c.textContent)).toEqual(["한국재료연구원", "2", "1", "1", expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/)]);
  });
});
