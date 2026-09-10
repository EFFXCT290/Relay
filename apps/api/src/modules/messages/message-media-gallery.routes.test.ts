import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import Fastify, { type FastifyError } from "fastify";
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
import type { MediaGalleryItem } from "@relay/contracts";
import type { PrismaClient } from "@prisma/client";

// Real integration test — same minimal-app harness as message-pin.routes.test.ts
// / message-media.routes.test.ts.
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
      username: `msg-gallery-${label}-${suffix}`,
      passwordHash: "not-a-real-hash",
      passwordSalt: randomBytes(32).toString("hex"),
    },
  });
}

describe("GET /api/conversations/:id/media (Contact info \"Shared media\" gallery)", () => {
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
    const [a, b] = await Promise.all([createUser(app.prisma, "a"), createUser(app.prisma, "b")]);
    createdUserIds.push(a.id, b.id);
    const conversation = await app.prisma.conversation.create({ data: {} });
    createdConversationIds.push(conversation.id);
    await app.prisma.participant.createMany({
      data: [
        { userId: a.id, conversationId: conversation.id, acceptedAt: new Date() },
        { userId: b.id, conversationId: conversation.id, acceptedAt: new Date() },
      ],
    });
    return { a, b, conversationId: conversation.id };
  }

  async function createMedia(uploaderId: string, mimeType: string) {
    const media = await app.prisma.media.create({
      data: { uploaderId, storageKey: `test/gallery-${randomUUID()}.bin`, mimeType, sizeBytes: 2048 },
    });
    createdMediaIds.push(media.id);
    return media;
  }

  // Exercises the real POST attach endpoint (not a manual MessageAttachment
  // insert) so attachment.type is derived exactly the way production does.
  async function attachMedia(callerId: string, conversationId: string, mediaId: string) {
    const res = await app.inject({
      method: "POST",
      url: `/api/conversations/${conversationId}/messages/media`,
      headers: { cookie: cookieFor(callerId), "content-type": "application/json" },
      payload: { mediaIds: [mediaId] },
    });
    assert.equal(res.statusCode, 201);
    return (res.json() as { messageId: string }).messageId;
  }

  async function sendText(callerId: string, conversationId: string, body: string) {
    const res = await app.inject({
      method: "POST",
      url: `/api/conversations/${conversationId}/messages`,
      headers: { cookie: cookieFor(callerId), "content-type": "application/json" },
      payload: { body },
    });
    assert.equal(res.statusCode, 201);
    return (res.json() as { messageId: string }).messageId;
  }

  function getGallery(callerId: string, conversationId: string, query = "") {
    return app.inject({
      method: "GET",
      url: `/api/conversations/${conversationId}/media${query}`,
      headers: { cookie: cookieFor(callerId) },
    });
  }

  it("403s a non-participant", async () => {
    const { a, conversationId } = await setup();
    const media = await createMedia(a.id, "image/jpeg");
    await attachMedia(a.id, conversationId, media.id);

    const outsider = await createUser(app.prisma, "outsider");
    createdUserIds.push(outsider.id);

    const res = await getGallery(outsider.id, conversationId);
    assert.equal(res.statusCode, 403);
  });

  it("returns image and video attachments, excludes voice notes and text-only messages", async () => {
    const { a, conversationId } = await setup();
    const image = await createMedia(a.id, "image/jpeg");
    const video = await createMedia(a.id, "video/mp4");
    const voice = await createMedia(a.id, "audio/ogg");
    await attachMedia(a.id, conversationId, image.id);
    await attachMedia(a.id, conversationId, video.id);
    await attachMedia(a.id, conversationId, voice.id);
    await sendText(a.id, conversationId, "just text, no media");

    const res = await getGallery(a.id, conversationId);
    assert.equal(res.statusCode, 200);
    const body = res.json() as { items: MediaGalleryItem[]; totalCount: number; nextCursor: string | null };
    assert.equal(body.totalCount, 2);
    assert.equal(body.items.length, 2);
    const types = body.items.map((i) => i.attachment.type).sort();
    assert.deepEqual(types, ["image", "video"]);
    assert.equal(body.nextCursor, null);
  });

  it("excludes media belonging to a soft-deleted message", async () => {
    const { a, conversationId } = await setup();
    const keep = await createMedia(a.id, "image/jpeg");
    const deleted = await createMedia(a.id, "image/jpeg");
    await attachMedia(a.id, conversationId, keep.id);
    const deletedMessageId = await attachMedia(a.id, conversationId, deleted.id);

    const delRes = await app.inject({
      method: "DELETE",
      url: `/api/messages/${deletedMessageId}`,
      headers: { cookie: cookieFor(a.id) },
    });
    assert.equal(delRes.statusCode, 204);

    const res = await getGallery(a.id, conversationId);
    const body = res.json() as { items: MediaGalleryItem[]; totalCount: number };
    assert.equal(body.totalCount, 1);
    assert.equal(body.items.length, 1);
    assert.notEqual(body.items[0]!.messageId, deletedMessageId);
  });

  it("paginates without gaps or duplicates across pages", async () => {
    const { a, conversationId } = await setup();
    const mediaIds: string[] = [];
    for (let i = 0; i < 5; i++) {
      const m = await createMedia(a.id, "image/jpeg");
      await attachMedia(a.id, conversationId, m.id);
      mediaIds.push(m.id);
      await new Promise((r) => setTimeout(r, 5)); // keep createdAt strictly increasing
    }

    const seenMessageIds = new Set<string>();
    let cursor: string | null = null;
    let pages = 0;
    do {
      const res = await getGallery(a.id, conversationId, `?limit=2${cursor ? `&cursor=${cursor}` : ""}`);
      assert.equal(res.statusCode, 200);
      const body = res.json() as { items: MediaGalleryItem[]; nextCursor: string | null; totalCount: number };
      assert.equal(body.totalCount, 5);
      assert.ok(body.items.length <= 2);
      for (const item of body.items) {
        assert.ok(!seenMessageIds.has(item.messageId), "no duplicate items across pages");
        seenMessageIds.add(item.messageId);
      }
      cursor = body.nextCursor;
      pages++;
      assert.ok(pages <= 10, "pagination did not terminate");
    } while (cursor);

    assert.equal(seenMessageIds.size, 5);
  });

  // Standardized to 100 across every paginated GET (conversations, messages,
  // media gallery, notifications, users/search) — this route was previously
  // capped at 60, the odd one out.
  it("accepts limit=100 (the standardized maximum)", async () => {
    const { a, conversationId } = await setup();
    const res = await getGallery(a.id, conversationId, "?limit=100");
    assert.equal(res.statusCode, 200);
  });

  it("rejects limit=101 (one above the standardized maximum)", async () => {
    const { a, conversationId } = await setup();
    const res = await getGallery(a.id, conversationId, "?limit=101");
    assert.equal(res.statusCode, 422);
  });
});
