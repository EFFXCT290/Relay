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
import { MESSAGE_EVENTS, CONVERSATION_EVENTS, type MessageNewEvent } from "@relay/contracts";
import type { PrismaClient } from "@prisma/client";

// Real integration test — real Postgres/Redis and a real Socket.IO server,
// same pattern as calls.socket.test.ts / user-profile-broadcast.socket.test.ts.
// message.routes.ts's POST text-send fires TWO separate emit calls for
// message:new: one to `conversation:${id}` (message.routes.ts:328) and one
// per participant to `user:${id}` (message.routes.ts:329). These are two
// genuinely distinct Socket.IO room broadcasts, not two names for the same
// thing — each is isolated below by controlling ONLY which room a socket has
// joined, so a receipt on one isolated test proves that specific path works
// independent of the other.
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
      username: `msg-new-${label}-${suffix}`,
      passwordHash: "not-a-real-hash",
      passwordSalt: randomBytes(32).toString("hex"), // matches passwordSalt @db.Char(64)
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cookieFor(userId: string): string {
  const { token } = signAccessToken(userId);
  return `${ACCESS_COOKIE}=${token}`;
}

describe("message:new dual-emit — real Socket.IO", () => {
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

    // See user-profile-broadcast.socket.test.ts's after() — a real listening
    // server + real client sockets leaves a handful of ioredis handles open
    // from every connection's fire-and-forget on-connect service calls.
    process.exit(0);
  });

  it("a socket that has joined the conversation:${id} room receives message:new via the room broadcast, even though it is NOT a participant", async () => {
    const [sender, participant] = await Promise.all([
      createUser(app.prisma, "sender"),
      createUser(app.prisma, "participant"),
    ]);
    // A non-participant, deliberately — isolates the conversation-room path
    // from the per-participant user-room path, since the per-user loop only
    // ever targets real participants and would never reach this socket.
    const roomWatcher = await createUser(app.prisma, "room-watcher");
    createdUserIds.push(sender.id, participant.id, roomWatcher.id);

    const conversation = await app.prisma.conversation.create({ data: {} });
    createdConversationIds.push(conversation.id);
    await app.prisma.participant.createMany({
      data: [
        { userId: sender.id, conversationId: conversation.id, acceptedAt: new Date() },
        { userId: participant.id, conversationId: conversation.id, acceptedAt: new Date() },
      ],
    });

    const watcherSocket = await connectSocket(url, roomWatcher.id);
    sockets.push(watcherSocket);
    const joined = new Promise<void>((resolve) => {
      watcherSocket.emit(CONVERSATION_EVENTS.JOIN, { conversationId: conversation.id });
      // conversation:join has no ack — give the server a moment to process
      // the room-join before the message is sent, so there's no race.
      setTimeout(resolve, 200);
    });
    await joined;

    const watcherEvent = waitForEvent<MessageNewEvent>(watcherSocket, MESSAGE_EVENTS.NEW, 3000);

    const res = await app.inject({
      method: "POST",
      url: `/api/conversations/${conversation.id}/messages`,
      headers: { cookie: cookieFor(sender.id), "content-type": "application/json" },
      payload: { body: "room broadcast test" },
    });
    assert.equal(res.statusCode, 201);

    const received = await watcherEvent;
    assert.equal(received.message.body, "room broadcast test");
    assert.equal(received.message.conversationId, conversation.id);
  });

  it("a real participant who never joined the conversation room still receives message:new via their personal user:${id} room", async () => {
    const [sender, participant] = await Promise.all([
      createUser(app.prisma, "sender"),
      createUser(app.prisma, "participant"),
    ]);
    createdUserIds.push(sender.id, participant.id);

    const conversation = await app.prisma.conversation.create({ data: {} });
    createdConversationIds.push(conversation.id);
    await app.prisma.participant.createMany({
      data: [
        { userId: sender.id, conversationId: conversation.id, acceptedAt: new Date() },
        { userId: participant.id, conversationId: conversation.id, acceptedAt: new Date() },
      ],
    });

    // Connected, but deliberately never emits conversation:join — isolates
    // the per-user room path from the conversation-room path.
    const participantSocket = await connectSocket(url, participant.id);
    sockets.push(participantSocket);

    const participantEvent = waitForEvent<MessageNewEvent>(participantSocket, MESSAGE_EVENTS.NEW, 3000);

    const res = await app.inject({
      method: "POST",
      url: `/api/conversations/${conversation.id}/messages`,
      headers: { cookie: cookieFor(sender.id), "content-type": "application/json" },
      payload: { body: "personal room test" },
    });
    assert.equal(res.statusCode, 201);

    const received = await participantEvent;
    assert.equal(received.message.body, "personal room test");
    assert.equal(received.message.conversationId, conversation.id);
  });

  it("a socket with neither the conversation room joined nor conversation membership never receives the event", async () => {
    const [sender, participant, bystander] = await Promise.all([
      createUser(app.prisma, "sender"),
      createUser(app.prisma, "participant"),
      createUser(app.prisma, "bystander"),
    ]);
    createdUserIds.push(sender.id, participant.id, bystander.id);

    const conversation = await app.prisma.conversation.create({ data: {} });
    createdConversationIds.push(conversation.id);
    await app.prisma.participant.createMany({
      data: [
        { userId: sender.id, conversationId: conversation.id, acceptedAt: new Date() },
        { userId: participant.id, conversationId: conversation.id, acceptedAt: new Date() },
      ],
    });

    const bystanderSocket = await connectSocket(url, bystander.id);
    sockets.push(bystanderSocket);
    const bystanderReceived: MessageNewEvent[] = [];
    bystanderSocket.on(MESSAGE_EVENTS.NEW, (payload: MessageNewEvent) => bystanderReceived.push(payload));

    const res = await app.inject({
      method: "POST",
      url: `/api/conversations/${conversation.id}/messages`,
      headers: { cookie: cookieFor(sender.id), "content-type": "application/json" },
      payload: { body: "bystander must not see this" },
    });
    assert.equal(res.statusCode, 201);

    await sleep(500); // grace period, not an instant check
    assert.equal(bystanderReceived.length, 0);
  });
});
