"use client";

import { useEffect, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Mic, MicOff, Phone, PhoneOff, Video, VideoOff, SwitchCamera } from "lucide-react";
import { Avatar } from "@/shared/components/avatar";
import type { CallState } from "./call-store";

const mono = "var(--font-mono)";
const display = "var(--font-display)";

// ─────────────────────────────────────────────────────────────────────────────
// Presentational call surface. All state + intents come from CallProvider; this
// only renders. Full-screen portal overlay (z-[140], above the media composer at
// 120, below the lightbox at 200), mobile-safe-area aware. Visual-only ringing —
// no ringtone (optional vibration on incoming).
// ─────────────────────────────────────────────────────────────────────────────

type Props = {
  state:          CallState;
  remoteAudioRef: RefObject<HTMLAudioElement | null>;
  localVideoRef:  RefObject<HTMLVideoElement | null>;
  remoteVideoRef: RefObject<HTMLVideoElement | null>;
  onAccept:       () => void;
  onReject:       () => void;
  onHangup:       () => void;
  onToggleMute:   () => void;
  onToggleCamera: () => void;
  onSwitchCamera: () => void;
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
  state, remoteAudioRef, localVideoRef, remoteVideoRef,
  onAccept, onReject, onHangup, onToggleMute, onToggleCamera, onSwitchCamera,
}: Props) {
  const { phase } = state;
  const isIncoming = phase === "incoming";
  const isVideo = state.type === "VIDEO";

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
    // Keep the audio element mounted only while a call exists; nothing otherwise.
    return null;
  }

  const peer = state.peer;

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-[140] flex flex-col items-center justify-between"
      style={{
        background: "rgba(8,10,14,0.97)",
        backdropFilter: "blur(14px)",
        paddingTop: "calc(env(safe-area-inset-top) + 48px)",
        paddingBottom: "calc(env(safe-area-inset-bottom) + 48px)",
        animation: "callFadeIn 0.18s ease-out both",
      }}
    >
      <style>{`@keyframes callFadeIn{from{opacity:0}to{opacity:1}}
        @keyframes callPulse{0%,100%{transform:scale(1);opacity:1}50%{transform:scale(1.06);opacity:0.85}}`}</style>

      {/* Remote video — full-screen background; it carries the remote audio too. */}
      {isVideo && (
        <video
          ref={remoteVideoRef}
          autoPlay
          playsInline
          className="absolute inset-0 h-full w-full bg-black object-cover"
        />
      )}

      {/* Self-preview — corner, mirrored while front-facing. */}
      {isVideo && (
        <video
          ref={localVideoRef}
          autoPlay
          playsInline
          muted
          className="absolute z-[2] h-40 w-28 rounded-2xl border border-white/15 object-cover shadow-xl"
          style={{
            right: "calc(env(safe-area-inset-right) + 16px)",
            bottom: "calc(env(safe-area-inset-bottom) + 124px)",
            background: "#000",
            transform: "scaleX(-1)",
          }}
        />
      )}

      {/* Identity — always for audio; for video only until the remote feed arrives. */}
      {(!isVideo || phase !== "connected") && (
        <div className="z-[1] flex flex-1 flex-col items-center justify-center gap-5 px-6">
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

      {/* For a connected video call, keep the controls anchored to the bottom. */}
      {isVideo && phase === "connected" && <div className="flex-1" />}

      {/* Controls */}
      <div className="z-[2] flex items-center gap-6">
        {isIncoming ? (
          <>
            <CircleButton label="Reject" onClick={onReject} bg="#EF4444">
              <PhoneOff className="h-7 w-7 text-white" />
            </CircleButton>
            <CircleButton label="Accept" onClick={onAccept} bg="var(--color-online, #22C55E)">
              {isVideo ? <Video className="h-7 w-7 text-white" /> : <Phone className="h-7 w-7 text-white" />}
            </CircleButton>
          </>
        ) : (
          <>
            {phase === "connected" && (
              <CircleButton
                label={state.isMuted ? "Unmute" : "Mute"}
                onClick={onToggleMute}
                bg={state.isMuted ? "rgba(255,255,255,0.25)" : "rgba(255,255,255,0.12)"}
              >
                {state.isMuted ? <MicOff className="h-6 w-6 text-white" /> : <Mic className="h-6 w-6 text-white" />}
              </CircleButton>
            )}
            {isVideo && phase === "connected" && (
              <>
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
              </>
            )}
            <CircleButton label="End call" onClick={onHangup} bg="#EF4444">
              <PhoneOff className="h-7 w-7 text-white" />
            </CircleButton>
          </>
        )}
      </div>

      {/* Remote audio — audio-only calls; video calls play audio via the <video>. */}
      {!isVideo && <audio ref={remoteAudioRef} autoPlay playsInline className="hidden" />}

      {/* Connected timer — pinned bottom so it reads over the video feed too. */}
      {phase === "connected" && (
        <div className="z-[2] mt-3">
          <CallTimer />
        </div>
      )}
    </div>,
    document.body,
  );
}

function CircleButton({
  label, onClick, bg, children,
}: { label: string; onClick: () => void; bg: string; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className="flex h-16 w-16 items-center justify-center rounded-full transition-transform active:scale-95"
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
