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
import devRoutes from "./dev.routes.js";
import { signAccessToken } from "../../backend-core/auth/tokens.js";
import { ACCESS_COOKIE } from "../../backend-core/auth/cookies.js";

// Real integration test — real Postgres/Redis (the throwaway CI services), not
// hand-rolled mocks. Same minimal-app approach as the other route tests in
// this session: does NOT import buildServer()/server.ts (its pre-existing
// void main() side effect boots a second real server on import). This is the
// first test for dev.routes.ts — no prior coverage existed.
async function buildTestApp() {
  const app = Fastify({ logger: false })
    .setValidatorCompiler(TypeBoxValidatorCompiler)
    .withTypeProvider<TypeBoxTypeProvider>();

  await app.register(cookie);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);

  app.decorate(
    "io",
    {
      sockets: { adapter: { rooms: new Map<string, { size: number }>() } },
      to: () => ({ emit: () => {} }),
    } as unknown as import("fastify").FastifyInstance["io"],
  );

  // Mirrors server.ts's real global error handler exactly (ProblemError,
  // TypeBox validation failures, rate-limit) — this test specifically checks
  // that "view"/"expired" are rejected as a validation error, not a 500, so
  // the handler has to behave the same way production's does.
  app.setErrorHandler((rawErr, _req, reply) => {
    const err = rawErr as FastifyError;
    if (err instanceof ProblemError) return problemResponse(reply, err.code, err.detail);
    if (err.validation) {
      return problemResponse(reply, "validation_error", err.validation[0]?.message ?? "Request failed validation.");
    }
    throw err;
  });

  // dev.routes.ts is registered unconditionally here — the non-prod gate
  // itself lives in server.ts (`if (!isProd) await app.register(devRoutes...)`,
  // confirmed unchanged), not in this file, so it isn't re-tested here.
  await app.register(devRoutes, { prefix: "/api" });
  return app;
}

describe("POST /api/dev/notifications/test", () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>;
  let callerId: string;
  let partnerId: string;

  before(async () => {
    app = await buildTestApp();
    const prisma = app.prisma;

    const suffix = randomUUID().slice(0, 8);
    const passwordHash = "not-a-real-hash"; // login isn't exercised — tokens are minted directly below
    const passwordSalt = randomBytes(32).toString("hex"); // matches passwordSalt @db.Char(64)

    const [caller, partner] = await Promise.all([
      prisma.user.create({ data: { username: `dev-notif-caller-${suffix}`, passwordHash, passwordSalt } }),
      prisma.user.create({ data: { username: `dev-notif-partner-${suffix}`, passwordHash, passwordSalt } }),
    ]);
    callerId = caller.id;
    partnerId = partner.id;
  });

  after(async () => {
    const prisma = app.prisma;
    await prisma.notification.deleteMany({ where: { userId: callerId } });
    await prisma.user.deleteMany({ where: { id: { in: [callerId, partnerId] } } });
    await app.close();
  });

  function cookieFor(userId: string): string {
    const { token } = signAccessToken(userId);
    return `${ACCESS_COOKIE}=${token}`;
  }

  it('"capture" creates a real SYSTEM_ALERT notification, not just a 202', async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/dev/notifications/test",
      headers: { cookie: cookieFor(callerId), "content-type": "application/json" },
      payload: { variant: "capture" },
    });
    assert.equal(res.statusCode, 202);

    const rows = await app.prisma.notification.findMany({ where: { userId: callerId } });
    assert.equal(rows.length, 1);
    const [row] = rows;
    assert.equal(row!.type, "SYSTEM_ALERT");
    const payload = row!.payload as { eventType?: string };
    assert.equal(payload.eventType, "SCREENSHOT_ATTEMPT");
  });

  it('"message" creates a real MESSAGE_RECEIVED notification, not just a 202', async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/dev/notifications/test",
      headers: { cookie: cookieFor(callerId), "content-type": "application/json" },
      payload: { variant: "message", fromUsername: undefined },
    });
    assert.equal(res.statusCode, 202);

    const rows = await app.prisma.notification.findMany({
      where: { userId: callerId, type: "MESSAGE_RECEIVED" },
    });
    assert.equal(rows.length, 1);
    const payload = rows[0]!.payload as { preview?: string };
    assert.equal(payload.preview, "ping — testing live notifications");
  });

  it('"view" is rejected by schema validation, not silently a no-op 202', async () => {
    const before = await app.prisma.notification.count({ where: { userId: callerId } });

    const res = await app.inject({
      method: "POST",
      url: "/api/dev/notifications/test",
      headers: { cookie: cookieFor(callerId), "content-type": "application/json" },
      payload: { variant: "view" },
    });
    assert.notEqual(res.statusCode, 202);
    assert.notEqual(res.statusCode, 500);

    const after = await app.prisma.notification.count({ where: { userId: callerId } });
    assert.equal(after, before, "a rejected variant must not create a notification");
  });

  it('"expired" is rejected by schema validation, not silently a no-op 202', async () => {
    const before = await app.prisma.notification.count({ where: { userId: callerId } });

    const res = await app.inject({
      method: "POST",
      url: "/api/dev/notifications/test",
      headers: { cookie: cookieFor(callerId), "content-type": "application/json" },
      payload: { variant: "expired" },
    });
    assert.notEqual(res.statusCode, 202);
    assert.notEqual(res.statusCode, 500);

    const after = await app.prisma.notification.count({ where: { userId: callerId } });
    assert.equal(after, before, "a rejected variant must not create a notification");
  });
});
