import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import Fastify, { type FastifyError } from "fastify";
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

// Real integration test — real Postgres/Redis (the throwaway CI services), not
// hand-rolled mocks. Deliberately does NOT import buildServer()/server.ts (see
// media.routes.test.ts for why: an unrelated, pre-existing, already-committed
// void main() module-scope side effect boots a second real server on import).
// Builds only the plugins the text-send route needs.
async function buildTestApp() {
  const app = Fastify({ logger: false })
    .setValidatorCompiler(TypeBoxValidatorCompiler)
    .withTypeProvider<TypeBoxTypeProvider>();

  await app.register(cookie);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);

  // The route reads fastify.io for online-presence checks and to broadcast
  // message:new. Stub it — real socket delivery isn't what this test covers.
  app.decorate(
    "io",
    {
      sockets: { adapter: { rooms: new Map<string, { size: number }>() } },
      to: () => ({ emit: () => {} }),
    } as unknown as import("fastify").FastifyInstance["io"],
  );

  // Mirrors server.ts's problem-details error handler — without it, thrown
  // ProblemErrors (403/404/etc.) would fall through to Fastify's generic 500,
  // which would make it impossible to tell "correctly rejected" from "the
  // route crashed" in this test.
  app.setErrorHandler((rawErr, _req, reply) => {
    // TypeBox provider widens the err type to unknown; narrow here so we can
    // read Fastify's standard `validation` field (mirrors server.ts).
    const err = rawErr as FastifyError;
    if (err instanceof ProblemError) return problemResponse(reply, err.code, err.detail);
    if (err.validation) {
      return problemResponse(reply, "validation_error", err.validation[0]?.message ?? "Request failed validation.");
    }
    throw err;
  });

  await app.register(messageRoutes, { prefix: "/api" });
  return app;
}

// message.routes.ts imports voiceQueue from media.queue.ts (which evaluates
// mediaQueue/videoQueue/voiceQueue together) and pushQueue transitively via
// services/push-notify.ts. Each opens an ioredis connection at module-load
// time regardless of whether .add() is ever called — left open, `node --test`
// never exits (mirrors calls.service.test.ts's identical workaround).
after(async () => {
  const [{ mediaQueue, videoQueue, voiceQueue }, { pushQueue }] = await Promise.all([
    import("../../queues/media.queue.js"),
    import("../../queues/push.queue.js"),
  ]);
  await Promise.all([mediaQueue.close(), videoQueue.close(), voiceQueue.close(), pushQueue.close()]);
});

describe("POST /api/conversations/:conversationId/messages — clientMessageId idempotency race", () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>;
  let senderId: string;
  let recipientId: string;
  let conversationId: string;
  const clientMessageId = randomUUID();

  before(async () => {
    app = await buildTestApp();
    const prisma = app.prisma;

    const suffix = randomUUID().slice(0, 8);
    const passwordHash = "not-a-real-hash"; // login isn't exercised — tokens are minted directly below
    const passwordSalt = randomBytes(32).toString("hex"); // matches passwordSalt @db.Char(64)

    const [sender, recipient] = await Promise.all([
      prisma.user.create({ data: { username: `race-sender-${suffix}`, passwordHash, passwordSalt } }),
      prisma.user.create({ data: { username: `race-recipient-${suffix}`, passwordHash, passwordSalt } }),
    ]);
    senderId = sender.id;
    recipientId = recipient.id;

    const conversation = await prisma.conversation.create({ data: {} });
    conversationId = conversation.id;
    await prisma.participant.createMany({
      data: [
        { userId: senderId, conversationId, acceptedAt: new Date() },
        { userId: recipientId, conversationId, acceptedAt: new Date() },
      ],
    });
  });

  after(async () => {
    const prisma = app.prisma;
    await prisma.message.deleteMany({ where: { conversationId } });
    await prisma.participant.deleteMany({ where: { conversationId } });
    await prisma.conversation.delete({ where: { id: conversationId } });
    await prisma.user.deleteMany({ where: { id: { in: [senderId, recipientId] } } });
    await app.close();
  });

  function cookieFor(userId: string): string {
    const { token } = signAccessToken(userId);
    return `${ACCESS_COOKIE}=${token}`;
  }

  it("two concurrent identical sends (same clientMessageId) resolve exactly one 201 and one 200 for the same messageId, never a 500", async () => {
    const payload = { body: "concurrent retry test", clientMessageId };
    const fire = () =>
      app.inject({
        method: "POST",
        url: `/api/conversations/${conversationId}/messages`,
        headers: { cookie: cookieFor(senderId), "content-type": "application/json" },
        payload,
      });

    // Fire both without awaiting either first — this is what actually exercises
    // the race window. Two sequential awaited calls would just hit the
    // fast-path idempotency check (findExistingByClientMessageId) on the
    // second call and never reach the P2002 path at all — a false-positive
    // pass even against the broken code.
    const [resA, resB] = await Promise.all([fire(), fire()]);

    assert.notEqual(resA.statusCode, 500);
    assert.notEqual(resB.statusCode, 500);
    // The race's winner genuinely creates the row (201); the loser hits the
    // P2002 recovery path and replays the winner's message back — that's an
    // idempotent "found existing", so it must report 200, not 201 (see
    // existingMessageResponse's two call sites in message.routes.ts). Order
    // is nondeterministic, so compare the pair, not either side by itself.
    assert.deepEqual([resA.statusCode, resB.statusCode].sort(), [200, 201]);

    const bodyA = resA.json() as { messageId: string; body: string };
    const bodyB = resB.json() as { messageId: string; body: string };
    assert.equal(bodyA.messageId, bodyB.messageId);
    assert.equal(bodyA.body, "concurrent retry test");
    assert.equal(bodyB.body, "concurrent retry test");

    const count = await app.prisma.message.count({ where: { conversationId, clientMessageId } });
    assert.equal(count, 1);
  });

  it("a sequential resend of the same clientMessageId hits the fast idempotency path and returns 200 with the original message", async () => {
    const clientMessageId2 = randomUUID();
    const first = await app.inject({
      method: "POST",
      url: `/api/conversations/${conversationId}/messages`,
      headers: { cookie: cookieFor(senderId), "content-type": "application/json" },
      payload: { body: "sequential retry test", clientMessageId: clientMessageId2 },
    });
    assert.equal(first.statusCode, 201);
    const firstBody = first.json() as { messageId: string };

    const second = await app.inject({
      method: "POST",
      url: `/api/conversations/${conversationId}/messages`,
      headers: { cookie: cookieFor(senderId), "content-type": "application/json" },
      payload: { body: "sequential retry test", clientMessageId: clientMessageId2 },
    });
    assert.equal(second.statusCode, 200);
    const secondBody = second.json() as { messageId: string };
    assert.equal(secondBody.messageId, firstBody.messageId);

    const count = await app.prisma.message.count({ where: { conversationId, clientMessageId: clientMessageId2 } });
    assert.equal(count, 1);
  });
});

describe("POST /api/messages/:messageId/attachments/:attachmentId/transcribe — status codes", () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>;
  let userId: string;
  let conversationId: string;
  const createdMediaIds: string[] = [];
  const createdMessageIds: string[] = [];

  before(async () => {
    app = await buildTestApp();
    const prisma = app.prisma;

    const suffix = randomUUID().slice(0, 8);
    const passwordHash = "not-a-real-hash";
    const passwordSalt = randomBytes(32).toString("hex");
    const user = await prisma.user.create({
      data: { username: `transcribe-${suffix}`, passwordHash, passwordSalt },
    });
    userId = user.id;

    const conversation = await prisma.conversation.create({ data: {} });
    conversationId = conversation.id;
    await prisma.participant.create({ data: { userId, conversationId, acceptedAt: new Date() } });
  });

  after(async () => {
    const prisma = app.prisma;
    await prisma.messageAttachment.deleteMany({ where: { messageId: { in: createdMessageIds } } });
    await prisma.message.deleteMany({ where: { id: { in: createdMessageIds } } });
    await prisma.media.deleteMany({ where: { id: { in: createdMediaIds } } });
    await prisma.participant.deleteMany({ where: { conversationId } });
    await prisma.conversation.delete({ where: { id: conversationId } });
    await prisma.user.delete({ where: { id: userId } });
    await app.close();
  });

  function cookieFor(id: string): string {
    const { token } = signAccessToken(id);
    return `${ACCESS_COOKIE}=${token}`;
  }

  async function createVoiceAttachment(transcriptStatus: string | null, transcript: unknown = null) {
    const suffix = randomUUID().slice(0, 8);
    const media = await app.prisma.media.create({
      data: {
        uploaderId: userId,
        storageKey: `voice/test/${suffix}.opus`,
        mimeType: "audio/opus",
        sizeBytes: 1024,
        transcriptStatus,
        transcript: transcript as never,
      },
    });
    createdMediaIds.push(media.id);
    const message = await app.prisma.message.create({
      data: { conversationId, senderId: userId, type: "AUDIO", body: null },
    });
    createdMessageIds.push(message.id);
    const attachment = await app.prisma.messageAttachment.create({
      data: { messageId: message.id, mediaId: media.id, type: "voice" },
    });
    return { mediaId: media.id, messageId: message.id, attachmentId: attachment.id };
  }

  it("returns 200 {status:\"ready\"} — not 202 — when the attachment is already transcribed (idempotent no-op, no new job enqueued)", async () => {
    const { messageId, attachmentId, mediaId } = await createVoiceAttachment("ready", {
      segments: [], fullText: "already done", primaryLanguage: "en",
    });

    const res = await app.inject({
      method: "POST",
      url: `/api/messages/${messageId}/attachments/${attachmentId}/transcribe`,
      headers: { cookie: cookieFor(userId) },
    });

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { status: "ready" });

    // No new job was enqueued — the row's status must be left exactly as-is,
    // not reset to "pending" the way the genuine-enqueue branch would.
    const media = await app.prisma.media.findUnique({ where: { id: mediaId } });
    assert.equal(media!.transcriptStatus, "ready");
  });

  it("returns 202 {status:\"pending\"} when transcription is genuinely enqueued for the first time", async () => {
    const { messageId, attachmentId, mediaId } = await createVoiceAttachment(null);

    const res = await app.inject({
      method: "POST",
      url: `/api/messages/${messageId}/attachments/${attachmentId}/transcribe`,
      headers: { cookie: cookieFor(userId) },
    });

    assert.equal(res.statusCode, 202);
    assert.deepEqual(res.json(), { status: "pending" });

    const media = await app.prisma.media.findUnique({ where: { id: mediaId } });
    assert.equal(media!.transcriptStatus, "pending");
  });
});

// Standardized to 100 across every paginated GET (conversations, messages,
// media gallery, notifications, users/search) — previously an arbitrary
// per-module 50/60/100.
describe("GET /api/conversations/:conversationId/messages — limit query param ceiling", () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>;
  let userId: string;
  let conversationId: string;

  before(async () => {
    app = await buildTestApp();
    const prisma = app.prisma;

    const suffix = randomUUID().slice(0, 8);
    const user = await prisma.user.create({
      data: { username: `msg-limit-${suffix}`, passwordHash: "not-a-real-hash", passwordSalt: randomBytes(32).toString("hex") },
    });
    userId = user.id;

    const conversation = await prisma.conversation.create({ data: {} });
    conversationId = conversation.id;
    await prisma.participant.create({ data: { userId, conversationId, acceptedAt: new Date() } });
  });

  after(async () => {
    const prisma = app.prisma;
    await prisma.participant.deleteMany({ where: { conversationId } });
    await prisma.conversation.delete({ where: { id: conversationId } });
    await prisma.user.delete({ where: { id: userId } });
    await app.close();
  });

  function cookieFor(id: string): string {
    const { token } = signAccessToken(id);
    return `${ACCESS_COOKIE}=${token}`;
  }

  it("accepts limit=100 (the standardized maximum)", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/conversations/${conversationId}/messages?limit=100`,
      headers: { cookie: cookieFor(userId) },
    });
    assert.equal(res.statusCode, 200);
  });

  it("rejects limit=101 (one above the standardized maximum)", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/conversations/${conversationId}/messages?limit=101`,
      headers: { cookie: cookieFor(userId) },
    });
    assert.equal(res.statusCode, 422);
  });
});
