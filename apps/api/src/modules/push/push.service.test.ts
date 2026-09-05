import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import Fastify from "fastify";
import webpush from "web-push";
import prismaPlugin from "../../plugins/prisma.js";
import { PushService } from "./push.service.js";
import type { PrismaClient } from "@prisma/client";

// Integration test with the REAL DB but a MOCKED web-push transport — per the
// coverage plan, real delivery to a real push service is explicitly
// CI-untestable. `webpush` is `web-push`'s CJS default export object;
// t.mock.method mutates its `sendNotification` property directly (same
// pattern as this codebase's argon2.verify mocking) — since it's a single
// shared object in the module cache, push.service.ts's own `import webpush
// from "web-push"` sees the exact same mutated method, no cache-busting
// needed. Each test's mock is scoped to that test via `t` and auto-restores.
async function buildTestApp() {
  const app = Fastify({ logger: false });
  await app.register(prismaPlugin);
  return app;
}

async function createUser(prisma: PrismaClient, label: string) {
  const suffix = randomUUID().slice(0, 8);
  return prisma.user.create({
    data: {
      username: `push-svc-${label}-${suffix}`,
      passwordHash: "not-a-real-hash",
      passwordSalt: randomBytes(32).toString("hex"), // matches passwordSalt @db.Char(64)
    },
  });
}

async function createSubscription(prisma: PrismaClient, userId: string, endpointSuffix: string) {
  return prisma.pushSubscription.create({
    data: {
      userId,
      endpoint: `https://push.example.com/ep-${endpointSuffix}-${randomUUID()}`,
      subscription: {
        endpoint: `https://push.example.com/ep-${endpointSuffix}-${randomUUID()}`,
        keys: { p256dh: `p256dh-${endpointSuffix}`, auth: `auth-${endpointSuffix}` },
      },
      lastUsedAt: new Date(0), // deliberately stale, so a real bump is observable
    },
  });
}

describe("PushService.sendToUser() — real Postgres, mocked web-push transport", () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>;
  const createdUserIds: string[] = [];

  before(async () => {
    app = await buildTestApp();
  });

  after(async () => {
    await app.prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    await app.close();
  });

  it("constructs the correct payload per subscription: JSON-stringified body, TTL/urgency defaults, the subscription's own keys", async (t) => {
    const user = await createUser(app.prisma, "single");
    createdUserIds.push(user.id);
    const sub = await createSubscription(app.prisma, user.id, "a");

    const calls: unknown[] = [];
    t.mock.method(webpush, "sendNotification", async (...args: unknown[]) => {
      calls.push(args);
      return { statusCode: 201 };
    });

    const service = new PushService(app.prisma, app.log);
    const payload = { v: 1 as const, type: "message" as const, title: "@alice", body: "hi there", url: "/conversations/c1", tag: "conversation-c1" };
    await service.sendToUser(user.id, payload);

    assert.equal(calls.length, 1, "exactly one send for a single subscription");
    const [subscriptionArg, bodyArg, optsArg] = calls[0] as [unknown, string, { TTL: number; urgency: string }];
    assert.deepEqual(subscriptionArg, sub.subscription);
    assert.equal(bodyArg, JSON.stringify(payload));
    assert.equal(optsArg.TTL, 4 * 60 * 60, "default TTL is 4h");
    assert.equal(optsArg.urgency, "normal");

    // Side effect of a successful send: lastUsedAt is bumped for real.
    const row = await app.prisma.pushSubscription.findUnique({ where: { id: sub.id } });
    assert.ok(row!.lastUsedAt.getTime() > 0, "lastUsedAt must be bumped away from the deliberately-stale epoch value");
  });

  it("respects explicit ttl/urgency overrides when given", async (t) => {
    const user = await createUser(app.prisma, "opts");
    createdUserIds.push(user.id);
    await createSubscription(app.prisma, user.id, "a");

    const calls: unknown[] = [];
    t.mock.method(webpush, "sendNotification", async (...args: unknown[]) => {
      calls.push(args);
      return { statusCode: 201 };
    });

    const service = new PushService(app.prisma, app.log);
    await service.sendToUser(user.id, { v: 1, type: "test", title: "t", body: "b" }, { ttl: 60, urgency: "high" });

    const [, , optsArg] = calls[0] as [unknown, string, { TTL: number; urgency: string }];
    assert.equal(optsArg.TTL, 60);
    assert.equal(optsArg.urgency, "high");
  });

  it("multiple subscriptions for one user each get their own send call, with their own subscription payload", async (t) => {
    const user = await createUser(app.prisma, "multi");
    createdUserIds.push(user.id);
    const [subA, subB, subC] = await Promise.all([
      createSubscription(app.prisma, user.id, "a"),
      createSubscription(app.prisma, user.id, "b"),
      createSubscription(app.prisma, user.id, "c"),
    ]);

    const calls: Array<{ subscription: unknown }> = [];
    t.mock.method(webpush, "sendNotification", async (subscription: unknown) => {
      calls.push({ subscription });
      return { statusCode: 201 };
    });

    const service = new PushService(app.prisma, app.log);
    await service.sendToUser(user.id, { v: 1, type: "message", title: "t", body: "b" });

    assert.equal(calls.length, 3, "one send call per registered subscription");
    const sentSubs = calls.map((c) => c.subscription);
    for (const sub of [subA, subB, subC]) {
      assert.ok(
        sentSubs.some((s) => JSON.stringify(s) === JSON.stringify(sub.subscription)),
        `subscription ${sub.id} must have received its own send call with its own payload`,
      );
    }

    // All three succeeded → all three get their lastUsedAt bumped.
    const rows = await app.prisma.pushSubscription.findMany({ where: { userId: user.id } });
    assert.equal(rows.length, 3);
    for (const row of rows) assert.ok(row.lastUsedAt.getTime() > 0);
  });

  it("never reaches a real push service: the mocked sendNotification is the only thing invoked, and its (fake) resolution is what sendToUser acts on", async (t) => {
    const user = await createUser(app.prisma, "mock");
    createdUserIds.push(user.id);
    await createSubscription(app.prisma, user.id, "a");

    let realTransportTouched = false;
    // A mock that would obviously not be a real web-push response — if
    // sendToUser's behavior only makes sense assuming the mock's return
    // value (not a real network round trip), that's the confirmation this
    // never touches a real service.
    t.mock.method(webpush, "sendNotification", async () => {
      realTransportTouched = true; // this line running IS the entire "call", no network I/O occurs
      return { statusCode: 201, headers: {}, body: "" };
    });

    const service = new PushService(app.prisma, app.log);
    await service.sendToUser(user.id, { v: 1, type: "test", title: "t", body: "b" });

    assert.equal(realTransportTouched, true, "the mock must be what actually ran");
    // No assertion needs a real network call to have happened — there is no
    // code path here that could reach one: webpush.sendNotification is fully
    // replaced for the duration of this test.
  });

  it("a user with no registered subscriptions: no send attempted, returns cleanly", async (t) => {
    const user = await createUser(app.prisma, "nosub");
    createdUserIds.push(user.id);

    const calls: unknown[] = [];
    t.mock.method(webpush, "sendNotification", async (...args: unknown[]) => { calls.push(args); return { statusCode: 201 }; });

    const service = new PushService(app.prisma, app.log);
    await service.sendToUser(user.id, { v: 1, type: "test", title: "t", body: "b" });

    assert.equal(calls.length, 0);
  });
});
