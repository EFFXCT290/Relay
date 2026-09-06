import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import Fastify from "fastify";
import sharp from "sharp";
import { DeleteObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import prismaPlugin from "../../plugins/prisma.js";
import minioPlugin from "../../plugins/minio.js";
import { env } from "../../backend-core/runtime/env.js";
import { putAvatar, clearAvatar } from "./avatar.service.js";
import type { PrismaClient } from "@prisma/client";
import type { FastifyBaseLogger } from "fastify";

// Real integration test — real Postgres + real MinIO. Calls the service
// functions directly (no HTTP layer, no auth/cookie/redis needed — those
// aren't part of what putAvatar/clearAvatar do).
async function buildTestApp() {
  const app = Fastify({ logger: false });
  await app.register(prismaPlugin);
  await app.register(minioPlugin);
  return app;
}

async function createUser(prisma: PrismaClient, label: string) {
  const suffix = randomUUID().slice(0, 8);
  return prisma.user.create({
    data: {
      username: `avatar-${label}-${suffix}`,
      passwordHash: "not-a-real-hash",
      passwordSalt: randomBytes(32).toString("hex"), // matches passwordSalt @db.Char(64)
    },
  });
}

function pngBuffer(r: number, g: number, b: number): Promise<Buffer> {
  return sharp({ create: { width: 8, height: 8, channels: 3, background: { r, g, b } } }).png().toBuffer();
}

describe("avatar.service.ts — putAvatar()/clearAvatar()", () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>;
  const createdUserIds: string[] = [];

  before(async () => {
    app = await buildTestApp();
  });

  after(async () => {
    await app.prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    await app.close();
  });

  it("writes the new object and updates the row BEFORE deleting the old object — no momentary zero-avatar window", async (t) => {
    const user = await createUser(app.prisma, "order");
    createdUserIds.push(user.id);

    const oldKey = await putAvatar({
      userId: user.id, buffer: await pngBuffer(255, 0, 0), mimeType: "image/png",
      prisma: app.prisma, s3: app.s3,
    });

    const originalSend = app.s3.send.bind(app.s3);
    let deleteAttempted = false;
    let rowKeyAtDeleteTime: string | null | undefined;
    let newObjectExistedAtDeleteTime = false;

    t.mock.method(app.s3, "send", async (cmd: unknown) => {
      if (cmd instanceof DeleteObjectCommand && cmd.input.Key === oldKey) {
        deleteAttempted = true;
        // At the exact moment the OLD object's delete fires, check what the
        // rest of the system would actually see — the row and the new
        // object in MinIO — rather than trusting the source's documented
        // ordering claim alone.
        const row = await app.prisma.user.findUnique({ where: { id: user.id }, select: { avatarKey: true } });
        rowKeyAtDeleteTime = row?.avatarKey;
        if (rowKeyAtDeleteTime) {
          try {
            await originalSend(new HeadObjectCommand({ Bucket: env.MINIO_BUCKET, Key: rowKeyAtDeleteTime }));
            newObjectExistedAtDeleteTime = true;
          } catch { /* leave false — would fail the assertion below */ }
        }
      }
      return originalSend(cmd as never);
    });

    const newKey = await putAvatar({
      userId: user.id, buffer: await pngBuffer(0, 255, 0), mimeType: "image/png",
      prisma: app.prisma, s3: app.s3,
    });

    assert.equal(deleteAttempted, true, "the old object's delete must actually have been attempted");
    assert.notEqual(rowKeyAtDeleteTime, oldKey, "the row must already point away from the old key by delete time");
    assert.equal(rowKeyAtDeleteTime, newKey, "the row must already point at the NEW key by delete time");
    assert.equal(newObjectExistedAtDeleteTime, true, "the new object must already be readable in MinIO before the old one is deleted");
  });

  it("a failed delete of the old object does not fail the update — swallowed, but now logged rather than silently dropped", async (t) => {
    const user = await createUser(app.prisma, "delfail");
    createdUserIds.push(user.id);

    const oldKey = await putAvatar({
      userId: user.id, buffer: await pngBuffer(10, 20, 30), mimeType: "image/png",
      prisma: app.prisma, s3: app.s3,
    });

    const originalSend = app.s3.send.bind(app.s3);
    t.mock.method(app.s3, "send", async (cmd: unknown) => {
      if (cmd instanceof DeleteObjectCommand) throw new Error("simulated transient MinIO failure");
      return originalSend(cmd as never);
    });

    const warnCalls: unknown[][] = [];
    const fakeLog = { warn: (...args: unknown[]) => warnCalls.push(args) } as unknown as FastifyBaseLogger;

    const newKey = await putAvatar({
      userId: user.id, buffer: await pngBuffer(40, 50, 60), mimeType: "image/png",
      prisma: app.prisma, s3: app.s3, log: fakeLog,
    });

    assert.notEqual(newKey, oldKey);
    const row = await app.prisma.user.findUnique({ where: { id: user.id }, select: { avatarKey: true } });
    assert.equal(row?.avatarKey, newKey, "the update itself must succeed despite the old object's delete failing");
    assert.equal(warnCalls.length, 1, "the delete failure must be logged, not silently swallowed");
    assert.match(String(warnCalls[0]![1]), /failed to delete old avatar/);
  });

  it("clearAvatar nulls the row and deletes the object; returns null when there was none", async () => {
    const user = await createUser(app.prisma, "clear");
    createdUserIds.push(user.id);

    assert.equal(await clearAvatar({ userId: user.id, prisma: app.prisma, s3: app.s3 }), null);

    const key = await putAvatar({
      userId: user.id, buffer: await pngBuffer(1, 2, 3), mimeType: "image/png",
      prisma: app.prisma, s3: app.s3,
    });

    const removed = await clearAvatar({ userId: user.id, prisma: app.prisma, s3: app.s3 });
    assert.equal(removed, key);

    const row = await app.prisma.user.findUnique({ where: { id: user.id }, select: { avatarKey: true } });
    assert.equal(row?.avatarKey, null);

    await assert.rejects(() => app.s3.send(new HeadObjectCommand({ Bucket: env.MINIO_BUCKET, Key: key })));
  });
});
