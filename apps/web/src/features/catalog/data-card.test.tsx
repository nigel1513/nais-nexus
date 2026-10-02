import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { getDb } from "@/mocks/db";
import { DATASET, ORG, USER, VERSION } from "@/mocks/fixtures";
import { router } from "../../../tests/navigation";
import { renderScreen } from "../../../tests/render";
import { DatasetDetailScreen } from "./dataset-detail-screen";
import { pickVersion } from "./data-card/pick-version";

configure({ asyncUtilTimeout: 5000 }); // the detail screen loads several queries; the 1 s default flakes under load

describe("Data Card", () => {
  it("renders header, subtitle, tags, AI-ready badge and the metadata block", async () => {
    renderScreen(<DatasetDetailScreen datasetId={DATASET.battery} />, { user: USER.bResearcher, path: `/commons/data/${DATASET.battery}` });
    expect(await screen.findByRole("heading", { level: 1, name: "Battery Cycling Measurements" })).toBeInTheDocument();
    expect(screen.getByText("리튬이온 18650 셀 12개의 1,000 사이클 충방전 용량·전압·온도 이력")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "데이터 카드" })).toHaveAttribute("aria-selected", "true");
    expect(await screen.findByRole("button", { name: /AI-ready/ })).toBeInTheDocument();
    // Header meta line: PI with NTIS, data period and the latest version.
    const summary = screen.getByRole("list", { name: "데이터셋 요약" });
    expect(within(summary).getByText("NTIS 10000002")).toBeInTheDocument();
    expect(within(summary).getByText("2026-01-12 – 2026-06-30")).toBeInTheDocument();
    expect(within(summary).getByText("v2.0")).toHaveClass("font-mono");
    expect(screen.getByRole("heading", { level: 1 })).toHaveClass("text-display");
    const meta = screen.getByRole("region", { name: "메타데이터" });
    expect(within(meta).getByText("2026-01-12 – 2026-06-30")).toBeInTheDocument();
    expect(within(meta).getByText("에너지")).toBeInTheDocument();
    expect(within(meta).getAllByText(/NTIS 10000002/).length).toBeGreaterThan(0); // PI and contributor
    expect(screen.getByRole("combobox", { name: "버전" })).toHaveTextContent(/v\d/);
  });

  it("shows at-the-time and current affiliation and the steward-absent notice", async () => {
    const db = getDb();
    const steward = db.users.find((u) => u.user_id === USER.bSteward)!;
    steward.organization_id = ORG.a; // moved institutes
    renderScreen(<DatasetDetailScreen datasetId={DATASET.battery} />, { user: USER.bResearcher, path: `/commons/data/${DATASET.battery}` });
    const card = await screen.findByRole("region", { name: "담당자" });
    expect(within(card).getByText("담당자 재지정 필요")).toBeInTheDocument();
    expect(within(card).getByText(/당시 소속/)).toBeInTheDocument();
    expect(within(card).getByText(/현재 Institute A/)).toBeInTheDocument();
  });

  it("shows the steward email only when public and the inquiry button focuses the contact card", async () => {
    renderScreen(<DatasetDetailScreen datasetId={DATASET.battery} />, { user: USER.bResearcher, path: `/commons/data/${DATASET.battery}` });
    const card = await screen.findByRole("region", { name: "담당자" });
    expect(within(card).getByRole("link", { name: "b.steward@inst-b.local" })).toHaveAttribute("href", "mailto:b.steward@inst-b.local");
    await userEvent.click(screen.getByRole("button", { name: "문의" }));
    expect(card).toHaveFocus();
  });

  it("renders the description as safe markdown", async () => {
    getDb().datasets.find((d) => d.dataset_id === DATASET.battery)!.description = "## 개요\n\n<script>x</script>**굵게**";
    const { container } = renderScreen(<DatasetDetailScreen datasetId={DATASET.battery} />, { user: USER.bResearcher, path: `/commons/data/${DATASET.battery}` });
    expect(await screen.findByRole("heading", { level: 4, name: "개요" })).toBeInTheDocument();
    expect(container.querySelector("script")).toBeNull();
  });

  it("switches version through the URL and keeps the versions tab", async () => {
    renderScreen(<DatasetDetailScreen datasetId={DATASET.battery} />, { user: USER.bResearcher, path: `/commons/data/${DATASET.battery}` });
    await userEvent.click(await screen.findByRole("tab", { name: "버전" }));
    expect(router.replace).toHaveBeenLastCalledWith(expect.stringContaining("tab=versions"), { scroll: false });
  });
});

describe("Data Card layout", () => {
  it("orders the actions 문의 · 새 노트북 (예정, disabled) · access CTA, and has a rail with four panels", async () => {
    renderScreen(<DatasetDetailScreen datasetId={DATASET.battery} />, { user: USER.bResearcher, path: `/commons/data/${DATASET.battery}` });
    const header = (await screen.findByRole("heading", { level: 1, name: "Battery Cycling Measurements" })).closest("header")!;
    await within(header).findByRole("button", { name: "접근 요청" });
    const actions = within(header).getAllByRole("button").filter((b) => /^(문의|새 노트북|접근 요청)/.test(b.textContent ?? ""));
    expect(actions.map((b) => b.textContent)).toEqual(["문의", "새 노트북예정", "접근 요청"]);
    expect(actions[1]).toBeDisabled();
    expect(actions[2]).toHaveClass("bg-primary");
    const rail = screen.getByRole("complementary", { name: "데이터셋 정보" });
    for (const name of ["담당자", "연구책임자", "이용 정책", "활동"]) expect(within(rail).getByRole("region", { name })).toBeInTheDocument();
  });
});

describe("Data Card extras", () => {
  it("lists the three seeded published versions, defaults to the latest and switches via the select", async () => {
    const ds = DATASET.battery;
    renderScreen(<DatasetDetailScreen datasetId={ds} />, { user: USER.bResearcher, path: `/commons/data/${ds}` });
    const select = await screen.findByRole("combobox", { name: "버전" });
    expect(select).toHaveTextContent("v2.0");
    expect(await screen.findByText("파일 5개")).toBeInTheDocument();
    await userEvent.click(select);
    const options = await screen.findAllByRole("option");
    expect(options).toHaveLength(3); // the DRAFT is hidden from researchers
    expect(options.map((o) => o.textContent)).toEqual([expect.stringContaining("v2.0"), expect.stringContaining("v1.1"), expect.stringContaining("v1.0")]);
    await userEvent.click(options[2]!);
    expect(router.replace).toHaveBeenLastCalledWith(expect.stringContaining(`v=${VERSION.batteryV10}`), { scroll: false });
    await waitFor(() => expect(select).toHaveTextContent("v1.0"));
    expect(await screen.findByText("파일 2개")).toBeInTheDocument();
  });
  it("shows the DRAFT version only to the owner steward", async () => {
    const ds = DATASET.battery;
    renderScreen(<DatasetDetailScreen datasetId={ds} />, { user: USER.bSteward, path: `/commons/data/${ds}` });
    const select = await screen.findByRole("combobox", { name: "버전" });
    expect(select).toHaveTextContent("v2.0"); // latest published, not the draft
    await userEvent.click(select);
    const options = await screen.findAllByRole("option");
    expect(options).toHaveLength(4);
    expect(options.some((o) => /초안/.test(o.textContent ?? ""))).toBe(true);
  });
  it("has the Metadata JSON-LD button and the column table slot", async () => {
    renderScreen(<DatasetDetailScreen datasetId={DATASET.battery} />, { user: USER.bResearcher, path: `/commons/data/${DATASET.battery}` });
    const meta = await screen.findByRole("region", { name: "메타데이터" });
    expect(within(meta).getByRole("button", { name: "JSON-LD" })).toBeInTheDocument();
    expect(screen.getByTestId("column-table-slot")).toBeInTheDocument();
  });
});

describe("pickVersion", () => {
  const v = (id: string, status: "DRAFT" | "PUBLISHED", at: string | null) => ({ dataset_version_id: id, status, published_at: at });
  const items = [v("d", "DRAFT", null), v("p1", "PUBLISHED", "2026-01-01T00:00:00Z"), v("p2", "PUBLISHED", "2026-02-01T00:00:00Z")];
  it("prefers ?v, then the latest published, else the first visible", () => {
    expect(pickVersion(items, "p1", false)?.dataset_version_id).toBe("p1");
    expect(pickVersion(items, null, true)?.dataset_version_id).toBe("p2");
    expect(pickVersion(items, "d", false)?.dataset_version_id).toBe("p2");
    expect(pickVersion([items[0]!], null, true)?.dataset_version_id).toBe("d");
    expect(pickVersion([], null, true)).toBeUndefined();
  });
});
