import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import Fastify, { type FastifyError } from "fastify";
import { TypeBoxTypeProvider, TypeBoxValidatorCompiler } from "@fastify/type-provider-typebox";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import argon2 from "argon2";
import "../../backend-core/runtime/formats.js"; // side effect: registers uuid/date-time/email TypeBox formats
import { ProblemError, problemResponse } from "../../backend-core/http/errors.js";
import prismaPlugin from "../../plugins/prisma.js";
import redisPlugin from "../../plugins/redis.js";
import authPlugin from "../../plugins/auth.js";
import authRoutes from "./auth.routes.js";
import { verifyAccessToken, verifyRefreshToken } from "../../backend-core/auth/tokens.js";
import { ACCESS_COOKIE, REFRESH_COOKIE } from "../../backend-core/auth/cookies.js";

// Real integration test — real Postgres/Redis (the throwaway local services), not
// hand-rolled mocks. Same minimal-app approach as the other route tests in this
// session: does NOT import buildServer()/server.ts (its pre-existing void main()
// side effect boots a second real server on import). Unlike those other route
// tests, this one also registers @fastify/rate-limit — auth.routes.ts's
// register/login rate limits are exactly what's under test here.
async function buildTestApp() {
  const app = Fastify({ logger: false })
    .setValidatorCompiler(TypeBoxValidatorCompiler)
    .withTypeProvider<TypeBoxTypeProvider>();

  await app.register(cookie);
  // Mirrors server.ts's global rate-limit registration; auth.routes.ts's
  // per-route configs (register: 3/1h, login: 5/15min) take precedence over it.
  await app.register(rateLimit, { global: true, max: 300, timeWindow: "1 minute" });
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);

  // Mirrors server.ts's real global error handler exactly (ProblemError,
  // TypeBox validation failures, rate-limit 429) so validation/rate-limit
  // rejections come back as the real problem-details shape, not a generic 500.
  app.setErrorHandler((rawErr, _req, reply) => {
    const err = rawErr as FastifyError;
    if (err instanceof ProblemError) return problemResponse(reply, err.code, err.detail);
    if (err.validation) {
      return problemResponse(reply, "validation_error", err.validation[0]?.message ?? "Request failed validation.");
    }
    if (err.statusCode === 429) {
      return problemResponse(reply, "rate_limited", "Too many requests.");
    }
    throw err;
  });

  await app.register(authRoutes, { prefix: "/api" });
  return app;
}

// Both routes' rate limits are keyed per-IP (auth.routes.ts's `ipKey`). Spread
// unrelated scenarios across distinct fake IPs so they don't trip each other's
// counters — only the dedicated rate-limit tests deliberately reuse one IP.
let ipCounter = 0;
function nextIp(): string {
  ipCounter += 1;
  return `10.${(ipCounter >> 16) & 255}.${(ipCounter >> 8) & 255}.${ipCounter & 255}`;
}

function randomUsername(length = 12): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_";
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) out += alphabet[bytes[i]! % alphabet.length];
  return out;
}

describe("POST /api/auth/register", () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>;
  const createdUsernames: string[] = [];

  before(async () => {
    app = await buildTestApp();
  });

  after(async () => {
    await app.prisma.user.deleteMany({ where: { username: { in: createdUsernames } } });
    await app.close();
  });

  function register(payload: { username: string; password: string }, ip: string) {
    return app.inject({
      method: "POST",
      url: "/api/auth/register",
      headers: { "content-type": "application/json" },
      remoteAddress: ip,
      payload,
    });
  }

  it("happy path: valid username + password creates a user, returns expected shape", async () => {
    const username = randomUsername();
    createdUsernames.push(username);

    const res = await register({ username, password: "correct-horse-battery-staple" }, nextIp());
    assert.equal(res.statusCode, 201);

    const body = res.json() as { userId: string; username: string };
    assert.match(body.userId, /^[0-9a-f-]{36}$/i);
    assert.equal(body.username, username);
    assert.equal(Object.keys(body).sort().join(","), "userId,username");

    const row = await app.prisma.user.findUnique({ where: { username } });
    assert.ok(row, "user row should exist in the database");
    assert.equal(row!.id, body.userId);

    const cookieNames = res.cookies.map((c) => c.name);
    assert.ok(cookieNames.includes(ACCESS_COOKIE));
    assert.ok(cookieNames.includes(REFRESH_COOKIE));
  });

  it("rejects a username that doesn't match ^[A-Za-z0-9_]+$", async () => {
    const res = await register({ username: "bad user!", password: "correct-horse-battery-staple" }, nextIp());
    assert.equal(res.statusCode, 422);
  });

  it("username length boundaries: 2 fails, 3 passes, 30 passes, 31 fails", async () => {
    const cases = [
      { length: 2, ok: false },
      { length: 3, ok: true },
      { length: 30, ok: true },
      { length: 31, ok: false },
    ];
    for (const { length, ok } of cases) {
      const username = randomUsername(length);
      const res = await register({ username, password: "correct-horse-battery-staple" }, nextIp());
      if (ok) {
        assert.equal(res.statusCode, 201, `username length ${length} should be accepted`);
        createdUsernames.push(username);
      } else {
        assert.equal(res.statusCode, 422, `username length ${length} should be rejected`);
      }
    }
  });

  it("password length boundaries: 11 fails, 12 passes, 256 passes, 257 fails", async () => {
    const cases = [
      { length: 11, ok: false },
      { length: 12, ok: true },
      { length: 256, ok: true },
      { length: 257, ok: false },
    ];
    for (const { length, ok } of cases) {
      const username = randomUsername();
      const res = await register({ username, password: "a".repeat(length) }, nextIp());
      if (ok) {
        assert.equal(res.statusCode, 201, `password length ${length} should be accepted`);
        createdUsernames.push(username);
      } else {
        assert.equal(res.statusCode, 422, `password length ${length} should be rejected`);
      }
    }
  });

  it("rejects a duplicate username", async () => {
    const username = randomUsername();
    createdUsernames.push(username);

    const first = await register({ username, password: "correct-horse-battery-staple" }, nextIp());
    assert.equal(first.statusCode, 201);

    const second = await register({ username, password: "a-different-password-entirely" }, nextIp());
    assert.equal(second.statusCode, 409);
  });

  it("rate limit: allows 3 attempts per hour per IP, rejects the 4th (auth.routes.ts:40)", async () => {
    const ip = nextIp();
    for (let i = 0; i < 3; i++) {
      const username = randomUsername();
      const res = await register({ username, password: "correct-horse-battery-staple" }, ip);
      assert.equal(res.statusCode, 201, `attempt ${i + 1} should succeed`);
      createdUsernames.push(username);
    }

    const blocked = await register({ username: randomUsername(), password: "correct-horse-battery-staple" }, ip);
    assert.equal(blocked.statusCode, 429);
  });
});

describe("POST /api/auth/login", () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>;
  let username: string;
  let userId: string;
  const password = "correct-horse-battery-staple";
  const createdUsernames: string[] = [];
  // Every username a failed login was attempted against — each leaves a
  // `login:fail:*` Redis counter (30-min TTL) that we clean up explicitly
  // below rather than waiting on the TTL.
  const failedLoginUsernames: string[] = [];

  before(async () => {
    app = await buildTestApp();
    username = randomUsername();
    createdUsernames.push(username);

    const res = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      headers: { "content-type": "application/json" },
      remoteAddress: nextIp(),
      payload: { username, password },
    });
    assert.equal(res.statusCode, 201);
    userId = (res.json() as { userId: string }).userId;
  });

  after(async () => {
    const failKeys = failedLoginUsernames.map((u) => `login:fail:${u.toLowerCase()}`);
    await app.redis.del(`login:lockout:${username.toLowerCase()}`, ...failKeys);
    await app.prisma.user.deleteMany({ where: { username: { in: createdUsernames } } });
    await app.close();
  });

  function login(payload: { username: string; password: string }, ip: string) {
    return app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { "content-type": "application/json" },
      remoteAddress: ip,
      payload,
    });
  }

  it("happy path: correct credentials return valid access+refresh tokens", async () => {
    const res = await login({ username, password }, nextIp());
    assert.equal(res.statusCode, 200);

    const body = res.json() as { userId: string; username: string };
    assert.equal(body.userId, userId);
    assert.equal(body.username, username);

    const access = res.cookies.find((c) => c.name === ACCESS_COOKIE);
    const refresh = res.cookies.find((c) => c.name === REFRESH_COOKIE);
    assert.ok(access, "access cookie should be set");
    assert.ok(refresh, "refresh cookie should be set");

    const accessPayload = verifyAccessToken(access!.value);
    const refreshPayload = verifyRefreshToken(refresh!.value);
    assert.equal(accessPayload.sub, userId);
    assert.equal(refreshPayload.sub, userId);
  });

  it("rejects a wrong password", async () => {
    failedLoginUsernames.push(username);
    const res = await login({ username, password: "totally-the-wrong-password" }, nextIp());
    assert.equal(res.statusCode, 401);
  });

  it("unknown username still runs the dummy-hash verify path instead of short-circuiting", async (t) => {
    const original = argon2.verify.bind(argon2);
    let calls = 0;
    t.mock.method(argon2, "verify", async (...args: Parameters<typeof argon2.verify>) => {
      calls++;
      return original(...args);
    });

    const unknownUsername = randomUsername();
    failedLoginUsernames.push(unknownUsername);
    const res = await login({ username: unknownUsername, password: "whatever-password-here" }, nextIp());
    assert.equal(res.statusCode, 401);
    assert.equal(calls, 1, "verifyPassword's argon2.verify should still run for an unknown username, not be skipped");
  });

  it("soft lockout: locks after 10 failed attempts (auth.routes.ts:84-106); a correct password during lockout is still rejected", async () => {
    const lockoutUsername = randomUsername();
    createdUsernames.push(lockoutUsername);
    const lockoutPassword = "the-real-password-1234";

    const registerRes = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      headers: { "content-type": "application/json" },
      remoteAddress: nextIp(),
      payload: { username: lockoutUsername, password: lockoutPassword },
    });
    assert.equal(registerRes.statusCode, 201);

    // Spread the 10 failures across distinct IPs so the per-IP login rate
    // limit (5/15min) doesn't trip before the lockout threshold does — the
    // lockout key itself is per-username (Redis), not per-IP.
    for (let i = 0; i < 10; i++) {
      const res = await login({ username: lockoutUsername, password: "wrong-password-attempt" }, nextIp());
      assert.equal(res.statusCode, 401, `failed attempt ${i + 1}`);
    }

    const lockoutKey = `login:lockout:${lockoutUsername.toLowerCase()}`;
    assert.equal(await app.redis.exists(lockoutKey), 1, "lockout key should be set after 10 failures");

    const stillLocked = await login({ username: lockoutUsername, password: lockoutPassword }, nextIp());
    assert.equal(stillLocked.statusCode, 401, "correct password during lockout must still be rejected");

    await app.redis.del(lockoutKey, `login:fail:${lockoutUsername.toLowerCase()}`);
  });

  it("rate limit: allows 5 attempts per 15 minutes per IP, rejects the 6th (auth.routes.ts:76)", async () => {
    const ip = nextIp();
    for (let i = 0; i < 5; i++) {
      const attemptUsername = randomUsername();
      failedLoginUsernames.push(attemptUsername);
      const res = await login({ username: attemptUsername, password: "irrelevant-password-123" }, ip);
      assert.equal(res.statusCode, 401, `attempt ${i + 1} should reach the handler, not be rate-limited`);
    }

    const blocked = await login({ username: randomUsername(), password: "irrelevant-password-123" }, ip);
    assert.equal(blocked.statusCode, 429);
  });
});
