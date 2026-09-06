import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import Fastify from "fastify";
import { TypeBoxTypeProvider, TypeBoxValidatorCompiler } from "@fastify/type-provider-typebox";
import cookie from "@fastify/cookie";
import { io as ioClient, type Socket as ClientSocket } from "socket.io-client";
import "../../backend-core/runtime/formats.js";
import prismaPlugin from "../../plugins/prisma.js";
import redisPlugin from "../../plugins/redis.js";
import authPlugin from "../../plugins/auth.js";
import socketPlugin from "../../plugins/socket.js";
import { signAccessToken } from "../../backend-core/auth/tokens.js";
import { ACCESS_COOKIE } from "../../backend-core/auth/cookies.js";
import { CONVERSATION_EVENTS } from "@relay/contracts";
import type { PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";

// Real integration test — a real Socket.IO server, real Postgres/Redis, real
// socket.io-client connections. conversation.socket.ts's JOIN/LEAVE handlers
// are pure room management (see its own header comment: "no DB" for these two
// cases) — this drives that room membership through the actual socket wiring
// rather than asserting it at the unit level.
async function buildTestApp() {
  const app = Fastify({ logger: false })
    .setValidatorCompiler(TypeBoxValidatorCompiler)
    .withTypeProvider<TypeBoxTypeProvider>();

  await app.register(cookie);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin); // real Socket.IO server

  const url = await app.listen({ port: 0, host: "127.0.0.1" });
  return { app, url };
}

async function createUser(prisma: PrismaClient, label: string) {
  const suffix = randomUUID().slice(0, 8);
  return prisma.user.create({
    data: {
      username: `conv-sock-${label}-${suffix}`,
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

function isInRoom(app: FastifyInstance, roomName: string, socketId: string): boolean {
  return !!app.io.sockets.adapter.rooms.get(roomName)?.has(socketId);
}

const TEST_EVENT = "test:room-broadcast";

describe("conversation.socket.ts — conversation:join / conversation:leave room management", () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>["app"];
  let url: string;
  const createdUserIds: string[] = [];
  const sockets: ClientSocket[] = [];

  before(async () => {
    ({ app, url } = await buildTestApp());
  });

  after(async () => {
    for (const s of sockets) s.close();
    await app.prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });

    const { pushQueue } = await import("../../queues/push.queue.js");
    const { mediaQueue, videoQueue, voiceQueue } = await import("../../queues/media.queue.js");
    await Promise.all([pushQueue.close(), mediaQueue.close(), videoQueue.close(), voiceQueue.close()]);
    await app.close();

    // See user-profile-broadcast.socket.test.ts's after() — real listening
    // server + real client sockets leaves a handful of ioredis handles open
    // from every connection's fire-and-forget on-connect service calls.
    process.exit(0);
  });

  it("conversation:join adds the socket to the conversation:${id} room — confirmed both server-side and by actually receiving a room broadcast", async () => {
    const user = await createUser(app.prisma, "join");
    createdUserIds.push(user.id);
    const socket = await connectSocket(url, user.id);
    sockets.push(socket);
    const conversationId = randomUUID();

    socket.emit(CONVERSATION_EVENTS.JOIN, { conversationId });
    // conversation:join has no ack — give the server a moment to process it.
    await sleep(150);

    assert.equal(isInRoom(app, `conversation:${conversationId}`, socket.id!), true, "server-side: socket must be a member of the room");

    const received = waitForEvent(socket, TEST_EVENT, 2000);
    app.io.to(`conversation:${conversationId}`).emit(TEST_EVENT, { hello: "world" });
    await received; // resolves (doesn't time out) only if the join actually worked
  });

  it("conversation:leave removes the socket from the room — it no longer receives broadcasts to it", async () => {
    const user = await createUser(app.prisma, "leave");
    createdUserIds.push(user.id);
    const socket = await connectSocket(url, user.id);
    sockets.push(socket);
    const conversationId = randomUUID();

    socket.emit(CONVERSATION_EVENTS.JOIN, { conversationId });
    await sleep(150);
    assert.equal(isInRoom(app, `conversation:${conversationId}`, socket.id!), true, "sanity: joined first");

    socket.emit(CONVERSATION_EVENTS.LEAVE, { conversationId });
    await sleep(150);
    assert.equal(isInRoom(app, `conversation:${conversationId}`, socket.id!), false, "server-side: socket must no longer be a room member");

    const received: unknown[] = [];
    socket.on(TEST_EVENT, (payload) => received.push(payload));
    app.io.to(`conversation:${conversationId}`).emit(TEST_EVENT, { hello: "should not arrive" });
    await sleep(300); // grace period, not an instant check
    assert.equal(received.length, 0, "a room broadcast after leave must not reach this socket");
  });

  it("a malformed join/leave payload (non-string conversationId) is a safe no-op — doesn't throw, doesn't join any room", async () => {
    const user = await createUser(app.prisma, "malformed");
    createdUserIds.push(user.id);
    const socket = await connectSocket(url, user.id);
    sockets.push(socket);

    // None of these should crash the connection or the process.
    socket.emit(CONVERSATION_EVENTS.JOIN, { conversationId: 12345 });
    socket.emit(CONVERSATION_EVENTS.JOIN, {});
    socket.emit(CONVERSATION_EVENTS.JOIN, null);
    await sleep(150);

    assert.equal(socket.connected, true, "the connection must survive a malformed join payload");
    // None of the malformed payloads produced a real room name to check —
    // the meaningful assertion is that the socket is still alive and only
    // ever in its own personal room, not some room derived from garbage input.
    const rooms = [...app.io.sockets.adapter.sids.get(socket.id!) ?? []];
    assert.deepEqual(rooms.sort(), [socket.id, `user:${user.id}`].sort());
  });

  it("documents actual behavior: conversation:join has no participant-authorization check — a socket for a user with no relationship to the conversation can still join its room", async () => {
    // This is deliberately consistent with message-new.socket.test.ts's own
    // documented finding for the message-broadcast path: joining a
    // conversation room is pure room management with no DB-backed
    // participant check (see conversation.socket.ts's own header comment).
    // Not re-litigated as a new bug here — recording the actual behavior.
    const bystander = await createUser(app.prisma, "bystander");
    createdUserIds.push(bystander.id);
    const socket = await connectSocket(url, bystander.id);
    sockets.push(socket);
    const someoneElsesConversationId = randomUUID(); // doesn't exist in the DB at all

    socket.emit(CONVERSATION_EVENTS.JOIN, { conversationId: someoneElsesConversationId });
    await sleep(150);

    assert.equal(
      isInRoom(app, `conversation:${someoneElsesConversationId}`, socket.id!),
      true,
      "join succeeds regardless of DB-level participancy — there is no authz gate at this layer",
    );
  });
});
