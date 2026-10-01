import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { DATASET, USER } from "@/mocks/fixtures";
import { server } from "../../../../tests/msw";
import { renderScreen } from "../../../../tests/render";
import { DatasetDetailScreen } from "../dataset-detail-screen";
import { isTabular } from "../lib/tabular";

const open = (user: string) => renderScreen(<DatasetDetailScreen datasetId={DATASET.battery} />, { user, path: `/commons/data/${DATASET.battery}` });
const explorer = async () => within(await screen.findByRole("list", { name: "파일" }).then((l) => l.closest("div.grid") as HTMLElement));

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
  it("lists files, defaults to the first tabular file and shows the column view", async () => {
    open(USER.bResearcher);
    const tree = await screen.findByRole("list", { name: "파일" });
    expect(within(tree).getByRole("button", { name: /data\/measurements\.csv/ })).toHaveAttribute("aria-current", "true");
    const ex = await explorer();
    await userEvent.click(ex.getByRole("radio", { name: "Column" }));
    const table = await ex.findByRole("table", { name: /열 요약/ });
    expect(within(table).getByRole("cell", { name: "temperature_c" })).toBeInTheDocument();
    expect(within(table).getByRole("cell", { name: "Cel" })).toBeInTheDocument();
  });

  it("shows distributions and a 100-row preview to users with download permission", async () => {
    open(USER.bResearcher);
    const ex = await explorer();
    await userEvent.click(await ex.findByRole("radio", { name: "Detail" }));
    expect(await ex.findByRole("img", { name: /temperature_c 분포/ })).toBeInTheDocument();
    await userEvent.click(ex.getByRole("radio", { name: "Compact" }));
    const rows = within(await ex.findByRole("table", { name: /미리보기/ })).getAllByRole("row");
    expect(rows).toHaveLength(101);
  });

  it("gates raw values behind download permission", async () => {
    open(USER.aAdmin);
    const ex = await explorer();
    await userEvent.click(await ex.findByRole("radio", { name: "Detail" }));
    expect(await ex.findByText("접근 승인 후 미리보기 가능")).toBeInTheDocument();
    expect(ex.getByRole("button", { name: "접근 요청" })).toBeInTheDocument();
    expect(ex.queryByRole("img", { name: /분포/ })).not.toBeInTheDocument();
    expect(ex.queryByText("AL")).not.toBeInTheDocument();
    await userEvent.click(ex.getByRole("radio", { name: "Column" }));
    expect(await ex.findByRole("cell", { name: "temperature_c" })).toBeInTheDocument();
  });

  it("shows a pending state while the profile is generated", async () => {
    server.use(http.get("*/mock-api/v1/dataset-files/:id/profile", ({ params }) => HttpResponse.json({ file_id: params.id, path: "data/measurements.csv", status: "PENDING", columns: [] })));
    open(USER.bResearcher);
    const ex = await explorer();
    await userEvent.click(await ex.findByRole("radio", { name: "Column" }));
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
    await userEvent.click(ex.getByRole("radio", { name: "Compact" }));
    expect(await ex.findByRole("cell", { name: "x" })).toBeInTheDocument();
  });

  it("renders the column description table for every tabular file", async () => {
    open(USER.bResearcher);
    const table = await screen.findByRole("table", { name: "열 설명표" });
    await within(table).findByRole("cell", { name: "temperature_c" });
    expect(within(table).getAllByRole("row").length).toBeGreaterThan(5);
  });
});
