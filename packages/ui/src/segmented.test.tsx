import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { SegmentedControl } from "./segmented";

function H() {
  const [v, setV] = useState("detail");
  return (
    <SegmentedControl
      aria-label="보기"
      value={v}
      onValueChange={setV}
      items={[
        { value: "detail", label: "Detail" },
        { value: "compact", label: "Compact" },
        { value: "column", label: "Column" },
      ]}
    />
  );
}

describe("SegmentedControl", () => {
  it("keeps exactly one segment pressed; arrows move focus, Enter picks", async () => {
    const user = userEvent.setup();
    render(<H />);
    expect(screen.getByRole("group", { name: "보기" })).toBeInTheDocument();
    const detail = screen.getByRole("button", { name: "Detail" });
    expect(detail).toHaveAttribute("aria-pressed", "true");
    await user.click(detail);
    expect(detail).toHaveAttribute("aria-pressed", "true");
    detail.focus();
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("button", { name: "Compact" })).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("button", { name: "Compact" })).toHaveAttribute("aria-pressed", "true");
    expect(detail).toHaveAttribute("aria-pressed", "false");
  });
});
