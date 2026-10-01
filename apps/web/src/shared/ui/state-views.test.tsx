import { act, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "../../../tests/render";
import { ApiError } from "../api/errors";
import { DelayedSkeleton, ErrorView, LoadMore } from "./state-views";

describe("ErrorView", () => {
  it("shows the Korean message for the code and the trace id", async () => {
    const onRetry = vi.fn();
    renderWithProviders(<ErrorView error={new ApiError(404, "NOT_FOUND", "nf", "trace-42")} onRetry={onRetry} />);
    expect(screen.getByRole("alert")).toHaveTextContent("찾을 수 없거나 접근 권한이 없습니다.");
    expect(screen.getByText("trace-42")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "다시 시도" }));
    expect(onRetry).toHaveBeenCalled();
  });

  it("uses the fallback message for unknown codes", () => {
    renderWithProviders(<ErrorView error={new ApiError(418, "TEAPOT", "x", "t")} />);
    expect(screen.getByRole("alert")).toHaveTextContent("요청을 처리하지 못했습니다.");
  });
});

describe("DelayedSkeleton", () => {
  it("does not flash for loads under 300ms", () => {
    vi.useFakeTimers();
    const { container } = renderWithProviders(<DelayedSkeleton lines={2} />);
    expect(container.querySelectorAll(".animate-pulse")).toHaveLength(0);
    act(() => vi.advanceTimersByTime(300));
    expect(container.querySelectorAll(".animate-pulse")).toHaveLength(2);
    vi.useRealTimers();
  });
});

describe("LoadMore", () => {
  it("renders a keyboard-accessible button only when there is a next page", async () => {
    const fetchNextPage = vi.fn();
    const first = renderWithProviders(<LoadMore hasNextPage={false} isFetchingNextPage={false} fetchNextPage={fetchNextPage} />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    first.unmount();
    renderWithProviders(<LoadMore hasNextPage isFetchingNextPage={false} fetchNextPage={fetchNextPage} />);
    await userEvent.click(screen.getByRole("button", { name: "더 보기" }));
    expect(fetchNextPage).toHaveBeenCalled();
  });
});
