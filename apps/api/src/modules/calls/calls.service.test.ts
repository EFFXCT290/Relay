import { describe, it, after } from "node:test";
import assert from "node:assert/strict";

// calls.service.ts transitively imports the real BullMQ Queue singletons
// (push.queue.ts, which itself imports media.queue.ts for queueConnection()).
// Each Queue opens an ioredis connection at module-load time regardless of
// whether .add() is ever called for real — left open, its reconnect timers
// keep the process alive and `node --test` never exits. Close them all once,
// after every test in this file has run.
after(async () => {
  const [{ pushQueue }, { mediaQueue, videoQueue, voiceQueue }] = await Promise.all([
    import("../../queues/push.queue.js"),
    import("../../queues/media.queue.js"),
  ]);
  await Promise.all([pushQueue.close(), mediaQueue.close(), videoQueue.close(), voiceQueue.close()]);
});

// calls.runtime.ts keeps module-level Maps, so re-import a fresh module graph
// per test (mirrors presence.service.test.ts / typing.service.test.ts).
async function freshCallService() {
  const url = new URL("./calls.service.ts", import.meta.url).href + `?t=${Math.random()}`;
  const mod = await import(url);
  return mod.CallService as typeof import("./calls.service.js").CallService;
}

type UserRow = { id: string; username: string; pushMessages: boolean; pushCalls: boolean };

function makeFastify(opts: { recipientOnline: boolean; callerId: string; recipientId: string }) {
  const users = new Map<string, UserRow>([
    [opts.callerId, { id: opts.callerId, username: "alice", pushMessages: true, pushCalls: true }],
    [opts.recipientId, { id: opts.recipientId, username: "bob", pushMessages: true, pushCalls: true }],
  ]);
  const heartbeats = new Set<string>();
  if (opts.recipientOnline) heartbeats.add(`presence:heartbeat:${opts.recipientId}`);

  const callRows: Array<Record<string, unknown>> = [];
  const emitted: Array<{ room: string; event: string; payload: unknown }> = [];

  const redis = { async exists(key: string) { return heartbeats.has(key) ? 1 : 0; } };

  const prisma = {
    user: {
      async findUnique(arg: { where: { id: string }; select?: Record<string, boolean> }) {
        const u = users.get(arg.where.id);
        if (!u) return null;
        const out: Record<string, unknown> = {};
        for (const key of Object.keys(arg.select ?? {})) {
          if (arg.select![key]) out[key] = (u as unknown as Record<string, unknown>)[key];
        }
        return out;
      },
    },
    userPresence: { async findUnique() { return null; } },
    call: {
      async create(arg: { data: Record<string, unknown> }) {
        callRows.push(arg.data);
        return { id: arg.data.id };
      },
      async update() { /* not exercised by this test */ },
    },
  };

  const io = {
    to(room: string) {
      return { emit: (event: string, payload: unknown) => emitted.push({ room, event, payload }) };
    },
  };

  const fastify = {
    redis,
    prisma,
    io,
    log: { debug() {}, info() {}, warn() {}, error() {} },
  };

  return { fastify: fastify as unknown as import("fastify").FastifyInstance, callRows, emitted };
}

const drain = () => new Promise<void>((r) => setImmediate(r));

describe("CallService.initiate — offline-callee gate (Step C.1)", () => {
  it("no longer hard-rejects an offline callee: creates a real RINGING session and enqueues push instead of a live emit", async () => {
    const { pushQueue } = await import("../../queues/push.queue.js");
    const pushCalls: Array<{ name: string; data: { userId: string; payload: { type: string } } }> = [];
    const originalAdd = pushQueue.add.bind(pushQueue);
    // Test-only override of the real BullMQ Queue's add() so this test never
    // touches a real Redis connection.
    pushQueue.add = async (name: string, data: unknown) => {
      pushCalls.push({ name, data: data as { userId: string; payload: { type: string } } });
      return {} as never;
    };

    try {
      const CallService = await freshCallService();
      const { fastify, callRows, emitted } = makeFastify({
        recipientOnline: false,
        callerId: "caller-offline-test",
        recipientId: "callee-offline-test",
      });
      const svc = new CallService(fastify);

      const ack = await svc.initiate("caller-offline-test", { targetUserId: "callee-offline-test", type: "AUDIO" });
      await drain(); // let the fire-and-forget pushIncomingCall() chain settle

      assert.equal(ack.ok, true, "an offline callee must no longer be hard-rejected");
      if (!ack.ok) return; // narrow for TS
      assert.ok(ack.callId, "ack must carry a real callId");

      assert.equal(callRows.length, 1, "a durable RINGING Call row must still be created for an offline callee");
      assert.equal(callRows[0]!.status, "RINGING");

      assert.equal(emitted.length, 0, "no live socket emit should fire — the recipient has no connected socket");

      assert.equal(pushCalls.length, 1, "an incoming-call push must be enqueued in place of the live emit");
      assert.equal(pushCalls[0]!.data.userId, "callee-offline-test");
      assert.equal(pushCalls[0]!.data.payload.type, "call_incoming");
    } finally {
      // Restore the real implementation for any later test.
      pushQueue.add = originalAdd;
    }
  });

  it("unchanged behavior for an online callee: live emit fires, no push is sent", async () => {
    const { pushQueue } = await import("../../queues/push.queue.js");
    const pushCalls: unknown[] = [];
    const originalAdd = pushQueue.add.bind(pushQueue);
    // Test-only override, see above.
    pushQueue.add = async (...args: unknown[]) => { pushCalls.push(args); return {} as never; };

    try {
      const CallService = await freshCallService();
      const { fastify, callRows, emitted } = makeFastify({
        recipientOnline: true,
        callerId: "caller-online-test",
        recipientId: "callee-online-test",
      });
      const svc = new CallService(fastify);

      const ack = await svc.initiate("caller-online-test", { targetUserId: "callee-online-test", type: "VIDEO" });
      await drain();

      assert.equal(ack.ok, true);
      assert.equal(callRows.length, 1);
      assert.equal(emitted.length, 1, "the live RINGING emit must still fire for an online recipient");
      assert.equal(emitted[0]!.room, "user:callee-online-test");
      assert.equal(pushCalls.length, 0, "no push should be sent when the recipient is already reachable live");
    } finally {
      pushQueue.add = originalAdd;
    }
  });
});
