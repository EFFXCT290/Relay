import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import Fastify from "fastify";
import { TypeBoxTypeProvider, TypeBoxValidatorCompiler } from "@fastify/type-provider-typebox";
import cookie from "@fastify/cookie";
import "../../backend-core/runtime/formats.js";
import { ProblemError, problemResponse } from "../../backend-core/http/errors.js";
import prismaPlugin from "../../plugins/prisma.js";
import redisPlugin from "../../plugins/redis.js";
import authPlugin from "../../plugins/auth.js";
import { signAccessToken } from "../../backend-core/auth/tokens.js";
import { ACCESS_COOKIE } from "../../backend-core/auth/cookies.js";
import type { PrismaClient } from "@prisma/client";
import type MessageRoutesDefault from "./message.routes.js";

// message.routes.ts (graphify's #6 god node, 15 edges) is the single call
// site for both notification channels — this file verifies the fan-out
// itself (both get called, with the right args, gated correctly), not each
// channel's own internal logic (push-notify.ts's filtering/preference logic
// has its own dedicated test file; discord-notify.ts isn't in this batch).
//
// discord-notify.js and push-notify.js are mocked via Node's experimental
// `t.mock.module` (run with --experimental-test-module-mocks — see
// package.json's "test" script). Because message.routes.ts binds its imports
// of those modules at ITS OWN module-load time, each test below must install
// the mock BEFORE a fresh, cache-busted import of message.routes.ts — a
// plain top-level import of message.routes.ts (like message.routes.test.ts
// uses) would already be bound to the real, unmocked functions.
async function freshMessageRoutes() {
  const url = new URL("./message.routes.ts", import.meta.url).href + `?t=${Math.random()}`;
  const mod = await import(url);
  return mod.default as typeof MessageRoutesDefault;
}

async function buildTestApp(messageRoutes: Awaited<ReturnType<typeof freshMessageRoutes>>) {
  const app = Fastify({ logger: false })
    .setValidatorCompiler(TypeBoxValidatorCompiler)
    .withTypeProvider<TypeBoxTypeProvider>();

  await app.register(cookie);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);

  app.decorate(
    "io",
    {
      sockets: { adapter: { rooms: new Map<string, { size: number }>() } },
      to: () => ({ emit: () => {} }),
    } as unknown as import("fastify").FastifyInstance["io"],
  );

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ProblemError) return problemResponse(reply, err.code, err.detail);
    throw err;
  });

  await app.register(messageRoutes, { prefix: "/api" });
  return app;
}

after(async () => {
  const { closeAllQueueConnections } = await import("../../queues/close-all-for-tests.js");
  await closeAllQueueConnections();
});

function cookieFor(userId: string): string {
  const { token } = signAccessToken(userId);
  return `${ACCESS_COOKIE}=${token}`;
}

async function createUser(prisma: PrismaClient, label: string) {
  const suffix = randomUUID().slice(0, 8);
  return prisma.user.create({
    data: {
      username: `msg-notify-${label}-${suffix}`,
      passwordHash: "not-a-real-hash",
      passwordSalt: randomBytes(32).toString("hex"), // matches passwordSalt @db.Char(64)
    },
  });
}

async function makeAcceptedConversation(app: Awaited<ReturnType<typeof buildTestApp>>, aId: string, bId: string) {
  const conversation = await app.prisma.conversation.create({ data: {} });
  await app.prisma.participant.createMany({
    data: [
      { userId: aId, conversationId: conversation.id, acceptedAt: new Date() },
      { userId: bId, conversationId: conversation.id, acceptedAt: new Date() },
    ],
  });
  return conversation.id;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe("POST .../messages fans out to both notification channels", () => {
  // Each test needs its OWN fresh app (registered with its own freshly
  // module-mocked messageRoutes) — a single shared `app` reassigned per test
  // would leak the previous test's real Postgres/Redis connections (only the
  // last-assigned instance would ever get closed), which is exactly what
  // hung the process the first time this file was run.
  const apps: Array<Awaited<ReturnType<typeof buildTestApp>>> = [];
  const createdUserIds: string[] = [];
  const createdConversationIds: string[] = [];

  after(async () => {
    if (apps.length === 0) return;
    const prisma = apps[0]!.prisma; // all apps share the same real Postgres
    await prisma.conversation.deleteMany({ where: { id: { in: createdConversationIds } } });
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    await Promise.all(apps.map((a) => a.close()));
  });

  it("calls maybeNotifyDiscord AND maybeNotifyPush, each with the sender/body/recipients/conversation context", async (t) => {
    const discordCalls: unknown[] = [];
    const pushCalls: unknown[] = [];
    t.mock.module(new URL("./services/discord-notify.ts", import.meta.url).href, {
      namedExports: { maybeNotifyDiscord: async (opts: unknown) => { discordCalls.push(opts); } },
    });
    t.mock.module(new URL("./services/push-notify.ts", import.meta.url).href, {
      namedExports: { maybeNotifyPush: async (_fastify: unknown, opts: unknown) => { pushCalls.push(opts); } },
    });

    const messageRoutes = await freshMessageRoutes();
    const app = await buildTestApp(messageRoutes);
    apps.push(app);

    const [a, b] = await Promise.all([createUser(app.prisma, "a"), createUser(app.prisma, "b")]);
    createdUserIds.push(a.id, b.id);
    const conversationId = await makeAcceptedConversation(app, a.id, b.id);
    createdConversationIds.push(conversationId);

    const res = await app.inject({
      method: "POST",
      url: `/api/conversations/${conversationId}/messages`,
      headers: { cookie: cookieFor(a.id), "content-type": "application/json" },
      payload: { body: "hello there" },
    });
    assert.equal(res.statusCode, 201);

    await sleep(200); // both calls are fire-and-forget (`void ...`) from the route

    const senderUsername = (await app.prisma.user.findUniqueOrThrow({ where: { id: a.id } })).username;

    assert.equal(discordCalls.length, 1, "maybeNotifyDiscord must be called exactly once");
    const discordOpts = discordCalls[0] as Record<string, unknown>;
    assert.equal(discordOpts.senderUsername, senderUsername);
    assert.equal(discordOpts.body, "hello there");
    assert.equal(discordOpts.messageType, "TEXT");
    assert.deepEqual(discordOpts.recipientIds, [b.id]);
    assert.deepEqual(discordOpts.onlineIds, []);
    assert.equal(typeof discordOpts.log, "object");

    assert.equal(pushCalls.length, 1, "maybeNotifyPush must be called exactly once");
    const pushOpts = pushCalls[0] as Record<string, unknown>;
    assert.equal(pushOpts.senderUsername, senderUsername);
    assert.equal(pushOpts.body, "hello there");
    assert.equal(pushOpts.messageType, "TEXT");
    assert.equal(pushOpts.conversationId, conversationId);
    assert.deepEqual(pushOpts.recipientIds, [b.id]);
    assert.deepEqual(pushOpts.onlineIds, []);
  });

  it("skips maybeNotifyDiscord when NOTIFICATION_PROVIDER excludes it, while maybeNotifyPush still fires", async (t) => {
    const discordCalls: unknown[] = [];
    const pushCalls: unknown[] = [];
    t.mock.module(new URL("./services/discord-notify.ts", import.meta.url).href, {
      namedExports: { maybeNotifyDiscord: async (opts: unknown) => { discordCalls.push(opts); } },
    });
    t.mock.module(new URL("./services/push-notify.ts", import.meta.url).href, {
      namedExports: { maybeNotifyPush: async (_fastify: unknown, opts: unknown) => { pushCalls.push(opts); } },
    });
    const envUrl = new URL("../../backend-core/runtime/env.ts", import.meta.url).href;
    const real = await import(envUrl);
    t.mock.module(envUrl, {
      namedExports: {
        env: real.env,
        isProd: real.isProd,
        isNotificationProviderEnabled: (name: string) => name !== "discord",
      },
    });

    const messageRoutes = await freshMessageRoutes();
    const app = await buildTestApp(messageRoutes);
    apps.push(app);

    const [a, b] = await Promise.all([createUser(app.prisma, "a"), createUser(app.prisma, "b")]);
    createdUserIds.push(a.id, b.id);
    const conversationId = await makeAcceptedConversation(app, a.id, b.id);
    createdConversationIds.push(conversationId);

    const res = await app.inject({
      method: "POST",
      url: `/api/conversations/${conversationId}/messages`,
      headers: { cookie: cookieFor(a.id), "content-type": "application/json" },
      payload: { body: "gated test" },
    });
    assert.equal(res.statusCode, 201);

    await sleep(200);

    assert.equal(discordCalls.length, 0, "discord must be skipped when NOTIFICATION_PROVIDER excludes it");
    assert.equal(pushCalls.length, 1, "push must still fire when only discord is excluded");
  });

  it("a disappearing message passes isDisappearing:true and the recipient's own nickname override to both channels — body still redacted to null", async (t) => {
    const discordCalls: unknown[] = [];
    const pushCalls: unknown[] = [];
    t.mock.module(new URL("./services/discord-notify.ts", import.meta.url).href, {
      namedExports: { maybeNotifyDiscord: async (opts: unknown) => { discordCalls.push(opts); } },
    });
    t.mock.module(new URL("./services/push-notify.ts", import.meta.url).href, {
      namedExports: { maybeNotifyPush: async (_fastify: unknown, opts: unknown) => { pushCalls.push(opts); } },
    });

    const messageRoutes = await freshMessageRoutes();
    const app = await buildTestApp(messageRoutes);
    apps.push(app);

    const [a, b] = await Promise.all([createUser(app.prisma, "a"), createUser(app.prisma, "b")]);
    createdUserIds.push(a.id, b.id);
    const conversationId = await makeAcceptedConversation(app, a.id, b.id);
    createdConversationIds.push(conversationId);
    // b's own private nickname for a — should surface in senderDisplayNames
    // keyed by b's userId, per the per-recipient/per-viewer nickname rule.
    await app.prisma.userNickname.create({ data: { ownerId: b.id, targetUserId: a.id, nickname: "Boss", sharedWithTarget: false } });

    const res = await app.inject({
      method: "POST",
      url: `/api/conversations/${conversationId}/messages`,
      headers: { cookie: cookieFor(a.id), "content-type": "application/json" },
      payload: { body: "this text must never leak", disappear: { mode: "views", viewLimit: 1 } },
    });
    assert.equal(res.statusCode, 201);

    await sleep(200);

    assert.equal(discordCalls.length, 1);
    const discordOpts = discordCalls[0] as Record<string, unknown>;
    assert.equal(discordOpts.body, null, "body must be redacted before it ever reaches the notify layer");
    assert.equal(discordOpts.isDisappearing, true);
    assert.equal((discordOpts.senderDisplayNames as Map<string, string>).get(b.id), "Boss");

    assert.equal(pushCalls.length, 1);
    const pushOpts = pushCalls[0] as Record<string, unknown>;
    assert.equal(pushOpts.body, null, "body must be redacted before it ever reaches the notify layer");
    assert.equal(pushOpts.isDisappearing, true);
    assert.equal((pushOpts.senderDisplayNames as Map<string, string>).get(b.id), "Boss");
  });
});
