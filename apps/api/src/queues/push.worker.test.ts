import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import Fastify from "fastify";
import webpush from "web-push";
import prismaPlugin from "../plugins/prisma.js";
import { createPushWorker } from "./push.worker.js";
import { pushQueue, SEND_PUSH_JOB } from "./push.queue.js";
import { PushRepository } from "../modules/push/push.repository.js";
import type { PrismaClient } from "@prisma/client";
import type { Worker, Job } from "bullmq";

// Real integration test — real Redis (BullMQ), real Postgres. Drives the
// actual `pushQueue`/`createPushWorker` from production code, not a
// throwaway queue, so this validates their real configured behavior.
async function buildTestApp() {
  const app = Fastify({ logger: false });
  await app.register(prismaPlugin);
  return app;
}

async function createUser(prisma: PrismaClient, label: string) {
  const suffix = randomUUID().slice(0, 8);
  return prisma.user.create({
    data: {
      username: `push-wk-${label}-${suffix}`,
      passwordHash: "not-a-real-hash",
      passwordSalt: randomBytes(32).toString("hex"), // matches passwordSalt @db.Char(64)
    },
  });
}

async function createSubscription(prisma: PrismaClient, userId: string) {
  return prisma.pushSubscription.create({
    data: {
      userId,
      endpoint: `https://push.example.com/ep-${randomUUID()}`,
      subscription: { endpoint: `https://push.example.com/ep-${randomUUID()}`, keys: { p256dh: "p", auth: "a" } },
    },
  });
}

async function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for: ${label}`);
    await new Promise((r) => setTimeout(r, 30));
  }
}

describe("push.queue.ts / push.worker.ts — real Redis", () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>;
  const createdUserIds: string[] = [];
  let worker: Worker;

  before(async () => {
    app = await buildTestApp();
    worker = createPushWorker({ prisma: app.prisma, log: app.log as never });
  });

  after(async () => {
    await worker.close();
    await app.prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    await pushQueue.close();
    const { mediaQueue, videoQueue, voiceQueue } = await import("./media.queue.js");
    await Promise.all([mediaQueue.close(), videoQueue.close(), voiceQueue.close()]);
    await app.close();
  });

  it("createPushWorker is configured with concurrency 8 — read directly off the real Worker instance, not assumed", () => {
    assert.equal(worker.opts.concurrency, 8);
  });

  it("pushQueue's real, resolved per-job options are 3 attempts with exponential backoff at a 1000ms base delay", async () => {
    const user = await createUser(app.prisma, "cfg");
    createdUserIds.push(user.id);
    const job = await pushQueue.add(SEND_PUSH_JOB, { userId: user.id, payload: { v: 1, type: "test", title: "t", body: "b" } });
    // Check the resolved opts immediately — no need to remove the job
    // afterward: the shared worker is already listening and will pick this
    // up right away (harmlessly — this user has no subscriptions, so
    // sendToUser no-ops), completing on its own and aging out via the
    // queue's normal removeOnComplete cap.
    assert.equal(job.opts.attempts, 3, "queue defaultJobOptions.attempts must actually apply to a real enqueued job");
    assert.deepEqual(job.opts.backoff, { type: "exponential", delay: 1000 });
  });

  it("a job that keeps genuinely failing retries exactly 3 times, with the delay between attempts growing (exponential, not constant)", { timeout: 15_000 }, async (t) => {
    // Force the JOB HANDLER itself to throw (not an individual webpush send
    // failure — those are caught inside sendToUser and never fail the job).
    // Mocking the shared PushRepository.prototype means the real worker's
    // own repo instance sees it too; scoped to this test via `t`, restored
    // automatically afterward.
    t.mock.method(PushRepository.prototype, "listForUser", async () => {
      throw new Error("simulated repository failure — forces a real job retry");
    });

    const user = await createUser(app.prisma, "retry");
    createdUserIds.push(user.id);

    const failedAt: number[] = [];
    const attemptsSeen: number[] = [];
    const onFailed = (job: Job | undefined, _err: Error) => {
      if (job?.data?.userId !== user.id) return; // shared queue — ignore other tests' jobs
      failedAt.push(Date.now());
      attemptsSeen.push(job.attemptsMade);
    };
    worker.on("failed", onFailed);

    const job = await pushQueue.add(SEND_PUSH_JOB, { userId: user.id, payload: { v: 1, type: "test", title: "t", body: "b" } });
    try {
      await waitFor(() => attemptsSeen.includes(3), 15_000, "the job's 3rd and final failed attempt");

      assert.equal(failedAt.length, 3, "exactly 3 attempts must have failed (queue default: attempts=3)");
      assert.deepEqual(attemptsSeen, [1, 2, 3]);

      const gap1 = failedAt[1]! - failedAt[0]!;
      const gap2 = failedAt[2]! - failedAt[1]!;
      // Exponential backoff (delay=1000ms): gap1 ≈ 1000ms, gap2 ≈ 2000ms.
      // Generous bounds — this is real wall-clock timing, not mocked — but
      // tight enough that a constant/linear backoff (the "not just that it
      // retries" failure mode) would clearly fail this.
      assert.ok(gap1 >= 700, `gap1 (${gap1}ms) should be roughly the base 1000ms delay`);
      assert.ok(gap2 > gap1 * 1.5, `gap2 (${gap2}ms) must be meaningfully larger than gap1 (${gap1}ms) — confirms exponential growth, not a constant delay`);
    } finally {
      worker.off("failed", onFailed);
      // Permanently-failed jobs are kept (removeOnFail: 100) for real
      // inspection — clean up the one this test created rather than leaving
      // it in the real shared queue.
      await job.remove().catch(() => {});
    }
  });

  it("a 404 response from webpush prunes the dead subscription from the DB — the job itself still completes, it doesn't retry forever", async (t) => {
    const user = await createUser(app.prisma, "dead404");
    createdUserIds.push(user.id);
    const sub = await createSubscription(app.prisma, user.id);

    t.mock.method(webpush, "sendNotification", async () => {
      throw Object.assign(new Error("Not Found"), { statusCode: 404 });
    });

    const completed: string[] = [];
    const onCompleted = (job: Job) => { if (job.data?.userId === user.id) completed.push(job.id!); };
    worker.on("completed", onCompleted);

    try {
      await pushQueue.add(SEND_PUSH_JOB, { userId: user.id, payload: { v: 1, type: "test", title: "t", body: "b" } });
      await waitFor(() => completed.length === 1, 5_000, "the job to complete (not fail/retry) despite the 404");

      const row = await app.prisma.pushSubscription.findUnique({ where: { id: sub.id } });
      assert.equal(row, null, "a subscription that 404s must be deleted from the DB");
    } finally {
      worker.off("completed", onCompleted);
    }
  });

  it("a 410 (Gone) response also prunes the subscription, same as 404", async (t) => {
    const user = await createUser(app.prisma, "dead410");
    createdUserIds.push(user.id);
    const sub = await createSubscription(app.prisma, user.id);

    t.mock.method(webpush, "sendNotification", async () => {
      throw Object.assign(new Error("Gone"), { statusCode: 410 });
    });

    const completed: string[] = [];
    const onCompleted = (job: Job) => { if (job.data?.userId === user.id) completed.push(job.id!); };
    worker.on("completed", onCompleted);

    try {
      await pushQueue.add(SEND_PUSH_JOB, { userId: user.id, payload: { v: 1, type: "test", title: "t", body: "b" } });
      await waitFor(() => completed.length === 1, 5_000, "the job to complete despite the 410");

      const row = await app.prisma.pushSubscription.findUnique({ where: { id: sub.id } });
      assert.equal(row, null);
    } finally {
      worker.off("completed", onCompleted);
    }
  });

  it("a non-404/410 failure (e.g. 500) does NOT prune the subscription — only dead-endpoint codes do", async (t) => {
    const user = await createUser(app.prisma, "transient500");
    createdUserIds.push(user.id);
    const sub = await createSubscription(app.prisma, user.id);

    t.mock.method(webpush, "sendNotification", async () => {
      throw Object.assign(new Error("Internal Server Error"), { statusCode: 500 });
    });

    const completed: string[] = [];
    const onCompleted = (job: Job) => { if (job.data?.userId === user.id) completed.push(job.id!); };
    worker.on("completed", onCompleted);

    try {
      await pushQueue.add(SEND_PUSH_JOB, { userId: user.id, payload: { v: 1, type: "test", title: "t", body: "b" } });
      // sendToUser catches this per-subscription (never rethrows for a
      // webpush-level failure), so the job still completes — a transient
      // provider error shouldn't be treated as a job failure.
      await waitFor(() => completed.length === 1, 5_000, "the job to complete (a webpush-level error never fails the job itself)");

      const row = await app.prisma.pushSubscription.findUnique({ where: { id: sub.id } });
      assert.ok(row, "a transient (non-404/410) failure must NOT delete the subscription");
    } finally {
      worker.off("completed", onCompleted);
    }
  });
});
