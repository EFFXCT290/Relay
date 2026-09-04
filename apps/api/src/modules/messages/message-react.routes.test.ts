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
// hand-rolled mocks. Same minimal-app approach as message.routes.test.ts: does
// NOT import buildServer()/server.ts (its pre-existing void main() side effect
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

describe("POST /api/messages/:messageId/react — concurrent race recovery", () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>;
  let reactorId: string;
  let otherId: string;
  let conversationId: string;
  let messageId: string;

  before(async () => {
    app = await buildTestApp();
    const prisma = app.prisma;

    const suffix = randomUUID().slice(0, 8);
    const passwordHash = "not-a-real-hash"; // login isn't exercised — tokens are minted directly below
    const passwordSalt = randomBytes(32).toString("hex"); // matches passwordSalt @db.Char(64)

    const [reactor, other] = await Promise.all([
      prisma.user.create({ data: { username: `react-actor-${suffix}`, passwordHash, passwordSalt } }),
      prisma.user.create({ data: { username: `react-other-${suffix}`, passwordHash, passwordSalt } }),
    ]);
    reactorId = reactor.id;
    otherId = other.id;

    const conversation = await prisma.conversation.create({ data: {} });
    conversationId = conversation.id;
    await prisma.participant.createMany({
      data: [
        { userId: reactorId, conversationId, acceptedAt: new Date() },
        { userId: otherId, conversationId, acceptedAt: new Date() },
      ],
    });

    const message = await prisma.message.create({
      data: { conversationId, senderId: otherId, type: "TEXT", body: "react to me" },
    });
    messageId = message.id;
  });

  after(async () => {
    const prisma = app.prisma;
    await prisma.reaction.deleteMany({ where: { messageId } });
    await prisma.message.delete({ where: { id: messageId } });
    await prisma.participant.deleteMany({ where: { conversationId } });
    await prisma.conversation.delete({ where: { id: conversationId } });
    await prisma.user.deleteMany({ where: { id: { in: [reactorId, otherId] } } });
    await app.close();
  });

  function cookieFor(userId: string): string {
    const { token } = signAccessToken(userId);
    return `${ACCESS_COOKIE}=${token}`;
  }

  function fireReact(userId: string, emoji: string) {
    return app.inject({
      method: "POST",
      url: `/api/messages/${messageId}/react`,
      headers: { cookie: cookieFor(userId), "content-type": "application/json" },
      payload: { emoji },
    });
  }

  it("two concurrent identical reactions with none existing yet both resolve without 500 (create-vs-create race, P2002)", async () => {
    // Fire both without awaiting either first — this is what actually exercises
    // the race window. Two sequential awaited calls would just hit the
    // existing-reaction read on the second call and never reach the write race
    // at all — a false-positive pass even against the broken code.
    const [resA, resB] = await Promise.all([fireReact(reactorId, "👍"), fireReact(reactorId, "👍")]);

    assert.notEqual(resA.statusCode, 500);
    assert.notEqual(resB.statusCode, 500);
    assert.equal(resA.statusCode, 200);
    assert.equal(resB.statusCode, 200);

    const bodyA = resA.json() as { reactions: Record<string, number>; myReaction: string | null };
    const bodyB = resB.json() as { reactions: Record<string, number>; myReaction: string | null };
    assert.equal(bodyA.reactions["👍"], 1);
    assert.equal(bodyB.reactions["👍"], 1);
    assert.equal(bodyA.myReaction, "👍");
    assert.equal(bodyB.myReaction, "👍");

    const count = await app.prisma.reaction.count({ where: { messageId, userId: reactorId } });
    assert.equal(count, 1);
  });

  it("two concurrent identical toggle-offs on an existing reaction both resolve without 500 (delete-vs-delete race, P2025)", async () => {
    // NOTE on scope: a genuinely *differing*-emoji concurrent pair (both
    // update, no delete involved) never throws at all here — Postgres just
    // applies both UPDATEs in commit order and the last one wins, which the
    // existing re-fetch-after-write already reports correctly with no race
    // handling needed. The error path this route actually needs (besides
    // create-vs-create/P2002 above) is two requests that both try to remove
    // the SAME row — same-emoji toggle-off, or a toggle-off racing a replace
    // that targets that row — which is reliably reproducible; ordering
    // between an update and a delete is not, so it isn't asserted here.
    await app.prisma.reaction.deleteMany({ where: { messageId, userId: reactorId } });
    await app.prisma.reaction.create({ data: { messageId, userId: reactorId, emoji: "👍" } });

    const [resA, resB] = await Promise.all([fireReact(reactorId, "👍"), fireReact(reactorId, "👍")]);

    assert.notEqual(resA.statusCode, 500);
    assert.notEqual(resB.statusCode, 500);
    assert.equal(resA.statusCode, 200);
    assert.equal(resB.statusCode, 200);

    const bodyA = resA.json() as { reactions: Record<string, number>; myReaction: string | null };
    const bodyB = resB.json() as { reactions: Record<string, number>; myReaction: string | null };
    assert.equal(bodyA.reactions["👍"], undefined);
    assert.equal(bodyB.reactions["👍"], undefined);
    assert.equal(bodyA.myReaction, null);
    assert.equal(bodyB.myReaction, null);

    const count = await app.prisma.reaction.count({ where: { messageId, userId: reactorId } });
    assert.equal(count, 0);
  });
});
