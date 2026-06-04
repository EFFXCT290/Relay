import { Queue } from "bullmq";
import { queueConnection } from "./media.queue.js";
import type { PushPayload, SendOptions } from "../modules/push/push.service.js";

// Web Push fan-out runs off the request path: routes/services enqueue a job per
// recipient-user; the worker (push.worker.ts) loads that user's subscriptions
// and sends each via web-push. Keeping it on its own queue means a slow/again
// push provider can't back up the media pipelines.
export const PUSH_QUEUE_NAME = "push-notifications";
export const SEND_PUSH_JOB = "send-push";
// Daily backstop sweep of long-idle subscriptions (the real cleanup is reactive
// 404/410 pruning on send). Runs through the same worker, branched on job name.
export const PRUNE_STALE_JOB = "prune-stale-subscriptions";
export const PRUNE_STALE_MS = 180 * 24 * 60 * 60 * 1000; // 180 days

export type SendPushJobData = {
  userId:   string;
  payload:  PushPayload;
  options?: SendOptions;
};

// The prune job carries no data; union it in so both `add()` calls type-check.
export type PushJobData = SendPushJobData | Record<string, never>;

const defaultJobOptions = {
  attempts: 3,
  backoff: { type: "exponential" as const, delay: 1_000 },
  removeOnComplete: 500,
  removeOnFail:     100,
};

export const pushQueue = new Queue<PushJobData>(PUSH_QUEUE_NAME, {
  connection: queueConnection(),
  defaultJobOptions,
});
