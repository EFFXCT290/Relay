import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import Fastify from "fastify";
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

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ProblemError) return problemResponse(reply, err.code, err.detail);
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
