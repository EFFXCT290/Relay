import { Queue } from "bullmq";
import { env } from "../backend-core/runtime/env.js";

// Two queues, deliberately separate: image variant generation is fast (sharp,
// sub-second) while voice transcription is CPU-bound Whisper that runs for
// minutes. Isolating them lets each have its own worker concurrency so heavy
// transcription jobs can never starve the snappy image pipeline.
export const MEDIA_QUEUE_NAME = "media-processing";
export const VIDEO_QUEUE_NAME = "video-processing";
export const VOICE_QUEUE_NAME = "voice-transcription";
export const PROCESS_IMAGE_JOB = "process-image";
export const PROCESS_VIDEO_JOB = "process-video";
export const TRANSCRIBE_VOICE_JOB = "transcribe-voice";

export type ProcessImageJobData = {
  mediaId:      string;
  storageKey:   string;
  mimeType:     string;
  uploaderId:   string;
  deliveryMode: "optimized" | "lss";
  isLss:        boolean;
};

export type ProcessVideoJobData = {
  mediaId:      string;
  storageKey:   string;
  mimeType:     string;
  uploaderId:   string;
  deliveryMode: "optimized" | "lss";
  isLss:        boolean;       // true for HEVC (passthrough) or user-chosen LSS
  isHevc:       boolean;       // drives remux-passthrough vs H.264 ladder
  width:        number | null;
  height:       number | null;
  durationMs:   number | null;
};

export type TranscribeVoiceJobData = {
  mediaId:        string;
  attachmentId:   string;
  messageId:      string;
  conversationId: string;
  storageKey:     string;
};

export function queueConnection() {
  const url = new URL(env.REDIS_URL);
  return {
    host:     url.hostname,
    port:     Number(url.port || 6379),
    password: url.password || undefined,
  };
}

const defaultJobOptions = {
  attempts: 3,
  backoff: { type: "exponential" as const, delay: 1_000 },
  removeOnComplete: 500,
  removeOnFail:     100,
};

// Enqueued from routes/services; consumed by the workers in media.worker.ts.
export const mediaQueue = new Queue<ProcessImageJobData>(MEDIA_QUEUE_NAME, {
  connection: queueConnection(),
  defaultJobOptions,
});

// Video transcoding is long-running; fewer attempts (re-running a 5-min ffmpeg
// job repeatedly is wasteful) and results kept briefly for inspection.
export const videoQueue = new Queue<ProcessVideoJobData>(VIDEO_QUEUE_NAME, {
  connection: queueConnection(),
  defaultJobOptions: { ...defaultJobOptions, attempts: 2 },
});

export const voiceQueue = new Queue<TranscribeVoiceJobData>(VOICE_QUEUE_NAME, {
  connection: queueConnection(),
  defaultJobOptions,
});
