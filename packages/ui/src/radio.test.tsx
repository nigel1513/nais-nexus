import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Radio, RadioGroup } from "./radio";

describe("RadioGroup", () => {
  it("is named, and arrow keys move the choice", async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    render(
      <RadioGroup aria-label="공개 수준" defaultValue="public" onValueChange={onValueChange}>
        <Radio value="public" label="공개" />
        <Radio value="controlled" label="통제" />
        <Radio value="private" label="비공개" disabled />
      </RadioGroup>,
    );
    expect(screen.getByRole("radiogroup", { name: "공개 수준" })).toBeInTheDocument();
    const pub = screen.getByRole("radio", { name: "공개" });
    expect(pub).toHaveAttribute("aria-checked", "true");
    pub.focus();
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("radio", { name: "통제" })).toHaveAttribute("aria-checked", "true");
    expect(onValueChange).toHaveBeenCalledWith("controlled");
  });
});
