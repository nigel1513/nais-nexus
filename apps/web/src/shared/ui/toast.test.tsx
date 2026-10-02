import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "../../../tests/render";
import { notify } from "./toast";

function Fire({ kind }: { kind: "success" | "error" }) {
  return <button onClick={() => notify[kind]("메시지")}>fire</button>;
}

const region = () => document.querySelector("section[aria-live]");

afterEach(() => vi.useRealTimers());

describe("app toasts (notify → Sonner)", () => {
  it("success toasts leave by themselves after 4s and are announced politely", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderWithProviders(<Fire kind="success" />);
    await user.click(screen.getByText("fire"));
    expect(await screen.findByText("메시지")).toBeInTheDocument();
    expect(region()).toHaveAttribute("aria-live", "polite");
    act(() => vi.advanceTimersByTime(4500));
    await waitFor(() => expect(screen.queryByText("메시지")).not.toBeInTheDocument());
  });

  it("error toasts stay until closed with the labelled button and are announced assertively", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderWithProviders(<Fire kind="error" />);
    await user.click(screen.getByText("fire"));
    expect(await screen.findByText("메시지")).toBeInTheDocument();
    expect(region()).toHaveAttribute("aria-live", "assertive");
    act(() => vi.advanceTimersByTime(60_000));
    expect(screen.getByText("메시지")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "닫기" }));
    await waitFor(() => expect(screen.queryByText("메시지")).not.toBeInTheDocument());
  });

  it("nothing leaks across a remount: the toaster starts empty", async () => {
    const { unmount } = renderWithProviders(<Fire kind="error" />);
    await userEvent.click(screen.getByText("fire"));
    expect(await screen.findByText("메시지")).toBeInTheDocument();
    act(() => notify.dismiss());
    unmount();
    renderWithProviders(<Fire kind="error" />);
    expect(screen.queryByText("메시지")).not.toBeInTheDocument();
  });
});
