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
import conversationRoutes from "../conversations/conversation.routes.js";
import { MessageService } from "./message.service.js";
import { signAccessToken } from "../../backend-core/auth/tokens.js";
import { ACCESS_COOKIE } from "../../backend-core/auth/cookies.js";
import type { PrismaClient } from "@prisma/client";

// Real integration test — real Postgres/Redis (the throwaway local services),
// not hand-rolled mocks. Same minimal-app approach as message.routes.test.ts /
// conversation.routes.test.ts: does NOT import buildServer()/server.ts (its
// pre-existing void main() side effect boots a second real server on import).
// Both route plugins are registered — several of these tests exercise the
// message-create/delete routes and then read the result back through a
// conversations route (list/requests/read), which is the whole point of the
// "soft-delete consistency" cluster below.
async function buildTestApp() {
  const app = Fastify({ logger: false })
    .setValidatorCompiler(TypeBoxValidatorCompiler)
    .withTypeProvider<TypeBoxTypeProvider>();

  await app.register(cookie);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);

  // The routes read fastify.io for online-presence checks (message send) and
  // to broadcast — stub it, real socket delivery isn't what this test covers.
  app.decorate(
    "io",
    {
      sockets: { adapter: { rooms: new Map<string, { size: number }>() } },
      to: () => ({ emit: () => {} }),
    } as unknown as import("fastify").FastifyInstance["io"],
  );
  // POST .../messages/media always signs a URL for its attachment(s)
  // (media.service.ts's serializeAttachment calls signUrl unconditionally for
  // non-ephemeral media) — stub it rather than standing up real MinIO, since
  // what's under test (the reply-to preview) doesn't depend on the URL itself.
  app.decorate("getMediaUrl", async (key: string) => `https://fake.example/${key}`);

  // Mirrors server.ts's problem-details error handler — without it, thrown
  // ProblemErrors (403/404/422/etc.) would fall through to Fastify's generic 500.
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ProblemError) return problemResponse(reply, err.code, err.detail);
    throw err;
  });

  await app.register(conversationRoutes, { prefix: "/api" });
  await app.register(messageRoutes, { prefix: "/api" });
  return app;
}

// message.routes.ts transitively opens several queue connections at import
// time (media/video/voice/push/cleanup) regardless of whether .add() is ever
// called — left open, `node --test` never exits. closeAllQueueConnections()
// closes every one of them so this file never has to track which subset it
// happens to pull in (see close-all-for-tests.ts for why).
after(async () => {
  const { closeAllQueueConnections } = await import("../../queues/close-all-for-tests.js");
  await closeAllQueueConnections();
});

function cookieFor(userId: string): string {
  const { token } = signAccessToken(userId);
  return `${ACCESS_COOKIE}=${token}`;
}

// Login isn't exercised in any of these tests — tokens are minted directly via
// signAccessToken (same convention as the other route test files in this module).
async function createUser(prisma: PrismaClient, label: string) {
  const suffix = randomUUID().slice(0, 8);
  return prisma.user.create({
    data: {
      username: `msg-authz-${label}-${suffix}`,
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
  extra: { replyToId?: string; clientMessageId?: string } = {},
) {
  return app.inject({
    method: "POST",
    url: `/api/conversations/${conversationId}/messages`,
    headers: { cookie: cookieFor(callerId), "content-type": "application/json" },
    payload: { body, ...extra },
  });
}

function deleteMessage(app: Awaited<ReturnType<typeof buildTestApp>>, callerId: string, messageId: string) {
  return app.inject({
    method: "DELETE",
    url: `/api/messages/${messageId}`,
    headers: { cookie: cookieFor(callerId) },
  });
}

describe("PATCH /api/messages/:messageId", () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>;
  const createdUserIds: string[] = [];
  const createdConversationIds: string[] = [];

  before(async () => {
    app = await buildTestApp();
  });

  after(async () => {
    const prisma = app.prisma;
    await prisma.conversation.deleteMany({ where: { id: { in: createdConversationIds } } }); // cascades participants + messages
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    await app.close();
  });

  async function setup() {
    const [a, b] = await Promise.all([createUser(app.prisma, "a"), createUser(app.prisma, "b")]);
    createdUserIds.push(a.id, b.id);
    const conversationId = await makeAcceptedConversation(app, a.id, b.id);
    createdConversationIds.push(conversationId);
    const sendRes = await sendText(app, a.id, conversationId, "original text");
    assert.equal(sendRes.statusCode, 201);
    const messageId = (sendRes.json() as { messageId: string }).messageId;
    return { a, b, conversationId, messageId };
  }

  it("403s a non-sender participant, not just a non-participant (message.routes.ts:696)", async () => {
    const { b, messageId } = await setup();
    const res = await app.inject({
      method: "PATCH",
      url: `/api/messages/${messageId}`,
      headers: { cookie: cookieFor(b.id), "content-type": "application/json" },
      payload: { body: "hijacked edit" },
    });
    assert.equal(res.statusCode, 403);

    const row = await app.prisma.message.findUnique({ where: { id: messageId } });
    assert.equal(row!.body, "original text", "a rejected edit must not change the message");
  });

  it("lets the sender edit their own message, updating isEdited/editedAt", async () => {
    const { a, messageId } = await setup();
    const res = await app.inject({
      method: "PATCH",
      url: `/api/messages/${messageId}`,
      headers: { cookie: cookieFor(a.id), "content-type": "application/json" },
      payload: { body: "edited text" },
    });
    assert.equal(res.statusCode, 200);

    const body = res.json() as { messageId: string; body: string; isEdited: boolean; editedAt: string };
    assert.equal(body.body, "edited text");
    assert.equal(body.isEdited, true);
    assert.equal(typeof body.editedAt, "string");

    const row = await app.prisma.message.findUnique({ where: { id: messageId } });
    assert.equal(row!.body, "edited text");
    assert.equal(row!.isEdited, true);
    assert.notEqual(row!.editedAt, null);
  });
});

describe("DELETE /api/messages/:messageId", () => {
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
    const sendRes = await sendText(app, a.id, conversationId, "original text");
    assert.equal(sendRes.statusCode, 201);
    const messageId = (sendRes.json() as { messageId: string }).messageId;
    return { a, b, conversationId, messageId };
  }

  it("403s a non-sender (message.routes.ts:829)", async () => {
    const { b, messageId } = await setup();
    const res = await deleteMessage(app, b.id, messageId);
    assert.equal(res.statusCode, 403);

    const row = await app.prisma.message.findUnique({ where: { id: messageId } });
    assert.equal(row!.isDeleted, false);
  });

  it("soft-deletes: the row persists with isDeleted=true, deletedAt set — not physically removed", async () => {
    const { a, messageId } = await setup();
    const res = await deleteMessage(app, a.id, messageId);
    assert.equal(res.statusCode, 204);

    const row = await app.prisma.message.findUnique({ where: { id: messageId } });
    assert.ok(row, "the row must still exist — this is a soft delete, not a physical one");
    assert.equal(row!.isDeleted, true);
    assert.notEqual(row!.deletedAt, null);
    // Soft-delete never scrubs the body column itself — that's exactly why
    // every read path below has to re-check isDeleted rather than trusting body.
    assert.equal(row!.body, "original text");
  });
});

describe("Soft-delete consistency — GET .../messages list nulls a deleted message's own body (message.routes.ts:139)", () => {
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

  it("a deleted message's body comes back null, with isDeleted true", async () => {
    const [a, b] = await Promise.all([createUser(app.prisma, "a"), createUser(app.prisma, "b")]);
    createdUserIds.push(a.id, b.id);
    const conversationId = await makeAcceptedConversation(app, a.id, b.id);
    createdConversationIds.push(conversationId);

    const sendRes = await sendText(app, a.id, conversationId, "sensitive content");
    const messageId = (sendRes.json() as { messageId: string }).messageId;
    const delRes = await deleteMessage(app, a.id, messageId);
    assert.equal(delRes.statusCode, 204);

    const listRes = await app.inject({
      method: "GET",
      url: `/api/conversations/${conversationId}/messages`,
      headers: { cookie: cookieFor(b.id) },
    });
    assert.equal(listRes.statusCode, 200);
    const { messages } = listRes.json() as {
      messages: Array<{ messageId: string; body: string | null; isDeleted: boolean }>;
    };
    const entry = messages.find((m) => m.messageId === messageId);
    assert.ok(entry, "the deleted message should still appear in the list, just with its body hidden");
    assert.equal(entry!.body, null);
    assert.equal(entry!.isDeleted, true);
  });
});

// Regression cluster for a bug found and fixed while writing this suite: none
// of message.routes.ts's four replyTo-preview constructions checked the
// parent message's isDeleted state before slicing its body into a preview.
// Soft-delete never clears the `body` column (see the DELETE test above), so
// a deleted parent's original text kept leaking through any message that
// replied to it, in every one of these four call sites — the exact "future
// call site that forgets the filter" scenario this test cluster exists to
// catch. Fixed by re-checking replyTo.isDeleted at each site; one test per
// site below, deliberately not sharing a single helper across them.
describe("Soft-delete consistency — reply-to preview never leaks a deleted parent's body", () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>;
  const createdUserIds: string[] = [];
  const createdConversationIds: string[] = [];
  const createdMediaIds: string[] = [];

  before(async () => {
    app = await buildTestApp();
  });

  after(async () => {
    const prisma = app.prisma;
    // Conversation delete cascades Message -> MessageAttachment, but Media
    // itself is owned by the uploader, not the conversation — clean it up
    // separately, after the attachments referencing it are already gone.
    await prisma.conversation.deleteMany({ where: { id: { in: createdConversationIds } } });
    await prisma.media.deleteMany({ where: { id: { in: createdMediaIds } } });
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    await app.close();
  });

  async function setup() {
    const [a, b] = await Promise.all([createUser(app.prisma, "a"), createUser(app.prisma, "b")]);
    createdUserIds.push(a.id, b.id);
    const conversationId = await makeAcceptedConversation(app, a.id, b.id);
    createdConversationIds.push(conversationId);
    return { a, b, conversationId };
  }

  it("GET .../messages list (message.routes.ts:140-146)", async () => {
    const { a, b, conversationId } = await setup();
    const parentRes = await sendText(app, a.id, conversationId, "secret plan details");
    const parentId = (parentRes.json() as { messageId: string }).messageId;
    const replyRes = await sendText(app, b.id, conversationId, "got it", { replyToId: parentId });
    assert.equal(replyRes.statusCode, 201);
    const replyId = (replyRes.json() as { messageId: string }).messageId;

    const delRes = await deleteMessage(app, a.id, parentId);
    assert.equal(delRes.statusCode, 204);

    const listRes = await app.inject({
      method: "GET",
      url: `/api/conversations/${conversationId}/messages`,
      headers: { cookie: cookieFor(b.id) },
    });
    const { messages } = listRes.json() as {
      messages: Array<{ messageId: string; replyTo: { messageId: string; preview: string | null } | null }>;
    };
    const replyEntry = messages.find((m) => m.messageId === replyId);
    assert.ok(replyEntry?.replyTo, "the reply link itself should survive — only the preview text is hidden");
    assert.equal(replyEntry!.replyTo!.messageId, parentId);
    assert.equal(replyEntry!.replyTo!.preview, null, "a deleted parent's text must not leak through the reply preview");
  });

  it("POST .../messages idempotent-replay path (message.routes.ts:221-235)", async () => {
    const { a, b, conversationId } = await setup();
    const parentRes = await sendText(app, a.id, conversationId, "secret plan details");
    const parentId = (parentRes.json() as { messageId: string }).messageId;

    const clientMessageId = randomUUID();
    const firstReply = await sendText(app, b.id, conversationId, "got it", { replyToId: parentId, clientMessageId });
    assert.equal(firstReply.statusCode, 201);

    const delRes = await deleteMessage(app, a.id, parentId);
    assert.equal(delRes.statusCode, 204);

    // Same clientMessageId again — hits the idempotent fast path, which
    // re-reads the existing message's replyTo relation fresh from the DB.
    // It's a found-existing replay, not a new creation, so it's 200 (see
    // POST /conversations' identical existing/created 200-vs-201 pattern).
    const retryReply = await sendText(app, b.id, conversationId, "got it", { replyToId: parentId, clientMessageId });
    assert.equal(retryReply.statusCode, 200);
    const body = retryReply.json() as { replyTo: { messageId: string; preview: string | null } | null };
    assert.equal(body.replyTo?.messageId, parentId);
    assert.equal(body.replyTo?.preview ?? null, null);
  });

  it("POST .../messages normal create path (message.routes.ts:288,316)", async () => {
    const { a, b, conversationId } = await setup();
    const parentRes = await sendText(app, a.id, conversationId, "secret plan details");
    const parentId = (parentRes.json() as { messageId: string }).messageId;

    const delRes = await deleteMessage(app, a.id, parentId);
    assert.equal(delRes.statusCode, 204);

    // The route allows replying to an already-deleted message (only
    // conversation membership is checked) — the response must not surface it.
    const replyRes = await sendText(app, b.id, conversationId, "got it", { replyToId: parentId });
    assert.equal(replyRes.statusCode, 201);
    const body = replyRes.json() as { replyTo: { messageId: string; preview: string | null } | null };
    assert.equal(body.replyTo?.messageId, parentId);
    assert.equal(body.replyTo?.preview ?? null, null);
  });

  it("POST .../messages/media create path (message.routes.ts:516,565)", async () => {
    const { a, b, conversationId } = await setup();
    const parentRes = await sendText(app, a.id, conversationId, "secret plan details");
    const parentId = (parentRes.json() as { messageId: string }).messageId;

    const delRes = await deleteMessage(app, a.id, parentId);
    assert.equal(delRes.statusCode, 204);

    const media = await app.prisma.media.create({
      data: {
        uploaderId: b.id,
        storageKey: `test/reply-preview-${randomUUID()}.jpg`,
        mimeType: "image/jpeg",
        sizeBytes: 1024,
      },
    });
    createdMediaIds.push(media.id);

    const res = await app.inject({
      method: "POST",
      url: `/api/conversations/${conversationId}/messages/media`,
      headers: { cookie: cookieFor(b.id), "content-type": "application/json" },
      payload: { mediaIds: [media.id], replyToId: parentId },
    });
    assert.equal(res.statusCode, 201);
    const body = res.json() as { replyTo: { messageId: string; preview: string | null } | null };
    assert.equal(body.replyTo?.messageId, parentId);
    assert.equal(body.replyTo?.preview ?? null, null);
  });
});

describe("Soft-delete consistency — MessageService.sweepUndelivered excludes deleted messages (message.service.ts:35)", () => {
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

  it("a soft-deleted, undelivered message is never marked delivered by the sweep", async () => {
    const [a, b] = await Promise.all([createUser(app.prisma, "a"), createUser(app.prisma, "b")]);
    createdUserIds.push(a.id, b.id);
    const conversationId = await makeAcceptedConversation(app, a.id, b.id);
    createdConversationIds.push(conversationId);

    // b is never "online" in our stub io, so deliveredAt starts out null.
    const sendRes = await sendText(app, a.id, conversationId, "will be deleted before delivery");
    const messageId = (sendRes.json() as { messageId: string }).messageId;
    const before = await app.prisma.message.findUnique({ where: { id: messageId } });
    assert.equal(before!.deliveredAt, null);

    const delRes = await deleteMessage(app, a.id, messageId);
    assert.equal(delRes.statusCode, 204);

    await new MessageService(app).sweepUndelivered(b.id);

    const afterRow = await app.prisma.message.findUnique({ where: { id: messageId } });
    assert.equal(afterRow!.deliveredAt, null, "a deleted message must not be swept into delivered state");
  });
});

describe("Soft-delete consistency — GET /api/conversations excludes a deleted message from lastMessage (conversation.routes.ts:188)", () => {
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

  it("a deleted message stops being the conversation's lastMessage preview", async () => {
    const [a, b] = await Promise.all([createUser(app.prisma, "a"), createUser(app.prisma, "b")]);
    createdUserIds.push(a.id, b.id);
    const conversationId = await makeAcceptedConversation(app, a.id, b.id);
    createdConversationIds.push(conversationId);

    const sendRes = await sendText(app, a.id, conversationId, "only message here");
    const messageId = (sendRes.json() as { messageId: string }).messageId;

    const before = await app.inject({ method: "GET", url: "/api/conversations", headers: { cookie: cookieFor(a.id) } });
    assert.equal(before.statusCode, 200);
    const beforeList = (before.json() as { conversations: Array<{ conversationId: string; lastMessage: unknown }> }).conversations;
    const beforeEntry = beforeList.find((c) => c.conversationId === conversationId);
    assert.ok(beforeEntry?.lastMessage, "sanity check: the message should show up before deletion");

    const delRes = await deleteMessage(app, a.id, messageId);
    assert.equal(delRes.statusCode, 204);

    const afterRes = await app.inject({ method: "GET", url: "/api/conversations", headers: { cookie: cookieFor(a.id) } });
    const afterList = (afterRes.json() as { conversations: Array<{ conversationId: string; lastMessage: unknown }> }).conversations;
    const afterEntry = afterList.find((c) => c.conversationId === conversationId);
    assert.equal(afterEntry?.lastMessage, null, "a deleted message must not surface as the lastMessage preview");
  });
});

describe("Soft-delete consistency — GET /api/conversations/requests excludes a deleted message from lastMessage (conversation.routes.ts:264)", () => {
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

  it("a deleted message stops being the pending request's lastMessage preview", async () => {
    const [a, b] = await Promise.all([createUser(app.prisma, "a"), createUser(app.prisma, "b")]);
    createdUserIds.push(a.id, b.id);

    // a is the creator (accepted immediately), b is the pending recipient —
    // GET /requests lists conversations where the CALLER's own row is pending.
    const conversation = await app.prisma.conversation.create({ data: {} });
    createdConversationIds.push(conversation.id);
    await app.prisma.participant.createMany({
      data: [
        { userId: a.id, conversationId: conversation.id, acceptedAt: new Date() },
        { userId: b.id, conversationId: conversation.id },
      ],
    });

    const sendRes = await sendText(app, a.id, conversation.id, "only message here");
    const messageId = (sendRes.json() as { messageId: string }).messageId;

    const before = await app.inject({ method: "GET", url: "/api/conversations/requests", headers: { cookie: cookieFor(b.id) } });
    assert.equal(before.statusCode, 200);
    const beforeList = (before.json() as { requests: Array<{ conversationId: string; lastMessage: unknown }> }).requests;
    const beforeEntry = beforeList.find((c) => c.conversationId === conversation.id);
    assert.ok(beforeEntry?.lastMessage, "sanity check: the message should show up before deletion");

    const delRes = await deleteMessage(app, a.id, messageId);
    assert.equal(delRes.statusCode, 204);

    const afterRes = await app.inject({ method: "GET", url: "/api/conversations/requests", headers: { cookie: cookieFor(b.id) } });
    const afterList = (afterRes.json() as { requests: Array<{ conversationId: string; lastMessage: unknown }> }).requests;
    const afterEntry = afterList.find((c) => c.conversationId === conversation.id);
    assert.equal(afterEntry?.lastMessage, null, "a deleted message must not surface as the lastMessage preview");
  });
});

describe("Soft-delete consistency — POST /:conversationId/read excludes deleted messages (conversation.routes.ts:477)", () => {
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

  it("a soft-deleted message is never marked read, and produces no MessageRead row", async () => {
    const [a, b] = await Promise.all([createUser(app.prisma, "a"), createUser(app.prisma, "b")]);
    createdUserIds.push(a.id, b.id);
    const conversationId = await makeAcceptedConversation(app, a.id, b.id);
    createdConversationIds.push(conversationId);

    const sendRes = await sendText(app, a.id, conversationId, "unread and about to be deleted");
    const messageId = (sendRes.json() as { messageId: string }).messageId;

    const delRes = await deleteMessage(app, a.id, messageId);
    assert.equal(delRes.statusCode, 204);

    // The only message in this conversation is now deleted, so the route's
    // `unread` set should be empty and short-circuit at 204.
    const readRes = await app.inject({
      method: "POST",
      url: `/api/conversations/${conversationId}/read`,
      headers: { cookie: cookieFor(b.id) },
    });
    assert.equal(readRes.statusCode, 204);

    const readRow = await app.prisma.messageRead.findUnique({
      where: { messageId_readerId: { messageId, readerId: b.id } },
    });
    assert.equal(readRow, null, "a deleted message must never be marked as read");
  });
});
