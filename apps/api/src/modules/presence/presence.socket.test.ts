import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import Fastify from "fastify";
import { TypeBoxTypeProvider, TypeBoxValidatorCompiler } from "@fastify/type-provider-typebox";
import cookie from "@fastify/cookie";
import { io as ioClient, type Socket as ClientSocket } from "socket.io-client";
import "../../backend-core/runtime/formats.js"; // side effect: registers uuid/date-time/email TypeBox formats
import prismaPlugin from "../../plugins/prisma.js";
import redisPlugin from "../../plugins/redis.js";
import authPlugin from "../../plugins/auth.js";
import socketPlugin from "../../plugins/socket.js";
import { signAccessToken } from "../../backend-core/auth/tokens.js";
import { ACCESS_COOKIE } from "../../backend-core/auth/cookies.js";
import { PRESENCE_EVENTS, PRESENCE_GRACE_MS, type PresenceOnlineEvent, type PresenceOfflineEvent } from "@relay/contracts";
import type { PrismaClient } from "@prisma/client";

// Real integration test — a real Socket.IO server bound to a real port, real
// Postgres/Redis, driven by real socket.io-client connections. Shared
// buildTestApp/createUser/connectSocket setup below is used by BOTH describe
// blocks in this file (the original crash-fix regression test, and the
// grace-period timer-ownership tests added afterward) — top-level
// before/after so setup/teardown run exactly once for the whole file.
async function buildTestApp() {
  const app = Fastify({ logger: false })
    .setValidatorCompiler(TypeBoxValidatorCompiler)
    .withTypeProvider<TypeBoxTypeProvider>();

  await app.register(cookie);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin); // real Socket.IO server — this is what actually runs markOnline/scheduleOffline

  const url = await app.listen({ port: 0, host: "127.0.0.1" });
  return { app, url };
}

async function createUser(prisma: PrismaClient, label: string) {
  const suffix = randomUUID().slice(0, 8);
  return prisma.user.create({
    data: {
      username: `presence-${label}-${suffix}`,
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// setImmediate-based yield — deliberately NOT setTimeout-based. Several tests
// below fake `setTimeout` via t.mock.timers to skip real 10-33s waits; a
// setTimeout-based sleep would never resolve on its own during that window,
// since virtual time only moves when a test explicitly calls .tick(). Node's
// mock.timers only fakes the APIs listed in its `apis` option (here, just
// "setTimeout"), so setImmediate stays real and safe to await regardless.
const drain = () => new Promise<void>((resolve) => setImmediate(resolve));

async function drainTimes(n: number): Promise<void> {
  for (let i = 0; i < n; i++) await drain();
}

// Iteration-bounded (not wall-clock-bounded) poll for a condition driven by
// real async I/O (socket connect/disconnect, DB/Redis round trips) — safe to
// use even while setTimeout is faked, since it only ever yields via the real
// setImmediate queue rather than any timer.
async function waitForCondition(predicate: () => boolean, label: string, maxIterations = 2000): Promise<void> {
  for (let i = 0; i < maxIterations; i++) {
    if (predicate()) return;
    await drain();
  }
  throw new Error(`timed out (iteration-bounded) waiting for: ${label}`);
}

let app: Awaited<ReturnType<typeof buildTestApp>>["app"];
let url: string;

before(async () => {
  ({ app, url } = await buildTestApp());
});

after(async () => {
  const { pushQueue } = await import("../../queues/push.queue.js");
  await pushQueue.close();
  await app.close();
  // See user-profile-broadcast.socket.test.ts's after() for why this test
  // style needs an explicit exit rather than relying on natural drain.
  process.exit(0);
});

describe("presence.socket.ts — fire-and-forget presence calls don't crash the process on failure", () => {
  it("a markOnline failure (the connecting user's row disappearing) is caught, not an unhandled rejection", async () => {
    const rejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => rejections.push(reason);
    process.on("unhandledRejection", onUnhandledRejection);

    try {
      const user = await createUser(app.prisma, "crash-a");
      const socket = await connectSocket(url, user.id);

      // Force the exact race that crashed the process: the user row is gone
      // by the time markOnline's fire-and-forget UserPresence upsert runs.
      await app.prisma.user.delete({ where: { id: user.id } });

      // Give the fire-and-forget markOnline() call time to settle (reject).
      await sleep(500);
      socket.close();
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
    }

    assert.equal(
      rejections.length,
      0,
      "markOnline's failure must be caught internally, not surfaced as a process-level unhandled rejection",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The documented "~30% disconnect bug": PING_INTERVAL_MS (10s) < HEARTBEAT_TTL_S
// (30s) < GRACE_MS (33s) (see presence.contract.ts). The offline-check timer
// is owned per-userId (module-level `offlineTimers` map in presence.service.ts),
// NOT per-socket — so a reconnect on any socket for that user must cancel a
// pending offline timer another socket's disconnect started. These tests
// drive that through the REAL connect/disconnect/reconnect wiring
// (registerPresenceSocket → PresenceService), not just the service directly
// (already covered at that level by presence.service.test.ts's re-arm test).
//
// Real Redis TTLs are NOT affected by faking Node's clock — t.mock.timers
// only fast-forwards the grace-period setTimeout inside PresenceService.
// Where a test needs "the heartbeat has genuinely expired" as a precondition,
// it deletes the real Redis key directly rather than waiting 30 real seconds.
// ─────────────────────────────────────────────────────────────────────────────
describe("presence timer ownership — reconnect cancellation, multi-tab dedup, and the offline-after-grace contrast (fake timers)", () => {
  const createdUserIds: string[] = [];
  const sockets: ClientSocket[] = [];
  let observer: ClientSocket;
  const onlineEvents: PresenceOnlineEvent[] = [];
  const offlineEvents: PresenceOfflineEvent[] = [];

  before(async () => {
    const watcher = await createUser(app.prisma, "observer");
    createdUserIds.push(watcher.id);
    observer = await connectSocket(url, watcher.id);
    sockets.push(observer);
    observer.on(PRESENCE_EVENTS.ONLINE, (e: PresenceOnlineEvent) => onlineEvents.push(e));
    observer.on(PRESENCE_EVENTS.OFFLINE, (e: PresenceOfflineEvent) => offlineEvents.push(e));
  });

  after(async () => {
    for (const s of sockets) s.close();
    await app.prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  });

  it("reconnecting on a DIFFERENT socket before the grace period elapses cancels the pending offline timer — presence:offline never fires", async (t) => {
    const user = await createUser(app.prisma, "reconnect");
    createdUserIds.push(user.id);

    const socket1 = await connectSocket(url, user.id);
    sockets.push(socket1);
    await waitForCondition(() => onlineEvents.some((e) => e.userId === user.id), "the initial presence:online broadcast");

    t.mock.timers.enable({ apis: ["setTimeout"] });

    // First tab disconnects — starts the grace-period countdown toward offline.
    socket1.close();
    await waitForCondition(
      () => (app.io.sockets.adapter.rooms.get(`user:${user.id}`)?.size ?? 0) === 0,
      "the user's room to empty after the first socket disconnects (arms the offline timer)",
    );

    // Reconnect on a genuinely DIFFERENT connection before the grace period
    // elapses. This is the core of the bug description: the timer is keyed
    // by userId, not by socket id, so this reconnect — on a totally separate
    // socket — must cancel the timer socket1's disconnect started.
    const socket2 = await connectSocket(url, user.id);
    sockets.push(socket2);
    await waitForCondition(
      () => (app.io.sockets.adapter.rooms.get(`user:${user.id}`)?.size ?? 0) > 0,
      "the reconnected socket to join its room",
    );

    // Advance well past the grace period. If the timer were NOT cancelled,
    // checkAndMarkOffline would fire right about now.
    t.mock.timers.tick(PRESENCE_GRACE_MS + 5_000);
    await drainTimes(50); // let any (incorrectly) fired timer's async chain settle before asserting

    assert.equal(
      offlineEvents.some((e) => e.userId === user.id),
      false,
      "a reconnect on a different socket before the grace period elapsed must cancel the pending offline timer — presence:offline must never fire",
    );

    const row = await app.prisma.userPresence.findUnique({ where: { userId: user.id } });
    assert.equal(row?.isOnline, true, "the durable row must still say online — it was never flushed to offline");
  });

  it("a second tab connecting for an already-online user does not re-broadcast presence:online", async () => {
    const user = await createUser(app.prisma, "multitab");
    createdUserIds.push(user.id);

    const socket1 = await connectSocket(url, user.id);
    sockets.push(socket1);
    await waitForCondition(() => onlineEvents.some((e) => e.userId === user.id), "the first tab's online broadcast");
    assert.equal(
      onlineEvents.filter((e) => e.userId === user.id).length,
      1,
      "exactly one online broadcast for the first connection",
    );

    // Second tab, same user, while still genuinely online (heartbeat alive).
    const socket2 = await connectSocket(url, user.id);
    sockets.push(socket2);

    // Give the second connection's markOnline call a chance to run (and,
    // incorrectly, re-broadcast) before asserting it didn't.
    await drainTimes(50);

    assert.equal(
      onlineEvents.filter((e) => e.userId === user.id).length,
      1,
      "a second tab for an already-online user must NOT trigger a duplicate presence:online broadcast — only the absent→present transition broadcasts",
    );
  });

  it("with NO reconnect, presence:offline correctly fires once the grace period elapses — the contrast case to the cancellation above", async (t) => {
    const user = await createUser(app.prisma, "timeout");
    createdUserIds.push(user.id);

    const socket1 = await connectSocket(url, user.id);
    sockets.push(socket1);
    await waitForCondition(() => onlineEvents.some((e) => e.userId === user.id), "the initial presence:online broadcast");

    t.mock.timers.enable({ apis: ["setTimeout"] });

    socket1.close();
    await waitForCondition(
      () => (app.io.sockets.adapter.rooms.get(`user:${user.id}`)?.size ?? 0) === 0,
      "the user's room to empty after disconnecting",
    );

    // Simulate the heartbeat's real 30s Redis EX TTL having already expired,
    // rather than actually waiting 30 real seconds for it — faking Node's
    // clock has no effect on Redis's own, independent TTL clock.
    await app.redis.del(`presence:heartbeat:${user.id}`);

    // No reconnect this time — advance straight past the grace period.
    t.mock.timers.tick(PRESENCE_GRACE_MS);
    await waitForCondition(
      () => offlineEvents.some((e) => e.userId === user.id),
      "presence:offline to fire once the grace period genuinely elapses with no reconnect",
    );

    const event = offlineEvents.find((e) => e.userId === user.id)!;
    assert.equal(event.userId, user.id);
    assert.equal(typeof event.lastSeen, "string");

    const row = await app.prisma.userPresence.findUnique({ where: { userId: user.id } });
    assert.equal(row?.isOnline, false, "the durable UserPresence row must be flushed to isOnline:false");
  });
});
