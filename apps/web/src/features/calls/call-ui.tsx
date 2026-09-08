"use client";

import { useEffect, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Mic, MicOff, Phone, PhoneOff, Video, VideoOff, SwitchCamera, ScreenShare, ScreenShareOff, Columns2 } from "lucide-react";
import { Avatar } from "@/shared/components/avatar";
import { useIdle } from "@/shared/hooks/use-idle";
import type { CallState } from "./call-store";
import { computeCallLayout } from "./call-layout";

const mono = "var(--font-mono)";
const display = "var(--font-display)";

// ─────────────────────────────────────────────────────────────────────────────
// Presentational call surface. All state + intents come from CallProvider; this
// only renders. Full-screen portal overlay (z-[140], above the media composer at
// 120, below the lightbox at 200), mobile-safe-area aware.
//
// Layout split: pre-connected and audio-only phases use a centered avatar+status
// column. Connected video flips to absolute three-corner islands (FaceTime
// style) — remote stage fills, self PiP bottom-left, controls bottom-right,
// timer top-center. Controls + top meta auto-hide after 2.5s of inactivity via
// useIdle. Orientation is handled by CSS reflow only — no JS, no hooks, no
// per-rotation aspect logic; PiP is fixed aspect-square so it reads the same
// way portrait or landscape.
// ─────────────────────────────────────────────────────────────────────────────

type Props = {
  state:                CallState;
  selfUsername:         string | null;
  remoteAudioRef:       RefObject<HTMLAudioElement | null>;
  localVideoRef:        RefObject<HTMLVideoElement | null>;
  remoteVideoRef:       RefObject<HTMLVideoElement | null>;
  remoteBgVideoRef:     RefObject<HTMLVideoElement | null>;
  localScreenVideoRef:  RefObject<HTMLVideoElement | null>;
  remoteScreenVideoRef: RefObject<HTMLVideoElement | null>;
  onAccept:             () => void;
  onReject:             () => void;
  onHangup:             () => void;
  onToggleMute:         () => void;
  onToggleCamera:       () => void;
  onSwitchCamera:       () => void;
  onToggleScreenShare:  () => void;
  onToggleBothCameras:  () => void;
};

function statusLabel(state: CallState): string {
  const incoming = state.type === "VIDEO" ? "Incoming video call" : "Incoming audio call";
  switch (state.phase) {
    case "outgoing":   return "Calling…";
    case "incoming":   return incoming;
    case "connecting": return "Connecting…";
    case "connected":  return "Connected";
    case "ended":      return "Call ended";
    case "failed":     return "Call failed";
    default:           return "";
  }
}

export function CallUI({
  state, selfUsername,
  remoteAudioRef, localVideoRef, remoteVideoRef, remoteBgVideoRef,
  localScreenVideoRef, remoteScreenVideoRef,
  onAccept, onReject, onHangup, onToggleMute, onToggleCamera, onSwitchCamera,
  onToggleScreenShare, onToggleBothCameras,
}: Props) {
  const { phase } = state;
  const isIncoming = phase === "incoming";
  const isVideo = state.type === "VIDEO";
  const isConnectedVideo = isVideo && phase === "connected";
  const layout = computeCallLayout(state.screenShare.sharedBy, state.showBothCameras);
  const isSharing = layout.mode === "screen-share";
  // Narrow the discriminated union once here rather than re-checking layout.mode
  // at every render site below.
  const cameraLayoutMode = layout.mode === "screen-share" ? layout.cameraLayout : "corner-pip";
  const screenSource = layout.mode === "screen-share" ? layout.screenSource : null;

  // Auto-hide the controls + top meta only during connected video calls. Every
  // other phase keeps them visible (incoming needs accept/reject obvious;
  // pre-connected has no controls anyway; audio calls don't fade).
  const uiActive = useIdle(2500, isConnectedVideo);

  // ESC rejects an incoming call.
  useEffect(() => {
    if (!isIncoming) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onReject(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isIncoming, onReject]);

  // One short vibration when a call comes in (best-effort; ignored where unsupported).
  useEffect(() => {
    if (isIncoming && typeof navigator !== "undefined" && "vibrate" in navigator) {
      navigator.vibrate?.([200, 100, 200]);
    }
  }, [isIncoming]);

  if (typeof document === "undefined" || phase === "idle" || !state.peer) {
    return null;
  }

  const peer = state.peer;
  // Mirror only when front camera. Rear-camera selfies must not flip — that's
  // a real bug in the prior implementation that hard-coded scaleX(-1).
  const selfMirror = state.selfFacing === "user" ? "scaleX(-1)" : "none";

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-[140]"
      style={{
        background: "rgba(8,10,14,0.97)",
        backdropFilter: "blur(14px)",
        animation: "callFadeIn 0.18s ease-out both",
      }}
    >
      <style>{`@keyframes callFadeIn{from{opacity:0}to{opacity:1}}
        @keyframes callPulse{0%,100%{transform:scale(1);opacity:1}50%{transform:scale(1.06);opacity:0.85}}`}</style>

      {/* Remote stage — centered object-contain feed (never crops faces) over a
          blurred object-cover fill, so any camera aspect ratio frames cleanly on
          any screen. Background <video> is muted; main carries audio. Both stay
          mounted even when peer camera is off so the browser holds the last
          frame on its own — unmounting would defeat the freeze UX. */}
      {isVideo && (
        <div className="absolute inset-0 overflow-hidden bg-black">
          {isSharing ? (
            // Screen-share stage — whoever's screen is being shared (local or
            // remote) fills the space; a "both cameras" viewer preference
            // narrows it with a side column instead (see below). No blurred
            // fill here (that treatment is tuned for a face-cam feed, not
            // arbitrary screen content).
            <div className="flex h-full w-full">
              <div className="relative flex flex-1 items-center justify-center bg-black">
                <video
                  ref={screenSource === "local" ? localScreenVideoRef : remoteScreenVideoRef}
                  autoPlay
                  playsInline
                  // Local screen audio is muted here — the sharer already hears
                  // their own system audio directly; the remote share's audio
                  // (if any) is real content the viewer wants to hear.
                  muted={screenSource === "local"}
                  className="max-h-full max-w-full object-contain"
                />
              </div>
              {cameraLayoutMode === "both-column" && (
                <div
                  className="flex w-[26vw] max-w-[220px] shrink-0 flex-col gap-3 overflow-y-auto bg-black/40 p-3"
                  style={{
                    paddingTop: "calc(env(safe-area-inset-top) + 16px)",
                    paddingBottom: "calc(env(safe-area-inset-bottom) + 96px)",
                  }}
                >
                  <div className="aspect-square w-full shrink-0 overflow-hidden rounded-2xl border border-white/15 bg-black">
                    {state.peerCameraOff ? (
                      <div className="flex h-full w-full items-center justify-center">
                        <Avatar username={peer.username} size={64} />
                      </div>
                    ) : (
                      <video ref={remoteVideoRef} autoPlay playsInline className="h-full w-full object-cover" />
                    )}
                  </div>
                  <div className="aspect-square w-full shrink-0 overflow-hidden rounded-2xl border border-white/15 bg-black">
                    {state.isCameraOff ? (
                      <div className="flex h-full w-full items-center justify-center">
                        <Avatar username={selfUsername ?? "?"} size={64} />
                      </div>
                    ) : (
                      <video
                        ref={localVideoRef}
                        autoPlay
                        playsInline
                        muted
                        className="h-full w-full object-cover"
                        style={{ transform: selfMirror }}
                      />
                    )}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <>
              <video
                ref={remoteBgVideoRef}
                autoPlay
                playsInline
                muted
                className="absolute inset-0 h-full w-full scale-110 object-cover opacity-40 blur-2xl"
              />
              <div className="absolute inset-0 flex items-center justify-center">
                <video
                  ref={remoteVideoRef}
                  autoPlay
                  playsInline
                  className="max-h-full max-w-full object-contain"
                />
              </div>
            </>
          )}
          {/* Peer camera-off badge — overlay only, video stays mounted underneath.
              Screen-share modes show the peer's camera in a small tile instead
              (corner PiP or column), where an off camera already falls back to
              an Avatar — no need for this full-stage badge on top of that. */}
          {!isSharing && state.peerCameraOff && phase === "connected" && (
            <div className="absolute inset-0 z-[3] flex items-center justify-center pointer-events-none">
              <div className="flex items-center gap-2 rounded-full bg-black/55 px-4 py-2 backdrop-blur-md">
                <VideoOff className="h-4 w-4 text-white/80" />
                <span className="text-[11px] uppercase tracking-[0.16em] text-white/70" style={{ fontFamily: mono }}>
                  camera off
                </span>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Identity card — always for audio; for video only until connected.
          Connected video hides the card so the remote feed is unobstructed. */}
      {(!isVideo || phase !== "connected") && (
        <div
          className="absolute inset-0 z-[1] flex flex-col items-center justify-center gap-5 px-6"
          style={{
            paddingTop: "calc(env(safe-area-inset-top) + 48px)",
            paddingBottom: "calc(env(safe-area-inset-bottom) + 220px)",
          }}
        >
          <div style={{ animation: phase === "incoming" || phase === "outgoing" ? "callPulse 1.6s ease-in-out infinite" : undefined }}>
            <Avatar username={peer.username} size={104} />
          </div>
          <div className="flex flex-col items-center gap-1.5">
            <span className="text-[22px] font-bold tracking-[-0.01em] text-white" style={{ fontFamily: display }}>
              @{peer.username}
            </span>
            <span className="text-[12px] uppercase tracking-[0.16em] text-white/55" style={{ fontFamily: mono }}>
              {statusLabel(state)}
            </span>
          </div>
        </div>
      )}

      {/* Corner PiP — bottom-LEFT, fixed aspect-square. Two different sources
          depending on mode, never both, and NEVER the local viewer's own
          camera while a share is active (that's the whole point of the
          rendering rule — own self-preview is hidden the moment anyone
          shares):
            • not sharing → own camera (existing self-preview, mirror tied to
              facingMode so rear-camera doesn't render reversed)
            • sharing, corner-pip layout → the OTHER participant's camera
          "both-column" layout replaces this corner box entirely with the side
          column above, so it's skipped here. */}
      {isConnectedVideo && cameraLayoutMode !== "both-column" && (
        <div
          className="absolute z-[2] aspect-square w-[30vw] max-w-[150px] overflow-hidden rounded-2xl border border-white/15 shadow-xl sm:max-w-[180px]"
          style={{
            left: "calc(env(safe-area-inset-left) + 16px)",
            bottom: "calc(env(safe-area-inset-bottom) + 16px)",
            background: "#000",
          }}
        >
          {isSharing ? (
            state.peerCameraOff ? (
              <div className="flex h-full w-full items-center justify-center">
                <Avatar username={peer.username} size={88} />
              </div>
            ) : (
              <video ref={remoteVideoRef} autoPlay playsInline className="h-full w-full object-cover" />
            )
          ) : state.isCameraOff ? (
            <div className="flex h-full w-full items-center justify-center">
              <Avatar username={selfUsername ?? "?"} size={88} />
            </div>
          ) : (
            <video
              ref={localVideoRef}
              autoPlay
              playsInline
              muted
              className="h-full w-full object-cover"
              style={{ transform: selfMirror }}
            />
          )}
        </div>
      )}

      {/* Top meta — connected video only, fades with the controls. Carries the
          peer name + call timer where the centered identity card would be. */}
      {isConnectedVideo && (
        <div
          className="pointer-events-none absolute left-1/2 z-[2] -translate-x-1/2 transition-opacity duration-200"
          style={{
            top: "calc(env(safe-area-inset-top) + 16px)",
            opacity: uiActive ? 1 : 0,
          }}
        >
          <div className="flex flex-col items-center gap-1 rounded-full bg-black/35 px-4 py-2 backdrop-blur-md">
            <span className="text-[13px] font-semibold tracking-[-0.01em] text-white" style={{ fontFamily: display }}>
              @{peer.username}
            </span>
            <CallTimer />
          </div>
        </div>
      )}

      {/* Controls — three positions depending on phase:
          • incoming  → centered (accept/reject must be obvious)
          • connected video → bottom-right cluster, idle-fade
          • everything else → centered (audio call, pre-connected video) */}
      {isIncoming ? (
        <div
          className="absolute left-0 right-0 z-[2] flex items-center justify-center gap-6"
          style={{ bottom: "calc(env(safe-area-inset-bottom) + 48px)" }}
        >
          <CircleButton label="Reject" onClick={onReject} bg="#EF4444">
            <PhoneOff className="h-7 w-7 text-white" />
          </CircleButton>
          <CircleButton label="Accept" onClick={onAccept} bg="var(--color-online, #22C55E)">
            {isVideo ? <Video className="h-7 w-7 text-white" /> : <Phone className="h-7 w-7 text-white" />}
          </CircleButton>
        </div>
      ) : isConnectedVideo ? (
        <div
          className="absolute z-[2] flex items-center gap-4 transition-opacity duration-200"
          style={{
            right: "calc(env(safe-area-inset-right) + 16px)",
            bottom: "calc(env(safe-area-inset-bottom) + 16px)",
            opacity: uiActive ? 1 : 0,
            pointerEvents: uiActive ? "auto" : "none",
          }}
        >
          <CircleButton
            label={state.isMuted ? "Unmute" : "Mute"}
            onClick={onToggleMute}
            bg={state.isMuted ? "rgba(255,255,255,0.25)" : "rgba(255,255,255,0.12)"}
          >
            {state.isMuted ? <MicOff className="h-6 w-6 text-white" /> : <Mic className="h-6 w-6 text-white" />}
          </CircleButton>
          <CircleButton
            label={state.isCameraOff ? "Turn camera on" : "Turn camera off"}
            onClick={onToggleCamera}
            bg={state.isCameraOff ? "rgba(255,255,255,0.25)" : "rgba(255,255,255,0.12)"}
          >
            {state.isCameraOff ? <VideoOff className="h-6 w-6 text-white" /> : <Video className="h-6 w-6 text-white" />}
          </CircleButton>
          <CircleButton label="Flip camera" onClick={onSwitchCamera} bg="rgba(255,255,255,0.12)">
            <SwitchCamera className="h-6 w-6 text-white" />
          </CircleButton>
          {/* Desktop/tablet only — same lg: breakpoint the rest of the app uses
              for mobile-vs-desktop conditional rendering (e.g. sidebar-nav.tsx,
              bottom-tab-bar.tsx). Starting a share on mobile would require
              switching apps, which backgrounds the browser and — per the
              disconnect investigation — suspends the WebRTC connection
              entirely, dropping the whole call, not just the share. Viewing
              the PEER's share works fine on mobile (no capture/app-switch
              involved), so only this trigger is gated, not the screen-share
              stage/layout above. */}
          <CircleButton
            label={screenSource === "local" ? "Stop sharing" : "Share screen"}
            onClick={onToggleScreenShare}
            bg={screenSource === "local" ? "rgba(255,255,255,0.25)" : "rgba(255,255,255,0.12)"}
            className="hidden lg:flex"
          >
            {screenSource === "local" ? (
              <ScreenShareOff className="h-6 w-6 text-white" />
            ) : (
              <ScreenShare className="h-6 w-6 text-white" />
            )}
          </CircleButton>
          {isSharing && (
            <CircleButton
              label={state.showBothCameras ? "Hide both cameras" : "Show both cameras"}
              onClick={onToggleBothCameras}
              bg={state.showBothCameras ? "rgba(255,255,255,0.25)" : "rgba(255,255,255,0.12)"}
            >
              <Columns2 className="h-6 w-6 text-white" />
            </CircleButton>
          )}
          <CircleButton label="End call" onClick={onHangup} bg="#EF4444">
            <PhoneOff className="h-7 w-7 text-white" />
          </CircleButton>
        </div>
      ) : (
        // Audio call or pre-connected video — centered controls; no autohide.
        <div
          className="absolute left-0 right-0 z-[2] flex items-center justify-center gap-6"
          style={{ bottom: "calc(env(safe-area-inset-bottom) + 48px)" }}
        >
          {phase === "connected" && (
            <CircleButton
              label={state.isMuted ? "Unmute" : "Mute"}
              onClick={onToggleMute}
              bg={state.isMuted ? "rgba(255,255,255,0.25)" : "rgba(255,255,255,0.12)"}
            >
              {state.isMuted ? <MicOff className="h-6 w-6 text-white" /> : <Mic className="h-6 w-6 text-white" />}
            </CircleButton>
          )}
          <CircleButton label="End call" onClick={onHangup} bg="#EF4444">
            <PhoneOff className="h-7 w-7 text-white" />
          </CircleButton>
        </div>
      )}

      {/* Audio-only timer below the centered controls. Connected video uses the
          top-center meta cluster above; this branch covers AUDIO calls only. */}
      {!isVideo && phase === "connected" && (
        <div
          className="absolute left-0 right-0 z-[2] flex justify-center"
          style={{ bottom: "calc(env(safe-area-inset-bottom) + 16px)" }}
        >
          <CallTimer />
        </div>
      )}

      {/* Remote audio — audio-only calls; video calls play audio via the <video>. */}
      {!isVideo && <audio ref={remoteAudioRef} autoPlay playsInline className="hidden" />}
    </div>,
    document.body,
  );
}

function CircleButton({
  label, onClick, bg, children, className = "flex",
}: { label: string; onClick: () => void; bg: string; children: React.ReactNode; className?: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className={`${className} h-16 w-16 items-center justify-center rounded-full transition-transform active:scale-95`}
      style={{ background: bg }}
    >
      {children}
    </button>
  );
}

function CallTimer() {
  const [sec, setSec] = useState(0);
  useEffect(() => {
    const started = Date.now();
    const id = setInterval(() => setSec(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(id);
  }, []);
  const mm = String(Math.floor(sec / 60)).padStart(2, "0");
  const ss = String(sec % 60).padStart(2, "0");
  return (
    <span className="text-[13px] tabular-nums text-white/70" style={{ fontFamily: mono }}>
      {mm}:{ss}
    </span>
  );
}
