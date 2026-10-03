import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it, vi } from "vitest";
import { DATASET, USER, VERSION } from "@/mocks/fixtures";
import { server } from "../../../../tests/msw";
import { router } from "../../../../tests/navigation";
import { renderScreen } from "../../../../tests/render";
import { VersionDetailScreen } from "../version-detail-screen";
import { CitationBox } from "./citation-box";
import { CompareScreen } from "./compare-screen";

configure({ asyncUtilTimeout: 5000 });

const DS = DATASET.battery;
const open = (user: string, query: string) => renderScreen(<CompareScreen datasetId={DS} />, { user, path: `/commons/data/${DS}/versions/compare?${query}` });

describe("CompareScreen", () => {
  it("compares v1.1 → v2.0 in three layers and filters to changed files", async () => {
    open(USER.aResearcher, `to=${VERSION.battery}`);
    expect(await screen.findByRole("heading", { level: 1, name: "v1.1 → v2.0" })).toBeInTheDocument();
    expect(await screen.findByText("추가 2 · 삭제 0 · 변경 2")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /^파일/ })).toHaveAttribute("aria-selected", "true");
    const changedOnly = screen.getByRole("checkbox", { name: "변경된 것만 보기" });
    expect(changedOnly).toBeChecked();
    const table = screen.getByRole("table", { name: "파일 변경 목록" });
    expect(within(table).getByText("_codebook.csv")).toBeInTheDocument();
    expect(within(table).queryByText("test_cells.csv")).toBeNull(); // identical in both: hidden
    expect(within(table).getAllByText("추가").length).toBe(2);
    await userEvent.click(changedOnly);
    expect(within(table).getByText("test_cells.csv")).toBeInTheDocument();
    expect(within(table).getByText("data/")).toBeInTheDocument(); // directory row of the path tree

    await userEvent.click(screen.getByRole("tab", { name: /^데이터 구조/ }));
    const schema = await screen.findByRole("region", { name: "data/measurements.csv" });
    expect(within(schema).getByText(/행 수/)).toBeInTheDocument();
    expect(within(schema).getByText("500")).toBeInTheDocument();
    expect(within(schema).getByText("1,000")).toBeInTheDocument();
    // v2.0 tidied the codebook: temp_c integer → number (and back-filled readings), voltage_v mV → V.
    const changedCols = within(schema).getByRole("table", { name: /바뀐 컬럼/ });
    const temp = within(changedCols).getByText("temp_c").closest("tr")!;
    expect(temp).toHaveTextContent("integer→number");
    expect(temp).toHaveTextContent("2.4%→0.0%");
    expect(temp).toHaveTextContent("−2.4%p");
    expect(within(changedCols).getByText("voltage_v").closest("tr")).toHaveTextContent("mV→V");

    await userEvent.click(screen.getByRole("tab", { name: /^메타데이터/ }));
    const meta = await screen.findByRole("table", { name: "메타데이터" });
    const license = within(meta).getByText("license").closest("tr")!;
    expect(license).toHaveTextContent("라이선스");
    expect(license).toHaveTextContent("CC-BY-NC-4.0");
    expect(license).toHaveTextContent("CC-BY-4.0");
    const keywords = within(meta).getByText("keywords").closest("tr")!;
    expect(within(keywords).getByText("NCM811")).toBeInTheDocument(); // added keyword is listed
    const description = within(meta).getByText("description").closest("tr")!;
    expect(description.querySelector("del")).not.toBeNull();
    expect(description.querySelector("ins")).not.toBeNull();
  });

  it("lets the user pick the 'from' version (URL-synced)", async () => {
    open(USER.bSteward, `to=${VERSION.battery}`);
    await userEvent.selectOptions(await screen.findByLabelText("비교 기준"), "v1.0");
    await waitFor(() => expect(router.replace).toHaveBeenLastCalledWith(expect.stringContaining(`from=${VERSION.batteryV10}`), { scroll: false }));
    expect(await screen.findByRole("heading", { level: 1, name: "v1.0 → v2.0" })).toBeInTheDocument();
    expect(await screen.findByText("추가 3 · 삭제 0 · 변경 2")).toBeInTheDocument();
  });

  it("a first version compares with nothing", async () => {
    open(USER.aResearcher, `to=${VERSION.batteryV10}`);
    expect(await screen.findByRole("heading", { level: 1, name: "v1.0 (첫 버전)" })).toBeInTheDocument();
    expect(await screen.findByText(/첫 버전이라 비교할 이전 버전이 없습니다/)).toBeInTheDocument();
  });

  it("shows a file's history from a row, with inherited spans", async () => {
    open(USER.aResearcher, `to=${VERSION.battery}`);
    await userEvent.click(await screen.findByRole("checkbox", { name: "변경된 것만 보기" }));
    await userEvent.click(await screen.findByRole("button", { name: "data/test_cells.csv 이력" }));
    const panel = await screen.findByRole("region", { name: "파일 이력" });
    const items = await within(panel).findAllByRole("listitem");
    expect(items.map((li) => li.getAttribute("data-state"))).toEqual(["UNCHANGED", "ADDED", "ABSENT"]); // newest first
    expect(within(items[0]!).getByText("이어받음")).toBeInTheDocument();
    expect(within(items[0]!).getByText("비교 중")).toBeInTheDocument();
    await userEvent.click(within(panel).getByRole("button", { name: "이력 닫기" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "파일 이력" })).toBeNull());
  });

  it("a version that is not this dataset's is not found, and nothing is compared", async () => {
    open(USER.aResearcher, `to=${VERSION.openMaterials}`);
    expect(await screen.findByText("찾을 수 없거나 접근 권한이 없습니다.")).toBeInTheDocument();
    expect(screen.queryByRole("tab")).toBeNull();
  });

  it("'변경된 것만 보기' starts again when the compared versions change", async () => {
    open(USER.aResearcher, `to=${VERSION.battery}`);
    const box = await screen.findByRole("checkbox", { name: "변경된 것만 보기" });
    await userEvent.click(box);
    expect(box).not.toBeChecked();
    await userEvent.selectOptions(screen.getByLabelText("비교 기준"), "v1.0");
    await screen.findByRole("heading", { level: 1, name: "v1.0 → v2.0" });
    expect(await screen.findByRole("checkbox", { name: "변경된 것만 보기" })).toBeChecked();
  });

  it("a 3,000-file diff renders quickly, 200 rows per directory with '더 보기'", async () => {
    const side = (n: number) => ({ size_bytes: 100 + n, sha256: n.toString(16).padStart(64, "a") });
    const files = Array.from({ length: 3000 }, (_, i) => ({ path: `data/part-${String(i).padStart(4, "0")}.csv`, status: "ADDED", before: null, after: side(i), size_delta: 100 + i }));
    server.use(
      http.get("*/mock-api/v1/dataset-versions/:version_id/diff", () =>
        HttpResponse.json({ from_version_id: VERSION.batteryV11, to_version_id: VERSION.battery, summary: { added: 3000, removed: 0, changed: 0, unchanged: 0 }, files, schema: [], metadata: [] }),
      ),
    );
    const started = performance.now();
    open(USER.aResearcher, `to=${VERSION.battery}`);
    const table = await screen.findByRole("table", { name: "파일 변경 목록" });
    expect(performance.now() - started).toBeLessThan(4000);
    expect(within(table).getAllByRole("button", { name: /이력$/ })).toHaveLength(200);
    await userEvent.click(within(table).getByRole("button", { name: "data/ 더 보기 (2800개 남음)" }));
    expect(within(table).getAllByRole("button", { name: /이력$/ })).toHaveLength(400);
  });
});

describe("CitationBox", () => {
  it("copies a citation without the async clipboard API", async () => {
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    Object.defineProperty(document, "execCommand", { value: vi.fn(() => true), configurable: true, writable: true });
    renderScreen(<CitationBox versionId={VERSION.battery} label="v2.0" />, { user: USER.aResearcher });
    expect(await screen.findByText(/\(Version v2\.0\) \[Data set\]/)).toBeInTheDocument();
    await userEvent.click(await screen.findByRole("tab", { name: "BibTeX" }));
    expect(await within(screen.getByRole("tabpanel")).findByText(/@misc\{/)).toBeInTheDocument(); // a proper tabpanel
    await userEvent.click(screen.getByRole("button", { name: "복사" }));
    expect(await screen.findByText("복사했습니다")).toBeInTheDocument();
  });

  it("when copying fails the citation is selected for manual copy", async () => {
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    Object.defineProperty(document, "execCommand", { value: vi.fn(() => false), configurable: true, writable: true });
    renderScreen(<CitationBox versionId={VERSION.battery} label="v2.0" />, { user: USER.aResearcher });
    await screen.findByText(/\[Data set\]/);
    await userEvent.click(screen.getByRole("button", { name: "복사" }));
    expect(await screen.findByText(/직접 선택해 복사해 주세요/)).toBeInTheDocument();
  });

  it("is on a published version page, pinned to that version", async () => {
    renderScreen(<VersionDetailScreen datasetId={DS} versionId={VERSION.batteryV11} readinessPollMs={60_000} />, { user: USER.aResearcher, path: `/commons/data/${DS}/versions/${VERSION.batteryV11}` });
    const box = await screen.findByRole("region", { name: "이 버전 인용하기" });
    expect(box).toHaveTextContent("v1.1에 고정된 인용입니다");
    expect(await within(box).findByText(/Version v1\.1/)).toBeInTheDocument();
  });
});
