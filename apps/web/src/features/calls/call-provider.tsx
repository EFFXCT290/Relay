"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useReducer,
  useRef,
  type ReactNode,
} from "react";
import type { CallType } from "@relay/contracts";
import { getSocket } from "@/frontend-core/socket";
import {
  callReducer,
  initialCallState,
  type CallPeer,
  type CallState,
} from "./call-store";
import { WebRtcController } from "./webrtc";
import {
  bindCallSocket,
  emitAccept,
  emitAnswer,
  emitEnd,
  emitIce,
  emitInit,
  emitOffer,
  emitReject,
} from "./call-socket";
import { CallUI } from "./call-ui";

// ─────────────────────────────────────────────────────────────────────────────
// CallProvider — the one place that wires the FSM (call-store), the peer
// connection (webrtc), and signaling (call-socket) together. Mounted ONCE in the
// app shell so a single set of socket listeners exists app-wide (no duplicates)
// and incoming calls surface on any page.
//
// Every terminal trigger — hangup, reject, server timeout/ended/failed, ICE
// failure, unmount — funnels through teardown(), the client-side mirror of the
// server's terminate(). It is the only path that closes the peer connection.
// ─────────────────────────────────────────────────────────────────────────────

type CallContextValue = {
  state:        CallState;
  startCall:    (peer: CallPeer, type: CallType, conversationId?: string) => void;
  accept:       () => void;
  reject:       () => void;
  hangup:       () => void;
  toggleMute:   () => void;
  toggleCamera: () => void;
  switchCamera: () => void;
};

const CallContext = createContext<CallContextValue | null>(null);

// Streams are UI-only once attached: the element holds a reference, the sender
// owns the network tracks. Set srcObject once per lifecycle change (the === guard
// stops per-track ontrack firings from thrashing it) and drive .play() so iOS
// Safari doesn't freeze the video until a tap.
function attachStream(el: HTMLMediaElement | null, stream: MediaStream): void {
  if (!el || el.srcObject === stream) return;
  el.srcObject = stream;
  void el.play?.().catch(() => {});
}

export function useCall(): CallContextValue {
  const ctx = useContext(CallContext);
  if (!ctx) throw new Error("useCall must be used within <CallProvider>");
  return ctx;
}

export function CallProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(callReducer, initialCallState);

  // Refs read inside async socket / WebRTC callbacks, where `state` would be stale.
  const stateRef    = useRef(state);
  stateRef.current  = state;
  const webrtcRef   = useRef<WebRtcController | null>(null);
  const callIdRef   = useRef<string | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
  const localVideoRef  = useRef<HTMLVideoElement | null>(null);
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null);
  // The streams are captured here too, so we can re-attach them once the matching
  // media elements actually mount (they don't exist while phase === "idle").
  const localStreamRef  = useRef<MediaStream | null>(null);
  const remoteStreamRef = useRef<MediaStream | null>(null);
  const resetTimer  = useRef<ReturnType<typeof setTimeout> | null>(null);

  // The single client cleanup routine. Idempotent: close() guards itself, and a
  // "terminated" dispatch from idle is a no-op. Shows the terminal phase briefly,
  // then resets — unless a new call has already started.
  const teardown = useCallback((phase: "ended" | "failed") => {
    webrtcRef.current?.close();
    webrtcRef.current = null;
    callIdRef.current = null;
    localStreamRef.current = null;
    remoteStreamRef.current = null;
    if (remoteAudioRef.current) remoteAudioRef.current.srcObject = null;
    if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;
    if (localVideoRef.current) localVideoRef.current.srcObject = null;
    dispatch({ t: "terminated", phase });
    if (resetTimer.current) clearTimeout(resetTimer.current);
    resetTimer.current = setTimeout(() => {
      if (callIdRef.current === null) dispatch({ t: "reset" });
    }, 1400);
  }, []);

  // Builds a controller whose callbacks emit signaling for the *current* call.
  const makeController = useCallback((): WebRtcController => {
    const controller = new WebRtcController({
      onIceCandidate: (candidate) => {
        const callId = callIdRef.current;
        if (callId) emitIce(getSocket(), { callId, candidate });
      },
      onLocalStream: (stream) => {
        localStreamRef.current = stream;
        attachStream(localVideoRef.current, stream);
      },
      onRemoteStream: (stream) => {
        // CallUI mounts exactly one remote element (video for VIDEO, audio for
        // AUDIO), so only one ref is non-null — no double audio.
        remoteStreamRef.current = stream;
        attachStream(remoteVideoRef.current, stream);
        attachStream(remoteAudioRef.current, stream);
      },
      onConnectionState: (s) => {
        if (s === "connected") dispatch({ t: "connected" });
        else if (s === "failed") teardown("failed");
      },
    });
    webrtcRef.current = controller;
    return controller;
  }, [teardown]);

  // ── Intents ────────────────────────────────────────────────────────────────

  const startCall = useCallback(
    (peer: CallPeer, type: CallType, conversationId?: string) => {
      if (stateRef.current.phase !== "idle") return;
      const socket = getSocket();
      const controller = makeController();
      void (async () => {
        try {
          await controller.startLocalMedia({ video: type === "VIDEO" });
        } catch {
          controller.close();
          webrtcRef.current = null;
          return; // mic/camera permission denied — abort silently
        }
        const ack = await emitInit(socket, { targetUserId: peer.id, type, conversationId });
        if (!ack.ok || webrtcRef.current !== controller) {
          controller.close();
          if (webrtcRef.current === controller) webrtcRef.current = null;
          return;
        }
        callIdRef.current = ack.callId;
        dispatch({ t: "outgoing", callId: ack.callId, peer, callType: type, conversationId });
      })();
    },
    [makeController],
  );

  const accept = useCallback(() => {
    const s = stateRef.current;
    if (s.phase !== "incoming" || !s.callId) return;
    const callId = s.callId;
    const socket = getSocket();
    const controller = makeController();
    void (async () => {
      try {
        await controller.startLocalMedia({ video: stateRef.current.type === "VIDEO" });
      } catch {
        controller.close();
        webrtcRef.current = null;
        emitReject(socket, { callId });
        teardown("ended");
        return;
      }
      callIdRef.current = callId;
      emitAccept(socket, { callId });
      dispatch({ t: "connecting" });
    })();
  }, [makeController, teardown]);

  const reject = useCallback(() => {
    const callId = stateRef.current.callId;
    if (callId) emitReject(getSocket(), { callId });
    teardown("ended");
  }, [teardown]);

  const hangup = useCallback(() => {
    const callId = stateRef.current.callId;
    if (callId) emitEnd(getSocket(), { callId });
    teardown("ended");
  }, [teardown]);

  const toggleMute = useCallback(() => {
    const next = !stateRef.current.isMuted;
    webrtcRef.current?.setMuted(next);
    dispatch({ t: "muted", value: next });
  }, []);

  const toggleCamera = useCallback(() => {
    const next = !stateRef.current.isCameraOff;
    webrtcRef.current?.setCameraEnabled(!next);
    dispatch({ t: "cameraOff", value: next });
  }, []);

  const switchCamera = useCallback(() => {
    void webrtcRef.current?.switchCamera();
  }, []);

  // ── Signaling listeners — bound once for the provider's lifetime ────────────
  useEffect(() => {
    const socket = getSocket();
    const cleanup = bindCallSocket(socket, {
      onRinging: ({ callId, caller, type, conversationId }) => {
        // Already in a call → auto-reject so we never ring two calls at once.
        if (stateRef.current.phase !== "idle") {
          emitReject(socket, { callId });
          return;
        }
        callIdRef.current = callId;
        dispatch({ t: "incoming", callId, peer: caller, callType: type, conversationId });
      },
      onAccepted: ({ callId }) => {
        const controller = webrtcRef.current;
        if (!controller) return;
        dispatch({ t: "connecting" });
        void (async () => {
          const offer = await controller.createOffer();
          emitOffer(socket, { callId, sdp: offer });
        })();
      },
      onOffer: ({ callId, sdp }) => {
        const controller = webrtcRef.current;
        if (!controller) return;
        void (async () => {
          const answer = await controller.acceptOffer(sdp);
          emitAnswer(socket, { callId, sdp: answer });
        })();
      },
      onAnswer: ({ sdp }) => {
        void webrtcRef.current?.acceptAnswer(sdp);
      },
      onIce: ({ candidate }) => {
        void webrtcRef.current?.addIce(candidate);
      },
      onTimeout: () => teardown("ended"),
      onEnded:   () => teardown("ended"),
      onFailed:  () => teardown("failed"),
    });
    return cleanup;
  }, [teardown]);

  // Re-attach streams after a phase change mounts the media elements. The local
  // stream is acquired while phase is still "idle" (before its <video> exists),
  // so the onLocalStream attach is a no-op then; this runs once the element is in
  // the DOM. attachStream's identity guard makes the repeat harmless.
  useEffect(() => {
    if (localStreamRef.current) attachStream(localVideoRef.current, localStreamRef.current);
    if (remoteStreamRef.current) {
      attachStream(remoteVideoRef.current, remoteStreamRef.current);
      attachStream(remoteAudioRef.current, remoteStreamRef.current);
    }
  }, [state.phase]);

  // Release the mic if the provider ever unmounts.
  useEffect(() => () => { webrtcRef.current?.close(); }, []);

  return (
    <CallContext.Provider value={{ state, startCall, accept, reject, hangup, toggleMute, toggleCamera, switchCamera }}>
      {children}
      <CallUI
        state={state}
        remoteAudioRef={remoteAudioRef}
        localVideoRef={localVideoRef}
        remoteVideoRef={remoteVideoRef}
        onAccept={accept}
        onReject={reject}
        onHangup={hangup}
        onToggleMute={toggleMute}
        onToggleCamera={toggleCamera}
        onSwitchCamera={switchCamera}
      />
    </CallContext.Provider>
  );
}
