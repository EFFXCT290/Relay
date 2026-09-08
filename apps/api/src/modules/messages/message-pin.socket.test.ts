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
import messageRoutes from "./message.routes.js";
import { signAccessToken } from "../../backend-core/auth/tokens.js";
import { ACCESS_COOKIE } from "../../backend-core/auth/cookies.js";
import { CONVERSATION_EVENTS, MESSAGE_EVENTS, type MessagePinnedEvent, type MessageUnpinnedEvent } from "@relay/contracts";
import type { PrismaClient } from "@prisma/client";

// Real integration test — real Postgres/Redis and a real Socket.IO server,
// same pattern as message-new.socket.test.ts. Pin/unpin broadcast to the
// conversation:${id} room only (no per-user room fan-out, unlike message:new)
// — this test proves both participants' sockets receive the event via that
// shared room, and that the payload/event names match the contract.
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
      username: `msg-pin-sock-${label}-${suffix}`,
      passwordHash: "not-a-real-hash",
      passwordSalt: randomBytes(32).toString("hex"),
    },
  });
}

function connectSocket(url: string, userId: string): Promise<ClientSocket> {
  const { token } = signAccessToken(userId);
  const socket = ioClient(url, {
    extraHeaders: { cookie: `${ACCESS_COOKIE}=${token}` },
    forceNew: true,
    reconnection: false,
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

function cookieFor(userId: string): string {
  const { token } = signAccessToken(userId);
  return `${ACCESS_COOKIE}=${token}`;
}

describe("message:pinned / message:unpinned — real Socket.IO broadcast", () => {
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
    await prisma.conversation.deleteMany({ where: { id: { in: createdConversationIds } } });
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });

    const { pushQueue } = await import("../../queues/push.queue.js");
    const { mediaQueue, videoQueue, voiceQueue } = await import("../../queues/media.queue.js");
    await Promise.all([pushQueue.close(), mediaQueue.close(), videoQueue.close(), voiceQueue.close()]);
    await app.close();

    // See message-new.socket.test.ts's identical after() note — a real
    // listening server + real client sockets leaves ioredis handles open.
    process.exit(0);
  });

  it("both participants' sockets receive message:pinned via the conversation room when one of them pins a message", async () => {
    const [pinner, other] = await Promise.all([createUser(app.prisma, "pinner"), createUser(app.prisma, "other")]);
    createdUserIds.push(pinner.id, other.id);

    const conversation = await app.prisma.conversation.create({ data: {} });
    createdConversationIds.push(conversation.id);
    await app.prisma.participant.createMany({
      data: [
        { userId: pinner.id, conversationId: conversation.id, acceptedAt: new Date() },
        { userId: other.id, conversationId: conversation.id, acceptedAt: new Date() },
      ],
    });

    const sendRes = await app.inject({
      method: "POST",
      url: `/api/conversations/${conversation.id}/messages`,
      headers: { cookie: cookieFor(pinner.id), "content-type": "application/json" },
      payload: { body: "pin me over the wire" },
    });
    assert.equal(sendRes.statusCode, 201);
    const messageId = (sendRes.json() as { messageId: string }).messageId;

    const pinnerSocket = await connectSocket(url, pinner.id);
    const otherSocket = await connectSocket(url, other.id);
    sockets.push(pinnerSocket, otherSocket);

    // Both sockets join the conversation room, mirroring the real client's
    // conversation:join on mount.
    await Promise.all(
      [pinnerSocket, otherSocket].map(
        (s) =>
          new Promise<void>((resolve) => {
            s.emit(CONVERSATION_EVENTS.JOIN, { conversationId: conversation.id });
            setTimeout(resolve, 200);
          }),
      ),
    );

    const pinnerEvent = waitForEvent<MessagePinnedEvent>(pinnerSocket, MESSAGE_EVENTS.PINNED, 3000);
    const otherEvent = waitForEvent<MessagePinnedEvent>(otherSocket, MESSAGE_EVENTS.PINNED, 3000);

    const pinRes = await app.inject({
      method: "POST",
      url: `/api/conversations/${conversation.id}/messages/${messageId}/pin`,
      headers: { cookie: cookieFor(other.id) },
    });
    assert.equal(pinRes.statusCode, 201);

    const [pinnerReceived, otherReceived] = await Promise.all([pinnerEvent, otherEvent]);
    for (const received of [pinnerReceived, otherReceived]) {
      assert.equal(received.pin.messageId, messageId);
      assert.equal(received.pin.conversationId, conversation.id);
      assert.equal(received.pin.pinnedBy, other.id);
    }

    const unpinnerEvent = waitForEvent<MessageUnpinnedEvent>(pinnerSocket, MESSAGE_EVENTS.UNPINNED, 3000);
    const unpinRes = await app.inject({
      method: "DELETE",
      url: `/api/conversations/${conversation.id}/messages/${messageId}/pin`,
      headers: { cookie: cookieFor(pinner.id) },
    });
    assert.equal(unpinRes.statusCode, 204);

    const unpinReceived = await unpinnerEvent;
    assert.equal(unpinReceived.messageId, messageId);
    assert.equal(unpinReceived.conversationId, conversation.id);
  });

  it("soft-deleting a pinned message broadcasts message:unpinned alongside message:deleted", async () => {
    const [sender, pinner] = await Promise.all([createUser(app.prisma, "sender"), createUser(app.prisma, "pinner2")]);
    createdUserIds.push(sender.id, pinner.id);

    const conversation = await app.prisma.conversation.create({ data: {} });
    createdConversationIds.push(conversation.id);
    await app.prisma.participant.createMany({
      data: [
        { userId: sender.id, conversationId: conversation.id, acceptedAt: new Date() },
        { userId: pinner.id, conversationId: conversation.id, acceptedAt: new Date() },
      ],
    });

    const sendRes = await app.inject({
      method: "POST",
      url: `/api/conversations/${conversation.id}/messages`,
      headers: { cookie: cookieFor(sender.id), "content-type": "application/json" },
      payload: { body: "will be pinned then deleted" },
    });
    const messageId = (sendRes.json() as { messageId: string }).messageId;

    const pinRes = await app.inject({
      method: "POST",
      url: `/api/conversations/${conversation.id}/messages/${messageId}/pin`,
      headers: { cookie: cookieFor(pinner.id) },
    });
    assert.equal(pinRes.statusCode, 201);

    const watcherSocket = await connectSocket(url, pinner.id);
    sockets.push(watcherSocket);
    await new Promise<void>((resolve) => {
      watcherSocket.emit(CONVERSATION_EVENTS.JOIN, { conversationId: conversation.id });
      setTimeout(resolve, 200);
    });

    const unpinnedEvent = waitForEvent<MessageUnpinnedEvent>(watcherSocket, MESSAGE_EVENTS.UNPINNED, 3000);
    const deletedEvent = waitForEvent<{ messageId: string }>(watcherSocket, MESSAGE_EVENTS.DELETED, 3000);

    const delRes = await app.inject({
      method: "DELETE",
      url: `/api/messages/${messageId}`,
      headers: { cookie: cookieFor(sender.id) },
    });
    assert.equal(delRes.statusCode, 204);

    const [unpinned, deleted] = await Promise.all([unpinnedEvent, deletedEvent]);
    assert.equal(unpinned.messageId, messageId);
    assert.equal(deleted.messageId, messageId);
  });
});
