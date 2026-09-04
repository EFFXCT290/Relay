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
import minioPlugin from "../../plugins/minio.js";
import mediaRoutes from "./media.routes.js";
import { signAccessToken } from "../../backend-core/auth/tokens.js";
import { ACCESS_COOKIE } from "../../backend-core/auth/cookies.js";

// Real integration test — real Postgres/Redis/MinIO (the throwaway CI services),
// not hand-rolled mocks. Deliberately does NOT import buildServer()/server.ts:
// server.ts runs `void main()` at module scope (an unrelated, pre-existing,
// already-committed debug artifact, not touched by this change) which calls
// app.listen() as an unconditional side effect of import — any test importing
// it would boot a second real server on the real port. This builds only the
// plugins GET /media/:mediaId/url actually needs, registered in the same order
// server.ts uses, so the route runs unmodified against the real datastores.
async function buildTestApp() {
  const app = Fastify({ logger: false })
    .setValidatorCompiler(TypeBoxValidatorCompiler)
    .withTypeProvider<TypeBoxTypeProvider>();

  await app.register(cookie);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(minioPlugin);

  // Mirrors server.ts's problem-details error handler — without it, thrown
  // ProblemErrors (403/404/etc.) would fall through to Fastify's generic 500.
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ProblemError) return problemResponse(reply, err.code, err.detail);
    throw err;
  });

  await app.register(mediaRoutes, { prefix: "/api" });
  return app;
}

// media.service.ts (imported transitively by media.routes.ts) imports the
// module-level mediaQueue/videoQueue/voiceQueue BullMQ Queue singletons from
// media.queue.ts. Each opens an ioredis connection at module-load time
// regardless of whether .add() is ever called — left open, `node --test`
// never exits (mirrors calls.service.test.ts's identical workaround).
after(async () => {
  const { mediaQueue, videoQueue, voiceQueue } = await import("../../queues/media.queue.js");
  await Promise.all([mediaQueue.close(), videoQueue.close(), voiceQueue.close()]);
});

describe("GET /api/media/:mediaId/url — authz", () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>;
  let uploaderId: string;
  let participantId: string;
  let outsiderId: string;
  let mediaId: string;
  let conversationId: string;
  let messageId: string;

  before(async () => {
    app = await buildTestApp();
    const prisma = app.prisma;

    // Unique per run so repeated local runs against the same DB never collide
    // on the User.username unique constraint.
    const suffix = randomUUID().slice(0, 8);
    const passwordHash = "not-a-real-hash"; // login isn't exercised — tokens are minted directly below
    const passwordSalt = randomBytes(32).toString("hex"); // matches passwordSalt @db.Char(64)

    const [uploader, participant, outsider] = await Promise.all([
      prisma.user.create({ data: { username: `url-authz-uploader-${suffix}`, passwordHash, passwordSalt } }),
      prisma.user.create({ data: { username: `url-authz-participant-${suffix}`, passwordHash, passwordSalt } }),
      prisma.user.create({ data: { username: `url-authz-outsider-${suffix}`, passwordHash, passwordSalt } }),
    ]);
    uploaderId = uploader.id;
    participantId = participant.id;
    outsiderId = outsider.id;

    const conversation = await prisma.conversation.create({ data: {} });
    conversationId = conversation.id;
    await prisma.participant.createMany({
      data: [
        { userId: uploaderId, conversationId, acceptedAt: new Date() },
        { userId: participantId, conversationId, acceptedAt: new Date() },
        // outsiderId is deliberately NOT a participant of this conversation.
      ],
    });

    const media = await prisma.media.create({
      data: {
        uploaderId,
        storageKey: `test/url-authz-${suffix}.jpg`,
        mimeType: "image/jpeg",
        sizeBytes: 1024,
      },
      // no `temporary` row — this is non-ephemeral media, the case this route serves.
    });
    mediaId = media.id;

    const message = await prisma.message.create({
      data: { conversationId, senderId: uploaderId, type: "IMAGE" },
    });
    messageId = message.id;
    await prisma.messageAttachment.create({
      data: { messageId, mediaId, type: "image" },
    });
  });

  after(async () => {
    const prisma = app.prisma;
    // Delete children before parents explicitly — don't rely on cascade config,
    // some of these FKs (Media←uploader, Message←sender) have none.
    await prisma.messageAttachment.deleteMany({ where: { mediaId } });
    await prisma.media.delete({ where: { id: mediaId } });
    await prisma.message.delete({ where: { id: messageId } });
    await prisma.participant.deleteMany({ where: { conversationId } });
    await prisma.conversation.delete({ where: { id: conversationId } });
    await prisma.user.deleteMany({ where: { id: { in: [uploaderId, participantId, outsiderId] } } });
    await app.close();
  });

  function cookieFor(userId: string): string {
    const { token } = signAccessToken(userId);
    return `${ACCESS_COOKIE}=${token}`;
  }

  it("403s a caller who is neither the uploader nor a conversation participant", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/media/${mediaId}/url`,
      headers: { cookie: cookieFor(outsiderId) },
    });
    assert.equal(res.statusCode, 403);
  });

  it("200s a participant with a signed URL", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/media/${mediaId}/url`,
      headers: { cookie: cookieFor(participantId) },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { url: string };
    assert.match(body.url, /^https?:\/\//);
  });

  it("200s the uploader themselves — the uploader-exclusion from POST /:mediaId/view does NOT apply here", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/media/${mediaId}/url`,
      headers: { cookie: cookieFor(uploaderId) },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { url: string };
    assert.match(body.url, /^https?:\/\//);
  });
});
