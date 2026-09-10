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

function pinMessage(app: Awaited<ReturnType<typeof buildTestApp>>, callerId: string, messageId: string) {
  return app.inject({
    method: "POST",
    url: `/api/messages/${messageId}/pin`,
    headers: { cookie: cookieFor(callerId) },
  });
}

function unpinMessage(app: Awaited<ReturnType<typeof buildTestApp>>, callerId: string, messageId: string) {
  return app.inject({
    method: "DELETE",
    url: `/api/messages/${messageId}/pin`,
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

describe("POST /api/messages/:messageId/pin", () => {
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
    const { messageId } = await setup();
    const outsider = await createUser(app.prisma, "outsider");
    createdUserIds.push(outsider.id);

    const res = await pinMessage(app, outsider.id, messageId);
    assert.equal(res.statusCode, 403);

    const row = await app.prisma.pinnedMessage.findUnique({ where: { messageId } });
    assert.equal(row, null);
  });

  it("lets the RECIPIENT (not just the sender) pin a message — either participant can pin any message", async () => {
    const { b, conversationId, messageId } = await setup();
    const res = await pinMessage(app, b.id, messageId);
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

  // The route no longer takes a conversationId path param (see
  // message.routes.ts), so the old "messageId belongs to a different
  // conversation than the one named in the path" mismatch this test used to
  // guard against can no longer be constructed at all — conversationId is
  // now derived exclusively from the message's own row. The equivalent
  // not-found coverage for the flat route is a messageId that doesn't exist.
  it("404s pinning a message that doesn't exist", async () => {
    const { a } = await setup();
    const res = await pinMessage(app, a.id, randomUUID());
    assert.equal(res.statusCode, 404);
  });

  it("422s pinning an already-deleted message", async () => {
    const { a, messageId } = await setup();
    const delRes = await deleteMessage(app, a.id, messageId);
    assert.equal(delRes.statusCode, 204);

    const res = await pinMessage(app, a.id, messageId);
    assert.equal(res.statusCode, 422);
  });

  it("409s re-pinning an already-pinned message (unique messageId constraint)", async () => {
    const { a, messageId } = await setup();
    const first = await pinMessage(app, a.id, messageId);
    assert.equal(first.statusCode, 201);

    const second = await pinMessage(app, a.id, messageId);
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
      const pinRes = await pinMessage(app, a.id, mid);
      assert.equal(pinRes.statusCode, 201, `expected pin #${i} to succeed`);
    }

    const overflowRes = await sendText(app, a.id, conversationId, "one too many");
    const overflowId = (overflowRes.json() as { messageId: string }).messageId;
    const res = await pinMessage(app, a.id, overflowId);
    assert.equal(res.statusCode, 409);
    assert.match(res.json().detail as string, /unpin one first/i);

    const count = await app.prisma.pinnedMessage.count({ where: { conversationId } });
    assert.equal(count, MAX_PINNED_MESSAGES, "the rejected 4th pin must not have been created");

    // Unpinning one frees a slot for a new pin.
    const unpinRes = await unpinMessage(app, a.id, messageIds[0]!);
    assert.equal(unpinRes.statusCode, 204);
    const retryRes = await pinMessage(app, a.id, overflowId);
    assert.equal(retryRes.statusCode, 201);
  });

  // Two concurrent pins on DIFFERENT messages in the same conversation both
  // read pinnedMessage.count() before either commits — the exact write-skew
  // shape Postgres's SERIALIZABLE isolation exists to catch, so one of the
  // two transactions reliably gets aborted with a real write conflict (P2034)
  // even though there is room for both (empirically confirmed directly
  // against Postgres before writing this fix — not assumed). Before the fix,
  // that abort surfaced immediately as a 409 "another pin just landed" with
  // no retry, even though the client did nothing wrong and there was no real
  // capacity problem. Same concurrent-fire technique as the clientMessageId
  // race test in message.routes.test.ts (P2002) and the reaction toggle race
  // in the same file (P2002/P2025) — fire both requests via Promise.all
  // without awaiting either first, which is what actually produces the race
  // window; two sequential awaited calls would never collide.
  it("two concurrent pins with room for both both resolve 201 via retry, instead of one spuriously 409ing", async () => {
    const { a, conversationId, messageId: firstMessageId } = await setup();
    const secondRes = await sendText(app, a.id, conversationId, "second candidate");
    const secondMessageId = (secondRes.json() as { messageId: string }).messageId;

    const [resA, resB] = await Promise.all([
      pinMessage(app, a.id, firstMessageId),
      pinMessage(app, a.id, secondMessageId),
    ]);

    assert.notEqual(resA.statusCode, 500);
    assert.notEqual(resB.statusCode, 500);
    assert.equal(resA.statusCode, 201, `expected both pins to succeed, got ${resA.statusCode}: ${JSON.stringify(resA.json())}`);
    assert.equal(resB.statusCode, 201, `expected both pins to succeed, got ${resB.statusCode}: ${JSON.stringify(resB.json())}`);

    const count = await app.prisma.pinnedMessage.count({ where: { conversationId } });
    assert.equal(count, 2, "both concurrent pins must have actually landed, not just returned 201");
  });

  // Same race, but staged right at the cap boundary (MAX_PINNED_MESSAGES - 1
  // already pinned, exactly one slot left) — confirms the retry doesn't let
  // the cap itself get bypassed: exactly one of the two racing pins gets the
  // last slot, and the loser's retry re-reads the now-current count and
  // correctly reports the cap error (not a raw conflict, and not a second
  // successful pin past the cap).
  it("two concurrent pins racing for the LAST slot: exactly one lands, the other gets a clean cap error", async () => {
    const { a, conversationId } = await setup();
    for (let i = 0; i < MAX_PINNED_MESSAGES - 1; i++) {
      const sendRes = await sendText(app, a.id, conversationId, `filler ${i}`);
      const mid = (sendRes.json() as { messageId: string }).messageId;
      const pinRes = await pinMessage(app, a.id, mid);
      assert.equal(pinRes.statusCode, 201, `expected filler pin #${i} to succeed`);
    }

    const raceA = await sendText(app, a.id, conversationId, "race candidate A");
    const raceB = await sendText(app, a.id, conversationId, "race candidate B");
    const raceMessageIdA = (raceA.json() as { messageId: string }).messageId;
    const raceMessageIdB = (raceB.json() as { messageId: string }).messageId;

    const [resA, resB] = await Promise.all([
      pinMessage(app, a.id, raceMessageIdA),
      pinMessage(app, a.id, raceMessageIdB),
    ]);

    const codes = [resA.statusCode, resB.statusCode].sort();
    assert.deepEqual(codes, [201, 409], `expected exactly one winner and one clean cap rejection, got ${JSON.stringify(codes)}`);

    const loser = resA.statusCode === 409 ? resA : resB;
    assert.match(
      loser.json().detail as string,
      /unpin one first/i,
      "the retry should surface the real cap error, not the transient 'another pin just landed' message",
    );

    const count = await app.prisma.pinnedMessage.count({ where: { conversationId } });
    assert.equal(count, MAX_PINNED_MESSAGES, "the cap must still hold exactly — not under- or over-filled");
  });
});

describe("DELETE /api/messages/:messageId/pin", () => {
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
    const pinRes = await pinMessage(app, a.id, messageId);
    assert.equal(pinRes.statusCode, 201);
    return { a, b, conversationId, messageId };
  }

  it("lets the RECIPIENT unpin a message pinned by the sender — either participant can unpin any message", async () => {
    const { b, messageId } = await setup();
    const res = await unpinMessage(app, b.id, messageId);
    assert.equal(res.statusCode, 204);

    const row = await app.prisma.pinnedMessage.findUnique({ where: { messageId } });
    assert.equal(row, null);
  });

  it("403s a non-participant", async () => {
    const { messageId } = await setup();
    const outsider = await createUser(app.prisma, "outsider");
    createdUserIds.push(outsider.id);

    const res = await unpinMessage(app, outsider.id, messageId);
    assert.equal(res.statusCode, 403);

    const row = await app.prisma.pinnedMessage.findUnique({ where: { messageId } });
    assert.ok(row, "a rejected unpin must not remove the pin");
  });

  it("404s unpinning a message that isn't pinned", async () => {
    const { a, conversationId } = await setup();
    const sendRes = await sendText(app, a.id, conversationId, "never pinned");
    const messageId = (sendRes.json() as { messageId: string }).messageId;

    const res = await unpinMessage(app, a.id, messageId);
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

    assert.equal((await pinMessage(app, a.id, firstId)).statusCode, 201);
    assert.equal((await pinMessage(app, b.id, secondId)).statusCode, 201);

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

    const pinRes = await pinMessage(app, b.id, messageId);
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
    assert.equal((await pinMessage(app, a.id, pinnedId)).statusCode, 201);

    const unpinnedRes = await sendText(app, a.id, conversationId, "never pinned");
    const unpinnedId = (unpinnedRes.json() as { messageId: string }).messageId;

    const delRes = await deleteMessage(app, a.id, unpinnedId);
    assert.equal(delRes.statusCode, 204);

    const stillPinned = await app.prisma.pinnedMessage.findUnique({ where: { messageId: pinnedId } });
    assert.ok(stillPinned, "an unrelated pin must survive another message's deletion");
  });
});
