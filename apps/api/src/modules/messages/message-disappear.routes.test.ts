import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import Fastify from "fastify";
import { TypeBoxTypeProvider, TypeBoxValidatorCompiler } from "@fastify/type-provider-typebox";
import cookie from "@fastify/cookie";
import "../../backend-core/runtime/formats.js"; // side effect: registers uuid/date-time/email TypeBox formats
import { ProblemError, problemResponse } from "../../backend-core/http/errors.js";
import prismaPlugin from "../../plugins/prisma.js";
import redisPlugin from "../../plugins/redis.js";
import authPlugin from "../../plugins/auth.js";
import messageRoutes from "./message.routes.js";
import conversationRoutes from "../conversations/conversation.routes.js";
import { sweepDisappearingMessages } from "../../queues/cleanup.worker.js";
import { signAccessToken } from "../../backend-core/auth/tokens.js";
import { ACCESS_COOKIE } from "../../backend-core/auth/cookies.js";
import type { PrismaClient } from "@prisma/client";
import type { FastifyBaseLogger } from "fastify";

// Real integration test — real Postgres/Redis (the throwaway local services),
// same minimal-app approach as message-softdelete.routes.test.ts. Does NOT
// import buildServer()/server.ts (its pre-existing void main() side effect
// boots a second real server on import).
async function buildTestApp() {
  const app = Fastify({ logger: false })
    .setValidatorCompiler(TypeBoxValidatorCompiler)
    .withTypeProvider<TypeBoxTypeProvider>();

  await app.register(cookie);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);

  // Capture every emitted event so tests can assert on the realtime broadcast
  // without standing up real socket.io clients — mirrors the io stub used
  // throughout this module's other route tests, extended to record emits.
  const emitted: { room: string; event: string; payload: unknown }[] = [];
  app.decorate(
    "io",
    {
      sockets: { adapter: { rooms: new Map<string, { size: number }>() } },
      to: (room: string) => ({
        emit: (event: string, payload: unknown) => emitted.push({ room, event, payload }),
      }),
    } as unknown as import("fastify").FastifyInstance["io"],
  );
  app.decorate("getMediaUrl", async (key: string) => `https://fake.example/${key}`);

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ProblemError) return problemResponse(reply, err.code, err.detail);
    throw err;
  });

  await app.register(conversationRoutes, { prefix: "/api" });
  await app.register(messageRoutes, { prefix: "/api" });
  return { app, emitted };
}

// This file transitively opens several queue connections at import time
// (message.routes.ts pulls in media/video/voice/push; this file's own
// sweepDisappearingMessages import pulls in cleanup) regardless of whether
// .add() is ever called — left open, `node --test` never exits.
// closeAllQueueConnections() closes every queue this app can open, so this
// file never has to track which subset it happens to pull in (see
// close-all-for-tests.ts for the full story).
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
      username: `msg-dis-${label}-${suffix}`,
      passwordHash: "not-a-real-hash",
      passwordSalt: randomBytes(32).toString("hex"), // matches passwordSalt @db.Char(64)
    },
  });
}

async function makeAcceptedConversation(app: Awaited<ReturnType<typeof buildTestApp>>["app"], aId: string, bId: string) {
  const conversation = await app.prisma.conversation.create({ data: {} });
  await app.prisma.participant.createMany({
    data: [
      { userId: aId, conversationId: conversation.id, acceptedAt: new Date() },
      { userId: bId, conversationId: conversation.id, acceptedAt: new Date() },
    ],
  });
  return conversation.id;
}

function sendText(
  app: Awaited<ReturnType<typeof buildTestApp>>["app"],
  callerId: string,
  conversationId: string,
  body: string,
  extra: Record<string, unknown> = {},
) {
  return app.inject({
    method: "POST",
    url: `/api/conversations/${conversationId}/messages`,
    headers: { cookie: cookieFor(callerId), "content-type": "application/json" },
    payload: { body, ...extra },
  });
}

function viewMessage(app: Awaited<ReturnType<typeof buildTestApp>>["app"], callerId: string, messageId: string) {
  return app.inject({
    method: "POST",
    url: `/api/messages/${messageId}/view`,
    headers: { cookie: cookieFor(callerId) },
  });
}

function getMessages(app: Awaited<ReturnType<typeof buildTestApp>>["app"], callerId: string, conversationId: string) {
  return app.inject({
    method: "GET",
    url: `/api/conversations/${conversationId}/messages`,
    headers: { cookie: cookieFor(callerId) },
  });
}

describe("POST /api/conversations/:id/messages — disappear:views send", () => {
  let ctx: Awaited<ReturnType<typeof buildTestApp>>;
  const createdUserIds: string[] = [];
  const createdConversationIds: string[] = [];

  before(async () => {
    ctx = await buildTestApp();
  });

  after(async () => {
    const prisma = ctx.app.prisma;
    await prisma.conversation.deleteMany({ where: { id: { in: createdConversationIds } } });
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    await ctx.app.close();
  });

  async function setup() {
    const [a, b] = await Promise.all([createUser(ctx.app.prisma, "a"), createUser(ctx.app.prisma, "b")]);
    createdUserIds.push(a.id, b.id);
    const conversationId = await makeAcceptedConversation(ctx.app, a.id, b.id);
    createdConversationIds.push(conversationId);
    return { a, b, conversationId };
  }

  it("creates a MessageDisappearState row and never serializes body — not even to the sender", async () => {
    const { a, conversationId } = await setup();
    const res = await sendText(ctx.app, a.id, conversationId, "self-destruct in 3, 2, 1", {
      disappear: { mode: "views", viewLimit: 2 },
    });
    assert.equal(res.statusCode, 201);
    const created = res.json() as { messageId: string; body: string | null; disappear: { mode: string; viewLimit: number; viewCount: number } };
    assert.equal(created.body, null, "the server must not echo the hidden body, even to the sender who just typed it");
    assert.deepEqual(created.disappear, { mode: "views", viewLimit: 2, viewCount: 0, expiresAt: null });

    const row = await ctx.app.prisma.messageDisappearState.findUnique({ where: { messageId: created.messageId } });
    assert.ok(row, "a MessageDisappearState sidecar row must exist");
    assert.equal(row!.mode, "VIEWS");
    assert.equal(row!.viewLimit, 2);
    assert.equal(row!.viewCount, 0);

    // DB body itself is untouched — only serialization hides it.
    const dbRow = await ctx.app.prisma.message.findUnique({ where: { id: created.messageId } });
    assert.equal(dbRow!.body, "self-destruct in 3, 2, 1");
  });

  it("GET list also never serializes body for a views-mode message, for either participant", async () => {
    const { a, b, conversationId } = await setup();
    const sendRes = await sendText(ctx.app, a.id, conversationId, "hidden text", {
      disappear: { mode: "views", viewLimit: 1 },
    });
    const messageId = (sendRes.json() as { messageId: string }).messageId;

    for (const viewer of [a, b]) {
      const listRes = await getMessages(ctx.app, viewer.id, conversationId);
      const { messages } = listRes.json() as { messages: Array<{ messageId: string; body: string | null }> };
      const entry = messages.find((m) => m.messageId === messageId);
      assert.ok(entry);
      assert.equal(entry!.body, null);
    }
  });
});

describe("POST /api/messages/:messageId/view — views mode", () => {
  let ctx: Awaited<ReturnType<typeof buildTestApp>>;
  const createdUserIds: string[] = [];
  const createdConversationIds: string[] = [];

  before(async () => {
    ctx = await buildTestApp();
  });

  after(async () => {
    const prisma = ctx.app.prisma;
    await prisma.conversation.deleteMany({ where: { id: { in: createdConversationIds } } });
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    await ctx.app.close();
  });

  async function setup(viewLimit: number) {
    const [a, b] = await Promise.all([createUser(ctx.app.prisma, "a"), createUser(ctx.app.prisma, "b")]);
    createdUserIds.push(a.id, b.id);
    const conversationId = await makeAcceptedConversation(ctx.app, a.id, b.id);
    createdConversationIds.push(conversationId);
    const sendRes = await sendText(ctx.app, a.id, conversationId, "peekaboo", {
      disappear: { mode: "views", viewLimit },
    });
    assert.equal(sendRes.statusCode, 201);
    const messageId = (sendRes.json() as { messageId: string }).messageId;
    return { a, b, conversationId, messageId };
  }

  it("403s the sender opening their own disappearing message", async () => {
    const { a, messageId } = await setup(1);
    const res = await viewMessage(ctx.app, a.id, messageId);
    assert.equal(res.statusCode, 403);
  });

  it("403s a non-participant", async () => {
    const { messageId } = await setup(1);
    const stranger = await createUser(ctx.app.prisma, "stranger");
    createdUserIds.push(stranger.id);
    const res = await viewMessage(ctx.app, stranger.id, messageId);
    assert.equal(res.statusCode, 403);
  });

  it("a recipient's open returns the real body and, at viewLimit 1, immediately soft-deletes the message", async () => {
    const { b, conversationId, messageId } = await setup(1);
    const res = await viewMessage(ctx.app, b.id, messageId);
    assert.equal(res.statusCode, 200);
    const payload = res.json() as { mode: string; consumed: boolean; viewCount: number; viewLimit: number; body?: string };
    assert.equal(payload.mode, "views");
    assert.equal(payload.consumed, true);
    assert.equal(payload.viewCount, 1);
    assert.equal(payload.body, "peekaboo");

    const msgRow = await ctx.app.prisma.message.findUnique({ where: { id: messageId } });
    assert.equal(msgRow!.isDeleted, true, "the last look must soft-delete the message synchronously, not wait for the sweep");
    assert.notEqual(msgRow!.deletedAt, null);

    const stateRow = await ctx.app.prisma.messageDisappearState.findUnique({ where: { messageId } });
    assert.notEqual(stateRow!.consumedAt, null);

    // Now hidden from the list for everyone, same as any soft-deleted message.
    const listRes = await getMessages(ctx.app, b.id, conversationId);
    const { messages } = listRes.json() as { messages: Array<{ messageId: string; body: string | null; isDeleted: boolean }> };
    const entry = messages.find((m) => m.messageId === messageId);
    assert.equal(entry!.body, null);
    assert.equal(entry!.isDeleted, true);

    // Broadcast: message:disappear:progress ticked, then message:deleted fired.
    const events = ctx.emitted.filter((e) => e.room === `conversation:${conversationId}`).map((e) => e.event);
    assert.ok(events.includes("message:disappear:progress"));
    assert.ok(events.includes("message:deleted"));
  });

  it("viewLimit 2: first look returns the body without deleting; second look consumes it", async () => {
    const { b, messageId } = await setup(2);

    const first = await viewMessage(ctx.app, b.id, messageId);
    assert.equal(first.statusCode, 200);
    const firstBody = first.json() as { mode: string; consumed: boolean; viewCount: number; body?: string };
    assert.equal(firstBody.mode, "views");
    assert.equal(firstBody.consumed, false);
    assert.equal(firstBody.viewCount, 1);
    assert.equal(firstBody.body, "peekaboo");

    const midRow = await ctx.app.prisma.message.findUnique({ where: { id: messageId } });
    assert.equal(midRow!.isDeleted, false, "must still be alive between look 1 and the final look");

    const second = await viewMessage(ctx.app, b.id, messageId);
    assert.equal(second.statusCode, 200);
    const secondBody = second.json() as { mode: string; consumed: boolean; viewCount: number; body?: string };
    assert.equal(secondBody.consumed, true);
    assert.equal(secondBody.viewCount, 2);
    assert.equal(secondBody.body, "peekaboo");

    const finalRow = await ctx.app.prisma.message.findUnique({ where: { id: messageId } });
    assert.equal(finalRow!.isDeleted, true);
  });

  it("refuses a view after the message is already consumed — no body, no double-decrement", async () => {
    const { b, messageId } = await setup(1);
    await viewMessage(ctx.app, b.id, messageId);

    const again = await viewMessage(ctx.app, b.id, messageId);
    assert.equal(again.statusCode, 404, "the message is soft-deleted, so it's gone from this route's perspective");
  });

  it("400s an open attempt on a message that isn't disappearing at all", async () => {
    const { a, b, conversationId } = await setup(1);
    void a;
    const normalRes = await sendText(ctx.app, a.id, conversationId, "just a normal message");
    const normalId = (normalRes.json() as { messageId: string }).messageId;
    const res = await viewMessage(ctx.app, b.id, normalId);
    assert.equal(res.statusCode, 400);
  });

  it("unpins a pinned disappearing message the instant its last view is spent", async () => {
    const { a, b, conversationId, messageId } = await setup(1);
    const pinRes = await ctx.app.inject({
      method: "POST",
      url: `/api/conversations/${conversationId}/messages/${messageId}/pin`,
      headers: { cookie: cookieFor(a.id) },
    });
    assert.equal(pinRes.statusCode, 201);

    await viewMessage(ctx.app, b.id, messageId);

    const pinRow = await ctx.app.prisma.pinnedMessage.findUnique({ where: { messageId } });
    assert.equal(pinRow, null, "consuming the last view must unpin, mirroring the manual DELETE route's discipline");
  });
});

describe("POST /api/conversations/:id/messages — disappear:time send (clock does NOT start at send)", () => {
  let ctx: Awaited<ReturnType<typeof buildTestApp>>;
  const createdUserIds: string[] = [];
  const createdConversationIds: string[] = [];

  before(async () => {
    ctx = await buildTestApp();
  });

  after(async () => {
    const prisma = ctx.app.prisma;
    await prisma.conversation.deleteMany({ where: { id: { in: createdConversationIds } } });
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    await ctx.app.close();
  });

  async function setup() {
    const [a, b] = await Promise.all([createUser(ctx.app.prisma, "a"), createUser(ctx.app.prisma, "b")]);
    createdUserIds.push(a.id, b.id);
    const conversationId = await makeAcceptedConversation(ctx.app, a.id, b.id);
    createdConversationIds.push(conversationId);
    return { a, b, conversationId };
  }

  it("persists ttlSeconds but leaves expiresAt/firstOpenedAt null — the clock has not started", async () => {
    const { a, conversationId } = await setup();
    const res = await sendText(ctx.app, a.id, conversationId, "waiting to be opened", {
      disappear: { mode: "time", ttlSeconds: 3600 },
    });
    assert.equal(res.statusCode, 201);
    const created = res.json() as { messageId: string; body: string | null; disappear: { mode: string; expiresAt: string | null } };
    assert.equal(created.disappear.mode, "time");
    assert.equal(created.disappear.expiresAt, null, "expiresAt must not be set at send time");

    const row = await ctx.app.prisma.messageDisappearState.findUnique({ where: { messageId: created.messageId } });
    assert.equal(row!.ttlSeconds, 3600, "the chosen duration is persisted even though the clock hasn't started");
    assert.equal(row!.expiresAt, null);
    assert.equal(row!.firstOpenedAt, null);
  });

  it("body is hidden at send — not even the sender sees it, matching views mode's rule", async () => {
    const { a, conversationId } = await setup();
    const res = await sendText(ctx.app, a.id, conversationId, "hidden until opened", {
      disappear: { mode: "time", ttlSeconds: 60 },
    });
    const created = res.json() as { body: string | null };
    assert.equal(created.body, null);
  });

  it("body stays hidden via GET list for both participants before it's ever been opened", async () => {
    const { a, b, conversationId } = await setup();
    const sendRes = await sendText(ctx.app, a.id, conversationId, "hidden until opened", {
      disappear: { mode: "time", ttlSeconds: 60 },
    });
    const messageId = (sendRes.json() as { messageId: string }).messageId;

    for (const viewer of [a, b]) {
      const listRes = await getMessages(ctx.app, viewer.id, conversationId);
      const { messages } = listRes.json() as { messages: Array<{ messageId: string; body: string | null; disappear: { expiresAt: string | null } }> };
      const entry = messages.find((m) => m.messageId === messageId);
      assert.equal(entry!.body, null);
      assert.equal(entry!.disappear.expiresAt, null, "no countdown before it's been opened");
    }
  });
});

describe("POST /api/messages/:messageId/view — time mode (first explicit open starts the clock)", () => {
  let ctx: Awaited<ReturnType<typeof buildTestApp>>;
  const createdUserIds: string[] = [];
  const createdConversationIds: string[] = [];

  before(async () => {
    ctx = await buildTestApp();
  });

  after(async () => {
    const prisma = ctx.app.prisma;
    await prisma.conversation.deleteMany({ where: { id: { in: createdConversationIds } } });
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    await ctx.app.close();
  });

  async function setup(ttlSeconds: number) {
    const [a, b] = await Promise.all([createUser(ctx.app.prisma, "a"), createUser(ctx.app.prisma, "b")]);
    createdUserIds.push(a.id, b.id);
    const conversationId = await makeAcceptedConversation(ctx.app, a.id, b.id);
    createdConversationIds.push(conversationId);
    const sendRes = await sendText(ctx.app, a.id, conversationId, "the timed secret", {
      disappear: { mode: "time", ttlSeconds },
    });
    assert.equal(sendRes.statusCode, 201);
    const messageId = (sendRes.json() as { messageId: string }).messageId;
    return { a, b, conversationId, messageId };
  }

  it("403s the sender opening their own time-mode message — same exclusion as views mode", async () => {
    const { a, messageId } = await setup(3600);
    const res = await viewMessage(ctx.app, a.id, messageId);
    assert.equal(res.statusCode, 403);

    const row = await ctx.app.prisma.messageDisappearState.findUnique({ where: { messageId } });
    assert.equal(row!.firstOpenedAt, null, "a forbidden attempt must never start the clock");
  });

  it("403s a non-participant", async () => {
    const { messageId } = await setup(3600);
    const stranger = await createUser(ctx.app.prisma, "stranger");
    createdUserIds.push(stranger.id);
    const res = await viewMessage(ctx.app, stranger.id, messageId);
    assert.equal(res.statusCode, 403);
  });

  it("the recipient's first open sets firstOpenedAt, computes expiresAt = open time + ttlSeconds, and returns the body", async () => {
    const { b, messageId } = await setup(3600);
    const before = Date.now();
    const res = await viewMessage(ctx.app, b.id, messageId);
    const after = Date.now();

    assert.equal(res.statusCode, 200);
    const payload = res.json() as { mode: string; body: string; expiresAt: string };
    assert.equal(payload.mode, "time");
    assert.equal(payload.body, "the timed secret");

    const expiresAtMs = new Date(payload.expiresAt).getTime();
    // Computed from ttlSeconds relative to whenever the open actually landed
    // server-side — allow the request's own real wall-clock window.
    assert.ok(expiresAtMs >= before + 3600_000 && expiresAtMs <= after + 3600_000 + 1000, "expiresAt must be ~3600s from the open, not from send");

    const row = await ctx.app.prisma.messageDisappearState.findUnique({ where: { messageId } });
    assert.notEqual(row!.firstOpenedAt, null);
    assert.equal(row!.expiresAt!.toISOString(), payload.expiresAt);

    // Opening never itself soft-deletes a time-mode message — only the sweep does.
    const msgRow = await ctx.app.prisma.message.findUnique({ where: { id: messageId } });
    assert.equal(msgRow!.isDeleted, false);
  });

  it("reopening does NOT restart or extend the clock — same expiresAt both times, firstOpenedAt unchanged", async () => {
    const { b, messageId } = await setup(3600);
    const first = await viewMessage(ctx.app, b.id, messageId);
    const firstPayload = first.json() as { expiresAt: string };
    const firstOpenedAt = (await ctx.app.prisma.messageDisappearState.findUnique({ where: { messageId } }))!.firstOpenedAt;

    // A brief real delay so a bug that DID recompute would produce a visibly
    // different (later) expiresAt — not relying on both calls landing in the
    // exact same millisecond to prove nothing moved.
    await new Promise((r) => setTimeout(r, 50));

    const second = await viewMessage(ctx.app, b.id, messageId);
    assert.equal(second.statusCode, 200);
    const secondPayload = second.json() as { mode: string; body: string; expiresAt: string };
    assert.equal(secondPayload.expiresAt, firstPayload.expiresAt, "reopening must return the exact same deadline, not a fresh one");
    assert.equal(secondPayload.body, "the timed secret", "reopening keeps returning the body — it's not a one-time reveal like views mode");

    const row = await ctx.app.prisma.messageDisappearState.findUnique({ where: { messageId } });
    assert.equal(row!.firstOpenedAt!.getTime(), firstOpenedAt!.getTime(), "firstOpenedAt must not be re-stamped on a reopen");
  });

  it("message:disappear:started fires once on the first open, and is not re-fired on a reopen", async () => {
    const { b, conversationId, messageId } = await setup(3600);
    await viewMessage(ctx.app, b.id, messageId);
    const afterFirst = ctx.emitted.filter((e) => e.room === `conversation:${conversationId}` && e.event === "message:disappear:started").length;
    assert.equal(afterFirst, 1);

    await viewMessage(ctx.app, b.id, messageId);
    const afterSecond = ctx.emitted.filter((e) => e.room === `conversation:${conversationId}` && e.event === "message:disappear:started").length;
    assert.equal(afterSecond, 1, "a reopen must not emit a second disappear:started event");
  });

  it("after the first open, GET list also returns the body and expiresAt normally — no budget left to protect", async () => {
    const { a, b, conversationId, messageId } = await setup(3600);
    await viewMessage(ctx.app, b.id, messageId);

    for (const viewer of [a, b]) {
      const listRes = await getMessages(ctx.app, viewer.id, conversationId);
      const { messages } = listRes.json() as { messages: Array<{ messageId: string; body: string | null; disappear: { expiresAt: string | null } }> };
      const entry = messages.find((m) => m.messageId === messageId);
      assert.equal(entry!.body, "the timed secret");
      assert.notEqual(entry!.disappear.expiresAt, null);
    }
  });

  it("400s an open attempt if the disappear row is somehow missing ttlSeconds (data-integrity guard)", async () => {
    const { b, messageId } = await setup(3600);
    // Simulate a corrupt/legacy row rather than relying on being able to
    // construct one through the API (the send route always sets it).
    await ctx.app.prisma.messageDisappearState.update({ where: { messageId }, data: { ttlSeconds: null } });
    const res = await viewMessage(ctx.app, b.id, messageId);
    assert.equal(res.statusCode, 400);
  });
});

describe("DELETE /api/messages/:messageId — manual delete closes out a live disappear row", () => {
  let ctx: Awaited<ReturnType<typeof buildTestApp>>;
  const createdUserIds: string[] = [];
  const createdConversationIds: string[] = [];

  before(async () => {
    ctx = await buildTestApp();
  });

  after(async () => {
    const prisma = ctx.app.prisma;
    await prisma.conversation.deleteMany({ where: { id: { in: createdConversationIds } } });
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    await ctx.app.close();
  });

  it("stamps consumedAt so the sweep never reprocesses a manually-deleted disappearing message", async () => {
    const [a, b] = await Promise.all([createUser(ctx.app.prisma, "a"), createUser(ctx.app.prisma, "b")]);
    createdUserIds.push(a.id, b.id);
    const conversationId = await makeAcceptedConversation(ctx.app, a.id, b.id);
    createdConversationIds.push(conversationId);

    const sendRes = await sendText(ctx.app, a.id, conversationId, "will be deleted early", {
      disappear: { mode: "time", ttlSeconds: 3600 },
    });
    const messageId = (sendRes.json() as { messageId: string }).messageId;

    const delRes = await ctx.app.inject({
      method: "DELETE",
      url: `/api/messages/${messageId}`,
      headers: { cookie: cookieFor(a.id) },
    });
    assert.equal(delRes.statusCode, 204);

    const stateRow = await ctx.app.prisma.messageDisappearState.findUnique({ where: { messageId } });
    assert.notEqual(stateRow!.consumedAt, null);
  });
});

describe("sweepDisappearingMessages (cleanup.worker.ts) — time-mode expiry is gated on having been opened", () => {
  let ctx: Awaited<ReturnType<typeof buildTestApp>>;
  const createdUserIds: string[] = [];
  const createdConversationIds: string[] = [];

  before(async () => {
    ctx = await buildTestApp();
  });

  after(async () => {
    const prisma = ctx.app.prisma;
    await prisma.conversation.deleteMany({ where: { id: { in: createdConversationIds } } });
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    await ctx.app.close();
  });

  async function setup(ttlSeconds: number) {
    const [a, b] = await Promise.all([createUser(ctx.app.prisma, "a"), createUser(ctx.app.prisma, "b")]);
    createdUserIds.push(a.id, b.id);
    const conversationId = await makeAcceptedConversation(ctx.app, a.id, b.id);
    createdConversationIds.push(conversationId);
    const sendRes = await sendText(ctx.app, a.id, conversationId, "ticking clock", {
      disappear: { mode: "time", ttlSeconds },
    });
    const messageId = (sendRes.json() as { messageId: string }).messageId;
    return { a, b, conversationId, messageId };
  }

  function fakeIoDeps() {
    const emitted: { room: string; event: string; payload: unknown }[] = [];
    const io = {
      to: (room: string) => ({ emit: (event: string, payload: unknown) => emitted.push({ room, event, payload }) }),
    } as unknown as import("socket.io").Server;
    return { io, emitted };
  }

  it("a NEVER-opened time-mode message survives indefinitely — the sweep never touches it, no matter how much time has passed", async () => {
    // ttlSeconds=5 (the minimum) — if the sweep incorrectly used createdAt or
    // a send-time deadline, this would already be well overdue.
    const { messageId } = await setup(5);
    // Simulate real elapsed time without ever opening it — createdAt is old,
    // but expiresAt/firstOpenedAt are still null (the send-time state).
    await ctx.app.prisma.message.update({ where: { id: messageId }, data: { createdAt: new Date(Date.now() - 60_000) } });

    const { io } = fakeIoDeps();
    await sweepDisappearingMessages({ prisma: ctx.app.prisma, s3: {} as never, io, log: ctx.app.log as unknown as FastifyBaseLogger });

    const msgRow = await ctx.app.prisma.message.findUnique({ where: { id: messageId } });
    assert.equal(msgRow!.isDeleted, false, "a never-opened message must wait indefinitely — the sweep must never touch it");

    const stateRow = await ctx.app.prisma.messageDisappearState.findUnique({ where: { messageId } });
    assert.equal(stateRow!.consumedAt, null);
    assert.equal(stateRow!.expiresAt, null);
  });

  it("an opened-and-overdue time-mode message is swept: soft-deleted and marked consumed", async () => {
    const { b, conversationId, messageId } = await setup(5);
    // Drive the real open flow first, then backdate the resulting expiresAt
    // to simulate wall-clock time actually passing.
    const openRes = await viewMessage(ctx.app, b.id, messageId);
    assert.equal(openRes.statusCode, 200);
    await ctx.app.prisma.messageDisappearState.update({
      where: { messageId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const { io, emitted } = fakeIoDeps();
    await sweepDisappearingMessages({ prisma: ctx.app.prisma, s3: {} as never, io, log: ctx.app.log as unknown as FastifyBaseLogger });

    const msgRow = await ctx.app.prisma.message.findUnique({ where: { id: messageId } });
    assert.equal(msgRow!.isDeleted, true);
    assert.notEqual(msgRow!.deletedAt, null);

    const stateRow = await ctx.app.prisma.messageDisappearState.findUnique({ where: { messageId } });
    assert.notEqual(stateRow!.consumedAt, null);

    assert.ok(emitted.some((e) => e.room === `conversation:${conversationId}` && e.event === "message:deleted"));
  });

  it("a re-run of the same tick never reprocesses an already-consumed row", async () => {
    const { b, messageId } = await setup(5);
    await viewMessage(ctx.app, b.id, messageId);
    await ctx.app.prisma.messageDisappearState.update({
      where: { messageId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const { io } = fakeIoDeps();
    const deps = { prisma: ctx.app.prisma, s3: {} as never, io, log: ctx.app.log as unknown as FastifyBaseLogger };
    await sweepDisappearingMessages(deps);
    const firstDeletedAt = (await ctx.app.prisma.message.findUnique({ where: { id: messageId } }))!.deletedAt;

    await sweepDisappearingMessages(deps);
    const secondDeletedAt = (await ctx.app.prisma.message.findUnique({ where: { id: messageId } }))!.deletedAt;
    assert.equal(firstDeletedAt!.getTime(), secondDeletedAt!.getTime(), "a second tick must not touch an already-consumed row");
  });
});
