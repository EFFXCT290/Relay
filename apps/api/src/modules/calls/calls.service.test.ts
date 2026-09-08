import { describe, it, after, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { CALL_EVENTS } from "@relay/contracts";
import { callRuntime, type ActiveCallSession } from "./calls.runtime.js";
import { env } from "../../backend-core/runtime/env.js";

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

// calls.service.ts itself carries no module-level state — every "fresh"
// import below produces a genuinely new CallService class, but its internal
// `import { callRuntime } from "./calls.runtime.js"` resolves (via relative
// URL resolution, which drops query strings on the base) to the exact same
// cached calls.runtime.js module as the plain top-level import of callRuntime
// above. In other words: the CallService class is fresh per test, but the
// sessions/byUser Maps underneath it are one shared instance for the whole
// file (and would be in the real process too — that's by design). That's
// exactly what makes seedSession() below work: creating a session through the
// top-level `callRuntime` import is visible to a CallService instance built
// from any freshCallService() import. Tests below rely on this and use
// randomUUID() ids throughout so they never collide with each other despite
// sharing the underlying Maps.
async function freshCallService() {
  const url = new URL("./calls.service.ts", import.meta.url).href + `?t=${Math.random()}`;
  const mod = await import(url);
  return mod.CallService as typeof import("./calls.service.js").CallService;
}

function seedSession(overrides: Partial<ActiveCallSession> & { callId: string; callerId: string; recipientId: string }): ActiveCallSession {
  const session: ActiveCallSession = {
    type: "AUDIO",
    state: "ringing",
    callerUsername: "alice",
    iceCandidateCount: 0,
    ...overrides,
  };
  callRuntime.create(session);
  return session;
}

type UserRow = { id: string; username: string; pushMessages: boolean; pushCalls: boolean };

function makeFastify(opts: { users: UserRow[]; onlineUserIds?: string[] }) {
  const usersById = new Map(opts.users.map((u) => [u.id, u]));
  const heartbeats = new Set<string>((opts.onlineUserIds ?? []).map((id) => `presence:heartbeat:${id}`));

  const callRows: Array<Record<string, unknown>> = [];
  const callUpdates: Array<{ id: string; data: Record<string, unknown> }> = [];
  const emitted: Array<{ room: string; event: string; payload: unknown }> = [];

  const redis = { async exists(key: string) { return heartbeats.has(key) ? 1 : 0; } };

  const prisma = {
    user: {
      async findUnique(arg: { where: { id: string }; select?: Record<string, boolean> }) {
        const u = usersById.get(arg.where.id);
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
      async update(arg: { where: { id: string }; data: Record<string, unknown> }) {
        callUpdates.push({ id: arg.where.id as string, data: arg.data });
        return {};
      },
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

  return { fastify: fastify as unknown as import("fastify").FastifyInstance, callRows, callUpdates, emitted };
}

const drain = () => new Promise<void>((r) => setImmediate(r));

// Test-only override of the real BullMQ Queue's add() so no test in this file
// ever touches a real Redis connection — same pattern as the pre-existing
// initiate() tests below.
async function withPushCapture<T>(fn: () => Promise<T>): Promise<{ result: T; pushCalls: Array<{ name: string; data: unknown }> }> {
  const { pushQueue } = await import("../../queues/push.queue.js");
  const pushCalls: Array<{ name: string; data: unknown }> = [];
  const originalAdd = pushQueue.add.bind(pushQueue);
  pushQueue.add = async (name: string, data: unknown) => {
    pushCalls.push({ name, data });
    return {} as never;
  };
  try {
    const result = await fn();
    return { result, pushCalls };
  } finally {
    pushQueue.add = originalAdd;
  }
}

describe("CallService.initiate — offline-callee gate (Step C.1)", () => {
  it("no longer hard-rejects an offline callee: creates a real RINGING session and enqueues push instead of a live emit", async () => {
    const CallService = await freshCallService();
    const callerId = "caller-offline-test";
    const recipientId = "callee-offline-test";
    const { fastify, callRows, emitted } = makeFastify({
      users: [
        { id: callerId, username: "alice", pushMessages: true, pushCalls: true },
        { id: recipientId, username: "bob", pushMessages: true, pushCalls: true },
      ],
      onlineUserIds: [],
    });
    const svc = new CallService(fastify);

    const { result: ack, pushCalls } = await withPushCapture(async () => {
      const r = await svc.initiate(callerId, { targetUserId: recipientId, type: "AUDIO" });
      await drain(); // let the fire-and-forget pushIncomingCall() chain settle
      return r;
    });

    assert.equal(ack.ok, true, "an offline callee must no longer be hard-rejected");
    if (!ack.ok) return; // narrow for TS
    assert.ok(ack.callId, "ack must carry a real callId");

    assert.equal(callRows.length, 1, "a durable RINGING Call row must still be created for an offline callee");
    assert.equal(callRows[0]!.status, "RINGING");

    assert.equal(emitted.length, 0, "no live socket emit should fire — the recipient has no connected socket");

    assert.equal(pushCalls.length, 1, "an incoming-call push must be enqueued in place of the live emit");
    assert.equal((pushCalls[0]!.data as { userId: string }).userId, recipientId);
    assert.equal((pushCalls[0]!.data as { payload: { type: string } }).payload.type, "call_incoming");

    callRuntime.destroy(ack.callId);
  });

  it("unchanged behavior for an online callee: live emit fires, no push is sent", async () => {
    const CallService = await freshCallService();
    const callerId = "caller-online-test";
    const recipientId = "callee-online-test";
    const { fastify, callRows, emitted } = makeFastify({
      users: [
        { id: callerId, username: "alice", pushMessages: true, pushCalls: true },
        { id: recipientId, username: "bob", pushMessages: true, pushCalls: true },
      ],
      onlineUserIds: [recipientId],
    });
    const svc = new CallService(fastify);

    const { result: ack, pushCalls } = await withPushCapture(async () => {
      const r = await svc.initiate(callerId, { targetUserId: recipientId, type: "VIDEO" });
      await drain();
      return r;
    });

    assert.equal(ack.ok, true);
    assert.equal(callRows.length, 1);
    assert.equal(emitted.length, 1, "the live RINGING emit must still fire for an online recipient");
    assert.equal(emitted[0]!.room, "user:callee-online-test");
    assert.equal(pushCalls.length, 0, "no push should be sent when the recipient is already reachable live");

    if (ack.ok) callRuntime.destroy(ack.callId);
  });
});

describe("CallService.accept — ringing → active state transition", () => {
  it("recipient accepting a ringing call: state → active, ring timer cleared, ANSWERED persisted, ACCEPTED emitted to the caller", async () => {
    const CallService = await freshCallService();
    const callerId = randomUUID();
    const recipientId = randomUUID();
    const callId = randomUUID();
    const { fastify, callUpdates, emitted } = makeFastify({
      users: [
        { id: callerId, username: "alice", pushMessages: true, pushCalls: true },
        { id: recipientId, username: "bob", pushMessages: true, pushCalls: true },
      ],
    });
    const ringTimer = setTimeout(() => { throw new Error("ring timer should have been cleared by accept()"); }, 60_000);
    ringTimer.unref?.();
    const session = seedSession({ callId, callerId, recipientId, ringTimer });

    const svc = new CallService(fastify);
    await svc.accept(recipientId, callId);

    assert.equal(session.state, "active");
    assert.equal(typeof session.answeredAt, "number");
    assert.equal(session.ringTimer, undefined, "the ring timer must be cleared on accept");

    assert.equal(callUpdates.length, 1);
    assert.equal(callUpdates[0]!.id, callId);
    assert.equal(callUpdates[0]!.data.status, "ANSWERED");
    assert.ok(callUpdates[0]!.data.answeredAt instanceof Date);
    assert.ok(callUpdates[0]!.data.startedAt instanceof Date);

    assert.equal(emitted.length, 1);
    assert.equal(emitted[0]!.room, `user:${callerId}`);
    assert.equal(emitted[0]!.event, CALL_EVENTS.ACCEPTED);
    assert.deepEqual(emitted[0]!.payload, { callId });

    callRuntime.destroy(callId);
  });

  it("invalid transition: the caller (not the recipient) cannot accept their own outgoing call", async () => {
    const CallService = await freshCallService();
    const callerId = randomUUID();
    const recipientId = randomUUID();
    const callId = randomUUID();
    const { fastify, callUpdates, emitted } = makeFastify({ users: [] });
    const session = seedSession({ callId, callerId, recipientId });

    const svc = new CallService(fastify);
    await svc.accept(callerId, callId); // wrong side

    assert.equal(session.state, "ringing", "state must not change");
    assert.equal(callUpdates.length, 0);
    assert.equal(emitted.length, 0);

    callRuntime.destroy(callId);
  });

  it("invalid transition: accepting an already-active call is a no-op (double accept)", async () => {
    const CallService = await freshCallService();
    const callerId = randomUUID();
    const recipientId = randomUUID();
    const callId = randomUUID();
    const { fastify, callUpdates, emitted } = makeFastify({ users: [] });
    seedSession({ callId, callerId, recipientId, state: "active", answeredAt: Date.now() });

    const svc = new CallService(fastify);
    await svc.accept(recipientId, callId);

    assert.equal(callUpdates.length, 0, "an already-active call must not be re-answered");
    assert.equal(emitted.length, 0);

    callRuntime.destroy(callId);
  });

  it("invalid transition: accepting a call that's already ended (no session) no-ops without throwing", async () => {
    const CallService = await freshCallService();
    const { fastify, callUpdates, emitted } = makeFastify({ users: [] });
    const svc = new CallService(fastify);

    await assert.doesNotReject(() => svc.accept(randomUUID(), randomUUID()));
    assert.equal(callUpdates.length, 0);
    assert.equal(emitted.length, 0);
  });
});

describe("CallService.reject — recipient-only terminal transition", () => {
  it("recipient rejecting a ringing call: REJECTED persisted, ENDED emitted to the caller, session torn down", async () => {
    const CallService = await freshCallService();
    const callerId = randomUUID();
    const recipientId = randomUUID();
    const callId = randomUUID();
    const { fastify, callUpdates, emitted } = makeFastify({ users: [] });
    seedSession({ callId, callerId, recipientId });

    const svc = new CallService(fastify);
    const { pushCalls } = await withPushCapture(async () => {
      await svc.reject(recipientId, callId);
      await drain();
    });

    assert.equal(callUpdates.length, 1);
    assert.equal(callUpdates[0]!.data.status, "REJECTED");
    assert.equal(callUpdates[0]!.data.endedByUserId, recipientId);

    assert.equal(emitted.length, 1);
    assert.equal(emitted[0]!.room, `user:${callerId}`);
    assert.equal(emitted[0]!.event, CALL_EVENTS.ENDED);
    assert.deepEqual(emitted[0]!.payload, { callId, status: "REJECTED" });

    assert.equal(callRuntime.get(callId), undefined, "the session must be torn down");
    assert.equal(pushCalls.length, 0, "no push follow-up when the recipient was never push-notified");
  });

  it("invalid transition: the caller cannot reject their own outgoing call", async () => {
    const CallService = await freshCallService();
    const callerId = randomUUID();
    const recipientId = randomUUID();
    const callId = randomUUID();
    const { fastify, callUpdates, emitted } = makeFastify({ users: [] });
    seedSession({ callId, callerId, recipientId });

    const svc = new CallService(fastify);
    await svc.reject(callerId, callId); // wrong side

    assert.equal(callUpdates.length, 0);
    assert.equal(emitted.length, 0);
    assert.ok(callRuntime.get(callId), "an invalid reject must not tear the session down");

    callRuntime.destroy(callId);
  });

  it("invalid transition: rejecting an already-terminated call no-ops without throwing", async () => {
    const CallService = await freshCallService();
    const { fastify, callUpdates, emitted } = makeFastify({ users: [] });
    const svc = new CallService(fastify);

    await assert.doesNotReject(() => svc.reject(randomUUID(), randomUUID()));
    assert.equal(callUpdates.length, 0);
    assert.equal(emitted.length, 0);
  });

  it("a rejected call that was originally push-notified (offline recipient) also clears the stale device notification", async () => {
    const CallService = await freshCallService();
    const callerId = randomUUID();
    const recipientId = randomUUID();
    const callId = randomUUID();
    const { fastify } = makeFastify({ users: [] });
    seedSession({ callId, callerId, recipientId, pushNotified: true });

    const svc = new CallService(fastify);
    const { pushCalls } = await withPushCapture(async () => {
      await svc.reject(recipientId, callId);
      await drain();
    });

    assert.equal(pushCalls.length, 1);
    assert.equal((pushCalls[0]!.data as { payload: { type: string } }).payload.type, "call_cleared");
  });
});

describe("CallService.end — participant-only terminal transition (valid from ringing or active)", () => {
  it("caller ends an active call: ENDED persisted with the real duration, emitted to the recipient", async () => {
    const CallService = await freshCallService();
    const callerId = randomUUID();
    const recipientId = randomUUID();
    const callId = randomUUID();
    const { fastify, callUpdates, emitted } = makeFastify({ users: [] });
    seedSession({ callId, callerId, recipientId, state: "active", answeredAt: Date.now() - 5000 });

    const svc = new CallService(fastify);
    await svc.end(callerId, callId);

    assert.equal(callUpdates.length, 1);
    assert.equal(callUpdates[0]!.data.status, "ENDED");
    assert.equal(callUpdates[0]!.data.endedByUserId, callerId);
    const durationSec = callUpdates[0]!.data.durationSec as number;
    assert.ok(durationSec >= 4 && durationSec <= 6, `expected ~5s duration, got ${durationSec}`);

    assert.equal(emitted.length, 1);
    assert.equal(emitted[0]!.room, `user:${recipientId}`);
    assert.deepEqual(emitted[0]!.payload, { callId, status: "ENDED" });
  });

  it("recipient ends an active call: emitted to the caller instead", async () => {
    const CallService = await freshCallService();
    const callerId = randomUUID();
    const recipientId = randomUUID();
    const callId = randomUUID();
    const { fastify, emitted } = makeFastify({ users: [] });
    seedSession({ callId, callerId, recipientId, state: "active", answeredAt: Date.now() });

    const svc = new CallService(fastify);
    await svc.end(recipientId, callId);

    assert.equal(emitted.length, 1);
    assert.equal(emitted[0]!.room, `user:${callerId}`);
  });

  it("valid transition: ending a still-ringing (never-answered) call — duration is 0, still a normal ENDED", async () => {
    const CallService = await freshCallService();
    const callerId = randomUUID();
    const recipientId = randomUUID();
    const callId = randomUUID();
    const { fastify, callUpdates } = makeFastify({ users: [] });
    seedSession({ callId, callerId, recipientId }); // state: "ringing", no answeredAt

    const svc = new CallService(fastify);
    await svc.end(callerId, callId);

    assert.equal(callUpdates[0]!.data.status, "ENDED");
    assert.equal(callUpdates[0]!.data.durationSec, 0);
  });

  it("invalid transition: a non-participant cannot end someone else's call", async () => {
    const CallService = await freshCallService();
    const callerId = randomUUID();
    const recipientId = randomUUID();
    const callId = randomUUID();
    const { fastify, callUpdates, emitted } = makeFastify({ users: [] });
    seedSession({ callId, callerId, recipientId, state: "active", answeredAt: Date.now() });

    const svc = new CallService(fastify);
    await svc.end(randomUUID(), callId); // bystander

    assert.equal(callUpdates.length, 0);
    assert.equal(emitted.length, 0);
    assert.ok(callRuntime.get(callId));

    callRuntime.destroy(callId);
  });

  it("invalid transition: ending an already-terminated call no-ops without throwing", async () => {
    const CallService = await freshCallService();
    const { fastify, callUpdates, emitted } = makeFastify({ users: [] });
    const svc = new CallService(fastify);

    await assert.doesNotReject(() => svc.end(randomUUID(), randomUUID()));
    assert.equal(callUpdates.length, 0);
    assert.equal(emitted.length, 0);
  });
});

describe("CallService.handleDisconnect — safety-net teardown on socket drop", () => {
  beforeEach(() => { mock.timers.reset(); });

  it("disconnect during an active call: arms a grace timer instead of terminating immediately", async () => {
    const CallService = await freshCallService();
    const callerId = randomUUID();
    const recipientId = randomUUID();
    const callId = randomUUID();
    const { fastify, callUpdates, emitted } = makeFastify({ users: [] });
    seedSession({ callId, callerId, recipientId, state: "active", answeredAt: Date.now() });

    const svc = new CallService(fastify);
    await svc.handleDisconnect(recipientId); // recipient's socket drops

    assert.equal(callUpdates.length, 0, "must not terminate on the spot — a grace period is pending");
    assert.equal(emitted.length, 0);
    const session = callRuntime.get(callId);
    assert.ok(session, "the session must survive while the grace window is open");
    assert.equal(session!.disconnectGrace?.disconnectedUserId, recipientId);

    callRuntime.destroy(callId);
  });

  it("disconnect during an active call that's never followed by a reconnect: FAILED persisted and emitted to the peer once the grace window elapses", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    const CallService = await freshCallService();
    const callerId = randomUUID();
    const recipientId = randomUUID();
    const callId = randomUUID();
    const { fastify, callUpdates, emitted } = makeFastify({ users: [] });
    seedSession({ callId, callerId, recipientId, state: "active", answeredAt: Date.now() });

    const svc = new CallService(fastify);
    await svc.handleDisconnect(recipientId); // recipient's socket drops
    assert.equal(callUpdates.length, 0, "still inside the grace window");

    mock.timers.tick(env.CALL_DISCONNECT_GRACE_MS);
    await drain();

    assert.equal(callUpdates.length, 1);
    assert.equal(callUpdates[0]!.data.status, "FAILED");
    assert.equal(callUpdates[0]!.data.endedByUserId, recipientId);

    assert.equal(emitted.length, 1);
    assert.equal(emitted[0]!.room, `user:${callerId}`);
    assert.equal(emitted[0]!.event, CALL_EVENTS.FAILED);
    assert.deepEqual(emitted[0]!.payload, { callId, status: "FAILED" });
  });

  it("reconnecting within the grace window cancels the pending timer — the call is never terminated", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    const CallService = await freshCallService();
    const callerId = randomUUID();
    const recipientId = randomUUID();
    const callId = randomUUID();
    const { fastify, callUpdates, emitted } = makeFastify({ users: [] });
    seedSession({ callId, callerId, recipientId, state: "active", answeredAt: Date.now() });

    const svc = new CallService(fastify);
    await svc.handleDisconnect(recipientId); // recipient's socket drops
    svc.handleReconnect(recipientId);         // ...and reconnects before the timer fires

    mock.timers.tick(env.CALL_DISCONNECT_GRACE_MS); // let the (now-cancelled) timer's scheduled time pass
    await drain();

    assert.equal(callUpdates.length, 0, "the call must not be terminated — the grace timer was cancelled");
    assert.equal(emitted.length, 0);
    const session = callRuntime.get(callId);
    assert.ok(session, "the session must still be alive");
    assert.equal(session!.disconnectGrace, undefined);

    callRuntime.destroy(callId);
  });

  it("a reconnect from the OTHER (still-connected) participant does not cancel a grace timer that isn't theirs", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    const CallService = await freshCallService();
    const callerId = randomUUID();
    const recipientId = randomUUID();
    const callId = randomUUID();
    const { fastify, callUpdates } = makeFastify({ users: [] });
    seedSession({ callId, callerId, recipientId, state: "active", answeredAt: Date.now() });

    const svc = new CallService(fastify);
    await svc.handleDisconnect(recipientId); // recipient's socket drops
    svc.handleReconnect(callerId);            // caller's unrelated connection event fires

    mock.timers.tick(env.CALL_DISCONNECT_GRACE_MS);
    await drain();

    assert.equal(callUpdates.length, 1, "the recipient's own disconnect must still terminate on schedule");
    assert.equal(callUpdates[0]!.data.status, "FAILED");
  });

  it("the other participant explicitly ending the call while a disconnect grace timer is pending: ENDED wins, and the timer that later elapses does not resurrect or double-terminate", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    const CallService = await freshCallService();
    const callerId = randomUUID();
    const recipientId = randomUUID();
    const callId = randomUUID();
    const { fastify, callUpdates, emitted } = makeFastify({ users: [] });
    seedSession({ callId, callerId, recipientId, state: "active", answeredAt: Date.now() });

    const svc = new CallService(fastify);
    await svc.handleDisconnect(recipientId); // recipient's socket drops, grace timer armed
    assert.equal(callUpdates.length, 0);

    await svc.end(callerId, callId); // caller hangs up for real before the grace window elapses
    assert.equal(callUpdates.length, 1);
    assert.equal(callUpdates[0]!.data.status, "ENDED");

    mock.timers.tick(env.CALL_DISCONNECT_GRACE_MS); // the now-orphaned grace timer's scheduled time passes
    await drain();

    assert.equal(callUpdates.length, 1, "the expired grace timer must not write a second terminal row over the real ENDED");
    assert.equal(emitted.length, 1, "and must not emit a second terminal event");
  });

  it("disconnect while still ringing (never answered): MISSED persisted, peer notified, and a missed-call push always targets the recipient — even when the CALLER is the one who disconnected", async () => {
    const CallService = await freshCallService();
    const callerId = randomUUID();
    const recipientId = randomUUID();
    const callId = randomUUID();
    const { fastify, callUpdates, emitted } = makeFastify({
      users: [{ id: recipientId, username: "bob", pushMessages: true, pushCalls: true }],
    });
    seedSession({ callId, callerId, recipientId, callerUsername: "alice" });

    const svc = new CallService(fastify);
    const { pushCalls } = await withPushCapture(async () => {
      await svc.handleDisconnect(callerId); // the CALLER drops before the recipient ever answers
      await drain();
    });

    assert.equal(callUpdates[0]!.data.status, "MISSED");
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0]!.room, `user:${recipientId}`, "the recipient (who never got to answer) is the peer notified");
    assert.equal(emitted[0]!.event, CALL_EVENTS.ENDED);

    assert.equal(pushCalls.length, 1);
    assert.equal((pushCalls[0]!.data as { userId: string }).userId, recipientId, "the missed-call push always targets the recipient, not whoever disconnected");
    assert.equal((pushCalls[0]!.data as { payload: { type: string } }).payload.type, "call_missed");
  });

  it("a user with no active or ringing call: disconnect is a total no-op", async () => {
    const CallService = await freshCallService();
    const { fastify, callUpdates, emitted } = makeFastify({ users: [] });
    const svc = new CallService(fastify);

    await assert.doesNotReject(() => svc.handleDisconnect(randomUUID()));
    assert.equal(callUpdates.length, 0);
    assert.equal(emitted.length, 0);
  });
});

describe("CallService terminate() idempotency — a disconnect racing an explicit end never double-fires", () => {
  it("end() followed immediately by handleDisconnect() for the other side: the second call is a complete no-op", async () => {
    const CallService = await freshCallService();
    const callerId = randomUUID();
    const recipientId = randomUUID();
    const callId = randomUUID();
    const { fastify, callUpdates, emitted } = makeFastify({ users: [] });
    seedSession({ callId, callerId, recipientId, state: "active", answeredAt: Date.now() });

    const svc = new CallService(fastify);
    await svc.end(callerId, callId);
    assert.equal(callUpdates.length, 1, "the explicit end() writes exactly once");
    assert.equal(emitted.length, 1);

    // The recipient's socket drops right after — same call, already torn down.
    await svc.handleDisconnect(recipientId);

    assert.equal(callUpdates.length, 1, "handleDisconnect must not write a second terminal row for an already-ended call");
    assert.equal(emitted.length, 1, "handleDisconnect must not emit a second terminal event");
  });
});

describe("CallService.resyncRinging — on-reconnect resync (runs on every socket connect)", () => {
  it("recipient reconnecting into a still-ringing call: RINGING re-emitted with the full payload shape", async () => {
    const CallService = await freshCallService();
    const callerId = randomUUID();
    const recipientId = randomUUID();
    const callId = randomUUID();
    const { fastify, emitted } = makeFastify({ users: [] });
    seedSession({ callId, callerId, recipientId, type: "VIDEO", callerUsername: "alice", conversationId: "conv-1" });

    const svc = new CallService(fastify);
    svc.resyncRinging(recipientId);

    assert.equal(emitted.length, 1);
    assert.equal(emitted[0]!.room, `user:${recipientId}`);
    assert.equal(emitted[0]!.event, CALL_EVENTS.RINGING);
    assert.deepEqual(emitted[0]!.payload, {
      callId,
      caller: { id: callerId, username: "alice" },
      type: "VIDEO",
      conversationId: "conv-1",
      // TURN is unconfigured in the test env → STUN-only, deterministic.
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    });

    callRuntime.destroy(callId);
  });

  it("no-op for an active (already-answered) call — nothing to resync", async () => {
    const CallService = await freshCallService();
    const callerId = randomUUID();
    const recipientId = randomUUID();
    const callId = randomUUID();
    const { fastify, emitted } = makeFastify({ users: [] });
    seedSession({ callId, callerId, recipientId, state: "active", answeredAt: Date.now() });

    const svc = new CallService(fastify);
    svc.resyncRinging(recipientId);

    assert.equal(emitted.length, 0);
    callRuntime.destroy(callId);
  });

  it("no-op for the caller's own reconnect — only the recipient side has anything to resync", async () => {
    const CallService = await freshCallService();
    const callerId = randomUUID();
    const recipientId = randomUUID();
    const callId = randomUUID();
    const { fastify, emitted } = makeFastify({ users: [] });
    seedSession({ callId, callerId, recipientId });

    const svc = new CallService(fastify);
    svc.resyncRinging(callerId);

    assert.equal(emitted.length, 0);
    callRuntime.destroy(callId);
  });

  it("no-op for a user with no call at all", async () => {
    const CallService = await freshCallService();
    const { fastify, emitted } = makeFastify({ users: [] });
    const svc = new CallService(fastify);

    assert.doesNotThrow(() => svc.resyncRinging(randomUUID()));
    assert.equal(emitted.length, 0);
  });
});
