import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { createRef } from "react";
import { CallUI } from "./call-ui";
import { initialCallState, type CallState } from "./call-store";

// CallUI is purely presentational — all state/intents come from CallProvider
// (call-provider.test.tsx covers the wiring). These tests focus on the two
// things call-ui.tsx itself is responsible for getting right: the desktop-only
// share button, and picking the right element/ref per call-layout.ts's output
// (the actual layout MATRIX is exhaustively covered in call-layout.test.ts —
// this just checks CallUI reads that output correctly).

function makeConnectedVideoState(overrides: Partial<CallState> = {}): CallState {
  return {
    ...initialCallState,
    phase: "connected",
    callId: "call-1",
    direction: "outgoing",
    peer: { id: "peer-1", username: "peer" },
    type: "VIDEO",
    ...overrides,
  };
}

function renderCallUI(state: CallState) {
  return render(
    <CallUI
      state={state}
      selfUsername="me"
      remoteAudioRef={createRef()}
      localVideoRef={createRef()}
      remoteVideoRef={createRef()}
      remoteBgVideoRef={createRef()}
      localScreenVideoRef={createRef()}
      remoteScreenVideoRef={createRef()}
      onAccept={vi.fn()}
      onReject={vi.fn()}
      onHangup={vi.fn()}
      onToggleMute={vi.fn()}
      onToggleCamera={vi.fn()}
      onSwitchCamera={vi.fn()}
      onToggleScreenShare={vi.fn()}
      onToggleBothCameras={vi.fn()}
    />,
  );
}

describe("CallUI — screen-share button is hidden on mobile/tablet", () => {
  it("the 'Share screen' button carries the app's mobile-hidden convention (hidden by default, flex from lg: up)", () => {
    renderCallUI(makeConnectedVideoState());
    const button = screen.getByLabelText("Share screen");
    expect(button.className).toContain("hidden");
    expect(button.className).toContain("lg:flex");
  });

  it("stays hidden the same way once local screen share is active ('Stop sharing')", () => {
    renderCallUI(makeConnectedVideoState({ screenShare: { sharedBy: "local" } }));
    const button = screen.getByLabelText("Stop sharing");
    expect(button.className).toContain("hidden");
    expect(button.className).toContain("lg:flex");
  });

  it("every other connected-video control has no such mobile-hiding class (only screen share is gated)", () => {
    renderCallUI(makeConnectedVideoState());
    for (const label of ["Mute", "Turn camera off", "Flip camera", "End call"]) {
      expect(screen.getByLabelText(label).className).not.toContain("hidden");
    }
  });
});

describe("CallUI — screen-share rendering rule wiring", () => {
  it("nobody sharing: own camera renders in the corner PiP, no screen-share stage/column, no 'both cameras' button", () => {
    renderCallUI(makeConnectedVideoState());
    expect(screen.queryByLabelText("Show both cameras")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Share screen")).toBeInTheDocument();
  });

  it("local sharing, toggle off: corner PiP shows the OTHER participant, not own camera; 'both cameras' button appears", () => {
    renderCallUI(makeConnectedVideoState({ screenShare: { sharedBy: "local" } }));
    expect(screen.getByLabelText("Stop sharing")).toBeInTheDocument();
    expect(screen.getByLabelText("Show both cameras")).toBeInTheDocument();
  });

  it("local sharing, own camera off: corner PiP falls back to the PEER's avatar/camera, not an own-camera-off avatar", () => {
    // isCameraOff true (mine), peerCameraOff false (theirs) — if the corner PiP
    // were still sourcing from "own camera" it would fall back to an Avatar
    // for "me" (initial "M"); sharing mode must route the corner PiP to the
    // peer's camera instead, which is on, so it's a <video>, not an Avatar.
    // CallUI portals into document.body, not the render() container, hence
    // querying `document` here rather than the returned `container`.
    renderCallUI(makeConnectedVideoState({ screenShare: { sharedBy: "local" }, isCameraOff: true, peerCameraOff: false }));

    expect(screen.queryByText("M")).not.toBeInTheDocument(); // own-camera-off Avatar never rendered
    // Exactly two <video> elements: the local screen stage + the peer's
    // camera in the corner PiP — no third for a (skipped) own-camera slot.
    expect(document.querySelectorAll("video").length).toBe(2);
  });

  it("remote sharing, toggle on (both cameras): shows a 'Hide both cameras' toggle and no corner PiP video for either camera alone", () => {
    renderCallUI(makeConnectedVideoState({ screenShare: { sharedBy: "remote" }, showBothCameras: true }));
    expect(screen.getByLabelText("Hide both cameras")).toBeInTheDocument();
    expect(screen.getByLabelText("Share screen")).toBeInTheDocument(); // peer is sharing, not me — button still reads "Share screen"
  });

  it("clicking the share button and the both-cameras toggle call their respective handlers, not each other's", () => {
    const onToggleScreenShare = vi.fn();
    const onToggleBothCameras = vi.fn();
    render(
      <CallUI
        state={makeConnectedVideoState({ screenShare: { sharedBy: "local" } })}
        selfUsername="me"
        remoteAudioRef={createRef()}
        localVideoRef={createRef()}
        remoteVideoRef={createRef()}
        remoteBgVideoRef={createRef()}
        localScreenVideoRef={createRef()}
        remoteScreenVideoRef={createRef()}
        onAccept={vi.fn()}
        onReject={vi.fn()}
        onHangup={vi.fn()}
        onToggleMute={vi.fn()}
        onToggleCamera={vi.fn()}
        onSwitchCamera={vi.fn()}
        onToggleScreenShare={onToggleScreenShare}
        onToggleBothCameras={onToggleBothCameras}
      />,
    );
    screen.getByLabelText("Stop sharing").click();
    expect(onToggleScreenShare).toHaveBeenCalledTimes(1);
    expect(onToggleBothCameras).not.toHaveBeenCalled();

    screen.getByLabelText("Show both cameras").click();
    expect(onToggleBothCameras).toHaveBeenCalledTimes(1);
    expect(onToggleScreenShare).toHaveBeenCalledTimes(1);
  });
});
