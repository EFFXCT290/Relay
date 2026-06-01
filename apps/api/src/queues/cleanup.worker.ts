import { Worker } from "bullmq";
import { DeleteObjectsCommand, type S3Client } from "@aws-sdk/client-s3";
import type { PrismaClient } from "@prisma/client";
import type { Server as IOServer } from "socket.io";
import type { FastifyBaseLogger } from "fastify";
import { env } from "../backend-core/runtime/env.js";
import { CLEANUP_QUEUE_NAME } from "./cleanup.queue.js";
import { queueConnection } from "./media.queue.js";

type WorkerDeps = {
  s3:     S3Client;
  prisma: PrismaClient;
  io:     IOServer;
  log:    FastifyBaseLogger;
};

const connection = { ...queueConnection(), maxRetriesPerRequest: null }; // null required by BullMQ workers

// DeleteObjects has a hard limit of 1000 keys per request. Mirrors the helper in
// scripts/gc-orphan-media.ts.
async function deleteBatch(
  s3: S3Client,
  bucket: string,
  keys: string[],
): Promise<{ deleted: number; errors: { key: string; message: string }[] }> {
  let deleted = 0;
  const errors: { key: string; message: string }[] = [];
  for (let i = 0; i < keys.length; i += 1000) {
    const chunk = keys.slice(i, i + 1000);
    const res = await s3.send(new DeleteObjectsCommand({
      Bucket: bucket,
      Delete: { Objects: chunk.map((Key) => ({ Key })), Quiet: false },
    }));
    deleted += res.Deleted?.length ?? 0;
    for (const e of res.Errors ?? []) {
      errors.push({ key: e.Key ?? "(unknown)", message: e.Message ?? e.Code ?? "(no error message)" });
    }
  }
  return { deleted, errors };
}

// One sweep tick: purge every ephemeral medium whose views are spent but whose
// bytes are still around. Idempotent — the `purgedAt: null` filter and S3's
// no-op delete on missing keys make re-runs (and crashes) safe. `purgedAt` is
// stamped ONLY when every key deleted cleanly, so a partial MinIO failure simply
// retries next tick (the medium is already unreachable via the read path).
async function sweep(deps: WorkerDeps): Promise<void> {
  const { prisma, s3, log } = deps;

  const rows = await prisma.temporaryMedia.findMany({
    where: { consumedAt: { not: null }, purgedAt: null },
    take: 500,
    include: { media: { include: { variants: { select: { storageKey: true } } } } },
  });
  if (rows.length === 0) return;

  for (const row of rows) {
    const m = row.media;
    // Collect every object this medium owns so nothing is orphaned: the pointer
    // keys on Media plus every generated variant (optimized/poster/preview/thumb).
    const keys = new Set<string>();
    keys.add(m.storageKey);
    if (m.blurStorageKey)  keys.add(m.blurStorageKey);
    if (m.thumbStorageKey) keys.add(m.thumbStorageKey);
    for (const v of m.variants) keys.add(v.storageKey);

    const { deleted, errors } = await deleteBatch(s3, env.MINIO_BUCKET, [...keys]);
    if (errors.length > 0) {
      log.warn({ mediaId: m.id, deleted, errors }, "ephemeral-cleanup: purge had errors; will retry next sweep");
      continue;
    }
    await prisma.temporaryMedia.update({
      where: { id: row.id },
      data:  { purgedAt: new Date() },
    });
    log.info({ mediaId: m.id, deleted }, "ephemeral-cleanup: purged consumed media");
  }
}

export function createCleanupWorker(deps: WorkerDeps) {
  const worker = new Worker(
    CLEANUP_QUEUE_NAME,
    () => sweep(deps),
    { connection, concurrency: 1 },
  );
  worker.on("failed", (_job, err) => {
    deps.log.error({ err }, "ephemeral-cleanup: sweep job failed");
  });
  return worker;
}
