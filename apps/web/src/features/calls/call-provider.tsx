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
import type { CallType, IceServer, CallClientStateInbound, CallConnectionStatsInbound } from "@relay/contracts";
import { getSocket } from "@/frontend-core/socket";
import {
  callReducer,
  initialCallState,
  type CallPeer,
  type CallState,
} from "./call-store";
import { WebRtcController, type ConnectionStatsSummary } from "./webrtc";
import {
  bindCallSocket,
  emitAccept,
  emitAnswer,
  emitClientState,
  emitConnectionStats,
  emitEnd,
  emitIce,
  emitInit,
  emitMediaState,
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
  state:             CallState;
  startCall:         (peer: CallPeer, type: CallType, conversationId?: string) => void;
  accept:            () => void;
  reject:            () => void;
  hangup:            () => void;
  toggleMute:        () => void;
  toggleCamera:      () => void;
  switchCamera:      () => void;
  toggleScreenShare: () => void;
  toggleBothCameras: () => void;
};

const CallContext = createContext<CallContextValue | null>(null);

// Grace period given to a "disconnected" pc.connectionState (spec-transient —
// a NAT rebind or brief network hiccup) before it's treated as dead. Distinct
// from CALL_RING_TIMEOUT_MS (contracts): that one is pre-connect signaling
// shared with the server; this is purely local post-connect recovery, so it
// has no reason to live in the shared contract.
export const ICE_DISCONNECT_GRACE_MS = 8_000;

// Streams are UI-only once attached: the element holds a reference, the sender
// owns the network tracks. Set srcObject once per lifecycle change (the === guard
// stops per-track ontrack firings from thrashing it) and drive .play() so iOS
// Safari doesn't freeze the video until a tap.
function attachStream(el: HTMLMediaElement | null, stream: MediaStream): void {
  if (!el || el.srcObject === stream) return;
  el.srcObject = stream;
  void el.play?.().catch(() => {});
}

// Observability only (Part 2/3). Fire-and-forget, best-effort: a socket that's
// momentarily down or a synchronous emit failure must never affect the actual
// call, so both are swallowed here rather than at every call site.
function reportClientState(payload: CallClientStateInbound): void {
  try {
    emitClientState(getSocket(), payload);
  } catch {
    /* telemetry only */
  }
}
function reportConnectionStats(payload: CallConnectionStatsInbound): void {
  try {
    emitConnectionStats(getSocket(), payload);
  } catch {
    /* telemetry only */
  }
}

export function useCall(): CallContextValue {
  const ctx = useContext(CallContext);
  if (!ctx) throw new Error("useCall must be used within <CallProvider>");
  return ctx;
}

export function CallProvider({
  children,
  selfUsername,
}: {
  children: ReactNode;
  // Local user's username — used for the camera-off Avatar in the self-preview
  // slot. Null while /auth/me is in flight; the call UI falls back to a "?" tile
  // until it resolves (rare race).
  selfUsername?: string | null;
}) {
  const [state, dispatch] = useReducer(callReducer, initialCallState);

  // Refs read inside async socket / WebRTC callbacks, where `state` would be stale.
  const stateRef    = useRef(state);
  stateRef.current  = state;
  const webrtcRef   = useRef<WebRtcController | null>(null);
  const callIdRef   = useRef<string | null>(null);
  // ICE config (STUN + per-call TURN relay) handed to us by call signaling — in
  // the ack for an outgoing call, in the ring event for an incoming one. Stashed
  // until the controller is built so the peer connection is created with it.
  const iceServersRef = useRef<IceServer[] | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
  const localVideoRef  = useRef<HTMLVideoElement | null>(null);
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null);
  // Blurred fill behind the centered remote feed (muted — main video has audio).
  const remoteBgVideoRef = useRef<HTMLVideoElement | null>(null);
  // Screen share — desktop only (call-ui.tsx hides the trigger on mobile/tablet).
  // Separate elements/streams from the camera ones above: a share is an
  // ADDITIVE track, so camera video keeps flowing in its own <video> the whole
  // time (see call-layout.ts for which one call-ui shows where).
  const localScreenVideoRef  = useRef<HTMLVideoElement | null>(null);
  const remoteScreenVideoRef = useRef<HTMLVideoElement | null>(null);
  // The streams are captured here too, so we can re-attach them once the matching
  // media elements actually mount (they don't exist while phase === "idle").
  const localStreamRef  = useRef<MediaStream | null>(null);
  const remoteStreamRef = useRef<MediaStream | null>(null);
  const localScreenStreamRef  = useRef<MediaStream | null>(null);
  const remoteScreenStreamRef = useRef<MediaStream | null>(null);
  // makeController (below) needs to hand the controller a callback for the
  // native "Stop sharing" bar, but the actual handler (finishLocalScreenShare)
  // is defined after it and would create a circular useCallback dependency.
  // Mirrors the stateRef pattern already used in this file: always points at
  // the latest closure, set on every render.
  const finishLocalScreenShareRef = useRef<() => void>(() => {});
  const resetTimer  = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Armed while pc.connectionState === "disconnected", waiting to see whether
  // it recovers on its own (or via the restartIce() kick below) before we give
  // up. Cleared on "connected", on "failed" (which always wins immediately),
  // on a fresh "disconnected" (no stacking), and by teardown() itself so a
  // stale timer from a finished call can never fire against a later one.
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // The single client cleanup routine. Idempotent: close() guards itself, and a
  // "terminated" dispatch from idle is a no-op. Shows the terminal phase briefly,
  // then resets — unless a new call has already started.
  const teardown = useCallback((phase: "ended" | "failed") => {
    if (reconnectTimer.current) {
      clearTimeout(reconnectTimer.current);
      reconnectTimer.current = null;
    }
    webrtcRef.current?.close();
    webrtcRef.current = null;
    callIdRef.current = null;
    iceServersRef.current = null;
    localStreamRef.current = null;
    remoteStreamRef.current = null;
    localScreenStreamRef.current = null;
    remoteScreenStreamRef.current = null;
    if (remoteAudioRef.current) remoteAudioRef.current.srcObject = null;
    if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;
    if (remoteBgVideoRef.current) remoteBgVideoRef.current.srcObject = null;
    if (localVideoRef.current) localVideoRef.current.srcObject = null;
    if (localScreenVideoRef.current) localScreenVideoRef.current.srcObject = null;
    if (remoteScreenVideoRef.current) remoteScreenVideoRef.current.srcObject = null;
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
        attachStream(remoteBgVideoRef.current, stream);
        attachStream(remoteAudioRef.current, stream);
      },
      onConnectionState: (s) => {
        if (s === "connected") {
          const wasRecovering = reconnectTimer.current !== null;
          if (reconnectTimer.current) {
            clearTimeout(reconnectTimer.current);
            reconnectTimer.current = null;
          }
          dispatch({ t: "connected" });
          const callId = callIdRef.current;
          if (callId) {
            reportClientState({
              callId,
              state: s,
              timestamp: Date.now(),
              outcome: wasRecovering ? "recovered" : undefined,
            });
          }
        } else if (s === "disconnected") {
          // Transient per spec — give it a grace window instead of hanging up.
          // Only the original offerer (the "outgoing" side) drives the ICE
          // restart, so both peers never renegotiate at once and collide.
          if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
          const direction = stateRef.current.direction;
          const iceRestartAttempted = direction === "outgoing";
          if (iceRestartAttempted) {
            const callId = callIdRef.current;
            const activeController = webrtcRef.current;
            if (callId && activeController) {
              activeController.restartIce();
              void (async () => {
                try {
                  const offer = await activeController.createOffer();
                  if (offer && webrtcRef.current === activeController) {
                    emitOffer(getSocket(), { callId, sdp: offer });
                  }
                } catch {
                  /* pc already closed (e.g. user hung up mid-restart) — ignore */
                }
              })();
            }
          }
          const disconnectedCallId = callIdRef.current;
          if (disconnectedCallId) {
            reportClientState({
              callId: disconnectedCallId,
              state: s,
              timestamp: Date.now(),
              iceRestartAttempted,
              iceRestartBy: direction ?? undefined,
            });
          }
          reconnectTimer.current = setTimeout(() => {
            reconnectTimer.current = null;
            const timedOutCallId = callIdRef.current;
            if (timedOutCallId) {
              reportClientState({ callId: timedOutCallId, state: s, timestamp: Date.now(), outcome: "timed_out" });
            }
            teardown("failed");
          }, ICE_DISCONNECT_GRACE_MS);
        } else if (s === "failed") {
          // Fast path: restartIce() itself can fail synchronously in some
          // cases, so "failed" always wins immediately rather than waiting
          // out a grace period that's no longer relevant.
          if (reconnectTimer.current) {
            clearTimeout(reconnectTimer.current);
            reconnectTimer.current = null;
          }
          const callId = callIdRef.current;
          if (callId) reportClientState({ callId, state: s, timestamp: Date.now() });
          teardown("failed");
        }
      },
      onConnectionStats: (summary: ConnectionStatsSummary) => {
        const callId = callIdRef.current;
        if (callId) reportConnectionStats({ callId, ...summary });
      },
      onFacingChange: (facing) => dispatch({ t: "facing", value: facing }),
      onRemoteScreenStream: (stream) => {
        // Attach-only. Whether this ever becomes visible is driven by the
        // explicit call:peer-media-state screenSharing signal (below), not by
        // track arrival — the two can race, and the FSM is the source of truth.
        remoteScreenStreamRef.current = stream;
        attachStream(remoteScreenVideoRef.current, stream);
      },
      onScreenShareEnded: () => finishLocalScreenShareRef.current(),
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
        // Bake in the relay config before the offer (created later, on accept).
        controller.setIceServers(ack.iceServers as RTCIceServer[] | undefined);
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
    // Relay config arrived with the ring event; bake it in before we answer.
    controller.setIceServers(iceServersRef.current as RTCIceServer[] | null);
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
    // Tell the peer so they can swap the remote stage to last-frame + badge
    // instead of a black video. Best-effort: if no callId yet (race with a
    // teardown) we just skip — the next toggle will reconcile.
    const callId = callIdRef.current;
    if (callId) emitMediaState(getSocket(), { callId, cameraOn: !next });
  }, []);

  const switchCamera = useCallback(() => {
    void webrtcRef.current?.switchCamera();
  }, []);

  // Shared tail for both ways a local share can end: the in-app button
  // (toggleScreenShare, which awaits controller.stopScreenShare() itself first)
  // and the browser's native "Stop sharing" bar (webrtc.ts already called
  // stopScreenShare() before invoking onScreenShareEnded — see its comment).
  // Clears local state/refs, tells the peer, and renegotiates the SDP back down
  // (removeTrack changes it same as addTrack did).
  const finishLocalScreenShare = useCallback(() => {
    localScreenStreamRef.current = null;
    if (localScreenVideoRef.current) localScreenVideoRef.current.srcObject = null;
    dispatch({ t: "screenShareState", sharedBy: null });
    const callId = callIdRef.current;
    const controller = webrtcRef.current;
    if (callId) {
      emitMediaState(getSocket(), { callId, cameraOn: !stateRef.current.isCameraOff, screenSharing: false });
    }
    if (callId && controller) {
      void (async () => {
        const offer = await controller.createOffer();
        if (offer && webrtcRef.current === controller) emitOffer(getSocket(), { callId, sdp: offer });
      })();
    }
  }, []);
  finishLocalScreenShareRef.current = finishLocalScreenShare;

  const toggleScreenShare = useCallback(() => {
    const controller = webrtcRef.current;
    const callId = callIdRef.current;
    if (!controller || !callId) return;

    if (stateRef.current.screenShare.sharedBy === "local") {
      void (async () => {
        await controller.stopScreenShare();
        finishLocalScreenShare();
      })();
      return;
    }
    // Peer is already sharing — starting a second, local share concurrently
    // isn't a designed case (see call-layout.ts); leave the toggle a no-op
    // rather than layering ambiguous state on top of it.
    if (stateRef.current.screenShare.sharedBy === "remote") return;

    void (async () => {
      let stream: MediaStream;
      try {
        stream = await controller.startScreenShare();
      } catch {
        return; // permission denied/cancelled — stay as-is, no error surfaced
      }
      if (webrtcRef.current !== controller) return; // call ended mid-request
      localScreenStreamRef.current = stream;
      attachStream(localScreenVideoRef.current, stream);
      dispatch({ t: "screenShareState", sharedBy: "local" });
      emitMediaState(getSocket(), { callId, cameraOn: !stateRef.current.isCameraOff, screenSharing: true });
      const offer = await controller.createOffer();
      if (offer && webrtcRef.current === controller) emitOffer(getSocket(), { callId, sdp: offer });
    })();
  }, [finishLocalScreenShare]);

  // Local-only viewer preference — never emitted to the peer.
  const toggleBothCameras = useCallback(() => {
    dispatch({ t: "toggleBothCameras" });
  }, []);

  // ── Signaling listeners — bound once for the provider's lifetime ────────────
  useEffect(() => {
    const socket = getSocket();
    const cleanup = bindCallSocket(socket, {
      onRinging: ({ callId, caller, type, conversationId, iceServers }) => {
        // Already in a call → auto-reject so we never ring two calls at once.
        if (stateRef.current.phase !== "idle") {
          emitReject(socket, { callId });
          return;
        }
        // Stash the relay config until accept() builds the controller.
        iceServersRef.current = iceServers ?? null;
        callIdRef.current = callId;
        dispatch({ t: "incoming", callId, peer: caller, callType: type, conversationId });
      },
      onAccepted: ({ callId }) => {
        const controller = webrtcRef.current;
        if (!controller) return;
        dispatch({ t: "connecting" });
        void (async () => {
          const offer = await controller.createOffer();
          if (offer) emitOffer(socket, { callId, sdp: offer });
        })();
      },
      onOffer: ({ callId, sdp }) => {
        const controller = webrtcRef.current;
        if (!controller) return;
        void (async () => {
          // acceptOffer() also covers every mid-call renegotiation (screen
          // share start/stop, ICE restart) — it's the same generic offer/
          // answer exchange as the initial one, just arriving later. null means
          // we're mid-glare (see webrtc.ts) — our own in-flight offer will
          // still resolve on its own, so this one is just dropped.
          const answer = await controller.acceptOffer(sdp);
          if (answer) emitAnswer(socket, { callId, sdp: answer });
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
      onPeerMediaState: ({ cameraOn, screenSharing }) => {
        dispatch({ t: "peerCameraOff", value: !cameraOn });
        if (screenSharing !== undefined) {
          dispatch({ t: "screenShareState", sharedBy: screenSharing ? "remote" : null });
        }
      },
    });
    return cleanup;
  }, [teardown]);

  // Re-attach streams after a phase change mounts the media elements. The local
  // stream is acquired while phase is still "idle" (before its <video> exists),
  // so the onLocalStream attach is a no-op then; this runs once the element is in
  // the DOM. attachStream's identity guard makes the repeat harmless.
  //
  // Also re-runs on isCameraOff transitions: the call-ui unmounts the local
  // <video> when the user turns their camera off (swapped for an Avatar). When
  // they turn it back on, the element re-mounts with srcObject=null — without
  // this dep, the freshly-mounted element would never get the stream re-bound.
  useEffect(() => {
    if (localStreamRef.current) attachStream(localVideoRef.current, localStreamRef.current);
    if (remoteStreamRef.current) {
      attachStream(remoteVideoRef.current, remoteStreamRef.current);
      attachStream(remoteBgVideoRef.current, remoteStreamRef.current);
      attachStream(remoteAudioRef.current, remoteStreamRef.current);
    }
    // Screen-share elements only mount once state.screenShare.sharedBy says so
    // (call-ui.tsx) — re-run this on that transition so a stream that arrived
    // before its <video> existed still gets attached once it does.
    if (localScreenStreamRef.current) attachStream(localScreenVideoRef.current, localScreenStreamRef.current);
    if (remoteScreenStreamRef.current) attachStream(remoteScreenVideoRef.current, remoteScreenStreamRef.current);
  }, [state.phase, state.isCameraOff, state.screenShare.sharedBy, state.showBothCameras]);

  // Release the mic if the provider ever unmounts.
  useEffect(() => () => { webrtcRef.current?.close(); }, []);

  return (
    <CallContext.Provider
      value={{ state, startCall, accept, reject, hangup, toggleMute, toggleCamera, switchCamera, toggleScreenShare, toggleBothCameras }}
    >
      {children}
      <CallUI
        state={state}
        selfUsername={selfUsername ?? null}
        remoteAudioRef={remoteAudioRef}
        localVideoRef={localVideoRef}
        remoteVideoRef={remoteVideoRef}
        remoteBgVideoRef={remoteBgVideoRef}
        localScreenVideoRef={localScreenVideoRef}
        remoteScreenVideoRef={remoteScreenVideoRef}
        onAccept={accept}
        onReject={reject}
        onHangup={hangup}
        onToggleMute={toggleMute}
        onToggleCamera={toggleCamera}
        onSwitchCamera={switchCamera}
        onToggleScreenShare={toggleScreenShare}
        onToggleBothCameras={toggleBothCameras}
      />
    </CallContext.Provider>
  );
}
