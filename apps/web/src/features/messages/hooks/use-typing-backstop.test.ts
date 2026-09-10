import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useTypingBackstop } from "./use-typing-backstop";

const BACKSTOP_MS = 10_000;

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("useTypingBackstop() — basic shape", () => {
  it("starts not-typing", () => {
    const { result } = renderHook(() => useTypingBackstop(BACKSTOP_MS));
    const [isTyping] = result.current;
    expect(isTyping).toBe(false);
  });

  it("markTyping(true) flips to typing immediately", () => {
    const { result } = renderHook(() => useTypingBackstop(BACKSTOP_MS));
    act(() => result.current[1](true));
    expect(result.current[0]).toBe(true);
  });
});

describe("useTypingBackstop() — the backstop itself (no further signal at all)", () => {
  it("stays typing right up to the window, then self-clears — the stuck-bubble bug this exists to fix", () => {
    const { result } = renderHook(() => useTypingBackstop(BACKSTOP_MS));
    act(() => result.current[1](true));
    expect(result.current[0]).toBe(true);

    // Just under the window: a dropped-stop bug (the ORIGINAL behavior this
    // hook replaces) would still show this as stuck-but-not-yet-caught here
    // — the real assertion is what happens the instant AFTER the window.
    act(() => vi.advanceTimersByTime(BACKSTOP_MS - 1));
    expect(result.current[0]).toBe(true);

    act(() => vi.advanceTimersByTime(1));
    expect(result.current[0]).toBe(false);
  });

  it("firing the backstop doesn't leave a dangling timer that fires again later", () => {
    const { result } = renderHook(() => useTypingBackstop(BACKSTOP_MS));
    act(() => result.current[1](true));
    act(() => vi.advanceTimersByTime(BACKSTOP_MS));
    expect(result.current[0]).toBe(false);

    // Nothing re-arms itself after firing — still false arbitrarily later.
    act(() => vi.advanceTimersByTime(BACKSTOP_MS * 5));
    expect(result.current[0]).toBe(false);
  });
});

describe("useTypingBackstop() — a real stop arriving before the backstop", () => {
  it("markTyping(false) clears immediately, well before the window would have elapsed on its own", () => {
    const { result } = renderHook(() => useTypingBackstop(BACKSTOP_MS));
    act(() => result.current[1](true));
    act(() => vi.advanceTimersByTime(2000));

    act(() => result.current[1](false));
    expect(result.current[0]).toBe(false);
  });

  it("REGRESSION: the pending backstop from the true→false transition does not leak forward and clobber a LATER, unrelated typing session", () => {
    // Real stop-then-resume: markTyping(true) at t=0 arms a backstop deadline
    // at t=10000. A real stop lands at t=2000. If that stop didn't properly
    // cancel the original timer, it would still be sitting there armed for
    // t=10000 — and could fire mid-way through a brand new session that
    // starts afterward, incorrectly clearing it despite its OWN, unexpired
    // backstop. This is exactly the "no double-clear/conflict" property.
    const { result } = renderHook(() => useTypingBackstop(BACKSTOP_MS));

    act(() => result.current[1](true)); // t=0, stale deadline would be t=10000
    act(() => vi.advanceTimersByTime(2000)); // t=2000
    act(() => result.current[1](false)); // real stop — must cancel the t=10000 timer
    expect(result.current[0]).toBe(false);

    act(() => result.current[1](true)); // t=2000, a fresh session — new deadline t=12000
    // Advance to t=10000 — exactly where the STALE (uncancelled) timer would
    // have fired, but well before the fresh session's own t=12000 deadline.
    act(() => vi.advanceTimersByTime(8000));
    expect(result.current[0]).toBe(true);
  });
});

describe("useTypingBackstop() — continued typing:start-equivalent signals reset the window", () => {
  it("a markTyping(true) landing before the window elapses re-arms it, instead of letting the original deadline expire mid-session", () => {
    const { result } = renderHook(() => useTypingBackstop(BACKSTOP_MS));

    act(() => result.current[1](true)); // t=0, deadline t=10000
    act(() => vi.advanceTimersByTime(9000)); // t=9000 — still typing
    act(() => result.current[1](true)); // re-signal: deadline pushed to t=19000
    expect(result.current[0]).toBe(true);

    // t=9000 + 9000 = 18000 — past the ORIGINAL t=10000 deadline, but still
    // short of the reset t=19000 one. Still typing proves the reset worked.
    act(() => vi.advanceTimersByTime(9000));
    expect(result.current[0]).toBe(true);

    // Now let the (reset) window actually run out with no further signal.
    act(() => vi.advanceTimersByTime(1000));
    expect(result.current[0]).toBe(false);
  });

  it("repeated resets can extend well past the original window, as long as each one lands before the previous deadline", () => {
    const { result } = renderHook(() => useTypingBackstop(BACKSTOP_MS));
    act(() => result.current[1](true));

    // Five renewals, each inside the previous window — total elapsed time
    // (25s) is well beyond one bare BACKSTOP_MS (10s), and it must still be
    // typing throughout: this is the "still actively typing" case the
    // backstop must never interrupt.
    for (let i = 0; i < 5; i++) {
      act(() => vi.advanceTimersByTime(5000));
      act(() => result.current[1](true));
      expect(result.current[0]).toBe(true);
    }

    // Then silence — the (last-reset) window elapses for real.
    act(() => vi.advanceTimersByTime(BACKSTOP_MS));
    expect(result.current[0]).toBe(false);
  });
});
