import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Switch } from "./switch";

describe("Switch", () => {
  it("is named by its label and toggles with Space", async () => {
    const user = userEvent.setup();
    const onCheckedChange = vi.fn();
    render(<Switch label="AI-ready만" onCheckedChange={onCheckedChange} />);
    const sw = screen.getByRole("switch", { name: "AI-ready만" });
    sw.focus();
    await user.keyboard(" ");
    expect(onCheckedChange).toHaveBeenCalledWith(true, expect.anything());
    expect(sw).toHaveAttribute("aria-checked", "true");
  });
  it("can be disabled", () => {
    render(<Switch aria-label="x" disabled />);
    expect(screen.getByRole("switch", { name: "x" })).toHaveAttribute("aria-disabled", "true");
  });
});
