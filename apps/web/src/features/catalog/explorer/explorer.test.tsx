import { configure, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { getDb } from "@/mocks/db";
import { DATASET, USER, VERSION } from "@/mocks/fixtures";
import { server } from "../../../../tests/msw";
import { renderScreen } from "../../../../tests/render";
import { DatasetDetailScreen } from "../dataset-detail-screen";
import { isTabular } from "../lib/tabular";

configure({ asyncUtilTimeout: 5000 }); // the full suite loads the machine; the 1 s default flakes
const open = (user: string) => renderScreen(<DatasetDetailScreen datasetId={DATASET.battery} />, { user, path: `/commons/data/${DATASET.battery}` });
const explorer = async () => within(await screen.findByRole("list", { name: "파일" }, { timeout: 5000 }).then((l) => l.closest("section") as HTMLElement));

describe("isTabular", () => {
  it("accepts csv/tsv/parquet and ignores _-prefixed metadata files", () => {
    expect(isTabular("data/a.CSV")).toBe(true);
    expect(isTabular("a.parquet")).toBe(true);
    expect(isTabular("data/_schema.json")).toBe(false);
    expect(isTabular("data/_x.csv")).toBe(false);
    expect(isTabular("README.md")).toBe(false);
  });
});

describe("Data Explorer", () => {
  it("is a panel with a file tree grouped under 파일, a view switch and a coloured histogram per numeric column", async () => {
    open(USER.bResearcher);
    const ex = await explorer();
    expect(ex.getByText("파일", { selector: "p" })).toBeInTheDocument();
    expect(ex.getByRole("group", { name: "보기 방식" })).toBeInTheDocument();
    expect(ex.getByRole("button", { name: "Detail" })).toHaveAttribute("aria-pressed", "true");
    const hists = await ex.findAllByRole("img", { name: /분포/ });
    expect(hists.length).toBe(4); // cycle, capacity_ah, voltage_v, temp_c
    expect(hists[0]!.querySelector("[data-bin]")).toHaveClass("bg-chart-1"); // one hue (chart-1), not grey
  });

  it("lists files, defaults to the first tabular file and shows the column view", async () => {
    open(USER.bResearcher);
    const tree = await screen.findByRole("list", { name: "파일" }, { timeout: 5000 });
    expect(within(tree).getByRole("button", { name: /data\/measurements\.csv/ })).toHaveAttribute("aria-current", "true");
    const ex = await explorer();
    await userEvent.click(ex.getByRole("button", { name: "Column" }));
    const table = await ex.findByRole("table", { name: /열 요약/ });
    expect(within(table).getByRole("cell", { name: "temp_c" })).toBeInTheDocument();
    expect(within(table).getByRole("cell", { name: "Cel" })).toBeInTheDocument();
    expect(ex.getByText(/전체 1,000행/)).toBeInTheDocument(); // total_rows (S7): the CSV was read to the end
  });

  it("shows distributions and a 100-row preview to users with download permission", async () => {
    open(USER.bResearcher);
    const ex = await explorer();
    await userEvent.click(await ex.findByRole("button", { name: "Detail" }));
    expect(await ex.findByRole("img", { name: /temp_c 분포/ })).toBeInTheDocument();
    await userEvent.click(ex.getByRole("button", { name: "Compact" }));
    const rows = within(await ex.findByRole("table", { name: /미리보기/ })).getAllByRole("row");
    expect(rows).toHaveLength(101);
  });

  it("gates raw values behind download permission", async () => {
    open(USER.aAdmin);
    const ex = await explorer();
    await userEvent.click(await ex.findByRole("button", { name: "Detail" }));
    expect(await ex.findByText("접근 승인 후 미리보기 가능")).toBeInTheDocument();
    expect(ex.getByRole("button", { name: "접근 요청" })).toBeInTheDocument();
    expect(ex.queryByRole("img", { name: /분포/ })).not.toBeInTheDocument();
    expect(ex.queryByText("3.0500")).not.toBeInTheDocument();
    await userEvent.click(ex.getByRole("button", { name: "Column" }));
    expect(await ex.findByRole("cell", { name: "temp_c" })).toBeInTheDocument();
  });

  it("shows a pending state while the profile is generated", async () => {
    server.use(http.get("*/mock-api/v1/dataset-files/:id/profile", ({ params }) => HttpResponse.json({ file_id: params.id, path: "data/measurements.csv", status: "PENDING", columns: [] })));
    open(USER.bResearcher);
    const ex = await explorer();
    await userEvent.click(await ex.findByRole("button", { name: "Column" }));
    expect(await ex.findByText("미리보기를 준비하고 있습니다…")).toBeInTheDocument();
  });

  it("notes omitted distributions instead of crashing when columns is empty", async () => {
    server.use(
      http.get("*/mock-api/v1/dataset-files/:id/preview", ({ params }) =>
        HttpResponse.json({ file_id: params.id, status: "READY", header: ["a"], rows: [["x"]], rows_truncated: false, columns: [] }),
      ),
    );
    open(USER.bResearcher);
    const ex = await explorer();
    expect(await ex.findByText("분포 정보 생략")).toBeInTheDocument();
    await userEvent.click(ex.getByRole("button", { name: "Compact" }));
    expect(await ex.findByRole("cell", { name: "x" })).toBeInTheDocument();
  });

  it("renders the column description table with rows from every tabular file", async () => {
    const db = getDb();
    const v = db.versions.find((x) => x.dataset_version_id === VERSION.battery)!;
    const src = v.files.find((f) => f.path === "data/measurements.csv")!;
    const copyId = "00000000-0000-4000-8000-0000000000aa";
    v.files.push({ ...src, file_id: copyId, path: "data/second.csv" });
    db.previews[copyId] = db.previews[src.file_id]!;
    open(USER.bResearcher);
    const table = await screen.findByRole("table", { name: "열 설명표" });
    await within(table).findByText("data/second.csv");
    const paths = within(table).getAllByText(/^data\//).map((c) => c.textContent);
    expect(paths).toContain("data/measurements.csv");
    expect(paths).toContain("data/second.csv");
  });

  it("polls a PENDING preview until it is READY", async () => {
    let calls = 0;
    server.use(
      http.get("*/mock-api/v1/dataset-files/:id/preview", ({ params }) =>
        ++calls === 1
          ? HttpResponse.json({ file_id: params.id, status: "PENDING", header: [], rows: [], rows_truncated: false, columns: [] })
          : HttpResponse.json({ file_id: params.id, status: "READY", header: ["a"], rows: [["zz"]], rows_truncated: false, columns: [] }),
      ),
    );
    open(USER.bResearcher);
    const ex = await explorer();
    await userEvent.click(await ex.findByRole("button", { name: "Compact" }));
    expect(await ex.findByText("미리보기를 준비하고 있습니다…")).toBeInTheDocument();
    expect(await ex.findByRole("cell", { name: "zz" }, { timeout: 9000 })).toBeInTheDocument();
  }, 20000);

  it("falls back to a generic message for an unknown failure code", async () => {
    server.use(http.get("*/mock-api/v1/dataset-files/:id/profile", ({ params }) => HttpResponse.json({ file_id: params.id, path: "x.csv", status: "FAILED", failure_code: "NEW_CODE", columns: [] })));
    open(USER.bResearcher);
    const ex = await explorer();
    await userEvent.click(await ex.findByRole("button", { name: "Column" }));
    expect(await ex.findByText("미리보기를 만들지 못했습니다")).toBeInTheDocument();
  });
});
