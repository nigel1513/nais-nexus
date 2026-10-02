import { screen, waitFor } from "@testing-library/react";
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
    await userEvent.type(screen.getByRole("combobox", { name: /연구책임자/ }), "최유진");
    await userEvent.click(await screen.findByRole("option", { name: /최유진/ }));
    // steward contact defaults to the creating steward
    expect(screen.getByRole("combobox", { name: /담당자/ })).toHaveValue("정현우 (한국재료연구원)");
    await userEvent.click(screen.getByRole("checkbox", { name: "재료" }));
    await userEvent.type(screen.getByLabelText("데이터 기간 시작"), "2025-01-01");
    await userEvent.type(screen.getByRole("combobox", { name: "공동연구자 검색" }), "최유진");
    await userEvent.click(await screen.findByRole("option", { name: /최유진/ }));
    await userEvent.click(screen.getByRole("button", { name: "추가" }));
    expect(screen.getByText(/공동연구자$/, { selector: "span span" })).toBeInTheDocument();
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
    await userEvent.type(screen.getByRole("combobox", { name: /연구책임자/ }), "최유진");
    await userEvent.click(await screen.findByRole("option", { name: /최유진/ }));
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
    await userEvent.type(screen.getByRole("combobox", { name: /연구책임자/ }), "최유진");
    await userEvent.click(await screen.findByRole("option", { name: /최유진/ }));
    await userEvent.click(screen.getByRole("button", { name: "데이터셋 등록" }));
    const link = await screen.findByRole("link", { name: /공동연구자: 중복된 값이 있습니다/ });
    expect(link).toHaveAttribute("href", "#dataset-contributors");
    expect(document.getElementById("dataset-contributors")).not.toBeNull();
  });
});
