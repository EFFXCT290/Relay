import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import Fastify from "fastify";
import { TypeBoxTypeProvider, TypeBoxValidatorCompiler } from "@fastify/type-provider-typebox";
import cookie from "@fastify/cookie";
import { io as ioClient, type Socket as ClientSocket } from "socket.io-client";
import "../../backend-core/runtime/formats.js";
import { ProblemError, problemResponse } from "../../backend-core/http/errors.js";
import prismaPlugin from "../../plugins/prisma.js";
import redisPlugin from "../../plugins/redis.js";
import authPlugin from "../../plugins/auth.js";
import socketPlugin from "../../plugins/socket.js";
import messageRoutes from "../messages/message.routes.js";
import { signAccessToken } from "../../backend-core/auth/tokens.js";
import { ACCESS_COOKIE } from "../../backend-core/auth/cookies.js";
import { SYNC_EVENTS, ACK_EVENT, MESSAGE_EVENTS, type ReplayResponse } from "@relay/contracts";
import { SyncRepository } from "./sync.repository.js";
import type { PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";

// Real integration test — real Postgres/Redis and a real Socket.IO server,
// same pattern as message-new.socket.test.ts / user-profile-broadcast.socket.test.ts.
// This exercises EventOutbox reconnect replay through the ACTUAL connect →
// disconnect → reconnect lifecycle: message.routes.ts's real POST handler is
// what writes outbox rows (message.routes.ts:358-372), and sync.socket.ts's
// real REPLAY_REQUEST/ACK_EVENT handlers are what read/advance them. A
// function-level test of SyncService/SyncRepository alone couldn't prove any
// of this — the whole point is what a client sees across real reconnects.
async function buildTestApp() {
  const app = Fastify({ logger: false })
    .setValidatorCompiler(TypeBoxValidatorCompiler)
    .withTypeProvider<TypeBoxTypeProvider>();

  await app.register(cookie);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin); // real Socket.IO server

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ProblemError) return problemResponse(reply, err.code, err.detail);
    throw err;
  });

  await app.register(messageRoutes, { prefix: "/api" });

  const url = await app.listen({ port: 0, host: "127.0.0.1" });
  return { app, url };
}

async function createUser(prisma: PrismaClient, label: string) {
  const suffix = randomUUID().slice(0, 8);
  return prisma.user.create({
    data: {
      username: `sync-${label}-${suffix}`,
      passwordHash: "not-a-real-hash",
      passwordSalt: randomBytes(32).toString("hex"), // matches passwordSalt @db.Char(64)
    },
  });
}

function cookieFor(userId: string): string {
  const { token } = signAccessToken(userId);
  return `${ACCESS_COOKIE}=${token}`;
}

function connectSocket(url: string, userId: string): Promise<ClientSocket> {
  const socket = ioClient(url, {
    extraHeaders: { cookie: cookieFor(userId) },
    forceNew: true,
    reconnection: false, // each "reconnect" in these tests is a deliberate, separate connectSocket() call
    transports: ["websocket"],
  });
  return new Promise((resolve, reject) => {
    socket.once("connect", () => resolve(socket));
    socket.once("connect_error", reject);
  });
}

function waitForEvent<T>(socket: ClientSocket, event: string, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for "${event}"`)), timeoutMs);
    socket.once(event, (payload: T) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Generic async-predicate poll — used where the outcome depends on a
// fire-and-forget server-side write (ACK_EVENT's markAcked call is never
// awaited by the client) rather than a socket event we can listen for.
async function waitUntil(predicate: () => Promise<boolean> | boolean, timeoutMs: number, label: string): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for: ${label}`);
    await sleep(20);
  }
}

// Mirrors the exact "is this user online" check message.routes.ts itself uses
// (fastify.io.sockets.adapter.rooms.get(`user:${uid}`)) — polling this after
// closing a client socket is what makes "B is now offline" a real, verified
// precondition instead of a blind sleep-and-hope.
async function waitForOffline(app: FastifyInstance, userId: string, timeoutMs = 3000): Promise<void> {
  await waitUntil(
    () => (app.io.sockets.adapter.rooms.get(`user:${userId}`)?.size ?? 0) === 0,
    timeoutMs,
    `user ${userId}'s socket room to empty out after disconnect`,
  );
}

async function sendTextMessage(app: FastifyInstance, senderId: string, conversationId: string, body: string) {
  const res = await app.inject({
    method: "POST",
    url: `/api/conversations/${conversationId}/messages`,
    headers: { cookie: cookieFor(senderId), "content-type": "application/json" },
    payload: { body },
  });
  assert.equal(res.statusCode, 201, `message send should succeed: ${res.body}`);
  return res.json() as { messageId: string; conversationId: string; body: string };
}

type MessageNewPayload = { message: { messageId: string; conversationId: string } };
const messageIdOf = (e: ReplayResponse["events"][number]) => (e.payload as MessageNewPayload).message.messageId;
const conversationIdOf = (e: ReplayResponse["events"][number]) => (e.payload as MessageNewPayload).message.conversationId;

const EPOCH = new Date(0).toISOString();

describe("EventOutbox reconnect replay — real Socket.IO connect/disconnect/reconnect lifecycle", () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>["app"];
  let url: string;
  const createdUserIds: string[] = [];
  const createdConversationIds: string[] = [];
  const sockets: ClientSocket[] = [];

  before(async () => {
    ({ app, url } = await buildTestApp());
  });

  after(async () => {
    for (const s of sockets) s.close();
    const prisma = app.prisma;
    await prisma.conversation.deleteMany({ where: { id: { in: createdConversationIds } } }); // cascades participants + messages + outbox rows
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });

    const { pushQueue } = await import("../../queues/push.queue.js");
    const { mediaQueue, videoQueue, voiceQueue } = await import("../../queues/media.queue.js");
    await Promise.all([pushQueue.close(), mediaQueue.close(), videoQueue.close(), voiceQueue.close()]);
    await app.close();

    // See user-profile-broadcast.socket.test.ts's after() — a real listening
    // server + real client sockets leaves a handful of ioredis handles open
    // from every connection's fire-and-forget on-connect service calls. This
    // suite additionally drives several explicit disconnect/reconnect cycles
    // per test, so there is more of this debris than usual.
    process.exit(0);
  });

  async function makeConversation(...userIds: string[]) {
    const conversation = await app.prisma.conversation.create({ data: {} });
    createdConversationIds.push(conversation.id);
    await app.prisma.participant.createMany({
      data: userIds.map((userId) => ({ userId, conversationId: conversation.id, acceptedAt: new Date() })),
    });
    return conversation;
  }

  it("a client that goes offline, misses an event, and reconnects receives it via sync:replay-request — not just a successful reconnect", async () => {
    const [a, b] = await Promise.all([createUser(app.prisma, "a"), createUser(app.prisma, "b")]);
    createdUserIds.push(a.id, b.id);
    const conversation = await makeConversation(a.id, b.id);

    // B starts online, then genuinely goes offline before the event fires —
    // confirmed via the same room check the production route uses.
    const bStart = await connectSocket(url, b.id);
    sockets.push(bStart);
    bStart.close();
    await waitForOffline(app, b.id);

    const sent = await sendTextMessage(app, a.id, conversation.id, "missed while offline");

    const bOnline = await connectSocket(url, b.id);
    sockets.push(bOnline);

    const replay = waitForEvent<ReplayResponse>(bOnline, SYNC_EVENTS.REPLAY_RESPONSE, 3000);
    bOnline.emit(SYNC_EVENTS.REPLAY_REQUEST, { since: EPOCH });
    const response = await replay;

    assert.equal(response.error, undefined, "a normal replay must not carry an error");
    const match = response.events.find((e) => e.eventName === MESSAGE_EVENTS.NEW && messageIdOf(e) === sent.messageId);
    assert.ok(match, "the message sent while B was offline must come back via replay, not just a bare successful reconnect");
  });

  it("an emitted-but-unacked event survives a SECOND reconnect — one replay attempt does not consume/drop it", async () => {
    const [a, b] = await Promise.all([createUser(app.prisma, "a2"), createUser(app.prisma, "b2")]);
    createdUserIds.push(a.id, b.id);
    const conversation = await makeConversation(a.id, b.id);

    const bStart = await connectSocket(url, b.id);
    sockets.push(bStart);
    bStart.close();
    await waitForOffline(app, b.id);

    const sent = await sendTextMessage(app, a.id, conversation.id, "survives two reconnects");

    // Reconnect #1 — replay it, but deliberately never ACK.
    const bRecon1 = await connectSocket(url, b.id);
    sockets.push(bRecon1);
    const replay1 = waitForEvent<ReplayResponse>(bRecon1, SYNC_EVENTS.REPLAY_RESPONSE, 3000);
    bRecon1.emit(SYNC_EVENTS.REPLAY_REQUEST, { since: EPOCH });
    const response1 = await replay1;
    const match1 = response1.events.find((e) => messageIdOf(e) === sent.messageId);
    assert.ok(match1, "first replay attempt must include the missed event");

    // Disconnect again, still unacked.
    bRecon1.close();
    await waitForOffline(app, b.id);

    // Reconnect #2 — request replay again with the same cursor.
    const bRecon2 = await connectSocket(url, b.id);
    sockets.push(bRecon2);
    const replay2 = waitForEvent<ReplayResponse>(bRecon2, SYNC_EVENTS.REPLAY_RESPONSE, 3000);
    bRecon2.emit(SYNC_EVENTS.REPLAY_REQUEST, { since: EPOCH });
    const response2 = await replay2;
    const match2 = response2.events.find((e) => messageIdOf(e) === sent.messageId);
    assert.ok(match2, "an un-acked event must still be replayed after a SECOND reconnect — it must not be silently dropped after only one replay attempt");
    assert.equal(match2.eventId, match1.eventId, "must be the exact same outbox event both times, not a new/duplicate one");
  });

  it("ACK_EVENT advances the outbox cursor — an acked event is never replayed again", async () => {
    const [a, b] = await Promise.all([createUser(app.prisma, "a3"), createUser(app.prisma, "b3")]);
    createdUserIds.push(a.id, b.id);
    const conversation = await makeConversation(a.id, b.id);

    const bStart = await connectSocket(url, b.id);
    sockets.push(bStart);
    bStart.close();
    await waitForOffline(app, b.id);

    const sent = await sendTextMessage(app, a.id, conversation.id, "gets acked, must not come back");

    const bRecon1 = await connectSocket(url, b.id);
    sockets.push(bRecon1);
    const replay1 = waitForEvent<ReplayResponse>(bRecon1, SYNC_EVENTS.REPLAY_RESPONSE, 3000);
    bRecon1.emit(SYNC_EVENTS.REPLAY_REQUEST, { since: EPOCH });
    const response1 = await replay1;
    const match = response1.events.find((e) => messageIdOf(e) === sent.messageId);
    assert.ok(match, "replay must first surface the event before it can be acked");

    // Client confirms receipt.
    bRecon1.emit(ACK_EVENT, { eventId: match!.eventId, status: "ok" });

    // sync.socket.ts's ACK_EVENT handler calls markAcked without awaiting it
    // (void service.markAcked(...).catch(...)) — poll the actual DB row
    // rather than assuming a fixed delay is enough.
    await waitUntil(
      async () => {
        const row = await app.prisma.eventOutbox.findUnique({ where: { eventId: match!.eventId } });
        return row?.ackedAt != null;
      },
      3000,
      "the eventOutbox row to be marked acked",
    );

    bRecon1.close();
    await waitForOffline(app, b.id);

    const bRecon2 = await connectSocket(url, b.id);
    sockets.push(bRecon2);
    const replay2 = waitForEvent<ReplayResponse>(bRecon2, SYNC_EVENTS.REPLAY_RESPONSE, 3000);
    bRecon2.emit(SYNC_EVENTS.REPLAY_REQUEST, { since: EPOCH });
    const response2 = await replay2;

    assert.equal(
      response2.events.some((e) => e.eventId === match!.eventId),
      false,
      "an already-acked event must never be returned by a later replay request",
    );
  });

  it("replay scoped to one conversationId returns only that conversation's pending events, not another's", async () => {
    const [a, b] = await Promise.all([createUser(app.prisma, "a4"), createUser(app.prisma, "b4")]);
    createdUserIds.push(a.id, b.id);
    const [conv1, conv2] = await Promise.all([makeConversation(a.id, b.id), makeConversation(a.id, b.id)]);

    const bStart = await connectSocket(url, b.id);
    sockets.push(bStart);
    bStart.close();
    await waitForOffline(app, b.id);

    const sent1 = await sendTextMessage(app, a.id, conv1.id, "conv1 event");
    const sent2 = await sendTextMessage(app, a.id, conv2.id, "conv2 event");

    const bOnline = await connectSocket(url, b.id);
    sockets.push(bOnline);
    const replay = waitForEvent<ReplayResponse>(bOnline, SYNC_EVENTS.REPLAY_RESPONSE, 3000);
    bOnline.emit(SYNC_EVENTS.REPLAY_REQUEST, { since: EPOCH, conversationId: conv1.id });
    const response = await replay;

    assert.ok(response.events.length > 0, "conv1 has a pending event to return");
    assert.ok(
      response.events.every((e) => conversationIdOf(e) === conv1.id),
      "a conversationId-scoped replay must only include events from that conversation",
    );
    assert.ok(response.events.some((e) => messageIdOf(e) === sent1.messageId), "conv1's own event must be present");
    assert.ok(!response.events.some((e) => messageIdOf(e) === sent2.messageId), "conv2's event must NOT leak into a conv1-scoped replay");
  });

  it("a malformed replay request (an unparseable 'since' cursor) degrades gracefully — {events:[], nextCursor:null, error} — without tearing down the connection", async () => {
    const b = await createUser(app.prisma, "malformed");
    createdUserIds.push(b.id);
    const bSocket = await connectSocket(url, b.id);
    sockets.push(bSocket);

    const replay = waitForEvent<ReplayResponse>(bSocket, SYNC_EVENTS.REPLAY_RESPONSE, 3000);
    bSocket.emit(SYNC_EVENTS.REPLAY_REQUEST, { since: "not-a-real-date" });
    const response = await replay;

    assert.deepEqual(response.events, []);
    assert.equal(response.nextCursor, null);
    assert.ok(response.error, "an unparseable cursor must surface as a graceful error field, not crash the handler");
    assert.equal(bSocket.connected, true, "the socket must still be connected right after a failed replay request");

    // The connection must still be USABLE afterward, not merely still open —
    // prove it with a normal, valid replay request on the very same socket.
    const followUp = waitForEvent<ReplayResponse>(bSocket, SYNC_EVENTS.REPLAY_RESPONSE, 3000);
    bSocket.emit(SYNC_EVENTS.REPLAY_REQUEST, { since: EPOCH });
    const followUpResponse = await followUp;
    assert.equal(followUpResponse.error, undefined, "the same socket must still serve a normal replay after a prior failed request");
  });

  it("a repository-level failure during replay also degrades gracefully, without crashing the socket", async (t) => {
    const b = await createUser(app.prisma, "repofail");
    createdUserIds.push(b.id);
    const bSocket = await connectSocket(url, b.id);
    sockets.push(bSocket);

    const mockFn = t.mock.method(SyncRepository.prototype, "fetchPendingSince", async () => {
      throw new Error("simulated outbox repository failure");
    });

    const replay = waitForEvent<ReplayResponse>(bSocket, SYNC_EVENTS.REPLAY_RESPONSE, 3000);
    bSocket.emit(SYNC_EVENTS.REPLAY_REQUEST, { since: EPOCH });
    const response = await replay;

    assert.deepEqual(response.events, []);
    assert.equal(response.nextCursor, null);
    assert.ok(response.error, "a thrown repository error must surface as a graceful error field, not propagate/crash");
    assert.equal(bSocket.connected, true, "the socket must still be connected after the repository throws");

    // Lift the mock mid-test and confirm the SAME connection fully recovers,
    // not just that it stayed technically connected.
    mockFn.mock.restore();
    const followUp = waitForEvent<ReplayResponse>(bSocket, SYNC_EVENTS.REPLAY_RESPONSE, 3000);
    bSocket.emit(SYNC_EVENTS.REPLAY_REQUEST, { since: EPOCH });
    const followUpResponse = await followUp;
    assert.equal(followUpResponse.error, undefined, "the same socket must serve a normal replay again once the underlying failure clears");
  });
});
