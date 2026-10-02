import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { GroupedList } from "./grouped-list";

type Item = { id: string; name: string };
const make = (n: number, prefix: string) => Array.from({ length: n }, (_, i) => ({ id: `${prefix}-${i}`, name: `${prefix} item ${i}` }));

describe("GroupedList", () => {
  it("renders every group under a sticky caption header", () => {
    render(
      <GroupedList<Item>
        label="활동"
        groups={[
          { key: "a", label: "오늘", items: make(2, "a") },
          { key: "b", label: "어제", items: make(3, "b") },
        ]}
        itemKey={(i) => i.id}
        renderItem={(i) => i.name}
      />,
    );
    const list = screen.getByRole("region", { name: "활동" });
    const headers = screen.getAllByRole("heading", { level: 2 });
    expect(headers.map((h) => h.textContent)).toEqual(["오늘", "어제"]);
    expect(headers[0]).toHaveClass("sticky", "top-12");
    expect(list.querySelectorAll("li")).toHaveLength(5);
    expect(screen.getByRole("region", { name: "어제" })).toHaveTextContent("b item 2");
  });

  it("virtualizes above 1,000 items: only a window is in the DOM", () => {
    render(
      <GroupedList<Item>
        label="활동"
        groups={[
          { key: "a", label: "오늘", items: make(800, "a") },
          { key: "b", label: "어제", items: make(800, "b") },
        ]}
        itemKey={(i) => i.id}
        renderItem={(i) => <span>{i.name}</span>}
      />,
    );
    expect(screen.getByText("a item 0")).toBeInTheDocument();
    expect(screen.queryByText("b item 799")).toBeNull();
    expect(screen.getByRole("region", { name: "활동" }).querySelectorAll("span").length).toBeLessThan(100);
  });
});
