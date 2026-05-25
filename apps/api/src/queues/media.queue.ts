import { Queue } from "bullmq";
import { env } from "../backend-core/runtime/env.js";

export const MEDIA_QUEUE_NAME = "media-processing";
export const PROCESS_IMAGE_JOB = "process-image";

export type ProcessImageJobData = {
  mediaId:    string;
  storageKey: string;
  mimeType:   string;
  uploaderId: string;
};

// BullMQ Queue — enqueues jobs; the Worker in media.worker.ts consumes them.
// Re-created on every import so it can be used from routes and server alike.
export const mediaQueue = new Queue<ProcessImageJobData>(MEDIA_QUEUE_NAME, {
  connection: {
    host:     new URL(env.REDIS_URL).hostname,
    port:     Number(new URL(env.REDIS_URL).port || 6379),
    password: new URL(env.REDIS_URL).password || undefined,
  },
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 1_000 },
    removeOnComplete: 500,
    removeOnFail:     100,
  },
});
