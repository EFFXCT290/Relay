import { Queue } from "bullmq";
import { queueConnection } from "./media.queue.js";

// Phase 6E: the project's first *repeatable* queue. A single recurring job runs
// two independent sweeps (see cleanup.worker.ts): ephemeral media whose view
// budget is spent (TemporaryMedia.consumedAt set) gets its MinIO bytes purged,
// and disappearing messages whose condition (view limit or expiry) has been met
// get soft-deleted (MessageDisappearState). Both are decoupled from their
// synchronous read paths so they're batched, idempotent, and retried on failure —
// the read paths already refuse access/serve nothing the instant a thing is
// consumed, so correctness never waits on this sweep; it's cleanup + backstop.
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
