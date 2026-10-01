import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { DataTable } from "./data-table";

type Row = { id: string; name: string; size: number };
const cols = [
  { key: "name", header: "이름", cell: (r: Row) => r.name },
  { key: "size", header: "크기", cell: (r: Row) => r.size, numeric: true },
];
const many = Array.from({ length: 5000 }, (_, i) => ({ id: String(i), name: `file-${i}`, size: i }));

describe("DataTable", () => {
  it("right-aligns numeric columns with tabular figures, dense rows are 32px", () => {
    render(<DataTable caption="파일" columns={cols} rows={many.slice(0, 3)} rowKey={(r) => r.id} dense />);
    const table = screen.getByRole("table", { name: "파일" });
    const cell = table.querySelector("tbody td:nth-child(2)")!;
    expect(cell).toHaveClass("num", "text-right");
    expect(table.querySelector("tbody tr")).toHaveClass("h-8");
  });
  it("virtualizes above 1,000 rows: only a window of rows is in the DOM", () => {
    render(<DataTable caption="파일" columns={cols} rows={many} rowKey={(r) => r.id} />);
    const rendered = document.querySelectorAll("tbody tr").length;
    expect(rendered).toBeGreaterThan(0);
    expect(rendered).toBeLessThan(100);
    expect(screen.getByText("file-0")).toBeInTheDocument();
    expect(screen.queryByText("file-4999")).toBeNull();
  });
  it("does not virtualize small tables", () => {
    render(<DataTable caption="파일" columns={cols} rows={many.slice(0, 50)} rowKey={(r) => r.id} />);
    expect(screen.getByRole("table").querySelectorAll("tbody tr")).toHaveLength(50);
  });
  it("opens a row with Enter and marks the selected row", async () => {
    const user = userEvent.setup();
    const onRowClick = vi.fn();
    render(<DataTable caption="파일" columns={cols} rows={many.slice(0, 3)} rowKey={(r) => r.id} onRowClick={onRowClick} selectedKey="1" />);
    const rows = screen.getByRole("table").querySelectorAll("tbody tr");
    expect(rows[1]).toHaveClass("bg-accent-soft");
    (rows[2] as HTMLElement).focus();
    await user.keyboard("{Enter}");
    expect(onRowClick).toHaveBeenCalledWith(many[2]);
  });
});
