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
import { signAccessToken } from "../../backend-core/auth/tokens.js";
import { ACCESS_COOKIE } from "../../backend-core/auth/cookies.js";
import { MAX_PINNED_MESSAGES, type PinnedMessage } from "@relay/contracts";
import type { PrismaClient } from "@prisma/client";

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

  app.decorate(
    "io",
    {
      sockets: { adapter: { rooms: new Map<string, { size: number }>() } },
      to: () => ({ emit: () => {} }),
    } as unknown as import("fastify").FastifyInstance["io"],
  );
  app.decorate("getMediaUrl", async (key: string) => `https://fake.example/${key}`);

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ProblemError) return problemResponse(reply, err.code, err.detail);
    throw err;
  });

  await app.register(messageRoutes, { prefix: "/api" });
  return app;
}

// message.routes.ts imports voiceQueue from media.queue.ts (which evaluates
// mediaQueue/videoQueue/voiceQueue together) and pushQueue transitively via
// services/push-notify.ts. Each opens an ioredis connection at module-load
// time regardless of whether .add() is ever called — left open, `node --test`
// never exits (mirrors message-softdelete.routes.test.ts's identical
// workaround).
after(async () => {
  const [{ mediaQueue, videoQueue, voiceQueue }, { pushQueue }] = await Promise.all([
    import("../../queues/media.queue.js"),
    import("../../queues/push.queue.js"),
  ]);
  await Promise.all([mediaQueue.close(), videoQueue.close(), voiceQueue.close(), pushQueue.close()]);
});

function cookieFor(userId: string): string {
  const { token } = signAccessToken(userId);
  return `${ACCESS_COOKIE}=${token}`;
}

async function createUser(prisma: PrismaClient, label: string) {
  const suffix = randomUUID().slice(0, 8);
  return prisma.user.create({
    data: {
      username: `msg-pin-${label}-${suffix}`,
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

function sendText(
  app: Awaited<ReturnType<typeof buildTestApp>>,
  callerId: string,
  conversationId: string,
  body: string,
) {
  return app.inject({
    method: "POST",
    url: `/api/conversations/${conversationId}/messages`,
    headers: { cookie: cookieFor(callerId), "content-type": "application/json" },
    payload: { body },
  });
}

function deleteMessage(app: Awaited<ReturnType<typeof buildTestApp>>, callerId: string, messageId: string) {
  return app.inject({
    method: "DELETE",
    url: `/api/messages/${messageId}`,
    headers: { cookie: cookieFor(callerId) },
  });
}

function pinMessage(
  app: Awaited<ReturnType<typeof buildTestApp>>,
  callerId: string,
  conversationId: string,
  messageId: string,
) {
  return app.inject({
    method: "POST",
    url: `/api/conversations/${conversationId}/messages/${messageId}/pin`,
    headers: { cookie: cookieFor(callerId) },
  });
}

function unpinMessage(
  app: Awaited<ReturnType<typeof buildTestApp>>,
  callerId: string,
  conversationId: string,
  messageId: string,
) {
  return app.inject({
    method: "DELETE",
    url: `/api/conversations/${conversationId}/messages/${messageId}/pin`,
    headers: { cookie: cookieFor(callerId) },
  });
}

function listPins(app: Awaited<ReturnType<typeof buildTestApp>>, callerId: string, conversationId: string) {
  return app.inject({
    method: "GET",
    url: `/api/conversations/${conversationId}/pins`,
    headers: { cookie: cookieFor(callerId) },
  });
}

describe("POST /api/conversations/:id/messages/:messageId/pin", () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>;
  const createdUserIds: string[] = [];
  const createdConversationIds: string[] = [];

  before(async () => {
    app = await buildTestApp();
  });

  after(async () => {
    const prisma = app.prisma;
    await prisma.conversation.deleteMany({ where: { id: { in: createdConversationIds } } }); // cascades participants + messages + pins
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    await app.close();
  });

  async function setup() {
    const [a, b] = await Promise.all([createUser(app.prisma, "a"), createUser(app.prisma, "b")]);
    createdUserIds.push(a.id, b.id);
    const conversationId = await makeAcceptedConversation(app, a.id, b.id);
    createdConversationIds.push(conversationId);
    const sendRes = await sendText(app, a.id, conversationId, "pin me");
    assert.equal(sendRes.statusCode, 201);
    const messageId = (sendRes.json() as { messageId: string }).messageId;
    return { a, b, conversationId, messageId };
  }

  it("403s a non-participant", async () => {
    const { conversationId, messageId } = await setup();
    const outsider = await createUser(app.prisma, "outsider");
    createdUserIds.push(outsider.id);

    const res = await pinMessage(app, outsider.id, conversationId, messageId);
    assert.equal(res.statusCode, 403);

    const row = await app.prisma.pinnedMessage.findUnique({ where: { messageId } });
    assert.equal(row, null);
  });

  it("lets the RECIPIENT (not just the sender) pin a message — either participant can pin any message", async () => {
    const { b, conversationId, messageId } = await setup();
    const res = await pinMessage(app, b.id, conversationId, messageId);
    assert.equal(res.statusCode, 201);

    const body = res.json() as PinnedMessage;
    assert.equal(body.messageId, messageId);
    assert.equal(body.conversationId, conversationId);
    assert.equal(body.pinnedBy, b.id);
    assert.equal(typeof body.pinnedByUsername, "string");
    assert.equal(body.message.body, "pin me");

    const row = await app.prisma.pinnedMessage.findUnique({ where: { messageId } });
    assert.ok(row);
    assert.equal(row!.pinnedBy, b.id);
  });

  it("404s pinning a message that doesn't belong to this conversation", async () => {
    const { a, conversationId } = await setup();
    const c = await createUser(app.prisma, "c");
    createdUserIds.push(c.id);
    const otherConversationId = await makeAcceptedConversation(app, a.id, c.id);
    createdConversationIds.push(otherConversationId);

    const otherMsgRes = await sendText(app, a.id, otherConversationId, "wrong thread");
    const otherMessageId = (otherMsgRes.json() as { messageId: string }).messageId;

    const res = await pinMessage(app, a.id, conversationId, otherMessageId);
    assert.equal(res.statusCode, 404);
  });

  it("422s pinning an already-deleted message", async () => {
    const { a, conversationId, messageId } = await setup();
    const delRes = await deleteMessage(app, a.id, messageId);
    assert.equal(delRes.statusCode, 204);

    const res = await pinMessage(app, a.id, conversationId, messageId);
    assert.equal(res.statusCode, 422);
  });

  it("409s re-pinning an already-pinned message (unique messageId constraint)", async () => {
    const { a, conversationId, messageId } = await setup();
    const first = await pinMessage(app, a.id, conversationId, messageId);
    assert.equal(first.statusCode, 201);

    const second = await pinMessage(app, a.id, conversationId, messageId);
    assert.equal(second.statusCode, 409);

    const count = await app.prisma.pinnedMessage.count({ where: { messageId } });
    assert.equal(count, 1);
  });

  it(`enforces the cap of ${MAX_PINNED_MESSAGES} pinned messages per conversation, rejecting the ${MAX_PINNED_MESSAGES + 1}th with a clear error`, async () => {
    const { a, conversationId } = await setup();
    const messageIds: string[] = [];
    for (let i = 0; i < MAX_PINNED_MESSAGES; i++) {
      const sendRes = await sendText(app, a.id, conversationId, `pin candidate ${i}`);
      const mid = (sendRes.json() as { messageId: string }).messageId;
      messageIds.push(mid);
      const pinRes = await pinMessage(app, a.id, conversationId, mid);
      assert.equal(pinRes.statusCode, 201, `expected pin #${i} to succeed`);
    }

    const overflowRes = await sendText(app, a.id, conversationId, "one too many");
    const overflowId = (overflowRes.json() as { messageId: string }).messageId;
    const res = await pinMessage(app, a.id, conversationId, overflowId);
    assert.equal(res.statusCode, 409);
    assert.match(res.json().detail as string, /unpin one first/i);

    const count = await app.prisma.pinnedMessage.count({ where: { conversationId } });
    assert.equal(count, MAX_PINNED_MESSAGES, "the rejected 4th pin must not have been created");

    // Unpinning one frees a slot for a new pin.
    const unpinRes = await unpinMessage(app, a.id, conversationId, messageIds[0]!);
    assert.equal(unpinRes.statusCode, 204);
    const retryRes = await pinMessage(app, a.id, conversationId, overflowId);
    assert.equal(retryRes.statusCode, 201);
  });
});

describe("DELETE /api/conversations/:id/messages/:messageId/pin", () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>;
  const createdUserIds: string[] = [];
  const createdConversationIds: string[] = [];

  before(async () => {
    app = await buildTestApp();
  });

  after(async () => {
    const prisma = app.prisma;
    await prisma.conversation.deleteMany({ where: { id: { in: createdConversationIds } } });
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    await app.close();
  });

  async function setup() {
    const [a, b] = await Promise.all([createUser(app.prisma, "a"), createUser(app.prisma, "b")]);
    createdUserIds.push(a.id, b.id);
    const conversationId = await makeAcceptedConversation(app, a.id, b.id);
    createdConversationIds.push(conversationId);
    const sendRes = await sendText(app, a.id, conversationId, "pin me");
    const messageId = (sendRes.json() as { messageId: string }).messageId;
    const pinRes = await pinMessage(app, a.id, conversationId, messageId);
    assert.equal(pinRes.statusCode, 201);
    return { a, b, conversationId, messageId };
  }

  it("lets the RECIPIENT unpin a message pinned by the sender — either participant can unpin any message", async () => {
    const { b, conversationId, messageId } = await setup();
    const res = await unpinMessage(app, b.id, conversationId, messageId);
    assert.equal(res.statusCode, 204);

    const row = await app.prisma.pinnedMessage.findUnique({ where: { messageId } });
    assert.equal(row, null);
  });

  it("403s a non-participant", async () => {
    const { conversationId, messageId } = await setup();
    const outsider = await createUser(app.prisma, "outsider");
    createdUserIds.push(outsider.id);

    const res = await unpinMessage(app, outsider.id, conversationId, messageId);
    assert.equal(res.statusCode, 403);

    const row = await app.prisma.pinnedMessage.findUnique({ where: { messageId } });
    assert.ok(row, "a rejected unpin must not remove the pin");
  });

  it("404s unpinning a message that isn't pinned", async () => {
    const { a, conversationId } = await setup();
    const sendRes = await sendText(app, a.id, conversationId, "never pinned");
    const messageId = (sendRes.json() as { messageId: string }).messageId;

    const res = await unpinMessage(app, a.id, conversationId, messageId);
    assert.equal(res.statusCode, 404);
  });
});

describe("GET /api/conversations/:id/pins", () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>;
  const createdUserIds: string[] = [];
  const createdConversationIds: string[] = [];

  before(async () => {
    app = await buildTestApp();
  });

  after(async () => {
    const prisma = app.prisma;
    await prisma.conversation.deleteMany({ where: { id: { in: createdConversationIds } } });
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    await app.close();
  });

  it("lists pinned messages ordered most-recently-pinned first", async () => {
    const [a, b] = await Promise.all([createUser(app.prisma, "a"), createUser(app.prisma, "b")]);
    createdUserIds.push(a.id, b.id);
    const conversationId = await makeAcceptedConversation(app, a.id, b.id);
    createdConversationIds.push(conversationId);

    const first = await sendText(app, a.id, conversationId, "first");
    const firstId = (first.json() as { messageId: string }).messageId;
    const second = await sendText(app, b.id, conversationId, "second");
    const secondId = (second.json() as { messageId: string }).messageId;

    assert.equal((await pinMessage(app, a.id, conversationId, firstId)).statusCode, 201);
    assert.equal((await pinMessage(app, b.id, conversationId, secondId)).statusCode, 201);

    const res = await listPins(app, a.id, conversationId);
    assert.equal(res.statusCode, 200);
    const { pins } = res.json() as { pins: PinnedMessage[] };
    assert.equal(pins.length, 2);
    assert.equal(pins[0]!.messageId, secondId, "the most recently pinned message should be first");
    assert.equal(pins[1]!.messageId, firstId);
  });

  it("403s a non-participant", async () => {
    const [a, b] = await Promise.all([createUser(app.prisma, "a2"), createUser(app.prisma, "b2")]);
    createdUserIds.push(a.id, b.id);
    const conversationId = await makeAcceptedConversation(app, a.id, b.id);
    createdConversationIds.push(conversationId);
    const outsider = await createUser(app.prisma, "outsider2");
    createdUserIds.push(outsider.id);

    const res = await listPins(app, outsider.id, conversationId);
    assert.equal(res.statusCode, 403);
  });
});

// Regression guard for exactly the class of soft-delete consistency bug this
// module has already had to fix multiple times (reply-to preview, lastMessage,
// read receipts, EventOutbox FK): a soft-deleted message must not leave a
// PinnedMessage row pointing at now-invisible content.
describe("Soft-delete consistency — DELETE /api/messages/:messageId auto-unpins", () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>;
  const createdUserIds: string[] = [];
  const createdConversationIds: string[] = [];

  before(async () => {
    app = await buildTestApp();
  });

  after(async () => {
    const prisma = app.prisma;
    await prisma.conversation.deleteMany({ where: { id: { in: createdConversationIds } } });
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    await app.close();
  });

  it("deleting a pinned message removes its PinnedMessage row instead of leaving it dangling", async () => {
    const [a, b] = await Promise.all([createUser(app.prisma, "a"), createUser(app.prisma, "b")]);
    createdUserIds.push(a.id, b.id);
    const conversationId = await makeAcceptedConversation(app, a.id, b.id);
    createdConversationIds.push(conversationId);

    const sendRes = await sendText(app, a.id, conversationId, "about to be pinned then deleted");
    const messageId = (sendRes.json() as { messageId: string }).messageId;

    const pinRes = await pinMessage(app, b.id, conversationId, messageId);
    assert.equal(pinRes.statusCode, 201);
    assert.ok(await app.prisma.pinnedMessage.findUnique({ where: { messageId } }), "sanity check: pin exists before delete");

    const delRes = await deleteMessage(app, a.id, messageId);
    assert.equal(delRes.statusCode, 204);

    const pinAfter = await app.prisma.pinnedMessage.findUnique({ where: { messageId } });
    assert.equal(pinAfter, null, "the PinnedMessage row must be gone, not left pointing at a deleted message");

    // The freed slot must count toward the cap immediately — no orphaned
    // count left behind by the deleted pin.
    const listRes = await listPins(app, a.id, conversationId);
    const { pins } = listRes.json() as { pins: PinnedMessage[] };
    assert.equal(pins.length, 0);
  });

  it("deleting a message that was never pinned is a no-op for pins (doesn't throw, doesn't touch other pins)", async () => {
    const [a, b] = await Promise.all([createUser(app.prisma, "a2"), createUser(app.prisma, "b2")]);
    createdUserIds.push(a.id, b.id);
    const conversationId = await makeAcceptedConversation(app, a.id, b.id);
    createdConversationIds.push(conversationId);

    const pinnedRes = await sendText(app, a.id, conversationId, "stays pinned");
    const pinnedId = (pinnedRes.json() as { messageId: string }).messageId;
    assert.equal((await pinMessage(app, a.id, conversationId, pinnedId)).statusCode, 201);

    const unpinnedRes = await sendText(app, a.id, conversationId, "never pinned");
    const unpinnedId = (unpinnedRes.json() as { messageId: string }).messageId;

    const delRes = await deleteMessage(app, a.id, unpinnedId);
    assert.equal(delRes.statusCode, 204);

    const stillPinned = await app.prisma.pinnedMessage.findUnique({ where: { messageId: pinnedId } });
    assert.ok(stillPinned, "an unrelated pin must survive another message's deletion");
  });
});
