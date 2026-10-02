import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http } from "msw";
import { describe, expect, it } from "vitest";
import { getDb } from "@/mocks/db";
import { DATASET, USER } from "@/mocks/fixtures";
import { API, apiError } from "@/mocks/http";
import { server } from "../../../tests/msw";
import { renderScreen } from "../../../tests/render";
import { DatasetNewScreen } from "./dataset-new-screen";
import { fromDataset, toDatasetUpdate } from "./schemas";

describe("dataset form (stage 1)", () => {
  it("creates a dataset with PI, steward, subjects, period and a contributor", async () => {
    renderScreen(<DatasetNewScreen />, { user: USER.bSteward, path: "/commons/data/new" });
    await userEvent.type(await screen.findByLabelText(/^제목/), "Electrolyte Cycling");
    await userEvent.type(screen.getByLabelText("부제"), "전해질 후보 충방전");
    await userEvent.type(screen.getByLabelText(/^라이선스/), "CC-BY-4.0");
    await userEvent.click(screen.getByRole("checkbox", { name: "학술 연구" }));
    await userEvent.type(screen.getByRole("combobox", { name: /연구책임자/ }), "B R");
    await userEvent.click(await screen.findByRole("option", { name: /B Researcher/ }));
    // steward contact defaults to the creating steward
    expect(screen.getByRole("combobox", { name: /담당자/ })).toHaveValue("B Steward (Institute B)");
    await userEvent.click(screen.getByRole("button", { name: "연구 분야 선택" }));
    await userEvent.click(await screen.findByRole("checkbox", { name: "재료" }));
    await userEvent.keyboard("{Escape}");
    expect(within(screen.getByRole("group", { name: "연구 분야" })).getByText("재료")).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("데이터 기간 시작"), "2025-01-01");
    await userEvent.type(screen.getByRole("combobox", { name: "공동연구자 검색" }), "B R");
    await userEvent.click(await screen.findByRole("option", { name: /B Researcher/ }));
    await userEvent.click(screen.getByRole("button", { name: "추가" }));
    const contributors = screen.getByRole("list", { name: "공동연구자" });
    expect(within(contributors).getByText("B Researcher")).toBeInTheDocument();
    expect(within(contributors).getByText("공동연구자")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "데이터셋 등록" }));
    await waitFor(() => expect(getDb().datasets.some((d) => d.title === "Electrolyte Cycling")).toBe(true));
    const created = getDb().datasets.find((d) => d.title === "Electrolyte Cycling")!;
    expect(created).toMatchObject({ subtitle: "전해질 후보 충방전", subject_codes: ["MATERIALS"], temporal_start: "2025-01-01", principal_investigator_id: USER.bResearcher });
    await waitFor(() => expect(getDb().contributors.filter((c) => c.dataset_id === created.dataset_id)).toMatchObject([{ user_id: USER.bResearcher, role: "CO_INVESTIGATOR" }]));
  });

  it("shows server PERSON_NOT_ELIGIBLE on the PI field", async () => {
    server.use(
      http.post(`${API}/datasets`, () => apiError("VALIDATION_FAILED", "invalid", { fields: [{ field: "principal_investigator_id", reason: "PERSON_NOT_ELIGIBLE" }] }), { once: true }),
    );
    renderScreen(<DatasetNewScreen />, { user: USER.bSteward, path: "/commons/data/new" });
    await userEvent.type(await screen.findByLabelText(/^제목/), "Electrolyte Cycling");
    await userEvent.type(screen.getByLabelText(/^라이선스/), "CC-BY-4.0");
    await userEvent.click(screen.getByRole("checkbox", { name: "학술 연구" }));
    await userEvent.type(screen.getByRole("combobox", { name: /연구책임자/ }), "B R");
    await userEvent.click(await screen.findByRole("option", { name: /B Researcher/ }));
    await userEvent.click(screen.getByRole("button", { name: "데이터셋 등록" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("연구책임자: 소유 기관의 활성 구성원이 아닙니다");
    expect(getDb().datasets.some((d) => d.title === "Electrolyte Cycling")).toBe(false);
  });

  it("clears nullable research fields with null", () => {
    const d = getDb().datasets.find((x) => x.dataset_id === DATASET.battery)!;
    const before = fromDataset({ ...d, latest_published_version: null } as never);
    const after = { ...before, temporal_end: "", subtitle: "" };
    expect(toDatasetUpdate(after, before)).toMatchObject({ temporal_end: null, subtitle: null });
  });

  it("blocks an inverted period on the client", async () => {
    renderScreen(<DatasetNewScreen />, { user: USER.bSteward, path: "/commons/data/new" });
    await userEvent.type(await screen.findByLabelText("데이터 기간 시작"), "2025-02-01");
    await userEvent.type(screen.getByLabelText("데이터 기간 끝"), "2025-01-01");
    await userEvent.click(screen.getByRole("button", { name: "데이터셋 등록" }));
    expect((await screen.findAllByText(/기간의 끝이 시작보다 빠릅니다/)).length).toBeGreaterThan(0);
  });

  it("maps server contributors[n].user_id errors onto the contributors field", async () => {
    server.use(
      http.post(`${API}/datasets`, () => apiError("VALIDATION_FAILED", "invalid", { fields: [{ field: "contributors[0].user_id", reason: "DUPLICATE" }] }), { once: true }),
    );
    renderScreen(<DatasetNewScreen />, { user: USER.bSteward, path: "/commons/data/new" });
    await userEvent.type(await screen.findByLabelText(/^제목/), "Electrolyte Cycling");
    await userEvent.type(screen.getByLabelText(/^라이선스/), "CC-BY-4.0");
    await userEvent.click(screen.getByRole("checkbox", { name: "학술 연구" }));
    await userEvent.type(screen.getByRole("combobox", { name: /연구책임자/ }), "B R");
    await userEvent.click(await screen.findByRole("option", { name: /B Researcher/ }));
    await userEvent.click(screen.getByRole("button", { name: "데이터셋 등록" }));
    const link = await screen.findByRole("link", { name: /공동연구자: 중복된 값이 있습니다/ });
    expect(link).toHaveAttribute("href", "#dataset-contributors");
    expect(document.getElementById("dataset-contributors")).not.toBeNull();
  });
});

describe("dataset form layout (redesign)", () => {
  const open = async () => {
    renderScreen(<DatasetNewScreen />, { user: USER.bSteward, path: "/commons/data/new" });
    await screen.findByLabelText(/^제목/);
  };

  it("lays the form out in titled sections with the 2-column template and a sticky action bar", async () => {
    await open();
    const sections = screen.getAllByRole("region").filter((r) => r.hasAttribute("data-section"));
    expect(sections.map((r) => within(r).getByRole("heading", { level: 2 }).textContent)).toEqual(["기본 정보", "사람", "연구 맥락", "데이터 정보", "분류", "이용 조건", "관련 논문"]);
    for (const r of sections) expect(r.className).toMatch(/@2xl\/form:grid-cols-\[13rem_minmax\(0,1fr\)\]/);
    expect(screen.getByRole("button", { name: "데이터셋 등록" }).closest(".sticky")).not.toBeNull();
    expect(screen.getByRole("button", { name: "취소" })).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "등록 단계" })).toHaveTextContent("데이터셋 정보");
  });

  it("UserPicker is a combobox whose options show name, organization and NTIS", async () => {
    await open();
    const pi = screen.getByRole("combobox", { name: /연구책임자/ });
    await userEvent.type(pi, "B R");
    const option = await screen.findByRole("option", { name: /B Researcher/ });
    expect(option).toHaveTextContent("Institute B");
    expect(option).toHaveTextContent("NTIS 10000002");
    expect(screen.getAllByText("소유 기관(Institute B)의 현재 구성원만 선택할 수 있습니다.").length).toBeGreaterThan(0);
    await userEvent.keyboard("{ArrowDown}{Enter}");
    await waitFor(() => expect(pi).toHaveValue("B Researcher (Institute B)"));
  });

  it("VocabularyPicker opens a searchable tree and stops at the limit with 최대 5개", async () => {
    await open();
    await userEvent.click(screen.getByRole("button", { name: "연구 분야 선택" }));
    const popup = await screen.findByRole("dialog", { name: "연구 분야" });
    expect(within(popup).getByText("최대 5개")).toBeInTheDocument();
    for (const name of ["재료", "에너지", "화학", "기계", "원자력"]) await userEvent.click(within(popup).getByRole("checkbox", { name }));
    expect(within(popup).getByRole("checkbox", { name: "해양" })).toBeDisabled();
    expect(within(popup).getByRole("status")).toHaveTextContent("최대 5개까지 고를 수 있습니다");
    await userEvent.type(within(popup).getByRole("searchbox", { name: "연구 분야 검색" }), "해양");
    expect(within(popup).getAllByRole("checkbox")).toHaveLength(1);
    await userEvent.keyboard("{Escape}");
    const group = screen.getByRole("group", { name: "연구 분야" });
    expect(within(group).getByText("5 / 5")).toBeInTheDocument();
    await userEvent.click(within(group).getByRole("button", { name: "재료 제거" }));
    expect(within(group).getByText("4 / 5")).toBeInTheDocument();
  });

  it("DateRangePicker keeps both inputs typeable and fills them from the calendar", async () => {
    await open();
    const start = screen.getByLabelText("데이터 기간 시작");
    const end = screen.getByLabelText("데이터 기간 끝");
    await userEvent.type(start, "2025-03-02");
    await userEvent.type(end, "2025-03-11");
    expect(screen.getByText("10일")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "달력에서 기간 고르기" }));
    const grid = await screen.findByRole("grid");
    await userEvent.click(within(grid).getByRole("button", { name: /3월 20일/ }));
    await waitFor(() => expect(end).toHaveValue("2025-03-20"));
    expect(start).toHaveValue("2025-03-02");
  });
});
