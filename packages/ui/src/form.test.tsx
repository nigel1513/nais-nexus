import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Checkbox, Input, Select } from "./form";

describe("form controls", () => {
  it("Checkbox stays a native checkbox with a 24px hit target and a drawn 16px box", async () => {
    const onChange = vi.fn();
    render(
      <label>
        <Checkbox onChange={onChange} /> 동의
      </label>,
    );
    const cb = screen.getByRole("checkbox", { name: "동의" });
    expect(cb).toHaveClass("-inset-1", "peer");
    await userEvent.setup().click(cb);
    expect(cb).toBeChecked();
    expect(onChange).toHaveBeenCalled();
  });
  it("Select keeps native options and a decorative chevron", () => {
    render(
      <Select aria-label="목적">
        <option value="a">연구</option>
      </Select>,
    );
    const s = screen.getByRole("combobox", { name: "목적" });
    expect(s).toHaveClass("appearance-none", "h-8");
    expect(s.parentElement!.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  });
  it("Input is 32px with an inner focus ring and an error border from aria-invalid", () => {
    render(<Input aria-label="이름" aria-invalid />);
    const i = screen.getByRole("textbox", { name: "이름" });
    expect(i.className).toContain("h-8");
    expect(i.className).toContain("focus-visible:ring-focus-ring");
    expect(i.className).toContain("aria-[invalid=true]:border-danger");
  });
});
