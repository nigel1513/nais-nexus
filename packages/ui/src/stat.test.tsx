import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Stat } from "./stat";

describe("Stat", () => {
  it("shows label, tabular value and a coloured change", () => {
    render(<Stat label="검토 대기" value="12" delta="+3" trend="up" hint="이번 주" />);
    expect(screen.getByText("12")).toHaveClass("num");
    expect(screen.getByText("+3").closest("span")).toHaveClass("text-success");
    expect(screen.getByText("이번 주")).toBeInTheDocument();
  });
});
