import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useVoiceRecorder } from "./use-voice-recorder";

// jsdom has no MediaRecorder/getUserMedia at all — hand-rolled fakes, same
// spirit as webrtc.test.ts's CI-safe substitute for real media flow.

class FakeTrack {
  stopped = false;
  stop() {
    this.stopped = true;
  }
}

class FakeMediaStream {
  constructor(private tracks: FakeTrack[]) {}
  getTracks() {
    return this.tracks;
  }
}

// The hook keeps its MediaRecorder instance in a ref, never exposed via its
// public API — self-registering into `instances` is the only way a test can
// reach "the recorder currently in flight" to simulate ondataavailable.
const instances: FakeMediaRecorder[] = [];

class FakeMediaRecorder {
  static isTypeSupported = vi.fn(() => true);
  state: "inactive" | "recording" = "inactive";
  mimeType: string;
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;

  constructor(
    public stream: FakeMediaStream,
    options?: { mimeType?: string },
  ) {
    this.mimeType = options?.mimeType ?? "";
    instances.push(this);
  }
  start() {
    this.state = "recording";
  }
  stop() {
    this.state = "inactive";
    this.onstop?.();
  }
}

function lastRecorder(): FakeMediaRecorder {
  const instance = instances.at(-1);
  if (!instance) throw new Error("no MediaRecorder was constructed — did start() run?");
  return instance;
}

let lastTracks: FakeTrack[];

beforeEach(() => {
  instances.length = 0;
  lastTracks = [new FakeTrack()];
  const stream = new FakeMediaStream(lastTracks);
  const getUserMediaMock = vi.fn(async () => stream);
  Object.defineProperty(globalThis.navigator, "mediaDevices", {
    value: { getUserMedia: getUserMediaMock },
    configurable: true,
  });
  vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
});

describe("useVoiceRecorder — finish(cancel) promise resolution", () => {
  it("stop() (cancel=false) resolves with the recorded blob and duration when audio was captured", async () => {
    const { result } = renderHook(() => useVoiceRecorder());

    await act(async () => {
      await result.current.start();
    });

    // Simulate the browser handing over a chunk of captured audio.
    act(() => lastRecorder().ondataavailable?.({ data: new Blob(["fake audio data"]) }));

    let outcome: { blob: Blob; durationMs: number } | null = null;
    await act(async () => {
      outcome = await result.current.stop();
    });

    expect(outcome).not.toBeNull();
    expect(outcome!.blob.size).toBeGreaterThan(0);
    expect(typeof outcome!.durationMs).toBe("number");
    expect(lastTracks.every((t) => t.stopped)).toBe(true); // mic released on stop too, not just unmount
  });

  it("cancel() (cancel=true) resolves null even though audio WAS captured — cancel discards regardless of content", async () => {
    const { result } = renderHook(() => useVoiceRecorder());

    await act(async () => {
      await result.current.start();
    });
    act(() => lastRecorder().ondataavailable?.({ data: new Blob(["fake audio data"]) }));

    let outcome: unknown = "not-yet-set";
    await act(async () => {
      outcome = await result.current.cancel();
    });

    expect(outcome).toBeNull();
    expect(lastTracks.every((t) => t.stopped)).toBe(true); // still releases the mic
  });

  it("stop() with NO audio captured resolves null (an empty recording is treated the same as no recording)", async () => {
    const { result } = renderHook(() => useVoiceRecorder());

    await act(async () => {
      await result.current.start();
    });
    // No ondataavailable call at all — zero bytes captured.

    let outcome: unknown = "not-yet-set";
    await act(async () => {
      outcome = await result.current.stop();
    });

    expect(outcome).toBeNull();
  });

  it("finish() when nothing is recording resolves null immediately, without throwing", async () => {
    const { result } = renderHook(() => useVoiceRecorder());
    // start() was never called — recorderRef.current is null.

    let outcome: unknown = "not-yet-set";
    await act(async () => {
      outcome = await result.current.stop();
    });
    expect(outcome).toBeNull();

    let cancelOutcome: unknown = "not-yet-set";
    await act(async () => {
      cancelOutcome = await result.current.cancel();
    });
    expect(cancelOutcome).toBeNull();
  });
});

describe("useVoiceRecorder — guaranteed mic release on unmount", () => {
  it("unmounting mid-recording actually stops every track on the stream, not just running some cleanup function", async () => {
    const { result, unmount } = renderHook(() => useVoiceRecorder());

    await act(async () => {
      await result.current.start();
    });

    expect(lastTracks.length).toBeGreaterThan(0);
    expect(lastTracks.every((t) => !t.stopped)).toBe(true); // sanity: still live while recording

    unmount();

    expect(lastTracks.every((t) => t.stopped)).toBe(true);
  });

  it("unmounting when nothing was ever recording does not throw", () => {
    const { unmount } = renderHook(() => useVoiceRecorder());
    expect(() => unmount()).not.toThrow();
  });
});
