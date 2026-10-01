import { act, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "../../../tests/render";
import { useToast } from "./toast";

function Fire({ tone }: { tone?: "info" | "error" }) {
  const toast = useToast();
  return <button onClick={() => toast("메시지", tone)}>fire</button>;
}

afterEach(() => vi.useRealTimers());

describe("toasts", () => {
  it("info toasts time out", () => {
    vi.useFakeTimers();
    renderWithProviders(<Fire />);
    act(() => screen.getByText("fire").click());
    expect(screen.getByText("메시지")).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(6100));
    expect(screen.queryByText("메시지")).not.toBeInTheDocument();
  });

  it("error toasts stay until dismissed with the close button", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderWithProviders(<Fire tone="error" />);
    await user.click(screen.getByText("fire"));
    act(() => vi.advanceTimersByTime(60_000));
    expect(screen.getByText("메시지")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "닫기" }));
    expect(screen.queryByText("메시지")).not.toBeInTheDocument();
  });

  it("clears pending timers on unmount", () => {
    vi.useFakeTimers();
    const { unmount } = renderWithProviders(<Fire />);
    act(() => screen.getByText("fire").click());
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
