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
import type { MessageSearchHit } from "@relay/contracts";
import type { PrismaClient } from "@prisma/client";

// Real integration test — same minimal-app harness as message-disappear.routes.test.ts
// / message-media-gallery.routes.test.ts.
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
      username: `msg-search-${label}-${suffix}`,
      passwordHash: "not-a-real-hash",
      passwordSalt: randomBytes(32).toString("hex"),
    },
  });
}

describe("GET /api/conversations/:id/messages/search", () => {
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

  function sendText(callerId: string, conversationId: string, body: string, extra: Record<string, unknown> = {}) {
    return app.inject({
      method: "POST",
      url: `/api/conversations/${conversationId}/messages`,
      headers: { cookie: cookieFor(callerId), "content-type": "application/json" },
      payload: { body, ...extra },
    });
  }

  function search(callerId: string, conversationId: string, q: string) {
    return app.inject({
      method: "GET",
      url: `/api/conversations/${conversationId}/messages/search?q=${encodeURIComponent(q)}`,
      headers: { cookie: cookieFor(callerId) },
    });
  }

  function viewMessage(callerId: string, messageId: string) {
    return app.inject({
      method: "POST",
      url: `/api/messages/${messageId}/view`,
      headers: { cookie: cookieFor(callerId) },
    });
  }

  async function attachVoice(callerId: string, conversationId: string, transcriptText: string) {
    const media = await app.prisma.media.create({
      data: { uploaderId: callerId, storageKey: `test/voice-${randomUUID()}.ogg`, mimeType: "audio/ogg", sizeBytes: 1024 },
    });
    createdMediaIds.push(media.id);
    await app.prisma.media.update({
      where: { id: media.id },
      data: { transcriptStatus: "ready", transcript: { segments: [], fullText: transcriptText, primaryLanguage: "en" } },
    });
    const res = await app.inject({
      method: "POST",
      url: `/api/conversations/${conversationId}/messages/media`,
      headers: { cookie: cookieFor(callerId), "content-type": "application/json" },
      payload: { mediaIds: [media.id] },
    });
    assert.equal(res.statusCode, 201);
    return (res.json() as { messageId: string }).messageId;
  }

  it("403s a non-participant", async () => {
    const { a, conversationId } = await setup();
    await sendText(a.id, conversationId, "hello world");
    const outsider = await createUser(app.prisma, "outsider");
    createdUserIds.push(outsider.id);

    const res = await search(outsider.id, conversationId, "hello");
    assert.equal(res.statusCode, 403);
  });

  it("matches message text case-insensitively and returns a snippet", async () => {
    const { a, conversationId } = await setup();
    await sendText(a.id, conversationId, "the quick Brown fox jumps");

    const res = await search(a.id, conversationId, "brown fox");
    assert.equal(res.statusCode, 200);
    const { hits } = res.json() as { hits: MessageSearchHit[] };
    assert.equal(hits.length, 1);
    assert.equal(hits[0]!.matchedIn, "body");
    assert.match(hits[0]!.snippet, /brown fox/i);
  });

  it("returns matches most-recent-first", async () => {
    const { a, conversationId } = await setup();
    const first = await sendText(a.id, conversationId, "marker one hit");
    await new Promise((r) => setTimeout(r, 5));
    const second = await sendText(a.id, conversationId, "marker two hit");
    const firstId = (first.json() as { messageId: string }).messageId;
    const secondId = (second.json() as { messageId: string }).messageId;

    const res = await search(a.id, conversationId, "marker");
    const { hits } = res.json() as { hits: MessageSearchHit[] };
    assert.deepEqual(hits.map((h) => h.messageId), [secondId, firstId]);
  });

  it("excludes a soft-deleted message", async () => {
    const { a, conversationId } = await setup();
    const sent = await sendText(a.id, conversationId, "delete me please");
    const messageId = (sent.json() as { messageId: string }).messageId;

    const del = await app.inject({
      method: "DELETE",
      url: `/api/messages/${messageId}`,
      headers: { cookie: cookieFor(a.id) },
    });
    assert.equal(del.statusCode, 204);

    const res = await search(a.id, conversationId, "delete me");
    const { hits } = res.json() as { hits: MessageSearchHit[] };
    assert.equal(hits.length, 0);
  });

  it("matches a voice-note transcript", async () => {
    const { a, conversationId } = await setup();
    await attachVoice(a.id, conversationId, "remember to buy oat milk tomorrow");

    const res = await search(a.id, conversationId, "oat milk");
    assert.equal(res.statusCode, 200);
    const { hits } = res.json() as { hits: MessageSearchHit[] };
    assert.equal(hits.length, 1);
    assert.equal(hits[0]!.matchedIn, "transcript");
    assert.match(hits[0]!.snippet, /oat milk/i);
  });

  describe("disappearing-message exclusion", () => {
    // Mutation-test discipline: this literal text is unique per test, so a
    // match anywhere in the response — hit list OR snippet content — proves
    // the exclusion failed. Verified by temporarily removing the WHERE-clause
    // OR filter in message-search.service.ts and confirming these tests fail.

    it("never matches a VIEWS-mode message not yet consumed, for either participant", async () => {
      const { a, b, conversationId } = await setup();
      const secretPhrase = `zzz-unrevealed-views-${randomUUID()}`;
      const sent = await sendText(a.id, conversationId, `top secret: ${secretPhrase}`, {
        disappear: { mode: "views", viewLimit: 3 },
      });
      const messageId = (sent.json() as { messageId: string }).messageId;

      for (const caller of [a, b]) {
        const res = await search(caller.id, conversationId, secretPhrase);
        assert.equal(res.statusCode, 200);
        const { hits } = res.json() as { hits: MessageSearchHit[] };
        assert.equal(hits.length, 0, `${caller.username} must get zero hits for the unrevealed VIEWS-mode message`);
        assert.ok(!hits.some((h) => h.messageId === messageId));
      }
    });

    it("never matches a TIME-mode message before its first open", async () => {
      const { a, b, conversationId } = await setup();
      const secretPhrase = `zzz-unrevealed-time-${randomUUID()}`;
      await sendText(a.id, conversationId, `later: ${secretPhrase}`, {
        disappear: { mode: "time", ttlSeconds: 3600 },
      });

      const res = await search(b.id, conversationId, secretPhrase);
      const { hits } = res.json() as { hits: MessageSearchHit[] };
      assert.equal(hits.length, 0);
    });

    it("matches a TIME-mode message once it has been opened", async () => {
      const { a, b, conversationId } = await setup();
      const phrase = `zzz-revealed-time-${randomUUID()}`;
      const sent = await sendText(a.id, conversationId, `later: ${phrase}`, {
        disappear: { mode: "time", ttlSeconds: 3600 },
      });
      const messageId = (sent.json() as { messageId: string }).messageId;

      const opened = await viewMessage(b.id, messageId);
      assert.equal(opened.statusCode, 200);

      const res = await search(b.id, conversationId, phrase);
      const { hits } = res.json() as { hits: MessageSearchHit[] };
      assert.equal(hits.length, 1);
      assert.equal(hits[0]!.messageId, messageId);
    });

    it("never matches a VIEWS-mode message even after it has been fully consumed", async () => {
      // Once viewCount reaches viewLimit the Message itself is soft-deleted —
      // covered here for its own sake since it exercises a different code
      // path (isDeleted, not the disappear-state OR clause) to the same end.
      const { a, b, conversationId } = await setup();
      const phrase = `zzz-consumed-views-${randomUUID()}`;
      const sent = await sendText(a.id, conversationId, `gone soon: ${phrase}`, {
        disappear: { mode: "views", viewLimit: 1 },
      });
      const messageId = (sent.json() as { messageId: string }).messageId;
      const opened = await viewMessage(b.id, messageId);
      assert.equal(opened.statusCode, 200);
      assert.equal((opened.json() as { consumed: boolean }).consumed, true);

      const res = await search(b.id, conversationId, phrase);
      const { hits } = res.json() as { hits: MessageSearchHit[] };
      assert.equal(hits.length, 0);
    });
  });
});
