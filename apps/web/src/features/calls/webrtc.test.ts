import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { WebRtcController, type WebRtcCallbacks, CONNECTION_STATS_INTERVAL_MS, summarizeStats } from "./webrtc";
import type { RTCIceCandidateInitLike } from "@relay/contracts";

// jsdom has no WebRTC implementation at all (no RTCPeerConnection, no
// MediaStream) — this is the CI-safe substitute the coverage plan calls for:
// a hand-rolled fake peer connection + media stream/track, driven the same
// way the real browser objects would be, so the controller's own buffering/
// teardown logic is what's under test, not a real network/media stack.

class FakeTrack {
  enabled = true;
  stopped = false;
  constructor(public kind: "audio" | "video") {}
  stop() {
    this.stopped = true;
  }
}

class FakeMediaStream {
  private tracks: FakeTrack[];
  constructor(tracks: FakeTrack[] = []) {
    this.tracks = tracks;
  }
  getTracks() {
    return this.tracks;
  }
  getAudioTracks() {
    return this.tracks.filter((t) => t.kind === "audio");
  }
  getVideoTracks() {
    return this.tracks.filter((t) => t.kind === "video");
  }
  addTrack(t: FakeTrack) {
    this.tracks.push(t);
  }
  removeTrack(t: FakeTrack) {
    this.tracks = this.tracks.filter((x) => x !== t);
  }
}

class FakeSender {
  track: FakeTrack | null;
  replaceTrackCalls: FakeTrack[] = [];
  constructor(track: FakeTrack) {
    this.track = track;
  }
  async replaceTrack(t: FakeTrack) {
    this.replaceTrackCalls.push(t);
    this.track = t;
  }
}

class FakePeerConnection {
  onicecandidate: ((e: { candidate: { toJSON(): RTCIceCandidateInitLike } | null }) => void) | null = null;
  ontrack: ((e: { streams: FakeMediaStream[]; track: FakeTrack }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  connectionState = "new";
  closed = false;
  senders: FakeSender[] = [];
  addIceCandidateCalls: unknown[] = [];
  localDescription: unknown = null;
  remoteDescription: unknown = null;

  constructor(public config: { iceServers: RTCIceServer[] }) {}

  addTrack(track: FakeTrack, _stream: FakeMediaStream) {
    const sender = new FakeSender(track);
    this.senders.push(sender);
    return sender;
  }
  getSenders() {
    return this.senders;
  }
  async createOffer() {
    return { type: "offer" as const, sdp: "fake-offer-sdp" };
  }
  async createAnswer() {
    return { type: "answer" as const, sdp: "fake-answer-sdp" };
  }
  async setLocalDescription(desc: unknown) {
    this.localDescription = desc;
  }
  async setRemoteDescription(desc: unknown) {
    this.remoteDescription = desc;
  }
  async addIceCandidate(candidate: unknown) {
    this.addIceCandidateCalls.push(candidate);
  }
  close() {
    this.closed = true;
  }
  // A real Map satisfies RTCStatsReport for these tests — its .forEach(value,
  // key, map) signature already matches, no fake needed. Tests set this
  // directly before advancing the stats timer.
  statsReport: RTCStatsReport = new Map() as unknown as RTCStatsReport;
  async getStats(): Promise<RTCStatsReport> {
    return this.statsReport;
  }
}

function makeCallbacks(): WebRtcCallbacks {
  return {
    onIceCandidate: vi.fn(),
    onLocalStream: vi.fn(),
    onRemoteStream: vi.fn(),
    onConnectionState: vi.fn(),
    onFacingChange: vi.fn(),
    onConnectionStats: vi.fn(),
  };
}

let lastPc: FakePeerConnection | null = null;
let getUserMediaMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  lastPc = null;
  class TrackedFakePeerConnection extends FakePeerConnection {
    constructor(config: { iceServers: RTCIceServer[] }) {
      super(config);
      lastPc = this;
    }
  }
  vi.stubGlobal("RTCPeerConnection", TrackedFakePeerConnection);
  vi.stubGlobal("MediaStream", FakeMediaStream);

  getUserMediaMock = vi.fn(async () => new FakeMediaStream([new FakeTrack("audio"), new FakeTrack("video")]));
  Object.defineProperty(globalThis.navigator, "mediaDevices", {
    value: { getUserMedia: getUserMediaMock },
    configurable: true,
  });
});

describe("WebRtcController — ICE candidate buffering before the remote description is set", () => {
  it("candidates added before the remote description is set are queued, not dropped or sent immediately", async () => {
    const controller = new WebRtcController(makeCallbacks());
    await controller.createOffer(); // creates the pc (offerer role); no remote description yet

    const candidateA: RTCIceCandidateInitLike = { candidate: "candidate-a", sdpMid: "0", sdpMLineIndex: 0 };
    const candidateB: RTCIceCandidateInitLike = { candidate: "candidate-b", sdpMid: "0", sdpMLineIndex: 0 };
    await controller.addIce(candidateA);
    await controller.addIce(candidateB);

    expect(lastPc!.addIceCandidateCalls).toEqual([]); // not sent to the pc yet — still queued

    // Remote description arrives (the offerer receives the answer) — this is
    // what flushes the queue.
    await controller.acceptAnswer({ type: "answer", sdp: "fake-answer-sdp" });

    expect(lastPc!.addIceCandidateCalls).toEqual([candidateA, candidateB]);
  });

  it("candidates added AFTER the remote description is set go straight through, not queued", async () => {
    const controller = new WebRtcController(makeCallbacks());
    await controller.createOffer();
    await controller.acceptAnswer({ type: "answer", sdp: "fake-answer-sdp" });

    const candidate: RTCIceCandidateInitLike = { candidate: "late-candidate", sdpMid: "0", sdpMLineIndex: 0 };
    await controller.addIce(candidate);

    expect(lastPc!.addIceCandidateCalls).toEqual([candidate]);
  });

  it("a late/duplicate candidate that the pc rejects is swallowed, not thrown", async () => {
    const controller = new WebRtcController(makeCallbacks());
    await controller.createOffer();
    await controller.acceptAnswer({ type: "answer", sdp: "fake-answer-sdp" });
    lastPc!.addIceCandidate = vi.fn(async () => {
      throw new Error("simulated: late/duplicate candidate rejected by the browser");
    });

    await expect(controller.addIce({ candidate: "x" })).resolves.toBeUndefined();
  });
});

describe("WebRtcController — close() is idempotent", () => {
  it("calling close() a second time does not throw and does not double-release anything", async () => {
    const controller = new WebRtcController(makeCallbacks());
    await controller.startLocalMedia({ video: true });
    await controller.createOffer();

    const pcCloseSpy = vi.spyOn(lastPc!, "close");

    expect(() => controller.close()).not.toThrow();
    expect(pcCloseSpy).toHaveBeenCalledTimes(1);

    expect(() => controller.close()).not.toThrow();
    // The second call must be a true no-op: the (already-closed, already
    // nulled-out) pc must not be touched again.
    expect(pcCloseSpy).toHaveBeenCalledTimes(1);
  });
});

describe("WebRtcController — guaranteed mic/camera release on teardown", () => {
  it("close() actually stops every local track acquired via getUserMedia, not just closing the pc", async () => {
    const controller = new WebRtcController(makeCallbacks());
    await controller.startLocalMedia({ video: true });

    const stream = getUserMediaMock.mock.results[0]!.value as Promise<FakeMediaStream>;
    const tracks = (await stream).getTracks() as FakeTrack[];
    expect(tracks.length).toBe(2); // audio + video
    expect(tracks.every((t) => !t.stopped)).toBe(true);

    controller.close();

    expect(tracks.every((t) => t.stopped)).toBe(true);
  });

  it("close() also stops remote tracks received via ontrack", async () => {
    const controller = new WebRtcController(makeCallbacks());
    await controller.createOffer(); // creates the pc + this.remoteStream

    const remoteTrack = new FakeTrack("audio");
    lastPc!.ontrack!({ streams: [], track: remoteTrack });
    expect(remoteTrack.stopped).toBe(false);

    controller.close();
    expect(remoteTrack.stopped).toBe(true);
  });

  it("a permission-denied getUserMedia rejection leaves nothing to release — close() afterward still doesn't throw", async () => {
    getUserMediaMock.mockRejectedValueOnce(new Error("Permission denied"));
    const controller = new WebRtcController(makeCallbacks());

    await expect(controller.startLocalMedia({ video: true })).rejects.toThrow("Permission denied");
    expect(() => controller.close()).not.toThrow();
  });
});

// Builds a fake RTCStatsReport (a real Map satisfies it — see FakePeerConnection
// above) from plain stat objects, keyed by their own `id` field like the real API.
function makeStatsReport(stats: Array<Record<string, unknown>>): RTCStatsReport {
  const map = new Map<string, Record<string, unknown>>();
  for (const s of stats) map.set(s.id as string, s);
  return map as unknown as RTCStatsReport;
}

describe("summarizeStats — pure RTCStatsReport parsing (Part 3)", () => {
  it("returns null when there is no succeeded candidate-pair yet", () => {
    const report = makeStatsReport([{ id: "cp1", type: "candidate-pair", state: "waiting" }]);
    expect(summarizeStats(report, 0, 0)).toBeNull();
  });

  it("picks the succeeded/nominated pair, resolves candidateType via its local-candidate, and diffs bytes against the previous report", () => {
    const report = makeStatsReport([
      { id: "cp1", type: "candidate-pair", state: "succeeded", nominated: true, localCandidateId: "local1", bytesSent: 5_000, bytesReceived: 3_000 },
      { id: "local1", type: "local-candidate", candidateType: "srflx" },
      { id: "rtp1", type: "inbound-rtp", isRemote: false, packetsLost: 2, packetsReceived: 998 },
    ]);

    const summary = summarizeStats(report, 4_000, 2_500);
    expect(summary).toEqual({
      candidateType: "srflx",
      bytesSentDelta: 1_000,
      bytesReceivedDelta: 500,
      packetLoss: 2 / 1000,
      totalBytesSent: 5_000,
      totalBytesReceived: 3_000,
    });
  });

  it("sums packetsLost/packetsReceived across multiple m-lines (audio + video)", () => {
    const report = makeStatsReport([
      { id: "cp1", type: "candidate-pair", state: "succeeded", localCandidateId: "local1", bytesSent: 100, bytesReceived: 100 },
      { id: "local1", type: "local-candidate", candidateType: "host" },
      { id: "audio-rtp", type: "inbound-rtp", isRemote: false, packetsLost: 1, packetsReceived: 199 },
      { id: "video-rtp", type: "inbound-rtp", isRemote: false, packetsLost: 9, packetsReceived: 791 },
    ]);

    expect(summarizeStats(report, 0, 0)?.packetLoss).toBeCloseTo(10 / 1000);
  });

  it("omits packetLoss when there is no inbound-rtp data at all", () => {
    const report = makeStatsReport([
      { id: "cp1", type: "candidate-pair", state: "succeeded", localCandidateId: "local1", bytesSent: 100, bytesReceived: 0 },
      { id: "local1", type: "local-candidate", candidateType: "relay" },
    ]);
    expect(summarizeStats(report, 0, 0)?.packetLoss).toBeUndefined();
  });

  it("clamps to 0 instead of going negative when a candidate-pair switch resets the cumulative counters", () => {
    // The newly-selected pair's own bytesSent starts lower than the previous
    // pair's cumulative total — this must read as "no data yet", not -8000.
    const report = makeStatsReport([
      { id: "cp2", type: "candidate-pair", state: "succeeded", nominated: true, localCandidateId: "local2", bytesSent: 200, bytesReceived: 100 },
      { id: "local2", type: "local-candidate", candidateType: "relay" },
    ]);

    const summary = summarizeStats(report, 8_000, 4_000);
    expect(summary?.bytesSentDelta).toBe(0);
    expect(summary?.bytesReceivedDelta).toBe(0);
    expect(summary?.candidateType).toBe("relay");
  });

  it("defaults candidateType to \"unknown\" when the local-candidate entry can't be resolved", () => {
    const report = makeStatsReport([
      { id: "cp1", type: "candidate-pair", state: "succeeded", localCandidateId: "missing", bytesSent: 0, bytesReceived: 0 },
    ]);
    expect(summarizeStats(report, 0, 0)?.candidateType).toBe("unknown");
  });
});

describe("WebRtcController — periodic connection-stats reporting (Part 3)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("does not poll before the first \"connected\" state, and stops polling after close()", async () => {
    const callbacks = makeCallbacks();
    const controller = new WebRtcController(callbacks);
    await controller.createOffer();

    await vi.advanceTimersByTimeAsync(CONNECTION_STATS_INTERVAL_MS * 2);
    expect(callbacks.onConnectionStats).not.toHaveBeenCalled();

    lastPc!.statsReport = makeStatsReport([
      { id: "cp1", type: "candidate-pair", state: "succeeded", localCandidateId: "l1", bytesSent: 100, bytesReceived: 100 },
      { id: "l1", type: "local-candidate", candidateType: "host" },
    ]);
    lastPc!.connectionState = "connected";
    lastPc!.onconnectionstatechange!();

    await vi.advanceTimersByTimeAsync(CONNECTION_STATS_INTERVAL_MS);
    expect(callbacks.onConnectionStats).toHaveBeenCalledTimes(1);

    controller.close();
    await vi.advanceTimersByTimeAsync(CONNECTION_STATS_INTERVAL_MS * 3);
    expect(callbacks.onConnectionStats).toHaveBeenCalledTimes(1); // no further ticks after close()
  });

  it("reports a DELTA against the previous tick, not the cumulative total", async () => {
    const callbacks = makeCallbacks();
    const controller = new WebRtcController(callbacks);
    await controller.createOffer();
    lastPc!.connectionState = "connected";
    lastPc!.onconnectionstatechange!();

    lastPc!.statsReport = makeStatsReport([
      { id: "cp1", type: "candidate-pair", state: "succeeded", localCandidateId: "l1", bytesSent: 1_000, bytesReceived: 500 },
      { id: "l1", type: "local-candidate", candidateType: "host" },
    ]);
    await vi.advanceTimersByTimeAsync(CONNECTION_STATS_INTERVAL_MS);
    expect(callbacks.onConnectionStats).toHaveBeenNthCalledWith(1, expect.objectContaining({ bytesSentDelta: 1_000, bytesReceivedDelta: 500 }));

    lastPc!.statsReport = makeStatsReport([
      { id: "cp1", type: "candidate-pair", state: "succeeded", localCandidateId: "l1", bytesSent: 1_600, bytesReceived: 650 },
      { id: "l1", type: "local-candidate", candidateType: "host" },
    ]);
    await vi.advanceTimersByTimeAsync(CONNECTION_STATS_INTERVAL_MS);
    expect(callbacks.onConnectionStats).toHaveBeenNthCalledWith(2, expect.objectContaining({ bytesSentDelta: 600, bytesReceivedDelta: 150 }));
  });

  it("a getStats() rejection on one tick is swallowed — never affects the call, never crashes the timer", async () => {
    const callbacks = makeCallbacks();
    const controller = new WebRtcController(callbacks);
    await controller.createOffer();
    lastPc!.connectionState = "connected";
    lastPc!.onconnectionstatechange!();

    const realGetStats = lastPc!.getStats.bind(lastPc);
    lastPc!.getStats = vi.fn()
      .mockRejectedValueOnce(new Error("simulated getStats() failure"))
      .mockImplementation(realGetStats);
    await vi.advanceTimersByTimeAsync(CONNECTION_STATS_INTERVAL_MS);
    expect(callbacks.onConnectionStats).not.toHaveBeenCalled();

    lastPc!.statsReport = makeStatsReport([
      { id: "cp1", type: "candidate-pair", state: "succeeded", localCandidateId: "l1", bytesSent: 10, bytesReceived: 10 },
      { id: "l1", type: "local-candidate", candidateType: "host" },
    ]);
    await vi.advanceTimersByTimeAsync(CONNECTION_STATS_INTERVAL_MS);
    expect(callbacks.onConnectionStats).toHaveBeenCalledTimes(1); // recovered on the next tick
  });
});
