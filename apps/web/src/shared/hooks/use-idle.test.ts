import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useIdle } from "./use-idle";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("useIdle() — basic smoke test", () => {
  it("starts active, flips to inactive after timeoutMs of silence, and resets to active on activity", () => {
    const { result } = renderHook(() => useIdle(1000));
    expect(result.current).toBe(true);

    act(() => vi.advanceTimersByTime(1000));
    expect(result.current).toBe(false);

    act(() => window.dispatchEvent(new Event("mousemove")));
    expect(result.current).toBe(true);
  });

  it("when disabled, stays always-active regardless of elapsed time", () => {
    const { result } = renderHook(() => useIdle(1000, false));
    act(() => vi.advanceTimersByTime(5000));
    expect(result.current).toBe(true);
  });
});
