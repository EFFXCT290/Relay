"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// Prefer Opus (per the storage contract). Chrome only exposes it in a WebM
// container, Firefox/Safari in Ogg — both decode fine server-side via ffmpeg.
const PREFERRED_MIME = [
  "audio/ogg;codecs=opus",
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/ogg",
];

function pickMimeType(): string {
  if (typeof MediaRecorder === "undefined") return "";
  return PREFERRED_MIME.find((m) => MediaRecorder.isTypeSupported(m)) ?? "";
}

export type VoiceRecording = { blob: Blob; durationMs: number };

/**
 * Single-track mic recorder. `start()` opens the mic and begins capturing;
 * `stop()` resolves with the recording, `cancel()` discards it. Either way the
 * mic stream is released. `elapsedMs` ticks while recording for a live timer.
 */
export function useVoiceRecorder() {
  const [recording, setRecording] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);

  const recorderRef  = useRef<MediaRecorder | null>(null);
  const chunksRef    = useRef<Blob[]>([]);
  const streamRef    = useRef<MediaStream | null>(null);
  const startedAtRef = useRef(0);
  const timerRef     = useRef<number | null>(null);
  const resolveRef   = useRef<((r: VoiceRecording | null) => void) | null>(null);
  const canceledRef  = useRef(false);

  const releaseStream = () => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
  };

  const start = useCallback(async () => {
    const mime   = pickMimeType();
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    streamRef.current  = stream;
    chunksRef.current  = [];
    canceledRef.current = false;

    const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    rec.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
    rec.onstop = () => {
      const durationMs = Date.now() - startedAtRef.current;
      const blob = new Blob(chunksRef.current, { type: rec.mimeType || mime || "audio/webm" });
      releaseStream();
      setRecording(false);
      const result = canceledRef.current || blob.size === 0 ? null : { blob, durationMs };
      resolveRef.current?.(result);
      resolveRef.current = null;
    };

    recorderRef.current = rec;
    rec.start();
    startedAtRef.current = Date.now();
    setElapsedMs(0);
    setRecording(true);
    timerRef.current = window.setInterval(() => setElapsedMs(Date.now() - startedAtRef.current), 100);
  }, []);

  const finish = useCallback((cancel: boolean): Promise<VoiceRecording | null> => {
    return new Promise((resolve) => {
      const rec = recorderRef.current;
      if (!rec || rec.state === "inactive") { resolve(null); return; }
      canceledRef.current = cancel;
      resolveRef.current  = resolve;
      rec.stop();
    });
  }, []);

  const stop   = useCallback(() => finish(false), [finish]);
  const cancel = useCallback(() => finish(true),  [finish]);

  // Release the mic if the component unmounts mid-recording.
  useEffect(() => () => releaseStream(), []);

  return {
    recording,
    elapsedMs,
    start,
    stop,
    cancel,
    supported: typeof window !== "undefined" && typeof MediaRecorder !== "undefined",
  };
}
