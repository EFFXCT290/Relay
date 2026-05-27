import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import { PRESENCE_EVENTS, PRESENCE_GRACE_MS } from "@relay/contracts";

// PresenceService keeps a module-level offlineTimers map, so re-import a fresh
// module per test (mirrors typing.service.test.ts).
async function freshService() {
  const url = new URL("./presence.service.ts", import.meta.url).href + `?t=${Math.random()}`;
  const mod = await import(url);
  return mod.PresenceService as typeof import("./presence.service.js").PresenceService;
}

type Row = { userId: string; lastSeenAt: Date; isOnline: boolean };
type Emitted = { event: string; payload: { userId: string; lastSeen?: string } };

// Fake fastify: in-memory Redis (honours SET NX) + Prisma userPresence + io/log.
// Introspection fields (_store/_rows/_upsertCalls/_emitted) are attached to the
// returned objects so tests can assert on them.
function makeFastify() {
  const store = new Map<string, string>();
  const rows = new Map<string, Row>();
  const upsertCalls: Array<{ userId: string; isOnline: boolean }> = [];
  const emitted: Emitted[] = [];

  const redis = {
    async set(key: string, val: string, ...args: unknown[]) {
      if (args.includes("NX") && store.has(key)) return null; // throttle gate already claimed
      store.set(key, val);
      return "OK";
    },
    async exists(key: string) { return store.has(key) ? 1 : 0; },
    pipeline() {
      const keys: string[] = [];
      const chain = {
        exists(key: string) { keys.push(key); return chain; },
        async exec() { return keys.map((k) => [null, store.has(k) ? 1 : 0] as [null, number]); },
      };
      return chain;
    },
    _store: store,
  };

  const prisma = {
    userPresence: {
      async upsert(arg: { where: { userId: string }; create: Row; update: { lastSeenAt: Date; isOnline: boolean } }) {
        upsertCalls.push({ userId: arg.where.userId, isOnline: arg.update.isOnline });
        const existing = rows.get(arg.where.userId);
        if (existing) { existing.lastSeenAt = arg.update.lastSeenAt; existing.isOnline = arg.update.isOnline; }
        else rows.set(arg.where.userId, { ...arg.create });
        return rows.get(arg.where.userId);
      },
      async findUnique(arg: { where: { userId: string } }) {
        const r = rows.get(arg.where.userId);
        return r ? { lastSeenAt: r.lastSeenAt } : null;
      },
      async findMany(arg: { where: { userId: { in: string[] } } }) {
        return arg.where.userId.in.filter((id) => rows.has(id)).map((id) => ({ userId: id, lastSeenAt: rows.get(id)!.lastSeenAt }));
      },
    },
    _rows: rows,
    _upsertCalls: upsertCalls,
  };

  const fastify = {
    redis,
    prisma,
    io: { emit(event: string, payload: Emitted["payload"]) { emitted.push({ event, payload }); } },
    log: { debug() {}, info() {}, warn() {}, error() {} },
    _emitted: emitted,
  };

  return fastify as unknown as import("fastify").FastifyInstance & {
    redis: { _store: Map<string, string> };
    prisma: { _rows: Map<string, Row>; _upsertCalls: Array<{ userId: string; isOnline: boolean }> };
    _emitted: Emitted[];
  };
}

const drain = () => new Promise<void>((r) => setImmediate(r));
const HB = (id: string) => `presence:heartbeat:${id}`;

describe("presence.service", () => {
  beforeEach(() => { mock.timers.reset(); });

  it("pulse throttles durable lastSeen writes to once per window", async () => {
    const PresenceService = await freshService();
    const fastify = makeFastify();
    const svc = new PresenceService(fastify);

    await svc.pulse("user-a");
    await svc.pulse("user-a");
    await svc.pulse("user-a");

    assert.equal(fastify.prisma._upsertCalls.length, 1, "only the first pulse in the window writes Postgres");
    assert.equal(fastify.prisma._upsertCalls[0]!.isOnline, true);
  });

  it("markOnline writes durable lastSeen and broadcasts online once per transition", async () => {
    const PresenceService = await freshService();
    const fastify = makeFastify();
    const svc = new PresenceService(fastify);

    await svc.markOnline("user-a"); // heartbeat absent → online transition
    assert.equal(fastify.prisma._upsertCalls.at(0)?.isOnline, true);
    assert.equal(fastify._emitted.filter((e) => e.event === PRESENCE_EVENTS.ONLINE).length, 1);

    await svc.markOnline("user-a"); // heartbeat now present → no duplicate broadcast
    assert.equal(fastify._emitted.filter((e) => e.event === PRESENCE_EVENTS.ONLINE).length, 1, "no duplicate online while still online");
  });

  it("checkAndMarkOffline flushes lastSeen and broadcasts offline when the heartbeat is gone", async () => {
    const PresenceService = await freshService();
    const fastify = makeFastify();
    const svc = new PresenceService(fastify);

    await svc.checkAndMarkOffline("user-a"); // no heartbeat key → confirmed offline

    assert.equal(fastify.prisma._upsertCalls.length, 1);
    assert.equal(fastify.prisma._upsertCalls[0]!.isOnline, false);
    const offline = fastify._emitted.filter((e) => e.event === PRESENCE_EVENTS.OFFLINE);
    assert.equal(offline.length, 1);
    assert.equal(offline[0]!.payload.userId, "user-a");
    assert.equal(typeof offline[0]!.payload.lastSeen, "string");
  });

  it("checkAndMarkOffline re-arms while the heartbeat is alive, then flushes once it expires", async () => {
    mock.timers.enable({ apis: ["setTimeout", "Date"] });
    const PresenceService = await freshService();
    const fastify = makeFastify();
    const svc = new PresenceService(fastify);

    // Heartbeat alive → must NOT mark offline; must re-arm instead (the bug fix).
    fastify.redis._store.set(HB("user-a"), String(Date.now()));
    await svc.checkAndMarkOffline("user-a");
    assert.equal(fastify.prisma._upsertCalls.length, 0, "no durable write while heartbeat alive");
    assert.equal(fastify._emitted.length, 0, "no broadcast while heartbeat alive");

    // Heartbeat expires; the re-armed timer fires after the grace window.
    fastify.redis._store.delete(HB("user-a"));
    mock.timers.tick(PRESENCE_GRACE_MS);
    await drain();

    const offline = fastify._emitted.filter((e) => e.event === PRESENCE_EVENTS.OFFLINE);
    assert.equal(offline.length, 1, "offline broadcast after the heartbeat finally expired");
    assert.equal(fastify.prisma._upsertCalls.at(-1)?.isOnline, false);
  });

  it("getMany merges Redis online flags with Postgres lastSeen (no N+1)", async () => {
    const PresenceService = await freshService();
    const fastify = makeFastify();
    const svc = new PresenceService(fastify);

    const t = new Date("2026-05-26T22:00:00.000Z");
    fastify.redis._store.set(HB("a"), String(Date.now()));       // a online
    fastify.prisma._rows.set("a", { userId: "a", lastSeenAt: t, isOnline: true });
    fastify.prisma._rows.set("b", { userId: "b", lastSeenAt: t, isOnline: false }); // b offline, has lastSeen
    // c: no heartbeat, no row → offline, null lastSeen

    const res = await svc.getMany(["a", "b", "c"]);
    assert.deepEqual(res, [
      { userId: "a", isOnline: true,  lastSeen: t.toISOString() },
      { userId: "b", isOnline: false, lastSeen: t.toISOString() },
      { userId: "c", isOnline: false, lastSeen: null },
    ]);
  });
});
