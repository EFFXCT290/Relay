import { describe, it, expect } from "vitest";
import { computeCallLayout } from "./call-layout";

// Full sharedBy × showBothCameras matrix — 3 × 2 = 6 cases, all asserted
// explicitly rather than spot-checked, same rationale as call-store.test.ts's
// exhaustive phase table.

describe("computeCallLayout", () => {
  it("nobody sharing → camera-only, regardless of showBothCameras", () => {
    expect(computeCallLayout(null, false)).toEqual({ mode: "camera-only" });
    expect(computeCallLayout(null, true)).toEqual({ mode: "camera-only" });
  });

  it("local sharing, toggle off → local screen full-width, other camera as corner PiP", () => {
    expect(computeCallLayout("local", false)).toEqual({
      mode: "screen-share",
      screenSource: "local",
      cameraLayout: "corner-pip",
    });
  });

  it("local sharing, toggle on → local screen full-width, both cameras in a column", () => {
    expect(computeCallLayout("local", true)).toEqual({
      mode: "screen-share",
      screenSource: "local",
      cameraLayout: "both-column",
    });
  });

  it("remote sharing, toggle off → remote screen full-width, other (remote) camera as corner PiP", () => {
    expect(computeCallLayout("remote", false)).toEqual({
      mode: "screen-share",
      screenSource: "remote",
      cameraLayout: "corner-pip",
    });
  });

  it("remote sharing, toggle on → remote screen full-width, both cameras in a column", () => {
    expect(computeCallLayout("remote", true)).toEqual({
      mode: "screen-share",
      screenSource: "remote",
      cameraLayout: "both-column",
    });
  });

  it("corner-pip mode always implies the viewer's own camera is hidden (not part of cameraLayout's two other-camera states)", () => {
    // "corner-pip" only ever shows the OTHER participant — this is the encoding
    // of "own camera self-preview is hidden while any share is active" from the
    // spec: there is no "own camera visible, share active" layout at all.
    const local = computeCallLayout("local", false);
    const remote = computeCallLayout("remote", false);
    expect(local).toMatchObject({ cameraLayout: "corner-pip" });
    expect(remote).toMatchObject({ cameraLayout: "corner-pip" });
  });
});
