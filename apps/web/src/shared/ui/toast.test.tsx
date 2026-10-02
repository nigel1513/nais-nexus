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

  it("error toasts stay until closed, are announced through the alert region and not again politely", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderWithProviders(<Fire kind="error" />);
    await user.click(screen.getByText("fire"));
    expect(await screen.findByRole("alert")).toHaveTextContent("메시지");
    const card = () => region()!.querySelector("div[aria-hidden=true]");
    expect(card()).toHaveTextContent("메시지"); // the polite region does not read it a second time
    act(() => vi.advanceTimersByTime(60_000));
    expect(card()).toHaveTextContent("메시지");
    await user.click(screen.getByRole("button", { name: "닫기" }));
    await waitFor(() => expect(card()).toBeNull());
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
