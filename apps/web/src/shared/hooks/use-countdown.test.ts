import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatCountdown, useCountdown } from "./use-countdown";

afterEach(() => vi.useRealTimers());

describe("useCountdown", () => {
  it("counts down to zero and stays there", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-01T00:00:00Z"));
    const { result } = renderHook(() => useCountdown("2026-10-01T00:00:05Z"));
    expect(result.current).toBe(5);
    act(() => vi.advanceTimersByTime(3000));
    expect(result.current).toBe(2);
    act(() => vi.advanceTimersByTime(5000));
    expect(result.current).toBe(0);
  });

  it("is 0 without an expiry and formats m:ss", () => {
    const { result } = renderHook(() => useCountdown(null));
    expect(result.current).toBe(0);
    expect(formatCountdown(299)).toBe("4:59");
    expect(formatCountdown(5)).toBe("0:05");
  });
});
