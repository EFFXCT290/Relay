import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import Fastify from "fastify";
import { TypeBoxTypeProvider, TypeBoxValidatorCompiler } from "@fastify/type-provider-typebox";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import sharp from "sharp";
import "../../backend-core/runtime/formats.js";
import { ProblemError, problemResponse } from "../../backend-core/http/errors.js";
import prismaPlugin from "../../plugins/prisma.js";
import redisPlugin from "../../plugins/redis.js";
import authPlugin from "../../plugins/auth.js";
import minioPlugin from "../../plugins/minio.js";
import mediaRoutes from "./media.routes.js";
import { signAccessToken } from "../../backend-core/auth/tokens.js";
import { ACCESS_COOKIE } from "../../backend-core/auth/cookies.js";
import { env } from "../../backend-core/runtime/env.js";
import type { PrismaClient } from "@prisma/client";

// Real integration test — real Postgres/Redis/MinIO. `rateLimit` is
// registered WITHOUT `global: true` (server.ts sets that for the whole app),
// so only routes that opt in via their own `config.rateLimit` — like
// POST /media/upload's 20/1min — are limited here; nothing else in this
// minimal app accidentally shares a global counter.
async function buildTestApp() {
  const app = Fastify({ logger: false })
    .setValidatorCompiler(TypeBoxValidatorCompiler)
    .withTypeProvider<TypeBoxTypeProvider>();

  await app.register(cookie);
  await app.register(rateLimit, { redis: undefined });
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(minioPlugin);
  await app.register(multipart, { limits: { fileSize: env.MEDIA_MAX_SIZE_MB * 1024 * 1024 } });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ProblemError) return problemResponse(reply, err.code, err.detail);
    throw err;
  });

  await app.register(mediaRoutes, { prefix: "/api" });
  return app;
}

after(async () => {
  const { mediaQueue, videoQueue, voiceQueue } = await import("../../queues/media.queue.js");
  await Promise.all([mediaQueue.close(), videoQueue.close(), voiceQueue.close()]);
});

function cookieFor(userId: string): string {
  const { token } = signAccessToken(userId);
  return `${ACCESS_COOKIE}=${token}`;
}

async function createUser(prisma: PrismaClient, label: string) {
  const suffix = randomUUID().slice(0, 8);
  return prisma.user.create({
    data: {
      username: `media-up-${label}-${suffix}`,
      passwordHash: "not-a-real-hash",
      passwordSalt: randomBytes(32).toString("hex"), // matches passwordSalt @db.Char(64)
    },
  });
}

// Hand-rolled multipart/form-data body for a single file field — avoids
// pulling in a new dependency just to build one. `@fastify/multipart` parses
// standard multipart bodies regardless of which client constructed them.
function multipartBody(fileBuffer: Buffer, filename: string, mimeType: string) {
  const boundary = `----relaytest${randomUUID().replace(/-/g, "")}`;
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mimeType}\r\n\r\n`),
    fileBuffer,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

async function tinyPngBuffer(): Promise<Buffer> {
  return sharp({ create: { width: 4, height: 4, channels: 3, background: { r: 10, g: 20, b: 30 } } }).png().toBuffer();
}

describe("POST /api/media/upload", () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>;
  const createdUserIds: string[] = [];
  const createdMediaIds: string[] = [];

  before(async () => {
    app = await buildTestApp();
  });

  after(async () => {
    const prisma = app.prisma;
    // mediaQueue is a real, Redis-backed singleton shared across every test
    // file/process (and future test runs) — none of this file's tests run a
    // real worker, so every job enqueued here would otherwise sit in Redis
    // forever and get picked up (and fail, since its Media row is about to be
    // deleted below) by the next thing that DOES start a real media worker
    // (e.g. media.worker.test.ts). Remove them explicitly rather than leak
    // real infrastructure state across test files.
    const { mediaQueue } = await import("../../queues/media.queue.js");
    const jobs = await mediaQueue.getJobs(["waiting", "active", "delayed", "completed", "failed"]);
    await Promise.all(
      jobs.filter((j) => createdMediaIds.includes(j.data.mediaId)).map((j) => j.remove()),
    );

    await prisma.media.deleteMany({ where: { id: { in: createdMediaIds } } });
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    await app.close();
  });

  it("uploads a small real fixture image end-to-end: 201, real MinIO object, real DB row, real dimensions read back", async () => {
    const user = await createUser(app.prisma, "happy");
    createdUserIds.push(user.id);
    const png = await tinyPngBuffer();
    const { body, contentType } = multipartBody(png, "fixture.png", "image/png");

    const res = await app.inject({
      method: "POST",
      url: "/api/media/upload",
      headers: { cookie: cookieFor(user.id), "content-type": contentType },
      payload: body,
    });

    assert.equal(res.statusCode, 201);
    const parsed = res.json() as { mediaId: string; mimeType: string; sizeBytes: number; width?: number; height?: number };
    createdMediaIds.push(parsed.mediaId);
    assert.equal(parsed.mimeType, "image/png");
    assert.equal(parsed.sizeBytes, png.length);
    assert.equal(parsed.width, 4);
    assert.equal(parsed.height, 4);

    const row = await app.prisma.media.findUnique({ where: { id: parsed.mediaId } });
    assert.ok(row, "a real Media row must exist");
    assert.equal(row!.uploaderId, user.id);
    assert.equal(row!.status, "processing");

    // Real MinIO round trip: the object at storageKey is byte-identical.
    const { GetObjectCommand } = await import("@aws-sdk/client-s3");
    const obj = await app.s3.send(new GetObjectCommand({ Bucket: env.MINIO_BUCKET, Key: row!.storageKey }));
    const chunks: Buffer[] = [];
    for await (const chunk of obj.Body as AsyncIterable<Buffer>) chunks.push(chunk);
    assert.deepEqual(Buffer.concat(chunks), png);
  });

  it("enqueues a real processing job on mediaQueue — checked against the real queue, not just the HTTP response", async () => {
    const user = await createUser(app.prisma, "queue");
    createdUserIds.push(user.id);
    const png = await tinyPngBuffer();
    const { body, contentType } = multipartBody(png, "fixture.png", "image/png");

    const res = await app.inject({
      method: "POST",
      url: "/api/media/upload",
      headers: { cookie: cookieFor(user.id), "content-type": contentType },
      payload: body,
    });
    assert.equal(res.statusCode, 201);
    const { mediaId } = res.json() as { mediaId: string };
    createdMediaIds.push(mediaId);

    const { mediaQueue, PROCESS_IMAGE_JOB } = await import("../../queues/media.queue.js");
    const jobs = await mediaQueue.getJobs(["waiting", "active", "delayed", "completed"]);
    const job = jobs.find((j) => j.data.mediaId === mediaId);
    assert.ok(job, "a real job for this mediaId must be enqueued on mediaQueue");
    assert.equal(job!.name, PROCESS_IMAGE_JOB);
    assert.equal(job!.data.storageKey, (await app.prisma.media.findUnique({ where: { id: mediaId } }))!.storageKey);
  });

  it("rejects an empty file with a clear error, before touching MinIO or the queue", async () => {
    const user = await createUser(app.prisma, "empty");
    createdUserIds.push(user.id);
    const { body, contentType } = multipartBody(Buffer.alloc(0), "empty.png", "image/png");

    const res = await app.inject({
      method: "POST",
      url: "/api/media/upload",
      headers: { cookie: cookieFor(user.id), "content-type": contentType },
      payload: body,
    });
    assert.equal(res.statusCode, 400);
  });

  it("enforces the 20/1min rate limit: the 21st upload in the window is rejected with 429", async () => {
    const user = await createUser(app.prisma, "ratelimit");
    createdUserIds.push(user.id);
    // Tiny non-image bytes — mediaKindFromMime("image/jpeg") still routes to
    // uploadImage(), and a failed sharp .metadata() probe is caught
    // non-fatally (dimensions stay null) — real enough to exercise the full
    // route + rate limiter without the cost of encoding 21 real images.
    const fakeJpeg = Buffer.from("not a real jpeg but nonzero length");

    let last: Awaited<ReturnType<typeof app.inject>> | undefined;
    for (let i = 0; i < 21; i++) {
      const { body, contentType } = multipartBody(fakeJpeg, `f${i}.jpg`, "image/jpeg");
      last = await app.inject({
        method: "POST",
        url: "/api/media/upload",
        headers: { cookie: cookieFor(user.id), "content-type": contentType },
        payload: body,
      });
      if (last.statusCode === 201) {
        createdMediaIds.push((last.json() as { mediaId: string }).mediaId);
      }
    }

    assert.equal(last!.statusCode, 429, "the 21st upload within the window must be rate-limited");
  });
});
