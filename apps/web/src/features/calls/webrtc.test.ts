import { describe, it, expect, vi, beforeEach } from "vitest";
import { WebRtcController, type WebRtcCallbacks } from "./webrtc";
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
}

function makeCallbacks(): WebRtcCallbacks {
  return {
    onIceCandidate: vi.fn(),
    onLocalStream: vi.fn(),
    onRemoteStream: vi.fn(),
    onConnectionState: vi.fn(),
    onFacingChange: vi.fn(),
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
