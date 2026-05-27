import type { CallType } from "@relay/contracts";

// ─────────────────────────────────────────────────────────────────────────────
// The explicit, finite call state machine. Illegal transitions are no-ops, so a
// late/duplicate event can never push the UI into a nonsensical state. The
// provider drives transitions imperatively; this keeps them total and testable.
//
//   caller:   idle → outgoing → connecting → connected → ended | failed → idle
//   receiver: idle → incoming → connecting → connected → ended | failed → idle
// ─────────────────────────────────────────────────────────────────────────────

export type CallPhase =
  | "idle"
  | "incoming"
  | "outgoing"
  | "connecting"
  | "connected"
  | "ended"
  | "failed";

export type CallDirection = "incoming" | "outgoing";
export type CallPeer = { id: string; username: string };

export type CallState = {
  phase:           CallPhase;
  callId:          string | null;
  direction:       CallDirection | null;
  peer:            CallPeer | null;
  type:            CallType;
  isMuted:         boolean;
  conversationId?: string;
};

export const initialCallState: CallState = {
  phase:     "idle",
  callId:    null,
  direction: null,
  peer:      null,
  type:      "AUDIO",
  isMuted:   false,
};

export type CallAction =
  | { t: "outgoing"; callId: string; peer: CallPeer; callType: CallType; conversationId?: string }
  | { t: "incoming"; callId: string; peer: CallPeer; callType: CallType; conversationId?: string }
  | { t: "connecting" }
  | { t: "connected" }
  | { t: "terminated"; phase: "ended" | "failed" }
  | { t: "muted"; value: boolean }
  | { t: "reset" };

const isLive = (p: CallPhase) => p !== "idle" && p !== "ended" && p !== "failed";

export function callReducer(state: CallState, action: CallAction): CallState {
  switch (action.t) {
    case "outgoing":
      if (state.phase !== "idle") return state;
      return {
        phase: "outgoing",
        callId: action.callId,
        direction: "outgoing",
        peer: action.peer,
        type: action.callType,
        isMuted: false,
        conversationId: action.conversationId,
      };

    case "incoming":
      if (state.phase !== "idle") return state;
      return {
        phase: "incoming",
        callId: action.callId,
        direction: "incoming",
        peer: action.peer,
        type: action.callType,
        isMuted: false,
        conversationId: action.conversationId,
      };

    case "connecting":
      if (state.phase !== "outgoing" && state.phase !== "incoming") return state;
      return { ...state, phase: "connecting" };

    case "connected":
      if (!isLive(state.phase)) return state;
      return { ...state, phase: "connected" };

    case "terminated":
      // Only meaningful while a call exists; from idle it's a no-op.
      if (state.phase === "idle") return state;
      return { ...state, phase: action.phase };

    case "muted":
      return { ...state, isMuted: action.value };

    case "reset":
      return initialCallState;

    default:
      return state;
  }
}
