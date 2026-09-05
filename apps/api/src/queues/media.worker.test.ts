import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import Fastify from "fastify";
import sharp from "sharp";
import prismaPlugin from "../plugins/prisma.js";
import redisPlugin from "../plugins/redis.js";
import minioPlugin from "../plugins/minio.js";
import { uploadImage, uploadVideo } from "../modules/media/media.service.js";
import { createMediaWorker, createVideoWorker } from "./media.worker.js";
import { MEDIA_EVENTS, type MediaReadyEvent, type MediaProcessedEvent } from "@relay/contracts";
import type { PrismaClient } from "@prisma/client";
import type { Worker } from "bullmq";

const exec = promisify(execFile);

// Real integration test — real Redis (BullMQ), real MinIO, real Postgres.
// Drives the actual worker functions from media.worker.ts against jobs
// enqueued by the actual upload service functions (not hand-seeded job data),
// so this exercises the real production wiring end to end. `io` is stubbed
// with a capturing emit — the worker's OWN business logic (variant
// generation, manifest patch, DB writes, event payload) is what's under
// test, not Socket.IO room delivery (already covered by the real-socket
// tests elsewhere in this suite).
async function buildTestApp() {
  const app = Fastify({ logger: false });
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(minioPlugin);
  return app;
}

function capturingIo() {
  const emitted: Array<{ room: string; event: string; payload: unknown }> = [];
  const io = {
    to: (room: string) => ({
      emit: (event: string, payload: unknown) => emitted.push({ room, event, payload }),
    }),
  };
  return { io: io as never, emitted };
}

async function createUser(prisma: PrismaClient, label: string) {
  const suffix = randomUUID().slice(0, 8);
  return prisma.user.create({
    data: {
      username: `media-wk-${label}-${suffix}`,
      passwordHash: "not-a-real-hash",
      passwordSalt: randomBytes(32).toString("hex"), // matches passwordSalt @db.Char(64)
    },
  });
}

async function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for: ${label}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

// Real ffmpeg-generated test pattern video — no checked-in fixture needed.
async function generateTestVideo(durationSeconds: number): Promise<Buffer> {
  const outPath = `/tmp/relay-worker-test-${randomUUID()}.mp4`;
  await exec("ffmpeg", [
    "-f", "lavfi", "-i", `testsrc=duration=${durationSeconds}:size=320x240:rate=10`,
    "-pix_fmt", "yuv420p", "-y", outPath,
  ]);
  const { readFile, unlink } = await import("node:fs/promises");
  const buf = await readFile(outPath);
  await unlink(outPath).catch(() => {});
  return buf;
}

describe("media.worker.ts — real BullMQ worker, real MinIO, real Postgres", () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>;
  const createdUserIds: string[] = [];
  const createdMediaIds: string[] = [];
  const workers: Worker[] = [];

  // One shared video worker for both durations tested below — creating a
  // SECOND worker per test means both instances compete for jobs on the same
  // real queue name; whichever wins a given job emits into whichever test's
  // `io` closure happened to be bound at that moment, not necessarily the
  // test currently waiting. mediaId filtering (used below) makes it safe to
  // share one worker + one capturing array across cases.
  let videoEmitted: Array<{ room: string; event: string; payload: unknown }>;

  before(async () => {
    app = await buildTestApp();
    const { io: videoIo, emitted } = capturingIo();
    videoEmitted = emitted;
    const videoWorker = createVideoWorker({ s3: app.s3, prisma: app.prisma, io: videoIo, log: app.log as never });
    workers.push(videoWorker);
  });

  after(async () => {
    await Promise.all(workers.map((w) => w.close()));
    await app.prisma.media.deleteMany({ where: { id: { in: createdMediaIds } } });
    await app.prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    const { mediaQueue, videoQueue, voiceQueue } = await import("./media.queue.js");
    await Promise.all([mediaQueue.close(), videoQueue.close(), voiceQueue.close()]);
    await app.close();
  });

  it("processImage: a real enqueued job produces a thumbnail, flips status to ready, and emits media:ready with the correct payload shape", async () => {
    const user = await createUser(app.prisma, "img");
    createdUserIds.push(user.id);

    const png = await sharp({ create: { width: 800, height: 600, channels: 3, background: { r: 5, g: 5, b: 5 } } }).png().toBuffer();
    const uploaded = await uploadImage(png, "image/png", user.id, app.prisma, app.s3, null, "optimized");
    createdMediaIds.push(uploaded.mediaId);

    const { io, emitted } = capturingIo();
    const worker = createMediaWorker({ s3: app.s3, prisma: app.prisma, io, log: app.log as never });
    workers.push(worker);

    // mediaQueue is a real, shared, Redis-backed queue — filter by mediaId
    // rather than trusting that no other job's event ever lands in `emitted`.
    const isMine = (e: { payload: unknown }) => (e.payload as MediaReadyEvent).mediaId === uploaded.mediaId;
    await waitFor(() => emitted.some((e) => e.event === MEDIA_EVENTS.READY && isMine(e)), 15_000, "media:ready emit for this mediaId");

    const readyEmit = emitted.find((e) => e.event === MEDIA_EVENTS.READY && isMine(e))!;
    assert.equal(readyEmit.room, `user:${user.id}`);
    const payload = readyEmit.payload as MediaReadyEvent;
    assert.equal(payload.mediaId, uploaded.mediaId);
    assert.equal(typeof payload.thumbUrl, "string");
    assert.ok(payload.thumbUrl!.length > 0);
    assert.equal(typeof payload.thumbWidth, "number");
    assert.equal(typeof payload.thumbHeight, "number");
    // Legacy blur fields — this pipeline never produces them.
    assert.equal(payload.blurUrl, null);
    assert.equal(payload.blurWidth, null);
    assert.equal(payload.blurHeight, null);

    const row = await app.prisma.media.findUnique({ where: { id: uploaded.mediaId } });
    assert.equal(row!.status, "ready");
    assert.ok(row!.thumbStorageKey);
  });

  // Table-driven across a short (≤1s) and a normal-length clip — regression
  // coverage for a bug found and fixed while writing this suite:
  // processVideo() hardcoded a 1-second poster-frame seek regardless of the
  // clip's actual duration. ffmpeg's `-ss 1 -frames:v 1` on a clip that is
  // exactly 1 second (or shorter) seeks at/past end-of-stream and produces
  // zero frames, so the poster+thumbnail silently and permanently failed for
  // any such clip (caught by processVideo's own try/catch — the job still
  // completed as "ready", just missing poster/thumb forever). Fixed by
  // clamping the seek to a point inside the clip's actual duration.
  for (const durationSeconds of [1, 3]) {
    it(`processVideo (${durationSeconds}s clip): produces poster+thumbnail+stream variants, flips status to ready, and emits media:processed with the correct payload shape`, { timeout: 30_000 }, async () => {
      const user = await createUser(app.prisma, "vid");
      createdUserIds.push(user.id);

      const videoBuf = await generateTestVideo(durationSeconds);
      const uploaded = await uploadVideo(videoBuf, "video/mp4", user.id, app.prisma, app.s3, null, "optimized");
      createdMediaIds.push(uploaded.mediaId);

      const emitted = videoEmitted;
      const isMine = (e: { payload: unknown }) => (e.payload as MediaProcessedEvent).mediaId === uploaded.mediaId;
      await waitFor(() => emitted.some((e) => e.event === MEDIA_EVENTS.PROCESSED && isMine(e)), 30_000, "media:processed emit for this mediaId");

      const processedEmit = emitted.find((e) => e.event === MEDIA_EVENTS.PROCESSED && isMine(e))!;
      assert.equal(processedEmit.room, `user:${user.id}`);
      const payload = processedEmit.payload as MediaProcessedEvent;
      assert.equal(payload.mediaId, uploaded.mediaId);
      assert.equal(payload.kind, "video");
      assert.equal(payload.status, "ready");
      assert.equal(typeof payload.streamUrl, "string", "the H.264 ladder must have produced a playable stream (source is 240p, below the lowest rung — exercises ladderFor's fallback rung)");
      assert.equal(typeof payload.posterUrl, "string", `a ${durationSeconds}s clip must still get a poster frame`);
      assert.equal(typeof payload.thumbUrl, "string", `a ${durationSeconds}s clip must still get a thumbnail`);

      const row = await app.prisma.media.findUnique({ where: { id: uploaded.mediaId } });
      assert.equal(row!.status, "ready");

      // Videos track derivatives via MediaVariant rows, not the legacy
      // Media.thumbStorageKey column (that's image-only — see the
      // processImage test above).
      const posterVariant = await app.prisma.mediaVariant.findFirst({ where: { mediaId: uploaded.mediaId, type: "POSTER" } });
      const thumbVariant = await app.prisma.mediaVariant.findFirst({ where: { mediaId: uploaded.mediaId, type: "THUMBNAIL" } });
      assert.ok(posterVariant, "a POSTER MediaVariant row must exist");
      assert.ok(thumbVariant, "a THUMBNAIL MediaVariant row must exist");
    });
  }
});
