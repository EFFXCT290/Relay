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
import conversationRoutes from "./conversation.routes.js";
import messageRoutes from "../messages/message.routes.js";
import { signAccessToken } from "../../backend-core/auth/tokens.js";
import { ACCESS_COOKIE } from "../../backend-core/auth/cookies.js";
import type { ConversationSearchHit } from "@relay/contracts";
import type { PrismaClient } from "@prisma/client";

// Real integration test — same minimal-app harness as message-disappear.routes.test.ts,
// which similarly needs both route modules registered together (conversations
// for setup/search, messages to seed content to search over).
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

  await app.register(conversationRoutes, { prefix: "/api" });
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

describe("GET /api/conversations/search", () => {
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

  async function createUser(label: string) {
    const suffix = randomUUID().slice(0, 8);
    const user = await app.prisma.user.create({
      data: {
        username: `convo-search-${label}-${suffix}`,
        passwordHash: "not-a-real-hash",
        passwordSalt: randomBytes(32).toString("hex"),
      },
    });
    createdUserIds.push(user.id);
    return user;
  }

  async function makeConversation(aId: string, bId: string) {
    const conversation = await app.prisma.conversation.create({ data: {} });
    createdConversationIds.push(conversation.id);
    await app.prisma.participant.createMany({
      data: [
        { userId: aId, conversationId: conversation.id, acceptedAt: new Date() },
        { userId: bId, conversationId: conversation.id, acceptedAt: new Date() },
      ],
    });
    return conversation.id;
  }

  function sendText(callerId: string, conversationId: string, body: string, extra: Record<string, unknown> = {}) {
    return app.inject({
      method: "POST",
      url: `/api/conversations/${conversationId}/messages`,
      headers: { cookie: cookieFor(callerId), "content-type": "application/json" },
      payload: { body, ...extra },
    });
  }

  function viewMessage(callerId: string, messageId: string) {
    return app.inject({
      method: "POST",
      url: `/api/messages/${messageId}/view`,
      headers: { cookie: cookieFor(callerId) },
    });
  }

  function search(callerId: string, q: string) {
    return app.inject({
      method: "GET",
      url: `/api/conversations/search?q=${encodeURIComponent(q)}`,
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
  }

  it("matches the other participant's username", async () => {
    const a = await createUser("a");
    const b = await createUser("b-marker");
    const conversationId = await makeConversation(a.id, b.id);

    const res = await search(a.id, "marker");
    assert.equal(res.statusCode, 200);
    const { results } = res.json() as { results: ConversationSearchHit[] };
    const hit = results.find((r) => r.conversationId === conversationId);
    assert.ok(hit, "expected the conversation with the matching username to appear");
    assert.equal(hit!.matchType, "participant");
    assert.equal(hit!.snippet, null);
  });

  it("matches the caller's own nickname override for that participant, not their username", async () => {
    const a = await createUser("a");
    const b = await createUser("b");
    const conversationId = await makeConversation(a.id, b.id);
    await app.prisma.userNickname.create({
      data: { ownerId: a.id, targetUserId: b.id, nickname: "MyBestie" },
    });

    const res = await search(a.id, "bestie");
    const { results } = res.json() as { results: ConversationSearchHit[] };
    const hit = results.find((r) => r.conversationId === conversationId);
    assert.ok(hit);
    assert.equal(hit!.matchType, "participant");
  });

  it("matches message content and returns a snippet + messageId", async () => {
    const a = await createUser("a");
    const b = await createUser("b");
    const conversationId = await makeConversation(a.id, b.id);
    const sent = await sendText(a.id, conversationId, "let's meet at the lighthouse cafe");
    const messageId = (sent.json() as { messageId: string }).messageId;

    const res = await search(a.id, "lighthouse cafe");
    const { results } = res.json() as { results: ConversationSearchHit[] };
    const hit = results.find((r) => r.conversationId === conversationId);
    assert.ok(hit);
    assert.equal(hit!.matchType, "content");
    assert.equal(hit!.messageId, messageId);
    assert.match(hit!.snippet ?? "", /lighthouse cafe/i);
  });

  it("matches a voice-note transcript across conversations", async () => {
    const a = await createUser("a");
    const b = await createUser("b");
    const conversationId = await makeConversation(a.id, b.id);
    await attachVoice(a.id, conversationId, "the package arrives on friday");

    const res = await search(a.id, "arrives on friday");
    const { results } = res.json() as { results: ConversationSearchHit[] };
    const hit = results.find((r) => r.conversationId === conversationId);
    assert.ok(hit);
    assert.equal(hit!.matchType, "content");
  });

  it("is scoped to the caller's own accepted conversations — a stranger's matching conversation never appears", async () => {
    const a = await createUser("a");
    const b = await createUser("b");
    const stranger = await createUser("c");
    const theirConversationId = await makeConversation(b.id, stranger.id);
    await sendText(b.id, theirConversationId, "unique-phrase-only-b-and-c-share-xyz123");

    const res = await search(a.id, "unique-phrase-only-b-and-c-share-xyz123");
    const { results } = res.json() as { results: ConversationSearchHit[] };
    assert.ok(!results.some((r) => r.conversationId === theirConversationId));
  });

  it("excludes a pending (not-yet-accepted) conversation request", async () => {
    // makeConversation always accepts its first arg's side — to get a row
    // where the CALLER's own side is unaccepted (a request they haven't
    // acted on yet, per GET /conversations' identical scoping), build the
    // participants directly with the caller (a) as the not-yet-accepted side.
    const a = await createUser("a");
    const b = await createUser("pendmk-b");
    const conversation = await app.prisma.conversation.create({ data: {} });
    createdConversationIds.push(conversation.id);
    await app.prisma.participant.createMany({
      data: [
        { userId: b.id, conversationId: conversation.id, acceptedAt: new Date() },
        { userId: a.id, conversationId: conversation.id, acceptedAt: null },
      ],
    });

    const res = await search(a.id, "pendmk");
    const { results } = res.json() as { results: ConversationSearchHit[] };
    assert.ok(!results.some((r) => r.conversationId === conversation.id));
  });

  it("excludes content from a soft-deleted message", async () => {
    const a = await createUser("a");
    const b = await createUser("b");
    const conversationId = await makeConversation(a.id, b.id);
    const sent = await sendText(a.id, conversationId, "temporary-note-please-forget-abc987");
    const messageId = (sent.json() as { messageId: string }).messageId;
    const del = await app.inject({
      method: "DELETE",
      url: `/api/messages/${messageId}`,
      headers: { cookie: cookieFor(a.id) },
    });
    assert.equal(del.statusCode, 204);

    const res = await search(a.id, "temporary-note-please-forget-abc987");
    const { results } = res.json() as { results: ConversationSearchHit[] };
    assert.ok(!results.some((r) => r.conversationId === conversationId));
  });

  describe("disappearing-message exclusion", () => {
    it("never surfaces a conversation via an unrevealed VIEWS-mode message's content", async () => {
      const a = await createUser("a");
      const b = await createUser("b");
      const conversationId = await makeConversation(a.id, b.id);
      const phrase = `zzz-inbox-unrevealed-views-${randomUUID()}`;
      await sendText(a.id, conversationId, `secret: ${phrase}`, {
        disappear: { mode: "views", viewLimit: 2 },
      });

      for (const caller of [a, b]) {
        const res = await search(caller.id, phrase);
        const { results } = res.json() as { results: ConversationSearchHit[] };
        assert.ok(
          !results.some((r) => r.conversationId === conversationId),
          `${caller.username} must not find the conversation via the unrevealed message's content`,
        );
      }
    });

    it("never surfaces a conversation via a TIME-mode message before its first open", async () => {
      const a = await createUser("a");
      const b = await createUser("b");
      const conversationId = await makeConversation(a.id, b.id);
      const phrase = `zzz-inbox-unrevealed-time-${randomUUID()}`;
      await sendText(a.id, conversationId, `secret: ${phrase}`, {
        disappear: { mode: "time", ttlSeconds: 3600 },
      });

      const res = await search(b.id, phrase);
      const { results } = res.json() as { results: ConversationSearchHit[] };
      assert.ok(!results.some((r) => r.conversationId === conversationId));
    });

    it("surfaces the conversation via a TIME-mode message's content once opened", async () => {
      const a = await createUser("a");
      const b = await createUser("b");
      const conversationId = await makeConversation(a.id, b.id);
      const phrase = `zzz-inbox-revealed-time-${randomUUID()}`;
      const sent = await sendText(a.id, conversationId, `secret: ${phrase}`, {
        disappear: { mode: "time", ttlSeconds: 3600 },
      });
      const messageId = (sent.json() as { messageId: string }).messageId;
      const opened = await viewMessage(b.id, messageId);
      assert.equal(opened.statusCode, 200);

      const res = await search(b.id, phrase);
      const { results } = res.json() as { results: ConversationSearchHit[] };
      const hit = results.find((r) => r.conversationId === conversationId);
      assert.ok(hit);
      assert.equal(hit!.messageId, messageId);
    });
  });
});
