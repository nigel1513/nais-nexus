import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { getDb } from "@/mocks/db";
import { DATASET, ORG, USER, VERSION } from "@/mocks/fixtures";
import { router } from "../../../tests/navigation";
import { renderScreen } from "../../../tests/render";
import { DatasetDetailScreen } from "./dataset-detail-screen";
import { pickVersion } from "./data-card/pick-version";

describe("Data Card", () => {
  it("renders header, subtitle, tags, AI-ready badge and the metadata block", async () => {
    renderScreen(<DatasetDetailScreen datasetId={DATASET.battery} />, { user: USER.bResearcher, path: `/commons/data/${DATASET.battery}` });
    expect(await screen.findByRole("heading", { level: 1, name: "Battery Cycling Measurements" })).toBeInTheDocument();
    expect(screen.getByText("연료전지 고분자 막 시편 1,000개의 온도·압력 측정")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "데이터 카드" })).toHaveAttribute("aria-selected", "true");
    expect(await screen.findByRole("button", { name: /AI-ready/ })).toBeInTheDocument();
    const meta = screen.getByRole("region", { name: "메타데이터" });
    expect(within(meta).getByText("2026-01-01 – 2026-01-01")).toBeInTheDocument();
    expect(within(meta).getByText("재료")).toBeInTheDocument();
    expect(within(meta).getByText(/NTIS 10000002/)).toBeInTheDocument();
    expect((screen.getByRole("combobox", { name: "버전" }) as HTMLSelectElement).value).toMatch(/\S/);
  });

  it("shows at-the-time and current affiliation and the steward-absent notice", async () => {
    const db = getDb();
    const steward = db.users.find((u) => u.user_id === USER.bSteward)!;
    steward.organization_id = ORG.a; // moved institutes
    renderScreen(<DatasetDetailScreen datasetId={DATASET.battery} />, { user: USER.bResearcher, path: `/commons/data/${DATASET.battery}` });
    const card = await screen.findByRole("complementary", { name: "담당자" });
    expect(within(card).getByText("담당자 재지정 필요")).toBeInTheDocument();
    expect(within(card).getByText(/당시 소속/)).toBeInTheDocument();
    expect(within(card).getByText(/현재 Institute A/)).toBeInTheDocument();
  });

  it("shows the steward email only when public and the inquiry button focuses the contact card", async () => {
    renderScreen(<DatasetDetailScreen datasetId={DATASET.battery} />, { user: USER.bResearcher, path: `/commons/data/${DATASET.battery}` });
    const card = await screen.findByRole("complementary", { name: "담당자" });
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

describe("Data Card extras", () => {
  it("?v= selects that version and changing the select switches the content", async () => {
    const db = getDb();
    const v1 = db.versions.find((v) => v.dataset_version_id === VERSION.battery)!;
    const v2id = "00000000-0000-7000-8000-000000002199";
    db.versions.push({ ...v1, dataset_version_id: v2id, version_label: "v2", published_at: "2099-01-01T00:00:00Z", files: [], file_count: 3 });
    const ds = DATASET.battery;
    renderScreen(<DatasetDetailScreen datasetId={ds} />, { user: USER.bResearcher, path: `/commons/data/${ds}` });
    const select = (await screen.findByRole("combobox", { name: "버전" })) as HTMLSelectElement;
    await waitFor(() => expect(select.options.length).toBe(2));
    expect(select.value).toBe(v2id); // latest published by default
    expect(screen.getByText("파일 3개")).toBeInTheDocument();
    await userEvent.selectOptions(select, VERSION.battery);
    expect(router.replace).toHaveBeenLastCalledWith(expect.stringContaining(`v=${VERSION.battery}`), { scroll: false });
    await waitFor(() => expect(select.value).toBe(VERSION.battery));
    expect(screen.queryByText("파일 3개")).not.toBeInTheDocument();
    expect(screen.getByText(`파일 ${v1.file_count}개`)).toBeInTheDocument();
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
