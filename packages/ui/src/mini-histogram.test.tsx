import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MiniHistogram } from "./mini-histogram";

describe("MiniHistogram", () => {
  it("draws one bar per bin, heights proportional to the max", () => {
    const { container } = render(<MiniHistogram label="voltage 분포" bins={[2, 4, 8, 0]} height={40} />);
    expect(screen.getByRole("img", { name: "voltage 분포" })).toBeInTheDocument();
    const bars = [...container.querySelectorAll("rect[data-bin]")];
    expect(bars).toHaveLength(4);
    expect(bars.map((b) => Number(b.getAttribute("height")))).toEqual([10, 20, 40, 0]);
  });
  it("highlights given bins and shows label + value on hover; click reports the bin", () => {
    const onBinClick = vi.fn();
    const { container } = render(
      <MiniHistogram label="h" bins={[1, 3]} labels={["0–10", "10–20"]} highlight={[0]} onBinClick={onBinClick} />,
    );
    const bars = container.querySelectorAll("rect[data-bin]");
    expect(bars[0]).toHaveClass("fill-accent");
    expect(bars[1]).toHaveClass("fill-chart-muted");
    const hit = bars[1]!.nextElementSibling!;
    fireEvent.mouseEnter(hit);
    expect(screen.getByText("10–20 · 3")).toBeInTheDocument();
    expect(bars[1]).toHaveClass("fill-accent");
    fireEvent.click(hit);
    expect(onBinClick).toHaveBeenCalledWith(1);
  });
});
