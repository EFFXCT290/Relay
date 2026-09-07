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

// ─────────────────────────────────────────────────────────────────────────────
// Smoke-level coverage for call observability logging (see calls.socket.ts /
// calls.service.ts). This is tooling, not business logic — the bar here is
// "the right log line appears with the right fields", not exhaustive coverage
// of every branch. call:client-state and call:connection-stats in particular
// are pure logging sinks with zero side effects, so there's nothing else to
// assert against.
//
// Same real Socket.IO + real Postgres/Redis harness as calls.socket.test.ts —
// necessary here too, since the thing under test (fastify.log calls inside the
// real registerCallSocket/CallService) only runs on the real server plugin.
// ─────────────────────────────────────────────────────────────────────────────

type CapturedLog = { level: "info" | "warn" | "debug" | "error"; obj: Record<string, unknown>; msg: string };

async function buildTestApp() {
  const app = Fastify({ logger: false })
    .setValidatorCompiler(TypeBoxValidatorCompiler)
    .withTypeProvider<TypeBoxTypeProvider>();

  await app.register(cookie);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);

  // Capture every log call in place rather than replacing app.log wholesale —
  // registerCallSocket/CallService read `fastify.log.<level>` fresh on every
  // call, so mutating the existing methods here is picked up regardless of
  // when each CallService/socket handler was constructed.
  const logs: CapturedLog[] = [];
  for (const level of ["info", "warn", "debug", "error"] as const) {
    app.log[level] = ((obj: Record<string, unknown>, msg: string) => {
      logs.push({ level, obj, msg });
    }) as typeof app.log[typeof level];
  }

  const url = await app.listen({ port: 0, host: "127.0.0.1" });
  return { app, url, logs };
}

async function createUser(prisma: PrismaClient, label: string) {
  const suffix = randomUUID().slice(0, 8);
  return prisma.user.create({
    data: {
      username: `calls-observability-${label}-${suffix}`,
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function initAck(socket: ClientSocket, payload: unknown, timeoutMs = 3000): Promise<CallInitAck> {
  return socket.timeout(timeoutMs).emitWithAck(CALL_EVENTS.INIT, payload);
}

describe("call observability logging — real Socket.IO handlers", () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>["app"];
  let url: string;
  let logs: CapturedLog[];
  const createdUserIds: string[] = [];
  const sockets: ClientSocket[] = [];

  before(async () => {
    ({ app, url, logs } = await buildTestApp());
  });

  after(async () => {
    for (const s of sockets) s.close();
    await app.prisma.call.deleteMany({ where: { OR: [{ callerId: { in: createdUserIds } }, { recipientId: { in: createdUserIds } }] } });
    await app.prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });

    const { pushQueue } = await import("../../queues/push.queue.js");
    const { mediaQueue, videoQueue, voiceQueue } = await import("../../queues/media.queue.js");
    await Promise.all([pushQueue.close(), mediaQueue.close(), videoQueue.close(), voiceQueue.close()]);
    await app.close();
    process.exit(0);
  });

  it("call:client-state is logged verbatim as received, with no ack and no effect on the call", async () => {
    const [a, b] = await Promise.all([createUser(app.prisma, "a"), createUser(app.prisma, "b")]);
    createdUserIds.push(a.id, b.id);
    const [aSocket, bSocket] = await Promise.all([connectSocket(url, a.id), connectSocket(url, b.id)]);
    sockets.push(aSocket, bSocket);

    const bRinging = waitForEvent(bSocket, CALL_EVENTS.RINGING, 3000);
    const ack = await initAck(aSocket, { targetUserId: b.id, type: "AUDIO" });
    assert.equal(ack.ok, true);
    if (!ack.ok) return;
    const callId = ack.callId;
    await bRinging;

    logs.length = 0; // only care about what client-state itself produces
    aSocket.emit(CALL_EVENTS.CLIENT_STATE, {
      callId,
      state: "disconnected",
      timestamp: Date.now(),
      iceRestartAttempted: true,
      iceRestartBy: "outgoing",
    });

    // No ack, no relay to B — grace period, not an instant check, so a
    // mistaken relay-to-peer would still be caught.
    await sleep(300);

    const line = logs.find((l) => l.msg === "[call] client-state");
    assert.ok(line, "expected a [call] client-state log line");
    assert.equal(line!.level, "info");
    assert.equal(line!.obj.callId, callId);
    assert.equal(line!.obj.state, "disconnected");
    assert.equal(line!.obj.iceRestartAttempted, true);
    assert.equal(line!.obj.iceRestartBy, "outgoing");

    // Purely observability — never relayed to the peer as any call event.
    const bGotSomething = await Promise.race([
      waitForEvent(bSocket, CALL_EVENTS.FAILED, 300).then(() => true).catch(() => false),
    ]);
    assert.equal(bGotSomething, false);

    const bEnded = waitForEvent(bSocket, CALL_EVENTS.ENDED, 3000);
    aSocket.emit(CALL_EVENTS.END, { callId });
    await bEnded;
  });

  it("call:client-state with a missing callId is silently dropped, not logged", async () => {
    const a = await createUser(app.prisma, "a");
    createdUserIds.push(a.id);
    const socket = await connectSocket(url, a.id);
    sockets.push(socket);

    logs.length = 0;
    socket.emit(CALL_EVENTS.CLIENT_STATE, { state: "failed", timestamp: Date.now() });
    await sleep(200);

    assert.equal(logs.find((l) => l.msg === "[call] client-state"), undefined);
  });

  it("call:connection-stats is logged at debug level with the slim summary fields", async () => {
    const [a, b] = await Promise.all([createUser(app.prisma, "a"), createUser(app.prisma, "b")]);
    createdUserIds.push(a.id, b.id);
    const [aSocket, bSocket] = await Promise.all([connectSocket(url, a.id), connectSocket(url, b.id)]);
    sockets.push(aSocket, bSocket);

    const bRinging = waitForEvent(bSocket, CALL_EVENTS.RINGING, 3000);
    const ack = await initAck(aSocket, { targetUserId: b.id, type: "VIDEO" });
    assert.equal(ack.ok, true);
    if (!ack.ok) return;
    const callId = ack.callId;
    await bRinging;

    logs.length = 0;
    aSocket.emit(CALL_EVENTS.CONNECTION_STATS, {
      callId,
      candidateType: "relay",
      bytesSentDelta: 12_345,
      bytesReceivedDelta: 9_876,
      packetLoss: 0.02,
    });
    await sleep(300);

    const line = logs.find((l) => l.msg === "[call] connection-stats");
    assert.ok(line, "expected a [call] connection-stats log line");
    assert.equal(line!.level, "debug");
    assert.equal(line!.obj.callId, callId);
    assert.equal(line!.obj.candidateType, "relay");
    assert.equal(line!.obj.bytesSentDelta, 12_345);
    assert.equal(line!.obj.bytesReceivedDelta, 9_876);
    assert.equal(line!.obj.packetLoss, 0.02);

    const bEnded = waitForEvent(bSocket, CALL_EVENTS.ENDED, 3000);
    aSocket.emit(CALL_EVENTS.END, { callId });
    await bEnded;
  });

  it("a normal call lifecycle produces the Part 1 signaling/state-transition log lines", async () => {
    const [a, b] = await Promise.all([createUser(app.prisma, "a"), createUser(app.prisma, "b")]);
    createdUserIds.push(a.id, b.id);
    const [aSocket, bSocket] = await Promise.all([connectSocket(url, a.id), connectSocket(url, b.id)]);
    sockets.push(aSocket, bSocket);

    logs.length = 0;
    const bRinging = waitForEvent(bSocket, CALL_EVENTS.RINGING, 3000);
    const ack = await initAck(aSocket, { targetUserId: b.id, type: "AUDIO" });
    assert.equal(ack.ok, true);
    if (!ack.ok) return;
    const callId = ack.callId;
    await bRinging;

    const aAccepted = waitForEvent(aSocket, CALL_EVENTS.ACCEPTED, 3000);
    bSocket.emit(CALL_EVENTS.ACCEPT, { callId });
    await aAccepted;

    const bEnded = waitForEvent(bSocket, CALL_EVENTS.ENDED, 3000);
    aSocket.emit(CALL_EVENTS.END, { callId });
    await bEnded;
    await sleep(200);

    const tags = logs.map((l) => l.msg);
    assert.ok(tags.includes("[call] init"), `expected "[call] init", got: ${tags.join(", ")}`);
    assert.ok(tags.includes("[call] accepted"), `expected "[call] accepted", got: ${tags.join(", ")}`);
    assert.ok(tags.includes("[call] end"), `expected "[call] end", got: ${tags.join(", ")}`);
    assert.ok(tags.includes("[call] terminated"), `expected "[call] terminated", got: ${tags.join(", ")}`);

    const terminated = logs.find((l) => l.msg === "[call] terminated");
    assert.equal(terminated!.obj.callId, callId);
    assert.equal(terminated!.obj.status, "ENDED");
    assert.equal(typeof terminated!.obj.iceCandidatesRelayed, "number");
  });
});
