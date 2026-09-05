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
import messageRoutes from "./message.routes.js";
import { signAccessToken } from "../../backend-core/auth/tokens.js";
import { ACCESS_COOKIE } from "../../backend-core/auth/cookies.js";
import type { PrismaClient } from "@prisma/client";

// Real integration test — real Postgres/Redis, same minimal-app approach as
// message.routes.test.ts / message-softdelete.routes.test.ts. Getting a
// signed URL always runs (media.service.ts's serializeAttachment calls it
// unconditionally for non-ephemeral media) — stub it rather than standing up
// real MinIO, since the uploaderId check happens before that.
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
      username: `msg-media-${label}-${suffix}`,
      passwordHash: "not-a-real-hash",
      passwordSalt: randomBytes(32).toString("hex"), // matches passwordSalt @db.Char(64)
    },
  });
}

describe("POST .../messages/media — every mediaId's uploaderId must equal the caller (message.routes.ts:470-471)", () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>;
  const createdUserIds: string[] = [];
  const createdConversationIds: string[] = [];
  const createdMediaIds: string[] = [];

  before(async () => {
    app = await buildTestApp();
  });

  after(async () => {
    const prisma = app.prisma;
    await prisma.conversation.deleteMany({ where: { id: { in: createdConversationIds } } });
    await prisma.media.deleteMany({ where: { id: { in: createdMediaIds } } });
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    await app.close();
  });

  async function setup() {
    const [caller, other, stranger] = await Promise.all([
      createUser(app.prisma, "caller"),
      createUser(app.prisma, "other"),
      createUser(app.prisma, "stranger"),
    ]);
    createdUserIds.push(caller.id, other.id, stranger.id);
    const conversation = await app.prisma.conversation.create({ data: {} });
    createdConversationIds.push(conversation.id);
    await app.prisma.participant.createMany({
      data: [
        { userId: caller.id, conversationId: conversation.id, acceptedAt: new Date() },
        { userId: other.id, conversationId: conversation.id, acceptedAt: new Date() },
      ],
    });
    return { caller, other, stranger, conversationId: conversation.id };
  }

  async function createMedia(uploaderId: string) {
    const media = await app.prisma.media.create({
      data: {
        uploaderId,
        storageKey: `test/media-authz-${randomUUID()}.jpg`,
        mimeType: "image/jpeg",
        sizeBytes: 2048,
      },
    });
    createdMediaIds.push(media.id);
    return media;
  }

  it("403s when the caller tries to attach media uploaded by someone else, and creates no message", async () => {
    const { caller, other, conversationId } = await setup();
    const foreignMedia = await createMedia(other.id);

    const res = await app.inject({
      method: "POST",
      url: `/api/conversations/${conversationId}/messages/media`,
      headers: { cookie: cookieFor(caller.id), "content-type": "application/json" },
      payload: { mediaIds: [foreignMedia.id] },
    });

    assert.equal(res.statusCode, 403);
    const problem = res.json() as { detail?: string };
    assert.match(problem.detail ?? "", /not your media/i);

    const messageCount = await app.prisma.message.count({ where: { conversationId } });
    assert.equal(messageCount, 0, "a rejected attach must not create a message");
    const attachmentCount = await app.prisma.messageAttachment.count({ where: { mediaId: foreignMedia.id } });
    assert.equal(attachmentCount, 0);
  });

  it("403s a mixed batch (one owned + one foreign mediaId) — all-or-nothing, not partial attach", async () => {
    const { caller, other, conversationId } = await setup();
    const ownMedia = await createMedia(caller.id);
    const foreignMedia = await createMedia(other.id);

    const res = await app.inject({
      method: "POST",
      url: `/api/conversations/${conversationId}/messages/media`,
      headers: { cookie: cookieFor(caller.id), "content-type": "application/json" },
      payload: { mediaIds: [ownMedia.id, foreignMedia.id] },
    });

    assert.equal(res.statusCode, 403);
    const messageCount = await app.prisma.message.count({ where: { conversationId } });
    assert.equal(messageCount, 0, "a batch containing any foreign media must reject the whole request");
  });

  it("succeeds when every mediaId's uploaderId is the caller's own", async () => {
    const { caller, conversationId } = await setup();
    const ownMedia = await createMedia(caller.id);

    const res = await app.inject({
      method: "POST",
      url: `/api/conversations/${conversationId}/messages/media`,
      headers: { cookie: cookieFor(caller.id), "content-type": "application/json" },
      payload: { mediaIds: [ownMedia.id] },
    });

    assert.equal(res.statusCode, 201);
    const body = res.json() as { attachments: Array<{ id: string }> };
    assert.equal(body.attachments.length, 1);
  });

  it("the check isn't scoped to a specific pair: a different participant attaching a third party's media is also 403", async () => {
    const { other, stranger, conversationId } = await setup();
    const thirdPartyMedia = await createMedia(stranger.id);

    const res = await app.inject({
      method: "POST",
      url: `/api/conversations/${conversationId}/messages/media`,
      headers: { cookie: cookieFor(other.id), "content-type": "application/json" },
      payload: { mediaIds: [thirdPartyMedia.id] },
    });
    assert.equal(res.statusCode, 403);
  });
});
