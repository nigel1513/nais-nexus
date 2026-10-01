import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { PathText, splitForMiddleEllipsis } from "./path-text";

const PATH = "raw/2026/cycling/cell-0042/session-17/voltage_current_temperature.parquet";

describe("PathText", () => {
  it("cuts in the middle: the head truncates, the file name always shows", () => {
    expect(splitForMiddleEllipsis(PATH)).toEqual(["raw/2026/cycling/cell-0042/session-17", "/voltage_current_temperature.parquet"]);
    expect(splitForMiddleEllipsis("0f3a9c2e7b1d44aa9e0c5d6f7a8b9c0d")).toEqual(["0f3a9c2e7b1d44aa9e0c", "5d6f7a8b9c0d"]);
    const { container } = render(<PathText value={PATH} />);
    const head = container.querySelector('[data-part="head"]')!;
    const tail = container.querySelector('[data-part="tail"]')!;
    expect(head).toHaveClass("truncate");
    expect(tail).toHaveClass("truncate");
    expect(head).toHaveClass("shrink-[1000]");
    expect(head).toHaveClass("min-w-8");
    expect(head.textContent! + tail.textContent!).toBe(PATH);
  });

  it("copies through the execCommand fallback when navigator.clipboard is undefined", async () => {
    const user = userEvent.setup();
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    let copied = "";
    Object.defineProperty(document, "execCommand", {
      value: vi.fn(() => {
        copied = (document.activeElement as HTMLTextAreaElement).value;
        return true;
      }),
      configurable: true,
      writable: true,
    });
    render(<PathText value={PATH} copyLabel="경로 복사" copiedLabel="복사됨" />);
    await user.click(screen.getByRole("button", { name: "경로 복사" }));
    expect(copied).toBe(PATH);
    expect(await screen.findByText("복사됨")).toBeInTheDocument();
  });
});
