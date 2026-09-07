import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import Fastify from "fastify";
import prismaPlugin from "../../plugins/prisma.js";
import redisPlugin from "../../plugins/redis.js";
import { callRuntime } from "./calls.runtime.js";
import type { PrismaClient } from "@prisma/client";

// Integration coverage for pushIncomingCall / pushMissedCall / pushCallCleared
// (calls.service.ts:298-334) — the code that closed the previously-flagged
// "calls never push" gap. Real Postgres (per-user pushCalls preference) and
// real Redis (the presence heartbeat check inside initiate() — an offline
// recipient is simply one who never pinged, so no fake-presence plumbing is
// needed). Only the BullMQ enqueue itself is captured rather than sent to a
// real worker, same pattern as calls.service.test.ts's mock-based tests.
//
// Scope note: each push helper is gated by
// `isNotificationProviderEnabled("push") && prefs?.pushCalls !== false`. The
// pushCalls half is calls-specific and is exercised end-to-end below against
// real rows. The isNotificationProviderEnabled half reads a CSV parsed once
// into a module-level Set when env.ts loads (NOTIFICATION_PROVIDER) — there's
// no per-user knob to flip at request time, and its own CSV-parsing edge
// cases already have a dedicated future unit-test item
// (docs/test-coverage-plan.md Part 2, "isNotificationProviderEnabled()").
// Only the LAST test below exercises that half, via Node's `t.mock.module` —
// this file must be run with `node --experimental-test-module-mocks`
// (without the flag, that one test fails with "t.mock.module is not a
// function"; every other test in this file is unaffected by the flag).
async function freshCallService() {
  const url = new URL("./calls.service.ts", import.meta.url).href + `?t=${Math.random()}`;
  const mod = await import(url);
  return mod.CallService as typeof import("./calls.service.js").CallService;
}

async function buildTestApp() {
  const app = Fastify({ logger: false });
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  return app;
}

async function createUser(prisma: PrismaClient, label: string, pushCalls: boolean) {
  const suffix = randomUUID().slice(0, 8);
  return prisma.user.create({
    data: {
      username: `calls-push-${label}-${suffix}`,
      passwordHash: "not-a-real-hash",
      passwordSalt: randomBytes(32).toString("hex"), // matches passwordSalt @db.Char(64)
      pushCalls,
    },
  });
}

function fakeIo() {
  return { to: () => ({ emit() { /* not under test here */ } }) };
}

// handleDisconnect()/reject() both funnel through terminate(), which persists
// via CallRepository.markEnded() — a real UPDATE against a real Call row.
// Tests below seed the runtime session directly (skipping initiate()), so
// they must also create the backing row initiate() would have, or markEnded
// hits a real (silently-caught) "record not found" Prisma error.
async function createRingingCallRow(prisma: PrismaClient, callId: string, callerId: string, recipientId: string) {
  await prisma.call.create({
    data: { id: callId, callerId, recipientId, type: "AUDIO", status: "RINGING" },
  });
}

// The push side of every call here is fire-and-forget from the service's
// point of view (`void this.pushXxx(...)`), and unlike calls.service.test.ts's
// hand-rolled prisma mock, this file's PushRepository.getPreferences() hits a
// REAL Postgres connection — a genuine network round trip, not a
// same-microtask-turn resolution. A single setImmediate (enough to drain a
// mocked promise chain) is not enough to wait for that; poll with a bounded
// timeout instead.
async function waitForPushCount(pushCalls: unknown[], count: number, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (pushCalls.length < count) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timed out waiting for ${count} push enqueue(s), got ${pushCalls.length}`);
    }
    await new Promise((r) => setTimeout(r, 20));
  }
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Test-only override of the real BullMQ Queue's add() — captures the enqueue
// without a real worker/consumer, same as calls.service.test.ts. `fn` gets
// the live `pushCalls` array so it can wait on it (via waitForPushCount /
// sleep above) before the override is restored.
type PushCall = { name: string; data: unknown };
async function withPushCapture<T>(fn: (pushCalls: PushCall[]) => Promise<T>): Promise<{ result: T; pushCalls: PushCall[] }> {
  const { pushQueue } = await import("../../queues/push.queue.js");
  const pushCalls: PushCall[] = [];
  const originalAdd = pushQueue.add.bind(pushQueue);
  pushQueue.add = async (name: string, data: unknown) => {
    pushCalls.push({ name, data });
    return {} as never;
  };
  try {
    const result = await fn(pushCalls);
    return { result, pushCalls };
  } finally {
    pushQueue.add = originalAdd;
  }
}

describe("CallService push notifications — real Postgres + Redis", () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>;
  const createdUserIds: string[] = [];

  before(async () => {
    app = await buildTestApp();
  });

  after(async () => {
    await app.prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    const { pushQueue } = await import("../../queues/push.queue.js");
    const { mediaQueue, videoQueue, voiceQueue } = await import("../../queues/media.queue.js");
    await Promise.all([pushQueue.close(), mediaQueue.close(), videoQueue.close(), voiceQueue.close()]);
    await app.close();
  });

  it("pushIncomingCall: an offline recipient with pushCalls=true gets a real enqueue", async () => {
    const CallService = await freshCallService();
    const caller = await createUser(app.prisma, "caller", true);
    const recipient = await createUser(app.prisma, "recipient", true);
    createdUserIds.push(caller.id, recipient.id);

    const svc = new CallService({ ...app, io: fakeIo() } as never);
    const { result: ack, pushCalls } = await withPushCapture(async (pushCalls) => {
      const r = await svc.initiate(caller.id, { targetUserId: recipient.id, type: "AUDIO" });
      await waitForPushCount(pushCalls, 1);
      return r;
    });

    assert.equal(ack.ok, true);
    assert.equal(pushCalls.length, 1);
    assert.equal((pushCalls[0]!.data as { userId: string }).userId, recipient.id);
    assert.equal((pushCalls[0]!.data as { payload: { type: string } }).payload.type, "call_incoming");

    if (ack.ok) callRuntime.destroy(ack.callId);
  });

  it("pushIncomingCall: an offline recipient who opted out (pushCalls=false) gets no enqueue", async () => {
    const CallService = await freshCallService();
    const caller = await createUser(app.prisma, "caller", true);
    const recipient = await createUser(app.prisma, "recipient", false);
    createdUserIds.push(caller.id, recipient.id);

    const svc = new CallService({ ...app, io: fakeIo() } as never);
    const { result: ack, pushCalls } = await withPushCapture(async () => {
      const r = await svc.initiate(caller.id, { targetUserId: recipient.id, type: "AUDIO" });
      await sleep(300); // grace period — long enough for a real DB round trip, not an instant check
      return r;
    });

    assert.equal(ack.ok, true);
    assert.equal(pushCalls.length, 0, "an explicit pushCalls=false opt-out must suppress the incoming-call push");

    if (ack.ok) callRuntime.destroy(ack.callId);
  });

  it("pushMissedCall: a ring resolved by disconnect before being answered enqueues for a pushCalls=true recipient", async () => {
    const CallService = await freshCallService();
    const caller = await createUser(app.prisma, "caller", true);
    const recipient = await createUser(app.prisma, "recipient", true);
    createdUserIds.push(caller.id, recipient.id);

    const callId = randomUUID();
    callRuntime.create({ callId, callerId: caller.id, recipientId: recipient.id, type: "AUDIO", state: "ringing", iceCandidateCount: 0, callerUsername: "alice" });
    await createRingingCallRow(app.prisma, callId, caller.id, recipient.id);

    const svc = new CallService({ ...app, io: fakeIo() } as never);
    const { pushCalls } = await withPushCapture(async (pushCalls) => {
      await svc.handleDisconnect(caller.id);
      await waitForPushCount(pushCalls, 1);
    });

    assert.equal(pushCalls.length, 1);
    assert.equal((pushCalls[0]!.data as { userId: string }).userId, recipient.id);
    assert.equal((pushCalls[0]!.data as { payload: { type: string } }).payload.type, "call_missed");
  });

  it("pushMissedCall: no enqueue when the recipient opted out (pushCalls=false)", async () => {
    const CallService = await freshCallService();
    const caller = await createUser(app.prisma, "caller", true);
    const recipient = await createUser(app.prisma, "recipient", false);
    createdUserIds.push(caller.id, recipient.id);

    const callId = randomUUID();
    callRuntime.create({ callId, callerId: caller.id, recipientId: recipient.id, type: "AUDIO", state: "ringing", iceCandidateCount: 0, callerUsername: "alice" });
    await createRingingCallRow(app.prisma, callId, caller.id, recipient.id);

    const svc = new CallService({ ...app, io: fakeIo() } as never);
    const { pushCalls } = await withPushCapture(async () => {
      await svc.handleDisconnect(caller.id);
      await sleep(300);
    });

    assert.equal(pushCalls.length, 0);
  });

  it("pushCallCleared: resolving a push-notified call another way (reject) clears the stale notification for a pushCalls=true recipient", async () => {
    const CallService = await freshCallService();
    const caller = await createUser(app.prisma, "caller", true);
    const recipient = await createUser(app.prisma, "recipient", true);
    createdUserIds.push(caller.id, recipient.id);

    const callId = randomUUID();
    callRuntime.create({ callId, callerId: caller.id, recipientId: recipient.id, type: "AUDIO", state: "ringing", iceCandidateCount: 0, pushNotified: true });
    await createRingingCallRow(app.prisma, callId, caller.id, recipient.id);

    const svc = new CallService({ ...app, io: fakeIo() } as never);
    const { pushCalls } = await withPushCapture(async (pushCalls) => {
      await svc.reject(recipient.id, callId);
      await waitForPushCount(pushCalls, 1);
    });

    assert.equal(pushCalls.length, 1);
    assert.equal((pushCalls[0]!.data as { payload: { type: string } }).payload.type, "call_cleared");
  });

  it("pushCallCleared: no enqueue when the recipient opted out (pushCalls=false)", async () => {
    const CallService = await freshCallService();
    const caller = await createUser(app.prisma, "caller", true);
    const recipient = await createUser(app.prisma, "recipient", false);
    createdUserIds.push(caller.id, recipient.id);

    const callId = randomUUID();
    callRuntime.create({ callId, callerId: caller.id, recipientId: recipient.id, type: "AUDIO", state: "ringing", iceCandidateCount: 0, pushNotified: true });
    await createRingingCallRow(app.prisma, callId, caller.id, recipient.id);

    const svc = new CallService({ ...app, io: fakeIo() } as never);
    const { pushCalls } = await withPushCapture(async () => {
      await svc.reject(recipient.id, callId);
      await sleep(300);
    });

    assert.equal(pushCalls.length, 0);
  });

  it("no push of any kind fires when the notification provider doesn't include \"push\", even for a pushCalls=true recipient", async (t) => {
    const envUrl = new URL("../../backend-core/runtime/env.ts", import.meta.url).href;
    const real = await import(envUrl);
    t.mock.module(envUrl, {
      namedExports: { env: real.env, isProd: real.isProd, isNotificationProviderEnabled: () => false },
    });

    const CallService = await freshCallService();
    const caller = await createUser(app.prisma, "caller", true);
    const recipient = await createUser(app.prisma, "recipient", true);
    createdUserIds.push(caller.id, recipient.id);

    const svc = new CallService({ ...app, io: fakeIo() } as never);
    const { result: ack, pushCalls } = await withPushCapture(async () => {
      const r = await svc.initiate(caller.id, { targetUserId: recipient.id, type: "AUDIO" });
      await sleep(300); // grace period — long enough for a real DB round trip, not an instant check
      return r;
    });

    assert.equal(ack.ok, true, "the call itself still succeeds — only the push side-channel is gated");
    assert.equal(pushCalls.length, 0, "isNotificationProviderEnabled(\"push\") === false must suppress the push regardless of pushCalls");

    if (ack.ok) callRuntime.destroy(ack.callId);
  });
});
