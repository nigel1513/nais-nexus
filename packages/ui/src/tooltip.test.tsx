import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Tooltip, TooltipProvider } from "./tooltip";

afterEach(() => vi.useRealTimers());

const hover = (el: Element) => {
  for (const type of ["pointerOver", "pointerEnter", "mouseOver", "mouseEnter", "pointerMove", "mouseMove"] as const)
    fireEvent[type](el, { pointerType: "mouse" });
};
const unhover = (el: Element) => {
  for (const type of ["pointerOut", "pointerLeave", "mouseOut", "mouseLeave"] as const) fireEvent[type](el, { pointerType: "mouse" });
};

describe("Tooltip", () => {
  it("waits 500ms for the first tooltip, then opens neighbours instantly (data-instant)", async () => {
    vi.useFakeTimers();
    render(
      <TooltipProvider>
        <Tooltip content="굵게">
          <button>B</button>
        </Tooltip>
        <Tooltip content="기울임">
          <button>I</button>
        </Tooltip>
      </TooltipProvider>,
    );
    hover(screen.getByText("B"));
    await act(async () => vi.advanceTimersByTime(300));
    expect(screen.queryByText("굵게")).toBeNull();
    await act(async () => vi.advanceTimersByTime(250));
    expect(screen.getByText("굵게")).toBeInTheDocument();
    expect(screen.getByText("굵게")).not.toHaveAttribute("data-instant");

    unhover(screen.getByText("B"));
    hover(screen.getByText("I"));
    await act(async () => vi.advanceTimersByTime(1));
    expect(screen.getByText("기울임")).toHaveAttribute("data-instant");
  });
});
