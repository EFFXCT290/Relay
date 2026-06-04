import { Worker } from "bullmq";
import type { PrismaClient } from "@prisma/client";
import type { FastifyBaseLogger } from "fastify";
import { PushService } from "../modules/push/push.service.js";
import { PushRepository } from "../modules/push/push.repository.js";
import { queueConnection } from "./media.queue.js";
import {
  PUSH_QUEUE_NAME,
  PRUNE_STALE_JOB,
  PRUNE_STALE_MS,
  type PushJobData,
  type SendPushJobData,
} from "./push.queue.js";

// Only prisma + log are needed; accepts the shared workerDeps object (with extra
// s3/io) structurally so server.ts can register it like the media workers.
type WorkerDeps = { prisma: PrismaClient; log: FastifyBaseLogger };

const connection = { ...queueConnection(), maxRetriesPerRequest: null }; // null required by BullMQ workers

export function createPushWorker(deps: WorkerDeps) {
  const service = new PushService(deps.prisma, deps.log);
  const repo = new PushRepository(deps.prisma);

  const worker = new Worker<PushJobData>(
    PUSH_QUEUE_NAME,
    async (job) => {
      if (job.name === PRUNE_STALE_JOB) {
        const { count } = await repo.pruneStale(PRUNE_STALE_MS);
        if (count) deps.log.info({ pruned: count }, "[push-worker] pruned stale subscriptions");
        return;
      }
      const { userId, payload, options } = job.data as SendPushJobData;
      await service.sendToUser(userId, payload, options);
    },
    { connection, concurrency: 8 },
  );

  worker.on("failed", (job, err) => {
    const userId = (job?.data as { userId?: string } | undefined)?.userId;
    deps.log.error({ err, jobId: job?.id, userId }, "[push-worker] job failed");
  });

  return worker;
}
