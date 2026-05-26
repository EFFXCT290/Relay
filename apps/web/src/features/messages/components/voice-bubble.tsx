"use client";

import { useEffect, useRef, useState } from "react";
import { Pause, Play } from "lucide-react";
import { cn } from "@/frontend-core/utils";
import type { TranscriptLanguage, VoiceAttachment } from "@relay/contracts";

const mono = "var(--font-mono)";

const LANG_LABEL: Record<TranscriptLanguage, string> = { en: "EN", es: "ES", mixed: "MIX" };

function fmt(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

type Props = {
  attachment:          VoiceAttachment;
  isMine:              boolean;
  /** Triggers server-side transcription; rejects on failure so we can reset. */
  onRequestTranscript?: () => Promise<void> | void;
};

export function VoiceBubble({ attachment, isMine, onRequestTranscript }: Props) {
  const { media } = attachment;
  const audioRef = useRef<HTMLAudioElement>(null);
  const fixingRef = useRef(false);

  const [playing, setPlaying]     = useState(false);
  const [currentSec, setCurrent]  = useState(0);
  const [durationSec, setDuration] = useState<number | null>(null);
  const [showText, setShowText]   = useState(false);
  const [requested, setRequested] = useState(false);

  // All playback state is driven off the actual <audio> element. MediaRecorder
  // WebM blobs report duration === Infinity until the browser is forced to seek
  // to the end, which otherwise breaks the progress bar and the ended/stop
  // logic — hence the one-shot seek workaround below.
  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;

    const resolveDuration = () => {
      if (Number.isFinite(el.duration) && el.duration > 0) { setDuration(el.duration); return; }
      fixingRef.current = true;
      const onFixed = () => {
        el.removeEventListener("timeupdate", onFixed);
        fixingRef.current = false;
        el.currentTime = 0;
        if (Number.isFinite(el.duration)) setDuration(el.duration);
      };
      el.addEventListener("timeupdate", onFixed);
      el.currentTime = 1e101; // forces Chrome to compute the real duration
    };

    const onTime  = () => { if (!fixingRef.current) setCurrent(el.currentTime); };
    const onEnd   = () => { setPlaying(false); setCurrent(0); el.currentTime = 0; };
    const onPlay  = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    // Backstop for the seek workaround: once the real duration is known, record
    // it and make sure the forced end-seek didn't leave us parked at the end.
    const onDurationChange = () => {
      if (Number.isFinite(el.duration) && el.duration > 0) {
        setDuration(el.duration);
        if (!fixingRef.current && el.currentTime >= el.duration) el.currentTime = 0;
      }
    };

    el.addEventListener("loadedmetadata", resolveDuration);
    el.addEventListener("durationchange", onDurationChange);
    el.addEventListener("timeupdate", onTime);
    el.addEventListener("ended", onEnd);
    el.addEventListener("play", onPlay);
    el.addEventListener("pause", onPause);
    return () => {
      el.removeEventListener("loadedmetadata", resolveDuration);
      el.removeEventListener("durationchange", onDurationChange);
      el.removeEventListener("timeupdate", onTime);
      el.removeEventListener("ended", onEnd);
      el.removeEventListener("play", onPlay);
      el.removeEventListener("pause", onPause);
    };
  }, []);

  const toggle = async () => {
    const el = audioRef.current;
    if (!el) return;
    if (el.paused) { try { await el.play(); } catch { /* play() can reject if not ready */ } }
    else el.pause();
  };

  const requestTranscript = async () => {
    setRequested(true);
    try { await onRequestTranscript?.(); }
    catch { setRequested(false); }
  };

  // Real element duration wins; fall back to the recorder-measured length until
  // metadata resolves so the timer/bar aren't blank on first paint.
  const totalMs  = durationSec != null ? durationSec * 1000 : (media.durationMs ?? 0);
  const progress = totalMs > 0 ? Math.min((currentSec * 1000) / totalMs, 1) : 0;
  const timeMs   = playing || currentSec > 0 ? currentSec * 1000 : totalMs;

  const accent = isMine ? "var(--color-bubble-sent-text)" : "var(--color-signal)";
  const track  = isMine ? "rgba(255,255,255,0.30)" : "var(--color-hairline-strong)";

  const transcript = media.transcript;
  const status     = media.transcriptStatus;
  const isReady     = status === "ready" && !!transcript;
  const isPending   = !isReady && (status === "pending" || requested);
  const isFailed    = !isReady && !isPending && status === "failed";

  return (
    <div
      className={cn(
        "flex flex-col gap-2 rounded-[22px] px-3 py-2.5",
        isMine ? "rounded-br-[6px]" : "rounded-bl-[6px]",
      )}
      style={{
        background: isMine ? "var(--color-bubble-sent)" : "var(--color-bubble-received)",
        color:      isMine ? "var(--color-bubble-sent-text)" : "var(--color-text)",
        border:     isMine ? undefined : "1px solid rgba(255,255,255,0.04)",
        minWidth:   220,
      }}
    >
      <audio ref={audioRef} src={media.url} preload="metadata" />

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => void toggle()}
          aria-label={playing ? "Pause" : "Play"}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full"
          style={{ background: isMine ? "rgba(255,255,255,0.18)" : "var(--color-raised)", color: accent }}
        >
          {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4 translate-x-[1px]" />}
        </button>

        <div className="flex flex-1 flex-col gap-1.5">
          <div className="h-1 w-full overflow-hidden rounded-full" style={{ background: track }}>
            <div className="h-full rounded-full" style={{ width: `${progress * 100}%`, background: accent }} />
          </div>
          <span className="text-[10px] tabular-nums" style={{ fontFamily: mono, color: isMine ? "rgba(255,255,255,0.75)" : "var(--color-text-muted)" }}>
            {fmt(timeMs)}
          </span>
        </div>
      </div>

      {/* Transcription is opt-in — surfaced only when the user asks for it. */}
      {isReady ? (
        <>
          <button
            type="button"
            onClick={() => setShowText((v) => !v)}
            className="self-start text-[11px] font-semibold uppercase tracking-[0.06em] opacity-80 hover:opacity-100"
            style={{ fontFamily: mono, color: accent }}
          >
            {showText ? "Hide transcript" : "Show transcript"}
          </button>
          {showText && (
            <div
              className="flex flex-col gap-1 rounded-[12px] px-2.5 py-2 text-[13px] leading-[19px]"
              style={{ background: isMine ? "rgba(0,0,0,0.14)" : "rgba(255,255,255,0.03)" }}
            >
              {transcript!.segments.length === 0 ? (
                <span className="opacity-70">{transcript!.fullText || "(no speech detected)"}</span>
              ) : (
                transcript!.segments.map((seg, i) => (
                  <p key={i} className="m-0">
                    <span className="mr-1.5 align-[1px] text-[9px] font-bold opacity-70" style={{ fontFamily: mono }}>
                      [{LANG_LABEL[seg.language]}]
                    </span>
                    {seg.text}
                  </p>
                ))
              )}
            </div>
          )}
        </>
      ) : isPending ? (
        <span className="self-start text-[11px] italic opacity-70" style={{ fontFamily: mono }}>
          Transcribing…
        </span>
      ) : (
        <button
          type="button"
          onClick={() => void requestTranscript()}
          className="self-start text-[11px] font-semibold uppercase tracking-[0.06em] opacity-80 hover:opacity-100"
          style={{ fontFamily: mono, color: accent }}
        >
          {isFailed ? "Transcription failed · Retry" : "Transcribe"}
        </button>
      )}
    </div>
  );
}
