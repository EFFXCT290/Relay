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
import { env } from "../../backend-core/runtime/env.js";

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

  describe("disconnect grace period — a mid-call socket drop is not an instant hangup", () => {
    it("a reconnect within the grace window cancels the pending termination — the call survives", async () => {
      const [a, b] = await Promise.all([
        createUser(app.prisma, "gr-a"),
        createUser(app.prisma, "gr-b"),
      ]);
      createdUserIds.push(a.id, b.id);

      const [aSocket, bSocket] = await Promise.all([connectSocket(url, a.id), connectSocket(url, b.id)]);
      sockets.push(aSocket, bSocket);

      const bRinging = waitForEvent(bSocket, CALL_EVENTS.RINGING, 3000);
      const ack = await initAck(aSocket, { targetUserId: b.id, type: "AUDIO" });
      assert.equal(ack.ok, true);
      if (!ack.ok) return;
      const callId = ack.callId;
      await bRinging;

      // Bring the call to "active" — the grace period only applies once
      // media negotiation has actually started, not to a still-ringing call.
      const aAccepted = waitForEvent(aSocket, CALL_EVENTS.ACCEPTED, 3000);
      bSocket.emit(CALL_EVENTS.ACCEPT, { callId });
      await aAccepted;

      const terminalEvents: string[] = [];
      aSocket.on(CALL_EVENTS.FAILED, () => terminalEvents.push("failed"));
      aSocket.on(CALL_EVENTS.ENDED, () => terminalEvents.push("ended"));

      bSocket.disconnect(); // simulates a dropped connection mid-call

      // Reconnect as the SAME user well within the grace window — a fresh
      // socket.io-client connection, exactly like a page reload would produce.
      const bSocket2 = await connectSocket(url, b.id);
      sockets.push(bSocket2);

      // Outlive the grace window by a comfortable margin. If the reconnect
      // hadn't cancelled the pending timer, terminate() would have fired well
      // before this point.
      await sleep(env.CALL_DISCONNECT_GRACE_MS + 500);
      assert.equal(terminalEvents.length, 0, "the reconnect must have cancelled the grace timer — no terminal event should fire");

      // Prove the session is genuinely still alive server-side, not just
      // "hasn't failed yet": an explicit end() from the reconnected side must
      // still succeed and reach A.
      const aEnded = waitForEvent(aSocket, CALL_EVENTS.ENDED, 3000);
      bSocket2.emit(CALL_EVENTS.END, { callId });
      await aEnded;
    });

    it("a disconnect that's never followed by a reconnect ends in FAILED once the grace window elapses", async () => {
      const [a, b] = await Promise.all([
        createUser(app.prisma, "gt-a"),
        createUser(app.prisma, "gt-b"),
      ]);
      createdUserIds.push(a.id, b.id);

      const [aSocket, bSocket] = await Promise.all([connectSocket(url, a.id), connectSocket(url, b.id)]);
      sockets.push(aSocket, bSocket);

      const bRinging = waitForEvent(bSocket, CALL_EVENTS.RINGING, 3000);
      const ack = await initAck(aSocket, { targetUserId: b.id, type: "AUDIO" });
      assert.equal(ack.ok, true);
      if (!ack.ok) return;
      const callId = ack.callId;
      await bRinging;

      const aAccepted = waitForEvent(aSocket, CALL_EVENTS.ACCEPTED, 3000);
      bSocket.emit(CALL_EVENTS.ACCEPT, { callId });
      await aAccepted;

      const aFailed = waitForEvent<{ callId: string; status: string }>(
        aSocket,
        CALL_EVENTS.FAILED,
        env.CALL_DISCONNECT_GRACE_MS + 2000,
      );
      bSocket.disconnect(); // dropped, and never comes back

      const failedPayload = await aFailed;
      assert.deepEqual(failedPayload, { callId, status: "FAILED" });

      const row = await app.prisma.call.findUnique({ where: { id: callId } });
      assert.equal(row?.status, "FAILED");
    });
  });

  describe("disconnect grace period — multi-session isolation (an unrelated tab/device for the same account must never touch someone else's call)", () => {
    it("an unrelated second socket for the same user disconnecting does NOT arm the grace timer — the real call socket was never touched", async () => {
      const [a, b] = await Promise.all([
        createUser(app.prisma, "ms-a"),
        createUser(app.prisma, "ms-b"),
      ]);
      createdUserIds.push(a.id, b.id);

      const [aSocket, bSocket] = await Promise.all([connectSocket(url, a.id), connectSocket(url, b.id)]);
      sockets.push(aSocket, bSocket);

      const bRinging = waitForEvent(bSocket, CALL_EVENTS.RINGING, 3000);
      const ack = await initAck(aSocket, { targetUserId: b.id, type: "AUDIO" });
      assert.equal(ack.ok, true);
      if (!ack.ok) return;
      const callId = ack.callId;
      await bRinging;

      // bSocket accepts — it becomes the tracked call-socket for B.
      const aAccepted = waitForEvent(aSocket, CALL_EVENTS.ACCEPTED, 3000);
      bSocket.emit(CALL_EVENTS.ACCEPT, { callId });
      await aAccepted;

      // B now opens a second, entirely unrelated tab/device — same userId,
      // a completely different socket that has nothing to do with this call.
      const bSocketExtra = await connectSocket(url, b.id);
      sockets.push(bSocketExtra);

      const terminalEvents: string[] = [];
      aSocket.on(CALL_EVENTS.FAILED, () => terminalEvents.push("failed"));
      aSocket.on(CALL_EVENTS.ENDED, () => terminalEvents.push("ended"));

      bSocketExtra.disconnect(); // the UNRELATED tab drops; bSocket (the real call socket) is untouched

      await sleep(env.CALL_DISCONNECT_GRACE_MS + 500);
      assert.equal(terminalEvents.length, 0, "an unrelated tab's disconnect must be a complete no-op for call state");

      const row = await app.prisma.call.findUnique({ where: { id: callId } });
      assert.equal(row?.status, "ANSWERED", "the call must still be live server-side — no grace timer should ever have armed");

      // Prove the session is genuinely untouched: an explicit end from the
      // real call socket still works normally.
      const aEnded = waitForEvent(aSocket, CALL_EVENTS.ENDED, 3000);
      bSocket.emit(CALL_EVENTS.END, { callId });
      await aEnded;
    });

    it("the actual call-holding socket disconnecting still arms the grace timer and fails the call, even with another session open the whole time", async () => {
      const [a, b] = await Promise.all([
        createUser(app.prisma, "ms2-a"),
        createUser(app.prisma, "ms2-b"),
      ]);
      createdUserIds.push(a.id, b.id);

      const [aSocket, bSocket] = await Promise.all([connectSocket(url, a.id), connectSocket(url, b.id)]);
      sockets.push(aSocket, bSocket);

      const bRinging = waitForEvent(bSocket, CALL_EVENTS.RINGING, 3000);
      const ack = await initAck(aSocket, { targetUserId: b.id, type: "AUDIO" });
      assert.equal(ack.ok, true);
      if (!ack.ok) return;
      const callId = ack.callId;
      await bRinging;

      const aAccepted = waitForEvent(aSocket, CALL_EVENTS.ACCEPTED, 3000);
      bSocket.emit(CALL_EVENTS.ACCEPT, { callId }); // bSocket becomes the tracked call-socket for B
      await aAccepted;

      // B has an unrelated second tab open throughout — it must have zero
      // bearing on what happens when the REAL call socket drops.
      const bSocketExtra = await connectSocket(url, b.id);
      sockets.push(bSocketExtra);

      const aFailed = waitForEvent<{ callId: string; status: string }>(
        aSocket,
        CALL_EVENTS.FAILED,
        env.CALL_DISCONNECT_GRACE_MS + 2000,
      );
      bSocket.disconnect(); // the actual call-holding socket drops, and never comes back

      const failedPayload = await aFailed;
      assert.deepEqual(failedPayload, { callId, status: "FAILED" });

      const row = await app.prisma.call.findUnique({ where: { id: callId } });
      assert.equal(row?.status, "FAILED");
    });

    it("after a real reconnect cancels the grace timer, the NEW socket becomes the tracked call-socket — a later disconnect of that new socket arms a fresh timer", async () => {
      const [a, b] = await Promise.all([
        createUser(app.prisma, "ms3-a"),
        createUser(app.prisma, "ms3-b"),
      ]);
      createdUserIds.push(a.id, b.id);

      const [aSocket, bSocket] = await Promise.all([connectSocket(url, a.id), connectSocket(url, b.id)]);
      sockets.push(aSocket, bSocket);

      const bRinging = waitForEvent(bSocket, CALL_EVENTS.RINGING, 3000);
      const ack = await initAck(aSocket, { targetUserId: b.id, type: "AUDIO" });
      assert.equal(ack.ok, true);
      if (!ack.ok) return;
      const callId = ack.callId;
      await bRinging;

      const aAccepted = waitForEvent(aSocket, CALL_EVENTS.ACCEPTED, 3000);
      bSocket.emit(CALL_EVENTS.ACCEPT, { callId });
      await aAccepted;

      // First drop + reconnect within the grace window — like a page reload.
      // socket.io-client never reuses the old socket.id, so bSocket2 carries a
      // genuinely new one.
      bSocket.disconnect();
      const bSocket2 = await connectSocket(url, b.id);
      sockets.push(bSocket2);

      // Give handleReconnect a moment to run before we act again.
      await sleep(200);

      // Now the NEW socket drops for good. If the tracked call-socket hadn't
      // been repointed to bSocket2 on reconnect, this would compare against
      // the stale (already-dead) original socket.id and never arm — the call
      // would hang forever instead of failing.
      const aFailed = waitForEvent<{ callId: string; status: string }>(
        aSocket,
        CALL_EVENTS.FAILED,
        env.CALL_DISCONNECT_GRACE_MS + 2000,
      );
      bSocket2.disconnect();

      const failedPayload = await aFailed;
      assert.deepEqual(failedPayload, { callId, status: "FAILED" });

      const row = await app.prisma.call.findUnique({ where: { id: callId } });
      assert.equal(row?.status, "FAILED");
    });
  });
});
