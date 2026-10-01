import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Badge, toneClass } from "./badge";

describe("Badge", () => {
  it.each(Object.keys(toneClass) as Array<keyof typeof toneClass>)("tone %s uses step-3 fill and step-11 text", (tone) => {
    render(<Badge tone={tone}>상태</Badge>);
    expect(screen.getByText("상태").className).toContain(toneClass[tone].split(" ")[0]);
  });
  it("dot variant draws a decorative dot and no fill", () => {
    render(<Badge tone="success" dot>게시됨</Badge>);
    const b = screen.getByText("게시됨");
    expect(b.querySelector("[aria-hidden=true]")).toHaveClass("bg-success-solid");
    expect(b.className).not.toContain("bg-success-soft");
  });
});
