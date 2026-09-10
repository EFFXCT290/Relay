import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import Fastify, { type FastifyError } from "fastify";
import { TypeBoxTypeProvider, TypeBoxValidatorCompiler } from "@fastify/type-provider-typebox";
import cookie from "@fastify/cookie";
import "../../backend-core/runtime/formats.js"; // side effect: registers uuid/date-time/email TypeBox formats
import { ProblemError, problemResponse } from "../../backend-core/http/errors.js";
import prismaPlugin from "../../plugins/prisma.js";
import redisPlugin from "../../plugins/redis.js";
import authPlugin from "../../plugins/auth.js";
import notificationRoutes from "./notification.routes.js";
import { signAccessToken } from "../../backend-core/auth/tokens.js";
import { ACCESS_COOKIE } from "../../backend-core/auth/cookies.js";
import type { PrismaClient } from "@prisma/client";

// Real integration test — real Postgres/Redis (the throwaway local services),
// not hand-rolled mocks. Same minimal-app approach as the other route test
// files: does NOT import buildServer()/server.ts (its pre-existing void
// main() side effect boots a second real server on import).
async function buildTestApp() {
  const app = Fastify({ logger: false })
    .setValidatorCompiler(TypeBoxValidatorCompiler)
    .withTypeProvider<TypeBoxTypeProvider>();

  await app.register(cookie);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);

  app.setErrorHandler((rawErr, _req, reply) => {
    // TypeBox provider widens the err type to unknown; narrow here so we can
    // read Fastify's standard `validation` field (mirrors server.ts).
    const err = rawErr as FastifyError;
    if (err instanceof ProblemError) return problemResponse(reply, err.code, err.detail);
    if (err.validation) {
      return problemResponse(reply, "validation_error", err.validation[0]?.message ?? "Request failed validation.");
    }
    throw err;
  });

  await app.register(notificationRoutes, { prefix: "/api" });
  return app;
}

function cookieFor(userId: string): string {
  const { token } = signAccessToken(userId);
  return `${ACCESS_COOKIE}=${token}`;
}

async function createUser(prisma: PrismaClient, label: string) {
  const suffix = randomUUID().slice(0, 8);
  return prisma.user.create({
    data: {
      username: `notif-authz-${label}-${suffix}`,
      passwordHash: "not-a-real-hash",
      passwordSalt: randomBytes(32).toString("hex"), // matches passwordSalt @db.Char(64)
    },
  });
}

describe("PATCH /api/notifications/:notificationId/read", () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>;
  const createdUserIds: string[] = [];

  before(async () => {
    app = await buildTestApp();
  });

  after(async () => {
    const prisma = app.prisma;
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } }); // cascades notifications
    await app.close();
  });

  async function setup() {
    const [owner, other] = await Promise.all([createUser(app.prisma, "owner"), createUser(app.prisma, "other")]);
    createdUserIds.push(owner.id, other.id);
    const notification = await app.prisma.notification.create({
      data: { userId: owner.id, type: "SYSTEM_ALERT", payload: {} },
    });
    return { owner, other, notificationId: notification.id };
  }

  it("403s when the caller doesn't own the notification (notification.routes.ts:83)", async () => {
    const { other, notificationId } = await setup();
    const res = await app.inject({
      method: "PATCH",
      url: `/api/notifications/${notificationId}/read`,
      headers: { cookie: cookieFor(other.id) },
    });
    assert.equal(res.statusCode, 403);

    const row = await app.prisma.notification.findUnique({ where: { id: notificationId } });
    assert.equal(row!.isRead, false, "a rejected request must not mark someone else's notification read");
  });

  it("200s for the actual owner and the row's read state actually updates", async () => {
    const { owner, notificationId } = await setup();
    const before = await app.prisma.notification.findUnique({ where: { id: notificationId } });
    assert.equal(before!.isRead, false);

    const res = await app.inject({
      method: "PATCH",
      url: `/api/notifications/${notificationId}/read`,
      headers: { cookie: cookieFor(owner.id) },
    });
    assert.equal(res.statusCode, 204);

    const afterRow = await app.prisma.notification.findUnique({ where: { id: notificationId } });
    assert.equal(afterRow!.isRead, true);
  });
});

describe("GET /api/notifications — NotificationSchema (now sourced from @relay/contracts)", () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>;
  const createdUserIds: string[] = [];

  before(async () => {
    app = await buildTestApp();
  });

  after(async () => {
    const prisma = app.prisma;
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } }); // cascades notifications
    await app.close();
  });

  // Confirms the route's response still validates and serializes exactly the
  // same shape it did with the old inline schema: an object-valued `payload`
  // (the only shape notify() ever actually writes — see notification.service.ts)
  // must still pass through untouched, not get stripped by the swap from
  // Type.Unknown() to the contract's Type.Record(Type.String(), Type.Unknown()).
  it("returns 200 with notifications[].payload intact as an object, plus unreadCount/nextCursor", async () => {
    const owner = await createUser(app.prisma, "list");
    createdUserIds.push(owner.id);
    const fromUserId = randomUUID();
    const insertedPayload = { from: { userId: fromUserId, username: "someone" }, preview: "hi" };
    await app.prisma.notification.create({
      data: { userId: owner.id, type: "MESSAGE_RECEIVED", payload: insertedPayload },
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/notifications",
      headers: { cookie: cookieFor(owner.id) },
    });
    assert.equal(res.statusCode, 200);

    const body = res.json() as {
      notifications: { notificationId: string; type: string; isRead: boolean; payload: Record<string, unknown>; createdAt: string }[];
      unreadCount: number;
      nextCursor: string | null;
    };
    assert.equal(body.notifications.length, 1);
    assert.equal(body.notifications[0]!.type, "MESSAGE_RECEIVED");
    // Every key survives the round trip — proves the contract's
    // Type.Record(Type.String(), Type.Unknown()) serializes an arbitrary
    // object payload exactly like the old inline Type.Unknown() did.
    assert.deepEqual(body.notifications[0]!.payload, insertedPayload);
    assert.equal(body.unreadCount, 1);
    assert.equal(body.nextCursor, null);
  });

  // Standardized to 100 across every paginated GET (conversations, messages,
  // media gallery, notifications, users/search) — this route was already at
  // 100, the reference value the others were brought up to match.
  it("accepts limit=100 (the standardized maximum)", async () => {
    const owner = await createUser(app.prisma, "limitok");
    createdUserIds.push(owner.id);

    const res = await app.inject({
      method: "GET",
      url: "/api/notifications?limit=100",
      headers: { cookie: cookieFor(owner.id) },
    });
    assert.equal(res.statusCode, 200);
  });

  it("rejects limit=101 (one above the standardized maximum)", async () => {
    const owner = await createUser(app.prisma, "limitov");
    createdUserIds.push(owner.id);

    const res = await app.inject({
      method: "GET",
      url: "/api/notifications?limit=101",
      headers: { cookie: cookieFor(owner.id) },
    });
    assert.equal(res.statusCode, 422);
  });
});
