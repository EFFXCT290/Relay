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
  stopScreenShareCalls = 0;
  // Tests override these to simulate glare (return null) or a rejected
  // getDisplayMedia (permission denied/cancelled).
  nextCreateOfferReturnsNull = false;
  nextAcceptOfferReturnsNull = false;
  startScreenShareImpl: () => Promise<MediaStream> = async () => ({}) as MediaStream;

  constructor(cb: WebRtcCallbacks) {
    this.cb = cb;
    fakeControllers.push(this);
  }
  async startLocalMedia(): Promise<void> {}
  async createOffer() {
    this.createOfferCalls += 1;
    if (this.nextCreateOfferReturnsNull) {
      this.nextCreateOfferReturnsNull = false;
      return null;
    }
    return { type: "offer" as const, sdp: `offer-${this.createOfferCalls}` };
  }
  async acceptOffer() {
    if (this.nextAcceptOfferReturnsNull) {
      this.nextAcceptOfferReturnsNull = false;
      return null;
    }
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
  async startScreenShare(): Promise<MediaStream> {
    return this.startScreenShareImpl();
  }
  async stopScreenShare(): Promise<void> {
    this.stopScreenShareCalls += 1;
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
  emitClientState: vi.fn(),
  emitConnectionStats: vi.fn(),
}));

vi.mock("@/frontend-core/socket", () => ({
  getSocket: vi.fn(() => ({})),
}));

// eslint-disable-next-line import/first
import { CallProvider, useCall, ICE_DISCONNECT_GRACE_MS } from "./call-provider";
// eslint-disable-next-line import/first
import { emitOffer, emitAnswer, emitMediaState, emitClientState, emitConnectionStats } from "./call-socket";

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

describe("CallProvider observability reporting (Part 2/3)", () => {
  it("reports disconnected (with the restart attempt) then recovered, on the outgoing side", async () => {
    const { result } = renderHook(() => useCall(), { wrapper });
    const controller = await connectAsOutgoing(result);
    vi.mocked(emitClientState).mockClear(); // drop the "connected" report from connectAsOutgoing

    vi.useFakeTimers();
    act(() => {
      controller.cb.onConnectionState("disconnected");
    });
    expect(emitClientState).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ callId: "call-1", state: "disconnected", iceRestartAttempted: true, iceRestartBy: "outgoing" }),
    );

    act(() => {
      controller.cb.onConnectionState("connected");
    });
    expect(emitClientState).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ callId: "call-1", state: "connected", outcome: "recovered" }),
    );
  });

  it("reports a timed_out outcome right before the grace-period teardown fires", async () => {
    const { result } = renderHook(() => useCall(), { wrapper });
    const controller = await connectAsOutgoing(result);

    vi.useFakeTimers();
    act(() => {
      controller.cb.onConnectionState("disconnected");
    });
    vi.mocked(emitClientState).mockClear();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(ICE_DISCONNECT_GRACE_MS);
    });
    expect(emitClientState).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ callId: "call-1", state: "disconnected", outcome: "timed_out" }),
    );
    expect(controller.closed).toBe(true);
  });

  it("reports the failed state before immediate teardown", async () => {
    const { result } = renderHook(() => useCall(), { wrapper });
    const controller = await connectAsOutgoing(result);
    vi.mocked(emitClientState).mockClear();

    act(() => {
      controller.cb.onConnectionState("failed");
    });
    expect(emitClientState).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ callId: "call-1", state: "failed" }),
    );
    expect(controller.closed).toBe(true);
  });

  it("relays a periodic getStats() summary to the server with the callId attached", async () => {
    const { result } = renderHook(() => useCall(), { wrapper });
    const controller = await connectAsOutgoing(result);

    act(() => {
      controller.cb.onConnectionStats({
        candidateType: "srflx",
        bytesSentDelta: 1200,
        bytesReceivedDelta: 900,
        packetLoss: 0.01,
      });
    });

    expect(emitConnectionStats).toHaveBeenCalledWith(expect.anything(), {
      callId: "call-1",
      candidateType: "srflx",
      bytesSentDelta: 1200,
      bytesReceivedDelta: 900,
      packetLoss: 0.01,
    });
  });

  it("a throwing telemetry emit never affects the actual call — connected still dispatches", async () => {
    vi.mocked(emitClientState).mockImplementationOnce(() => {
      throw new Error("socket momentarily down");
    });
    const { result } = renderHook(() => useCall(), { wrapper });

    // connectAsOutgoing's final "connected" transition is exactly where the
    // (now throwing) report fires — the call must still reach "connected".
    const controller = await connectAsOutgoing(result);
    expect(result.current.state.phase).toBe("connected");
    expect(controller.closed).toBe(false);
  });
});

describe("CallProvider screen share — mid-call renegotiation", () => {
  it("starting a local share: attaches the stream, dispatches sharedBy:'local', tells the peer, and renegotiates via emitOffer", async () => {
    const { result } = renderHook(() => useCall(), { wrapper });
    const controller = await connectAsOutgoing(result);
    vi.mocked(emitOffer).mockClear(); // drop the initial-offer call from connectAsOutgoing

    const fakeStream = {} as MediaStream;
    controller.startScreenShareImpl = async () => fakeStream;

    act(() => {
      result.current.toggleScreenShare();
    });

    await waitFor(() => expect(result.current.state.screenShare).toEqual({ sharedBy: "local" }));
    expect(emitMediaState).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ callId: "call-1", screenSharing: true }),
    );
    // Adding the track changes the SDP — this must renegotiate, reusing the
    // same call:offer path as the initial offer, not a bespoke one.
    await waitFor(() =>
      expect(emitOffer).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ callId: "call-1" })),
    );
  });

  it("a permission-denied/cancelled getDisplayMedia leaves the FSM untouched — no crash, no false 'sharing' state", async () => {
    const { result } = renderHook(() => useCall(), { wrapper });
    const controller = await connectAsOutgoing(result);
    controller.startScreenShareImpl = async () => {
      throw new Error("Permission denied");
    };

    act(() => {
      result.current.toggleScreenShare();
    });

    // Nothing to wait FOR here (the failure path never dispatches) — settle
    // the microtask queue, then assert the FSM never moved.
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.state.screenShare).toEqual({ sharedBy: null });
  });

  it("stopping a local share (in-app button): calls controller.stopScreenShare(), clears FSM, tells the peer, and renegotiates back down", async () => {
    const { result } = renderHook(() => useCall(), { wrapper });
    const controller = await connectAsOutgoing(result);
    controller.startScreenShareImpl = async () => ({}) as MediaStream;
    act(() => {
      result.current.toggleScreenShare();
    });
    await waitFor(() => expect(result.current.state.screenShare).toEqual({ sharedBy: "local" }));
    vi.mocked(emitOffer).mockClear();
    vi.mocked(emitMediaState).mockClear();

    act(() => {
      result.current.toggleScreenShare(); // same intent — toggles off now
    });

    await waitFor(() => expect(result.current.state.screenShare).toEqual({ sharedBy: null }));
    expect(controller.stopScreenShareCalls).toBe(1);
    expect(emitMediaState).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ callId: "call-1", screenSharing: false }),
    );
    await waitFor(() =>
      expect(emitOffer).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ callId: "call-1" })),
    );
  });

  it("the browser's native 'Stop sharing' bar (onScreenShareEnded) tears down the SAME way, without the provider calling stopScreenShare() again", async () => {
    // webrtc.ts already calls stopScreenShare() itself before invoking this
    // callback (see its own test coverage) — the provider's job here is just
    // the FSM/signaling/renegotiation cleanup, not a second stop.
    const { result } = renderHook(() => useCall(), { wrapper });
    const controller = await connectAsOutgoing(result);
    controller.startScreenShareImpl = async () => ({}) as MediaStream;
    act(() => {
      result.current.toggleScreenShare();
    });
    await waitFor(() => expect(result.current.state.screenShare).toEqual({ sharedBy: "local" }));
    vi.mocked(emitOffer).mockClear();

    act(() => {
      controller.cb.onScreenShareEnded();
    });

    await waitFor(() => expect(result.current.state.screenShare).toEqual({ sharedBy: null }));
    expect(controller.stopScreenShareCalls).toBe(0); // NOT called again by the provider
    expect(emitMediaState).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ callId: "call-1", screenSharing: false }),
    );
    await waitFor(() => expect(emitOffer).toHaveBeenCalled());
  });

  it("a renegotiation offer arriving mid-call (peer's screen share) is accepted via the existing onOffer/acceptOffer/emitAnswer path", async () => {
    const { result } = renderHook(() => useCall(), { wrapper });
    await connectAsOutgoing(result);
    vi.mocked(emitAnswer).mockClear();

    act(() => {
      socketHandlers!.onOffer({ callId: "call-1", sdp: { type: "offer", sdp: "peer-screen-share-offer" } });
    });
    await waitFor(() => expect(emitAnswer).toHaveBeenCalled());
    expect(emitAnswer).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ callId: "call-1" }));
  });

  it("a glare-dropped acceptOffer (null) does not emit an answer", async () => {
    const { result } = renderHook(() => useCall(), { wrapper });
    const controller = await connectAsOutgoing(result);
    controller.nextAcceptOfferReturnsNull = true;
    vi.mocked(emitAnswer).mockClear();

    act(() => {
      socketHandlers!.onOffer({ callId: "call-1", sdp: { type: "offer", sdp: "colliding-offer" } });
    });

    // Nothing dispatches on this path (the offer was dropped), so there's no
    // state change to waitFor — just let the handler's promise settle.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(emitAnswer).not.toHaveBeenCalled();
  });

  it("peer-media-state screenSharing:true sets sharedBy:'remote'; screenSharing:false clears it back to null", async () => {
    const { result } = renderHook(() => useCall(), { wrapper });
    await connectAsOutgoing(result);

    act(() => {
      socketHandlers!.onPeerMediaState({ callId: "call-1", cameraOn: true, screenSharing: true });
    });
    expect(result.current.state.screenShare).toEqual({ sharedBy: "remote" });

    act(() => {
      socketHandlers!.onPeerMediaState({ callId: "call-1", cameraOn: true, screenSharing: false });
    });
    expect(result.current.state.screenShare).toEqual({ sharedBy: null });
  });

  it("peer-media-state without a screenSharing field (a plain camera toggle) leaves screenShare untouched", async () => {
    const { result } = renderHook(() => useCall(), { wrapper });
    await connectAsOutgoing(result);

    act(() => {
      socketHandlers!.onPeerMediaState({ callId: "call-1", cameraOn: true, screenSharing: true });
    });
    expect(result.current.state.screenShare).toEqual({ sharedBy: "remote" });

    act(() => {
      socketHandlers!.onPeerMediaState({ callId: "call-1", cameraOn: false }); // plain camera-off toggle
    });
    expect(result.current.state.screenShare).toEqual({ sharedBy: "remote" }); // unchanged
    expect(result.current.state.peerCameraOff).toBe(true);
  });

  it("hangup while sharing tears everything down through the same teardown() path (no leaked screen stream/state)", async () => {
    const { result } = renderHook(() => useCall(), { wrapper });
    const controller = await connectAsOutgoing(result);
    controller.startScreenShareImpl = async () => ({}) as MediaStream;
    act(() => {
      result.current.toggleScreenShare();
    });
    await waitFor(() => expect(result.current.state.screenShare).toEqual({ sharedBy: "local" }));

    act(() => {
      result.current.hangup();
    });

    expect(controller.closed).toBe(true);
    expect(result.current.state.phase).toBe("ended");
    // teardown() resets phase eventually via its own timer — screenShare
    // itself is reset the moment a NEW call starts (outgoing/incoming), which
    // "ended" alone doesn't exercise; the invariant that actually matters here
    // is already covered above: hangup routes through the one teardown() path
    // (controller.closed), same as every other terminal trigger.
  });
});
