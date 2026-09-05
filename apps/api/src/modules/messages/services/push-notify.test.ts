import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import Fastify from "fastify";
import prismaPlugin from "../../../plugins/prisma.js";
import redisPlugin from "../../../plugins/redis.js";
import { maybeNotifyPush } from "./push-notify.js";
import type { PrismaClient } from "@prisma/client";

// Integration test — real Postgres (per-recipient pushMessages preference),
// real Redis (transitively, via redisPlugin — not touched by this function
// directly). Only the BullMQ enqueue is captured, same pattern as
// calls.push.test.ts. maybeNotifyPush() takes `onlineIds` as a parameter
// (computed by the caller from live socket rooms) rather than querying
// sockets itself, so "only enqueues for recipients not in the online room"
// is exercised directly here by controlling that parameter — no real socket
// server needed for this file. NOTIFICATION_PROVIDER gating happens at the
// message.routes.ts call site, not inside maybeNotifyPush itself — see
// message-notify.routes.test.ts for that.
async function buildTestApp() {
  const app = Fastify({ logger: false });
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  return app;
}

async function createUser(prisma: PrismaClient, label: string, pushMessages: boolean) {
  const suffix = randomUUID().slice(0, 8);
  return prisma.user.create({
    data: {
      username: `push-notify-${label}-${suffix}`,
      passwordHash: "not-a-real-hash",
      passwordSalt: randomBytes(32).toString("hex"), // matches passwordSalt @db.Char(64)
      pushMessages,
    },
  });
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function waitForPushCount(pushCalls: unknown[], count: number, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (pushCalls.length < count) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${count} push enqueue(s), got ${pushCalls.length}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

type PushCall = { name: string; data: unknown };
async function withPushCapture<T>(fn: (pushCalls: PushCall[]) => Promise<T>): Promise<{ result: T; pushCalls: PushCall[] }> {
  const { pushQueue } = await import("../../../queues/push.queue.js");
  const pushCalls: PushCall[] = [];
  const originalAdd = pushQueue.add.bind(pushQueue);
  pushQueue.add = async (name: string, data: unknown) => {
    pushCalls.push({ name, data });
    return {} as never;
  };
  try {
    const result = await fn(pushCalls);
    return { result, pushCalls };
  } finally {
    pushQueue.add = originalAdd;
  }
}

describe("maybeNotifyPush() — real Postgres", () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>;
  const createdUserIds: string[] = [];

  before(async () => {
    app = await buildTestApp();
  });

  after(async () => {
    await app.prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    const { pushQueue } = await import("../../../queues/push.queue.js");
    const { mediaQueue, videoQueue, voiceQueue } = await import("../../../queues/media.queue.js");
    await Promise.all([pushQueue.close(), mediaQueue.close(), videoQueue.close(), voiceQueue.close()]);
    await app.close();
  });

  const log = { info() {} };

  it("only enqueues for recipients NOT in onlineIds — an online recipient is skipped even though they're in recipientIds", async () => {
    const [online, offline] = await Promise.all([
      createUser(app.prisma, "online", true),
      createUser(app.prisma, "offline", true),
    ]);
    createdUserIds.push(online.id, offline.id);

    const { pushCalls } = await withPushCapture(async (pushCalls) => {
      await maybeNotifyPush(app as never, {
        senderUsername: "alice",
        body: "hey",
        messageType: "TEXT",
        conversationId: "conv-1",
        recipientIds: [online.id, offline.id],
        onlineIds: [online.id],
        log,
      });
      await waitForPushCount(pushCalls, 1);
    });

    assert.equal(pushCalls.length, 1);
    assert.equal((pushCalls[0]!.data as { userId: string }).userId, offline.id);
  });

  it("enqueues nothing when every recipient is online", async () => {
    const online = await createUser(app.prisma, "online", true);
    createdUserIds.push(online.id);

    const { pushCalls } = await withPushCapture(async () => {
      await maybeNotifyPush(app as never, {
        senderUsername: "alice",
        body: "hey",
        messageType: "TEXT",
        conversationId: "conv-1",
        recipientIds: [online.id],
        onlineIds: [online.id],
        log,
      });
      await sleep(300);
    });

    assert.equal(pushCalls.length, 0);
  });

  it("respects each offline recipient's pushMessages preference individually — mixed batch", async () => {
    const [enabled, disabled] = await Promise.all([
      createUser(app.prisma, "enabled", true),
      createUser(app.prisma, "disabled", false),
    ]);
    createdUserIds.push(enabled.id, disabled.id);

    const { pushCalls } = await withPushCapture(async (pushCalls) => {
      await maybeNotifyPush(app as never, {
        senderUsername: "alice",
        body: "hey",
        messageType: "TEXT",
        conversationId: "conv-1",
        recipientIds: [enabled.id, disabled.id],
        onlineIds: [],
        log,
      });
      await waitForPushCount(pushCalls, 1);
      await sleep(200); // grace period to be sure `disabled` doesn't show up late
    });

    assert.equal(pushCalls.length, 1, "only the recipient with pushMessages=true should get an enqueue");
    assert.equal((pushCalls[0]!.data as { userId: string }).userId, enabled.id);
  });

  it("builds the correct payload shape: title is the sender's handle, preview truncates long text, url/tag target the conversation", async () => {
    const offline = await createUser(app.prisma, "offline", true);
    createdUserIds.push(offline.id);
    const longBody = "x".repeat(200);

    const { pushCalls } = await withPushCapture(async (pushCalls) => {
      await maybeNotifyPush(app as never, {
        senderUsername: "alice",
        body: longBody,
        messageType: "TEXT",
        conversationId: "conv-42",
        recipientIds: [offline.id],
        onlineIds: [],
        log,
      });
      await waitForPushCount(pushCalls, 1);
    });

    const payload = (pushCalls[0]!.data as { payload: Record<string, unknown> }).payload;
    assert.equal(payload.title, "@alice");
    assert.equal(payload.body, "x".repeat(120) + "…");
    assert.equal(payload.url, "/conversations/conv-42");
    assert.equal(payload.tag, "conversation-conv-42");
  });

  it("uses a media-type preview (not the raw body) for non-TEXT messages", async () => {
    const offline = await createUser(app.prisma, "offline", true);
    createdUserIds.push(offline.id);

    const { pushCalls } = await withPushCapture(async (pushCalls) => {
      await maybeNotifyPush(app as never, {
        senderUsername: "alice",
        body: null,
        messageType: "IMAGE",
        conversationId: "conv-1",
        recipientIds: [offline.id],
        onlineIds: [],
        log,
      });
      await waitForPushCount(pushCalls, 1);
    });

    const payload = (pushCalls[0]!.data as { payload: { body: string } }).payload;
    assert.equal(payload.body, "📷 Image");
  });
});
