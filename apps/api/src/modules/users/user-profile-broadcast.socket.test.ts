import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import Fastify from "fastify";
import { TypeBoxTypeProvider, TypeBoxValidatorCompiler } from "@fastify/type-provider-typebox";
import cookie from "@fastify/cookie";
import { io as ioClient, type Socket as ClientSocket } from "socket.io-client";
import "../../backend-core/runtime/formats.js"; // side effect: registers uuid/date-time/email TypeBox formats
import { ProblemError, problemResponse } from "../../backend-core/http/errors.js";
import prismaPlugin from "../../plugins/prisma.js";
import redisPlugin from "../../plugins/redis.js";
import authPlugin from "../../plugins/auth.js";
import socketPlugin from "../../plugins/socket.js";
import userRoutes from "./user.routes.js";
import { signAccessToken } from "../../backend-core/auth/tokens.js";
import { ACCESS_COOKIE } from "../../backend-core/auth/cookies.js";
import { USER_EVENTS, type UserProfileUpdatedEvent } from "@relay/contracts";
import { broadcastProfileUpdate } from "./user.socket.js";
import type { PrismaClient } from "@prisma/client";

// Real integration test — real Postgres/Redis AND a real Socket.IO server
// bound to a real port, driven by real socket.io-client connections. Unlike
// every other route test file in this session (which stub `fastify.io` and
// use app.inject()), this cluster is specifically about broadcast SCOPING —
// who actually receives a socket event over the wire — which a stubbed `io`
// can't exercise at all. Deliberately does NOT import buildServer()/server.ts
// (its pre-existing void main() side effect boots a second real server on
// import); this builds only the plugins the avatar-clear route + the socket
// layer need.
async function buildTestApp() {
  const app = Fastify({ logger: false })
    .setValidatorCompiler(TypeBoxValidatorCompiler)
    .withTypeProvider<TypeBoxTypeProvider>();

  await app.register(cookie);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin); // real Socket.IO server — see note above

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ProblemError) return problemResponse(reply, err.code, err.detail);
    throw err;
  });

  // user.routes.ts references fastify.s3/fastify.getMediaUrl in its type
  // surface, but DELETE /users/me/avatar never dereferences either for a user
  // with no existing avatarKey (avatar.service.ts's clearAvatar returns early
  // before touching S3) — which is exactly the case for every test user here,
  // so minioPlugin isn't needed to exercise this route for real.
  await app.register(userRoutes, { prefix: "/api" });

  const url = await app.listen({ port: 0, host: "127.0.0.1" });
  return { app, url };
}

async function createUser(prisma: PrismaClient, label: string) {
  const suffix = randomUUID().slice(0, 8);
  return prisma.user.create({
    data: {
      username: `profile-bcast-${label}-${suffix}`,
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
    // Skip the HTTP long-polling handshake entirely — with it enabled, a
    // lingering keep-alive polling connection can make Node's http.Server
    // hang on close() for ~ping-timeout seconds after the test itself
    // already passed, since close() waits for in-flight connections to end.
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

describe("user:profile-updated broadcast scoping", () => {
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
    await prisma.conversation.deleteMany({ where: { id: { in: createdConversationIds } } }); // cascades participants
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });

    // plugins/socket.ts imports CallService (for the on-connect resyncRinging
    // call), which imports pushQueue from push.queue.ts — a module-level
    // BullMQ Queue that opens its own ioredis connection at import time
    // regardless of whether .add() is ever called (same transitive-import
    // pattern documented in message.routes.test.ts).
    const { pushQueue } = await import("../../queues/push.queue.js");
    await pushQueue.close();
    await app.close();

    // Every connected socket's on-connect handlers (presence.socket.ts's
    // markOnline/pulse, MessageService.sweepUndelivered, CallService's
    // resyncRinging) each touch fastify.redis independently and fire without
    // being awaited by the connection handler. app.close()'s redis.disconnect()
    // races those in-flight calls rather than waiting for them, and — unlike
    // every other test file in this suite — this one drives a REAL listening
    // HTTP server with REAL socket.io-client connections, so that race
    // reliably leaves a handful of ioredis sockets open after everything this
    // test actually cares about (DB rows, app.close(), the queue) has already
    // been confirmed clean above. Exiting explicitly here is the deliberate,
    // narrow fix for that — not a substitute for the real cleanup above.
    process.exit(0);
  });

  it("reaches a co-participant but NOT a user who shares no conversation, when the real avatar-clear route fires it", async () => {
    // A and B share a conversation; C shares nothing with A.
    const [a, b, c] = await Promise.all([
      createUser(app.prisma, "a"),
      createUser(app.prisma, "b"),
      createUser(app.prisma, "c"),
    ]);
    createdUserIds.push(a.id, b.id, c.id);

    const conversation = await app.prisma.conversation.create({ data: {} });
    createdConversationIds.push(conversation.id);
    await app.prisma.participant.createMany({
      data: [
        { userId: a.id, conversationId: conversation.id, acceptedAt: new Date() },
        { userId: b.id, conversationId: conversation.id, acceptedAt: new Date() },
      ],
    });

    const [bSocket, cSocket] = await Promise.all([connectSocket(url, b.id), connectSocket(url, c.id)]);
    sockets.push(bSocket, cSocket);

    const bEvent = waitForEvent<UserProfileUpdatedEvent>(bSocket, USER_EVENTS.PROFILE_UPDATED, 3000);
    const cReceived: UserProfileUpdatedEvent[] = [];
    cSocket.on(USER_EVENTS.PROFILE_UPDATED, (payload: UserProfileUpdatedEvent) => cReceived.push(payload));

    // The real trigger — not a manual emit. clearAvatar() no-ops (no S3 call)
    // for a user with no avatarKey, but the route unconditionally broadcasts
    // afterward regardless, which is exactly the code path under test here.
    const { token } = signAccessToken(a.id);
    const delRes = await app.inject({
      method: "DELETE",
      url: "/api/users/me/avatar",
      headers: { cookie: `${ACCESS_COOKIE}=${token}` },
    });
    assert.equal(delRes.statusCode, 200);

    const received = await bEvent;
    assert.equal(received.userId, a.id, "the co-participant should receive the broadcast");

    // Grace period after B's confirmed receipt — not an instant check — so a
    // slow/out-of-order emit to C would still be caught before we assert.
    await sleep(500);
    assert.equal(cReceived.length, 0, "a user sharing no conversation with A must not receive the broadcast");
  });

  // The scoping test above only ever broadcasts avatarUrl:null (DELETE
  // /users/me/avatar's real trigger, with clearAvatar's early-return for a
  // user with no avatarKey) — it can't tell a redacted null apart from a
  // genuinely-null value. This drives broadcastProfileUpdate() directly with
  // a REAL non-null avatarUrl instead, since exercising this through the
  // real POST /users/me/avatar route would require a full multipart image
  // upload + S3 write harness to test a privacy gate that lives entirely in
  // this function — real Postgres connection-status lookup and real
  // Socket.IO delivery either way, just without that unrelated plumbing.
  it("a co-participant who hasn't accepted (pending, either direction) gets the event with avatarUrl redacted to null — a connected co-participant gets the real one", async () => {
    // A+B: accepted both sides (connected). A+D: pending (D never accepted).
    const [a, b, d] = await Promise.all([
      createUser(app.prisma, "a2"),
      createUser(app.prisma, "b2"),
      createUser(app.prisma, "d2"),
    ]);
    createdUserIds.push(a.id, b.id, d.id);

    const [convoAB, convoAD] = await Promise.all([
      app.prisma.conversation.create({ data: {} }),
      app.prisma.conversation.create({ data: {} }),
    ]);
    createdConversationIds.push(convoAB.id, convoAD.id);
    await app.prisma.participant.createMany({
      data: [
        { userId: a.id, conversationId: convoAB.id, acceptedAt: new Date() },
        { userId: b.id, conversationId: convoAB.id, acceptedAt: new Date() },
        { userId: a.id, conversationId: convoAD.id, acceptedAt: new Date() },
        { userId: d.id, conversationId: convoAD.id, acceptedAt: null },
      ],
    });

    const [bSocket, dSocket] = await Promise.all([connectSocket(url, b.id), connectSocket(url, d.id)]);
    sockets.push(bSocket, dSocket);

    const bEvent = waitForEvent<UserProfileUpdatedEvent>(bSocket, USER_EVENTS.PROFILE_UPDATED, 3000);
    const dEvent = waitForEvent<UserProfileUpdatedEvent>(dSocket, USER_EVENTS.PROFILE_UPDATED, 3000);

    const realAvatarUrl = "https://minio.example/avatars/a-real.webp?X-Amz-Expires=3600";
    await broadcastProfileUpdate(app, a.id, realAvatarUrl);

    const [bReceived, dReceived] = await Promise.all([bEvent, dEvent]);
    assert.equal(bReceived.avatarUrl, realAvatarUrl, "a connected (accepted-both-sides) co-participant gets the real avatarUrl");
    assert.equal(dReceived.avatarUrl, null, "a pending (not-yet-accepted) co-participant must get the real avatarUrl redacted to null, even though they DO receive the event");
  });
});
