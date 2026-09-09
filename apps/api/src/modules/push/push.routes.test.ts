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
import pushRoutes from "./push.routes.js";
import { signAccessToken } from "../../backend-core/auth/tokens.js";
import { ACCESS_COOKIE } from "../../backend-core/auth/cookies.js";
import type { PrismaClient } from "@prisma/client";

// Real integration test — real Postgres/Redis (the throwaway local services),
// not hand-rolled mocks. Same minimal-app approach as the other route test
// files: does NOT import buildServer()/server.ts (its pre-existing void
// main() side effect boots a second real server on import).
//
// This exercises the routes end-to-end through the real TypeBox validator,
// which is what actually proves WebPushSubscriptionSchema/PushPreferencesSchema/
// VapidPublicKeyResponseSchema — now sourced from @relay/contracts instead of
// being defined inline in push.routes.ts — still accept/serialize the exact
// same request and response shapes as before the move.
async function buildTestApp() {
  const app = Fastify({ logger: false })
    .setValidatorCompiler(TypeBoxValidatorCompiler)
    .withTypeProvider<TypeBoxTypeProvider>();

  await app.register(cookie);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);

  // Mirrors server.ts's full problem-details handler, including the
  // `.validation` branch — without it, a schema-rejected request would fall
  // through to Fastify's own default (400), not the app's real RFC 9457
  // validation_error (422) that production actually returns.
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

  await app.register(pushRoutes, { prefix: "/api" });
  return app;
}

after(async () => {
  const { closeAllQueueConnections } = await import("../../queues/close-all-for-tests.js");
  await closeAllQueueConnections();
});

function cookieFor(userId: string): string {
  const { token } = signAccessToken(userId);
  return `${ACCESS_COOKIE}=${token}`;
}

async function createUser(prisma: PrismaClient, label: string) {
  const suffix = randomUUID().slice(0, 8);
  return prisma.user.create({
    data: {
      username: `push-${label}-${suffix}`,
      passwordHash: "not-a-real-hash",
      passwordSalt: randomBytes(32).toString("hex"), // matches passwordSalt @db.Char(64)
    },
  });
}

describe("push routes — contract-sourced schemas (WebPushSubscriptionSchema / PushPreferencesSchema / VapidPublicKeyResponseSchema)", () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>;
  let userId: string;

  before(async () => {
    app = await buildTestApp();
    const user = await createUser(app.prisma, "subscriber");
    userId = user.id;
  });

  after(async () => {
    const prisma = app.prisma;
    await prisma.pushSubscription.deleteMany({ where: { userId } });
    await prisma.user.delete({ where: { id: userId } });
    await app.close();
  });

  it("GET /push/vapid-public-key returns 200 with a {publicKey} body", async () => {
    const res = await app.inject({ method: "GET", url: "/api/push/vapid-public-key" });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { publicKey: string };
    assert.equal(typeof body.publicKey, "string");
  });

  it("POST /push/subscriptions accepts the browser PushSubscription.toJSON() shape and returns 201", async () => {
    const endpoint = `https://fcm.googleapis.com/fcm/send/${randomUUID()}`;
    const res = await app.inject({
      method: "POST",
      url: "/api/push/subscriptions",
      headers: { cookie: cookieFor(userId), "content-type": "application/json" },
      payload: {
        endpoint,
        expirationTime: null,
        keys: { p256dh: "test-p256dh-key", auth: "test-auth-secret" },
      },
    });
    assert.equal(res.statusCode, 201);

    const row = await app.prisma.pushSubscription.findUnique({ where: { endpoint } });
    assert.ok(row, "subscription must actually persist");
    assert.equal(row!.userId, userId);
  });

  it("POST /push/subscriptions rejects a body missing required subscription fields (schema still enforces endpoint/keys)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/push/subscriptions",
      headers: { cookie: cookieFor(userId), "content-type": "application/json" },
      payload: { endpoint: `https://fcm.googleapis.com/fcm/send/${randomUUID()}` }, // missing `keys`
    });
    assert.equal(res.statusCode, 422);
  });

  it("DELETE /push/subscriptions?endpoint=... removes the subscription and returns 204", async () => {
    const endpoint = `https://fcm.googleapis.com/fcm/send/${randomUUID()}`;
    await app.prisma.pushSubscription.create({
      data: {
        userId,
        endpoint,
        subscription: { endpoint, keys: { p256dh: "x", auth: "y" } },
        lastUsedAt: new Date(),
      },
    });

    const res = await app.inject({
      method: "DELETE",
      url: `/api/push/subscriptions?endpoint=${encodeURIComponent(endpoint)}`,
      headers: { cookie: cookieFor(userId) },
    });
    assert.equal(res.statusCode, 204);

    const row = await app.prisma.pushSubscription.findUnique({ where: { endpoint } });
    assert.equal(row, null);
  });

  it("DELETE /push/subscriptions rejects a missing endpoint query param (schema still enforces it)", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: "/api/push/subscriptions",
      headers: { cookie: cookieFor(userId) },
    });
    assert.equal(res.statusCode, 422);
  });

  it("GET /push/preferences returns 200 with the {pushMessages, pushCalls} shape", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/push/preferences",
      headers: { cookie: cookieFor(userId) },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { pushMessages: boolean; pushCalls: boolean };
    assert.equal(typeof body.pushMessages, "boolean");
    assert.equal(typeof body.pushCalls, "boolean");
  });

  it("PATCH /push/preferences accepts a partial body (Type.Partial(PushPreferencesSchema)) and persists it", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/api/push/preferences",
      headers: { cookie: cookieFor(userId), "content-type": "application/json" },
      payload: { pushCalls: false },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { pushMessages: boolean; pushCalls: boolean };
    assert.equal(body.pushCalls, false);

    const user = await app.prisma.user.findUnique({ where: { id: userId }, select: { pushCalls: true } });
    assert.equal(user!.pushCalls, false);
  });

  it("PATCH /push/preferences rejects a body with a wrong-typed field (schema still validates)", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/api/push/preferences",
      headers: { cookie: cookieFor(userId), "content-type": "application/json" },
      payload: { pushCalls: "not-a-boolean" },
    });
    assert.equal(res.statusCode, 422);
  });
});
