import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import type { WebRtcCallbacks } from "./webrtc";
import type { CallSocketHandlers } from "./call-socket";

// ─────────────────────────────────────────────────────────────────────────────
// CallProvider is a React context/provider (not a pure reducer like
// call-store.ts), so it's driven here through the real useCall() hook via
// renderHook, with WebRtcController and call-socket fully faked — jsdom has no
// WebRTC or socket.io, and we want to control exactly when "connected" /
// "disconnected" / "failed" fire without a real peer connection.
//
// Focus: the ICE "disconnected" grace-period recovery in the onConnectionState
// callback (call-provider.tsx). "connected"/"failed" fast paths are covered
// incidentally since the new logic threads through both.
// ─────────────────────────────────────────────────────────────────────────────

class FakeController {
  cb: WebRtcCallbacks;
  closed = false;
  restartIceCalls = 0;
  createOfferCalls = 0;

  constructor(cb: WebRtcCallbacks) {
    this.cb = cb;
    fakeControllers.push(this);
  }
  async startLocalMedia(): Promise<void> {}
  async createOffer() {
    this.createOfferCalls += 1;
    return { type: "offer" as const, sdp: `offer-${this.createOfferCalls}` };
  }
  async acceptOffer() {
    return { type: "answer" as const, sdp: "answer" };
  }
  async acceptAnswer(): Promise<void> {}
  async addIce(): Promise<void> {}
  setMuted(): void {}
  setCameraEnabled(): void {}
  async switchCamera(): Promise<void> {}
  restartIce(): void {
    this.restartIceCalls += 1;
  }
  close(): void {
    this.closed = true;
  }
  setIceServers(): void {}
}

let fakeControllers: FakeController[] = [];
let socketHandlers: CallSocketHandlers | null = null;

vi.mock("./webrtc", () => ({
  // A plain arrow fn can't be `new`ed, so mockImplementation needs a real
  // function here — returning an object from it makes `new WebRtcController()`
  // resolve to that object instead of `this`.
  WebRtcController: vi.fn().mockImplementation(function (cb: WebRtcCallbacks) {
    return new FakeController(cb);
  }),
}));

vi.mock("./call-socket", () => ({
  bindCallSocket: vi.fn((_socket: unknown, handlers: CallSocketHandlers) => {
    socketHandlers = handlers;
    return () => {};
  }),
  emitInit: vi.fn(async () => ({ ok: true, callId: "call-1", iceServers: [] })),
  emitAccept: vi.fn(),
  emitReject: vi.fn(),
  emitEnd: vi.fn(),
  emitOffer: vi.fn(),
  emitAnswer: vi.fn(),
  emitIce: vi.fn(),
  emitMediaState: vi.fn(),
}));

vi.mock("@/frontend-core/socket", () => ({
  getSocket: vi.fn(() => ({})),
}));

// eslint-disable-next-line import/first
import { CallProvider, useCall, ICE_DISCONNECT_GRACE_MS } from "./call-provider";
// eslint-disable-next-line import/first
import { emitOffer } from "./call-socket";

function wrapper({ children }: { children: ReactNode }) {
  return <CallProvider selfUsername="me">{children}</CallProvider>;
}

// Drives the provider from idle through to "connected", as the outgoing
// (caller) side — the role that owns ICE-restart recovery. Returns the
// FakeController backing the live call so tests can inspect/drive it.
async function connectAsOutgoing(result: { current: ReturnType<typeof useCall> }) {
  act(() => {
    result.current.startCall({ id: "peer-1", username: "peer" }, "AUDIO");
  });
  await waitFor(() => expect(result.current.state.phase).toBe("outgoing"));

  act(() => {
    socketHandlers!.onAccepted({ callId: "call-1" });
  });
  await waitFor(() => expect(result.current.state.phase).toBe("connecting"));

  const controller = fakeControllers[fakeControllers.length - 1]!;
  act(() => {
    controller.cb.onConnectionState("connected");
  });
  await waitFor(() => expect(result.current.state.phase).toBe("connected"));

  return controller;
}

beforeEach(() => {
  fakeControllers = [];
  socketHandlers = null;
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("CallProvider ICE disconnect recovery", () => {
  it("recovers to connected before the grace period elapses: no teardown", async () => {
    const { result } = renderHook(() => useCall(), { wrapper });
    const controller = await connectAsOutgoing(result);

    vi.useFakeTimers();
    act(() => {
      controller.cb.onConnectionState("disconnected");
    });
    // Outgoing side kicks a restart attempt immediately.
    expect(controller.restartIceCalls).toBe(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(ICE_DISCONNECT_GRACE_MS - 1000);
    });
    expect(controller.closed).toBe(false);

    act(() => {
      controller.cb.onConnectionState("connected");
    });

    // Well past the original grace window — proves the timer was cancelled,
    // not just still pending.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(controller.closed).toBe(false);
    expect(result.current.state.phase).toBe("connected");
  });

  it("tears down when the grace period elapses without recovering", async () => {
    const { result } = renderHook(() => useCall(), { wrapper });
    const controller = await connectAsOutgoing(result);

    vi.useFakeTimers();
    act(() => {
      controller.cb.onConnectionState("disconnected");
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(ICE_DISCONNECT_GRACE_MS);
    });

    expect(controller.closed).toBe(true);
    expect(result.current.state.phase).toBe("failed");
  });

  it("failed tears down immediately, regardless of any pending grace timer", async () => {
    const { result } = renderHook(() => useCall(), { wrapper });
    const controller = await connectAsOutgoing(result);

    vi.useFakeTimers();
    act(() => {
      controller.cb.onConnectionState("disconnected");
    });
    expect(controller.closed).toBe(false);

    act(() => {
      controller.cb.onConnectionState("failed");
    });
    expect(controller.closed).toBe(true);
    expect(result.current.state.phase).toBe("failed");

    // The disconnect grace timer must not still be armed underneath — running
    // past its original deadline must not blow up or re-run teardown (which
    // would wipe out a new call's refs if one had started by then). The
    // provider's own 1400ms terminal-phase reset timer is expected to fire
    // in this window and take phase back to "idle" — that's pre-existing,
    // unrelated behavior, not something this test is checking.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ICE_DISCONNECT_GRACE_MS);
    });
    expect(controller.closed).toBe(true);
  });

  it("a rapid disconnected/connected flicker does not stack overlapping timers", async () => {
    const { result } = renderHook(() => useCall(), { wrapper });
    const controller = await connectAsOutgoing(result);

    vi.useFakeTimers();
    act(() => {
      controller.cb.onConnectionState("disconnected"); // timer A armed, t=0
    });
    expect(controller.restartIceCalls).toBe(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000); // t=3s
    });

    act(() => {
      controller.cb.onConnectionState("connected"); // cancels timer A
    });
    act(() => {
      controller.cb.onConnectionState("disconnected"); // timer B armed fresh, t=3s
    });
    expect(controller.restartIceCalls).toBe(2);

    // t=9s absolute: if timer A had never been cleared it would have fired
    // at t=8s already. It didn't — only timer B (due at t=11s) is live.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6_000);
    });
    expect(controller.closed).toBe(false);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000); // t=11s: timer B elapses
    });
    expect(controller.closed).toBe(true);
  });

  it("the incoming (answerer) side does not itself drive an ICE restart", async () => {
    const { result } = renderHook(() => useCall(), { wrapper });

    // Simulate an incoming call instead of connectAsOutgoing's outgoing path.
    // bindCallSocket is wired once on mount, so socketHandlers is already set.
    act(() => {
      socketHandlers!.onRinging({
        callId: "call-2",
        caller: { id: "peer-1", username: "peer" },
        type: "AUDIO",
        iceServers: [],
      });
    });
    await waitFor(() => expect(result.current.state.phase).toBe("incoming"));

    act(() => {
      result.current.accept();
    });
    await waitFor(() => expect(result.current.state.phase).toBe("connecting"));

    const controller = fakeControllers[fakeControllers.length - 1]!;
    act(() => {
      controller.cb.onConnectionState("connected");
    });
    await waitFor(() => expect(result.current.state.phase).toBe("connected"));

    vi.useFakeTimers();
    act(() => {
      controller.cb.onConnectionState("disconnected");
    });
    // Answerer side: grace timer still applies, but it must not be the one
    // driving the restart — that's the outgoing side's job.
    expect(controller.restartIceCalls).toBe(0);
    expect(emitOffer).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(ICE_DISCONNECT_GRACE_MS);
    });
    expect(controller.closed).toBe(true);
  });
});
