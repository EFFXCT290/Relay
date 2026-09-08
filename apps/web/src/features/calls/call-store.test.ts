import { describe, it, expect } from "vitest";
import { callReducer, initialCallState, type CallState, type CallPhase, type CallAction } from "./call-store";

// callReducer is a pure, total FSM — every (phase, action) pair below is
// exercised explicitly, not spot-checked. Illegal transitions must return
// the EXACT SAME state reference (the source does `return state;`, not a
// copy) — asserting `toBe` rather than just a deep-equal catches a
// regression that silently swaps in an equivalent-looking new object.

const PEER = { id: "peer-1", username: "peer" };

function makeState(phase: CallPhase): CallState {
  const base = { ...initialCallState, callId: "call-1", peer: PEER, direction: "outgoing" as const, conversationId: "conv-1" };
  switch (phase) {
    case "idle":
      return initialCallState;
    case "outgoing":
      return callReducer(initialCallState, { t: "outgoing", callId: "call-1", peer: PEER, callType: "AUDIO", conversationId: "conv-1" });
    case "incoming":
      return callReducer(initialCallState, { t: "incoming", callId: "call-1", peer: PEER, callType: "AUDIO", conversationId: "conv-1" });
    case "connecting":
      return callReducer(makeState("outgoing"), { t: "connecting" });
    case "connected":
      return callReducer(makeState("connecting"), { t: "connected" });
    case "ended":
      return callReducer(makeState("connected"), { t: "terminated", phase: "ended" });
    case "failed":
      return callReducer(makeState("connected"), { t: "terminated", phase: "failed" });
    default:
      return { ...base, phase };
  }
}

const ALL_PHASES: CallPhase[] = ["idle", "incoming", "outgoing", "connecting", "connected", "ended", "failed"];

describe("callReducer — exhaustive phase × action transition table", () => {
  describe('"outgoing" action — legal ONLY from idle', () => {
    for (const phase of ALL_PHASES) {
      const legal = phase === "idle";
      it(`${phase} → ${legal ? "outgoing (starts a new call)" : "no-op (illegal)"}`, () => {
        const state = makeState(phase);
        const action: CallAction = { t: "outgoing", callId: "new-call", peer: PEER, callType: "VIDEO", conversationId: "conv-2" };
        const result = callReducer(state, action);
        if (legal) {
          expect(result).toEqual({
            phase: "outgoing",
            callId: "new-call",
            direction: "outgoing",
            peer: PEER,
            type: "VIDEO",
            isMuted: false,
            isCameraOff: false,
            selfFacing: "user",
            peerCameraOff: false,
            screenShare: { sharedBy: null },
            showBothCameras: false,
            conversationId: "conv-2",
          });
        } else {
          expect(result).toBe(state);
        }
      });
    }
  });

  describe('"incoming" action — legal ONLY from idle', () => {
    for (const phase of ALL_PHASES) {
      const legal = phase === "idle";
      it(`${phase} → ${legal ? "incoming (rings)" : "no-op (illegal)"}`, () => {
        const state = makeState(phase);
        const action: CallAction = { t: "incoming", callId: "new-call", peer: PEER, callType: "AUDIO", conversationId: "conv-2" };
        const result = callReducer(state, action);
        if (legal) {
          expect(result).toEqual({
            phase: "incoming",
            callId: "new-call",
            direction: "incoming",
            peer: PEER,
            type: "AUDIO",
            isMuted: false,
            isCameraOff: false,
            selfFacing: "user",
            peerCameraOff: false,
            screenShare: { sharedBy: null },
            showBothCameras: false,
            conversationId: "conv-2",
          });
        } else {
          expect(result).toBe(state);
        }
      });
    }
  });

  describe('"connecting" action — legal ONLY from outgoing or incoming', () => {
    for (const phase of ALL_PHASES) {
      const legal = phase === "outgoing" || phase === "incoming";
      it(`${phase} → ${legal ? "connecting" : "no-op (illegal)"}`, () => {
        const state = makeState(phase);
        const result = callReducer(state, { t: "connecting" });
        if (legal) {
          expect(result).toEqual({ ...state, phase: "connecting" });
          expect(result.callId).toBe(state.callId);
          expect(result.peer).toBe(state.peer);
        } else {
          expect(result).toBe(state);
        }
      });
    }
  });

  describe('"connected" action — legal from any LIVE phase (incoming, outgoing, connecting, connected); illegal from idle/ended/failed', () => {
    for (const phase of ALL_PHASES) {
      const legal = phase === "incoming" || phase === "outgoing" || phase === "connecting" || phase === "connected";
      it(`${phase} → ${legal ? "connected" : "no-op (illegal)"}`, () => {
        const state = makeState(phase);
        const result = callReducer(state, { t: "connected" });
        if (legal) {
          expect(result).toEqual({ ...state, phase: "connected" });
          expect(result.callId).toBe(state.callId);
        } else {
          expect(result).toBe(state);
        }
      });
    }
  });

  describe('"terminated" action — legal from any NON-idle phase', () => {
    for (const phase of ALL_PHASES) {
      const legal = phase !== "idle";
      it(`${phase} → ${legal ? "ended" : "no-op (illegal)"}`, () => {
        const state = makeState(phase);
        const result = callReducer(state, { t: "terminated", phase: "ended" });
        if (legal) {
          expect(result).toEqual({ ...state, phase: "ended" });
        } else {
          expect(result).toBe(state);
        }
      });
    }

    it("also honors phase:\"failed\" (not hardcoded to ended) from a live call", () => {
      const state = makeState("connected");
      const result = callReducer(state, { t: "terminated", phase: "failed" });
      expect(result).toEqual({ ...state, phase: "failed" });
    });

    it("terminated is allowed even from an already-terminal phase (ended → failed is a legal re-terminate)", () => {
      const state = makeState("ended");
      const result = callReducer(state, { t: "terminated", phase: "failed" });
      expect(result).toEqual({ ...state, phase: "failed" });
    });
  });
});

describe("callReducer — field-setter actions (not phase-gated; documents actual behavior)", () => {
  const PHASES_TO_CHECK: CallPhase[] = ["idle", "connected"];

  for (const phase of PHASES_TO_CHECK) {
    it(`"muted" sets isMuted regardless of phase (${phase})`, () => {
      const state = makeState(phase);
      expect(callReducer(state, { t: "muted", value: true })).toEqual({ ...state, isMuted: true });
      expect(callReducer(state, { t: "muted", value: false })).toEqual({ ...state, isMuted: false });
    });

    it(`"cameraOff" sets isCameraOff regardless of phase (${phase})`, () => {
      const state = makeState(phase);
      expect(callReducer(state, { t: "cameraOff", value: true })).toEqual({ ...state, isCameraOff: true });
    });

    it(`"facing" sets selfFacing regardless of phase (${phase})`, () => {
      const state = makeState(phase);
      expect(callReducer(state, { t: "facing", value: "environment" })).toEqual({ ...state, selfFacing: "environment" });
    });

    it(`"peerCameraOff" sets peerCameraOff regardless of phase (${phase})`, () => {
      const state = makeState(phase);
      expect(callReducer(state, { t: "peerCameraOff", value: true })).toEqual({ ...state, peerCameraOff: true });
    });

    it(`"screenShareState" sets screenShare.sharedBy regardless of phase (${phase})`, () => {
      const state = makeState(phase);
      expect(callReducer(state, { t: "screenShareState", sharedBy: "local" })).toEqual({
        ...state,
        screenShare: { sharedBy: "local" },
      });
      expect(callReducer(state, { t: "screenShareState", sharedBy: "remote" })).toEqual({
        ...state,
        screenShare: { sharedBy: "remote" },
      });
      // Clearing (e.g. the sharer stopped, or the peer's screenSharing:false
      // signal arrived) is just sharedBy: null, same setter.
      const sharing = callReducer(state, { t: "screenShareState", sharedBy: "local" });
      expect(callReducer(sharing, { t: "screenShareState", sharedBy: null })).toEqual({
        ...state,
        screenShare: { sharedBy: null },
      });
    });

    it(`"toggleBothCameras" flips showBothCameras and is independent of screenShare.sharedBy (${phase})`, () => {
      const state = makeState(phase);
      expect(state.showBothCameras).toBe(false);
      const toggled = callReducer(state, { t: "toggleBothCameras" });
      expect(toggled).toEqual({ ...state, showBothCameras: true });
      expect(callReducer(toggled, { t: "toggleBothCameras" })).toEqual({ ...state, showBothCameras: false });
    });
  }

  for (const phase of ALL_PHASES) {
    it(`"reset" always returns the exact shared initialCallState from ${phase}`, () => {
      const state = makeState(phase);
      const result = callReducer(state, { t: "reset" });
      expect(result).toBe(initialCallState);
    });
  }
});
