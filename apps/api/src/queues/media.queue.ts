import { Queue } from "bullmq";
import { env } from "../backend-core/runtime/env.js";

// Two queues, deliberately separate: image variant generation is fast (sharp,
// sub-second) while voice transcription is CPU-bound Whisper that runs for
// minutes. Isolating them lets each have its own worker concurrency so heavy
// transcription jobs can never starve the snappy image pipeline.
export const MEDIA_QUEUE_NAME = "media-processing";
export const VOICE_QUEUE_NAME = "voice-transcription";
export const PROCESS_IMAGE_JOB = "process-image";
export const TRANSCRIBE_VOICE_JOB = "transcribe-voice";

export type ProcessImageJobData = {
  mediaId:    string;
  storageKey: string;
  mimeType:   string;
  uploaderId: string;
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

export const voiceQueue = new Queue<TranscribeVoiceJobData>(VOICE_QUEUE_NAME, {
  connection: queueConnection(),
  defaultJobOptions,
});
