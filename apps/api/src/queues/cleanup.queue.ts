import { Queue } from "bullmq";
import { queueConnection } from "./media.queue.js";

// Phase 6E: the project's first *repeatable* queue. A single recurring job sweeps
// ephemeral media whose view budget is spent (TemporaryMedia.consumedAt set) and
// purges the bytes from MinIO. Deletion is intentionally decoupled from the view
// endpoint so it is batched, idempotent, and retried on failure — the read path
// already refuses URLs the instant a medium is consumed, so security never waits
// on this sweep.
export const CLEANUP_QUEUE_NAME = "ephemeral-cleanup";
export const SWEEP_JOB = "sweep-expired";

export const cleanupQueue = new Queue(CLEANUP_QUEUE_NAME, {
  connection: queueConnection(),
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential" as const, delay: 1_000 },
    removeOnComplete: 50,
    removeOnFail:     50,
  },
});
