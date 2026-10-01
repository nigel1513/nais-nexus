import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Avatar, avatarTone, initials } from "./avatar";

describe("Avatar", () => {
  it("uses the Korean family name or two Latin initials", () => {
    expect(initials("김연구")).toBe("김");
    expect(initials("Bora Steward")).toBe("BS");
    expect(initials("ada")).toBe("A");
  });
  it("is named, stable in colour, and sized", () => {
    render(<Avatar name="김연구" size={32} />);
    const a = screen.getByRole("img", { name: "김연구" });
    expect(a).toHaveClass("size-8", "rounded-full");
    expect(avatarTone("김연구")).toBe(avatarTone("김연구"));
  });
  it("can be decorative next to a printed name", () => {
    const { container } = render(<Avatar name="x" decorative />);
    expect(container.firstElementChild).toHaveAttribute("aria-hidden", "true");
  });
});
