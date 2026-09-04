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

  it("two concurrent identical sends (same clientMessageId) both resolve 201 with the same messageId, never a 500", async () => {
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
    assert.equal(resA.statusCode, 201);
    assert.equal(resB.statusCode, 201);

    const bodyA = resA.json() as { messageId: string; body: string };
    const bodyB = resB.json() as { messageId: string; body: string };
    assert.equal(bodyA.messageId, bodyB.messageId);
    assert.equal(bodyA.body, "concurrent retry test");
    assert.equal(bodyB.body, "concurrent retry test");

    const count = await app.prisma.message.count({ where: { conversationId, clientMessageId } });
    assert.equal(count, 1);
  });
});
