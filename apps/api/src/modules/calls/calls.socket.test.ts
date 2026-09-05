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
import { CALL_EVENTS, type CallInitAck } from "@relay/contracts";
import type { PrismaClient } from "@prisma/client";

// Real integration test — a real Socket.IO server bound to a real port, real
// Postgres/Redis, driven by real socket.io-client connections. Same rationale
// as user-profile-broadcast.socket.test.ts: relay scoping ("does this event
// reach exactly the target user and no one else") can't be exercised through
// a stubbed `io`.
async function buildTestApp() {
  const app = Fastify({ logger: false })
    .setValidatorCompiler(TypeBoxValidatorCompiler)
    .withTypeProvider<TypeBoxTypeProvider>();

  await app.register(cookie);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin); // real Socket.IO server, registers every socket handler incl. calls

  const url = await app.listen({ port: 0, host: "127.0.0.1" });
  return { app, url };
}

async function createUser(prisma: PrismaClient, label: string) {
  const suffix = randomUUID().slice(0, 8);
  return prisma.user.create({
    data: {
      username: `calls-socket-${label}-${suffix}`,
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
    transports: ["websocket"], // see user-profile-broadcast.socket.test.ts for why
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

async function initAck(socket: ClientSocket, payload: unknown, timeoutMs = 3000): Promise<CallInitAck> {
  return socket.timeout(timeoutMs).emitWithAck(CALL_EVENTS.INIT, payload);
}

describe("calls.socket.ts — real Socket.IO handlers", () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>["app"];
  let url: string;
  const createdUserIds: string[] = [];
  const sockets: ClientSocket[] = [];

  before(async () => {
    ({ app, url } = await buildTestApp());
  });

  after(async () => {
    for (const s of sockets) s.close();
    await app.prisma.call.deleteMany({ where: { OR: [{ callerId: { in: createdUserIds } }, { recipientId: { in: createdUserIds } }] } });
    await app.prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });

    const { pushQueue } = await import("../../queues/push.queue.js");
    const { mediaQueue, videoQueue, voiceQueue } = await import("../../queues/media.queue.js");
    await Promise.all([pushQueue.close(), mediaQueue.close(), videoQueue.close(), voiceQueue.close()]);
    await app.close();

    // See user-profile-broadcast.socket.test.ts's after() — a real listening
    // server + real client sockets leaves a handful of ioredis handles open
    // from every connection's fire-and-forget on-connect service calls
    // (presence markOnline/pulse, MessageService.sweepUndelivered, CallService
    // resyncRinging), regardless of app.close() already having resolved.
    process.exit(0);
  });

  describe("call:init", () => {
    it("rejects a missing targetUserId with ok:false, reason:error — no ack crash", async () => {
      const a = await createUser(app.prisma, "a");
      createdUserIds.push(a.id);
      const socket = await connectSocket(url, a.id);
      sockets.push(socket);

      const ack = await initAck(socket, {});
      assert.deepEqual(ack, { ok: false, reason: "error" });
    });

    it("rejects an empty-string targetUserId", async () => {
      const a = await createUser(app.prisma, "a");
      createdUserIds.push(a.id);
      const socket = await connectSocket(url, a.id);
      sockets.push(socket);

      const ack = await initAck(socket, { targetUserId: "", type: "AUDIO" });
      assert.deepEqual(ack, { ok: false, reason: "error" });
    });

    it("rejects a non-string targetUserId", async () => {
      const a = await createUser(app.prisma, "a");
      createdUserIds.push(a.id);
      const socket = await connectSocket(url, a.id);
      sockets.push(socket);

      const ack = await initAck(socket, { targetUserId: 12345, type: "AUDIO" });
      assert.deepEqual(ack, { ok: false, reason: "error" });
    });
  });

  describe("signaling relay — verbatim payload to the target's user:${id} room only, not a broader broadcast", () => {
    it("call:offer / call:answer / call:ice-candidate / call:media-state each reach exactly the other peer, and never a third connected bystander", async () => {
      const [a, b, c] = await Promise.all([
        createUser(app.prisma, "a"),
        createUser(app.prisma, "b"),
        createUser(app.prisma, "c"),
      ]);
      createdUserIds.push(a.id, b.id, c.id);

      const [aSocket, bSocket, cSocket] = await Promise.all([
        connectSocket(url, a.id),
        connectSocket(url, b.id),
        connectSocket(url, c.id),
      ]);
      sockets.push(aSocket, bSocket, cSocket);

      // C is a real connected user who shares no call with A or B — a
      // bystander who should never receive any of the relayed signaling below.
      const bystanderEvents: Array<{ event: string; payload: unknown }> = [];
      for (const evt of [CALL_EVENTS.OFFER, CALL_EVENTS.ANSWER, CALL_EVENTS.ICE, CALL_EVENTS.PEER_MEDIA_STATE]) {
        cSocket.on(evt, (payload: unknown) => bystanderEvents.push({ event: evt, payload }));
      }

      // Real call:init establishes a real runtime session — relay handlers
      // check callRuntime.isParticipant(), so this is required, not optional
      // setup. B is online, so this is a live RINGING emit, not a push.
      const bRinging = waitForEvent(bSocket, CALL_EVENTS.RINGING, 3000);
      const ack = await initAck(aSocket, { targetUserId: b.id, type: "AUDIO" });
      assert.equal(ack.ok, true);
      if (!ack.ok) return;
      const callId = ack.callId;
      await bRinging;

      // call:offer — caller (A) → recipient (B)
      const sdpOffer = { type: "offer", sdp: "v=0 offer-sdp-body" };
      const bOffer = waitForEvent<{ callId: string; sdp: unknown }>(bSocket, CALL_EVENTS.OFFER, 3000);
      aSocket.emit(CALL_EVENTS.OFFER, { callId, sdp: sdpOffer });
      const offerReceived = await bOffer;
      assert.deepEqual(offerReceived, { callId, sdp: sdpOffer }, "the offer payload must arrive at B verbatim");

      // call:answer — recipient (B) → caller (A)
      const sdpAnswer = { type: "answer", sdp: "v=0 answer-sdp-body" };
      const aAnswer = waitForEvent<{ callId: string; sdp: unknown }>(aSocket, CALL_EVENTS.ANSWER, 3000);
      bSocket.emit(CALL_EVENTS.ANSWER, { callId, sdp: sdpAnswer });
      const answerReceived = await aAnswer;
      assert.deepEqual(answerReceived, { callId, sdp: sdpAnswer }, "the answer payload must arrive at A verbatim");

      // call:ice-candidate — either direction; test A → B
      const candidate = { candidate: "candidate:1 1 UDP 2130706431 10.0.0.1 54321 typ host", sdpMid: "0", sdpMLineIndex: 0 };
      const bIce = waitForEvent<{ callId: string; candidate: unknown }>(bSocket, CALL_EVENTS.ICE, 3000);
      aSocket.emit(CALL_EVENTS.ICE, { callId, candidate });
      const iceReceived = await bIce;
      assert.deepEqual(iceReceived, { callId, candidate }, "the ICE candidate payload must arrive at B verbatim");

      // call:media-state — either direction; test B → A. Relayed under a
      // DIFFERENT outbound event name (call:peer-media-state), per the
      // contract — not an echo of the inbound event name like offer/answer/ice.
      const aMediaState = waitForEvent<{ callId: string; cameraOn: boolean }>(aSocket, CALL_EVENTS.PEER_MEDIA_STATE, 3000);
      bSocket.emit(CALL_EVENTS.MEDIA_STATE, { callId, cameraOn: false });
      const mediaStateReceived = await aMediaState;
      assert.deepEqual(mediaStateReceived, { callId, cameraOn: false }, "the media-state payload must arrive at A verbatim");

      // Grace period after the last confirmed receipt — not an instant check —
      // so a slow/out-of-order emit to the bystander would still be caught.
      await sleep(500);
      assert.equal(bystanderEvents.length, 0, "a connected user with no part in this call must receive none of this signaling");

      // call:end has no ack — wait for the real ENDED confirmation so the call
      // is fully torn down (and its Call row finalized) before this test
      // returns, otherwise after()'s socket.close() disconnect handlers and
      // its Call-row cleanup can race the still-in-flight termination.
      const bEnded = waitForEvent(bSocket, CALL_EVENTS.ENDED, 3000);
      aSocket.emit(CALL_EVENTS.END, { callId });
      await bEnded;
    });
  });
});
