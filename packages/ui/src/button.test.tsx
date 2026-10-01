import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Button, buttonClass } from "./button";

describe("Button", () => {
  it("maps legacy variants", () => {
    render(<Button variant="default">저장</Button>);
    expect(screen.getByRole("button", { name: "저장" }).className).toContain("bg-primary");
    // The label colour must survive class merging next to the text-size token.
    expect(screen.getByRole("button", { name: "저장" }).className).toContain("text-primary-fg");
    expect(buttonClass("danger", "sm")).toContain("text-danger-fill-fg");
    expect(buttonClass("destructive")).toContain("bg-danger-fill");
    expect(buttonClass("outline")).toContain("border-border");
    expect(buttonClass("link")).toContain("underline");
  });
  it("defaults to secondary at 32px", () => {
    render(<Button>취소</Button>);
    const b = screen.getByRole("button", { name: "취소" });
    expect(b.className).toContain("bg-bg-panel");
    expect(b.className).toContain("h-8");
    expect(b).toHaveAttribute("type", "button");
  });
  it.each([["sm", "h-7"], ["md", "h-8"], ["lg", "h-10"]] as const)("size %s is %s", (size, h) => {
    render(<Button size={size}>x</Button>);
    expect(screen.getByRole("button").className).toContain(h);
  });
  it("keeps width and shows a spinner while loading", () => {
    render(<Button loading>저장</Button>);
    const b = screen.getByRole("button", { name: "저장" });
    expect(b).toHaveAttribute("aria-busy", "true");
    expect(b).toBeDisabled();
    expect(b.querySelector("svg.animate-spin")).not.toBeNull();
    // The label stays in place (transparent), so the width does not change.
    expect(screen.getByText("저장").className).toContain("opacity-0");
  });
  it("has press feedback and a keyboard focus ring", () => {
    render(<Button>저장</Button>);
    const cls = screen.getByRole("button").className;
    expect(cls).toContain("press");
    expect(cls).toContain("focus-visible:outline-focus");
  });
});
