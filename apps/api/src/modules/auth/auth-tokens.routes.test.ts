import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import Fastify, { type FastifyError } from "fastify";
import { TypeBoxTypeProvider, TypeBoxValidatorCompiler } from "@fastify/type-provider-typebox";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import jwt from "jsonwebtoken";
import "../../backend-core/runtime/formats.js"; // side effect: registers uuid/date-time/email TypeBox formats
import { ProblemError, problemResponse } from "../../backend-core/http/errors.js";
import { env } from "../../backend-core/runtime/env.js";
import prismaPlugin from "../../plugins/prisma.js";
import redisPlugin from "../../plugins/redis.js";
import authPlugin from "../../plugins/auth.js";
import authRoutes from "./auth.routes.js";
import { verifyAccessToken, verifyRefreshToken } from "../../backend-core/auth/tokens.js";
import { ACCESS_COOKIE, REFRESH_COOKIE } from "../../backend-core/auth/cookies.js";

// Real integration test — real Postgres/Redis (the throwaway local services), not
// hand-rolled mocks. Same approach as auth.routes.test.ts (register/login):
// does NOT import buildServer()/server.ts (its pre-existing void main() side
// effect boots a second real server on import), and registers @fastify/rate-limit
// since refresh's per-route limit is exercised incidentally by the multi-call
// flows below (kept under budget via distinct fake IPs, same as before).
async function buildTestApp() {
  const app = Fastify({ logger: false })
    .setValidatorCompiler(TypeBoxValidatorCompiler)
    .withTypeProvider<TypeBoxTypeProvider>();

  await app.register(cookie);
  await app.register(rateLimit, { global: true, max: 300, timeWindow: "1 minute" });
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);

  // Mirrors server.ts's real global error handler exactly (ProblemError,
  // TypeBox validation failures, rate-limit 429).
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

// Route rate limits are per-IP — give every request its own fake IP so
// unrelated scenarios never trip each other's counters (none of the tests
// below are exercising rate limiting itself, unlike auth.routes.test.ts).
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

const PASSWORD = "correct-horse-battery-staple";

type CookiePair = { username: string; userId: string; accessToken: string; refreshToken: string };

// Registers a brand-new user and returns its credentials + freshly-issued
// cookies. Callers are responsible for pushing `username` onto their own
// `createdUsernames` cleanup array — this helper doesn't track it for you.
async function registerFresh(app: Awaited<ReturnType<typeof buildTestApp>>, ip: string): Promise<CookiePair> {
  const username = randomUsername();
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    headers: { "content-type": "application/json" },
    remoteAddress: ip,
    payload: { username, password: PASSWORD },
  });
  assert.equal(res.statusCode, 201);
  const userId = (res.json() as { userId: string }).userId;
  const accessToken = res.cookies.find((c) => c.name === ACCESS_COOKIE)!.value;
  const refreshToken = res.cookies.find((c) => c.name === REFRESH_COOKIE)!.value;
  return { username, userId, accessToken, refreshToken };
}

describe("POST /api/auth/refresh", () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>;
  const createdUsernames: string[] = [];
  const blocklistedJtis: string[] = [];

  before(async () => {
    app = await buildTestApp();
  });

  after(async () => {
    if (blocklistedJtis.length) await app.redis.del(...blocklistedJtis.map((j) => `jti:${j}`));
    await app.prisma.user.deleteMany({ where: { username: { in: createdUsernames } } });
    await app.close();
  });

  function refresh(cookieHeader: string | undefined, ip: string) {
    return app.inject({
      method: "POST",
      url: "/api/auth/refresh",
      remoteAddress: ip,
      headers: cookieHeader ? { cookie: cookieHeader } : {},
    });
  }

  it("happy path: rotates to a new access+refresh pair", async () => {
    const { username, userId, refreshToken } = await registerFresh(app, nextIp());
    createdUsernames.push(username);

    const res = await refresh(`${REFRESH_COOKIE}=${refreshToken}`, nextIp());
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { ok: true });

    const newAccess = res.cookies.find((c) => c.name === ACCESS_COOKIE)!.value;
    const newRefresh = res.cookies.find((c) => c.name === REFRESH_COOKIE)!.value;
    assert.notEqual(newRefresh, refreshToken);

    const accessPayload = verifyAccessToken(newAccess);
    const refreshPayload = verifyRefreshToken(newRefresh);
    assert.equal(accessPayload.sub, userId);
    assert.equal(refreshPayload.sub, userId);

    // Old refresh token's jti should now be blocklisted (tokens.ts's
    // blocklistKey = `jti:${jti}`, set by blocklistJti()).
    const oldPayload = verifyRefreshToken(refreshToken); // still verifiable — blocklisting doesn't affect signature/exp
    blocklistedJtis.push(oldPayload.jti);
    assert.equal(await app.redis.exists(`jti:${oldPayload.jti}`), 1);
  });

  it("the real security property: replaying the old refresh token after rotation is rejected", async () => {
    const { username, refreshToken } = await registerFresh(app, nextIp());
    createdUsernames.push(username);

    const first = await refresh(`${REFRESH_COOKIE}=${refreshToken}`, nextIp());
    assert.equal(first.statusCode, 200);

    const oldPayload = verifyRefreshToken(refreshToken);
    blocklistedJtis.push(oldPayload.jti);

    const replay = await refresh(`${REFRESH_COOKIE}=${refreshToken}`, nextIp());
    assert.equal(replay.statusCode, 401, "the pre-rotation refresh token must be dead");
  });

  it("rejects a missing refresh cookie", async () => {
    const res = await refresh(undefined, nextIp());
    assert.equal(res.statusCode, 401);
  });

  it("rejects a malformed refresh cookie", async () => {
    const res = await refresh(`${REFRESH_COOKIE}=not-a-real-jwt`, nextIp());
    assert.equal(res.statusCode, 401);
  });

  it("rejects an expired refresh token", async () => {
    const { username, userId } = await registerFresh(app, nextIp());
    createdUsernames.push(username);
    // Forge a validly-signed but already-expired token (negative expiresIn) —
    // waiting out the real 7-day JWT_REFRESH_EXPIRY isn't practical in a test.
    const expired = jwt.sign({ sub: userId, jti: randomUUID() }, env.JWT_REFRESH_SECRET, {
      algorithm: "HS256",
      expiresIn: -10,
    });

    const res = await refresh(`${REFRESH_COOKIE}=${expired}`, nextIp());
    assert.equal(res.statusCode, 401);
  });
});

describe("POST /api/auth/logout", () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>;
  const createdUsernames: string[] = [];
  const blocklistedJtis: string[] = [];

  before(async () => {
    app = await buildTestApp();
  });

  after(async () => {
    if (blocklistedJtis.length) await app.redis.del(...blocklistedJtis.map((j) => `jti:${j}`));
    await app.prisma.user.deleteMany({ where: { username: { in: createdUsernames } } });
    await app.close();
  });

  // logout has no request body/schema, unlike register/login/refresh
  // (auth.routes.ts:165) — a known, accepted asymmetry, not a bug this test
  // flags.
  it("blocklists both the access and refresh token jtis (auth.routes.ts:171-186)", async () => {
    const { username, accessToken, refreshToken } = await registerFresh(app, nextIp());
    createdUsernames.push(username);
    const accessJti = verifyAccessToken(accessToken).jti;
    const refreshJti = verifyRefreshToken(refreshToken).jti;
    blocklistedJtis.push(accessJti, refreshJti);

    // Sanity: neither jti is blocklisted before logout.
    assert.equal(await app.redis.exists(`jti:${accessJti}`), 0);
    assert.equal(await app.redis.exists(`jti:${refreshJti}`), 0);

    const res = await app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: { cookie: `${ACCESS_COOKIE}=${accessToken}; ${REFRESH_COOKIE}=${refreshToken}` },
      remoteAddress: nextIp(),
    });
    assert.equal(res.statusCode, 204);

    assert.equal(await app.redis.exists(`jti:${accessJti}`), 1, "access token jti should be blocklisted");
    assert.equal(await app.redis.exists(`jti:${refreshJti}`), 1, "refresh token jti should be blocklisted");
  });
});

describe("GET /api/auth/me", () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>;
  let username: string;
  let userId: string;
  let accessToken: string;
  const createdUsernames: string[] = [];

  before(async () => {
    app = await buildTestApp();
    const fresh = await registerFresh(app, nextIp());
    username = fresh.username;
    userId = fresh.userId;
    accessToken = fresh.accessToken;
    createdUsernames.push(username);
  });

  after(async () => {
    await app.prisma.user.deleteMany({ where: { username: { in: createdUsernames } } });
    await app.close();
  });

  function me(cookieHeader: string | undefined, ip: string) {
    return app.inject({
      method: "GET",
      url: "/api/auth/me",
      remoteAddress: ip,
      headers: cookieHeader ? { cookie: cookieHeader } : {},
    });
  }

  it("returns exactly {userId, username, avatarUrl, createdAt} for the authenticated caller", async () => {
    const res = await me(`${ACCESS_COOKIE}=${accessToken}`, nextIp());
    assert.equal(res.statusCode, 200);

    const body = res.json() as Record<string, unknown>;
    assert.equal(Object.keys(body).sort().join(","), "avatarUrl,createdAt,userId,username");
    assert.equal(body["userId"], userId);
    assert.equal(body["username"], username);
    assert.equal(body["avatarUrl"], null); // no avatarKey set on this test user
    assert.equal(typeof body["createdAt"], "string");
  });

  it("401s when unauthenticated (no cookie at all)", async () => {
    const res = await me(undefined, nextIp());
    assert.equal(res.statusCode, 401);
  });

  it("401s when the access token is malformed or tampered", async () => {
    const malformed = await me(`${ACCESS_COOKIE}=not-a-real-jwt`, nextIp());
    assert.equal(malformed.statusCode, 401);

    // Flip the last two characters of a real, validly-signed token so the
    // signature no longer matches.
    const tail = accessToken.slice(-2);
    const flipped = tail === "aa" ? "bb" : "aa";
    const tampered = accessToken.slice(0, -2) + flipped;
    const tamperedRes = await me(`${ACCESS_COOKIE}=${tampered}`, nextIp());
    assert.equal(tamperedRes.statusCode, 401);
  });
});

// Cross-route integration: register/login/refresh/logout/me all touch the
// same token lifecycle (tokens.ts's sign/verify/blocklist). This is worth
// having alongside the per-route tests above, not instead of them — it's the
// only place that actually proves the routes compose correctly end-to-end
// (e.g. that /me accepts a *rotated* token, and rejects it again post-logout).
describe("Auth token lifecycle — register, login, refresh, logout, me", () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>;
  const createdUsernames: string[] = [];
  const blocklistedJtis: string[] = [];

  before(async () => {
    app = await buildTestApp();
  });

  after(async () => {
    if (blocklistedJtis.length) await app.redis.del(...blocklistedJtis.map((j) => `jti:${j}`));
    await app.prisma.user.deleteMany({ where: { username: { in: createdUsernames } } });
    await app.close();
  });

  it("a token issued at login is rotated, then revoked, and rejected everywhere afterward", async () => {
    const username = randomUsername();
    createdUsernames.push(username);

    const registerRes = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      headers: { "content-type": "application/json" },
      remoteAddress: nextIp(),
      payload: { username, password: PASSWORD },
    });
    assert.equal(registerRes.statusCode, 201);
    const userId = (registerRes.json() as { userId: string }).userId;

    const loginRes = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { "content-type": "application/json" },
      remoteAddress: nextIp(),
      payload: { username, password: PASSWORD },
    });
    assert.equal(loginRes.statusCode, 200);
    const loginRefresh = loginRes.cookies.find((c) => c.name === REFRESH_COOKIE)!.value;

    const refreshRes = await app.inject({
      method: "POST",
      url: "/api/auth/refresh",
      headers: { cookie: `${REFRESH_COOKIE}=${loginRefresh}` },
      remoteAddress: nextIp(),
    });
    assert.equal(refreshRes.statusCode, 200);
    const rotatedAccess = refreshRes.cookies.find((c) => c.name === ACCESS_COOKIE)!.value;
    const rotatedRefresh = refreshRes.cookies.find((c) => c.name === REFRESH_COOKIE)!.value;

    // The pre-rotation login refresh token is dead.
    blocklistedJtis.push(verifyRefreshToken(loginRefresh).jti);
    const replayRes = await app.inject({
      method: "POST",
      url: "/api/auth/refresh",
      headers: { cookie: `${REFRESH_COOKIE}=${loginRefresh}` },
      remoteAddress: nextIp(),
    });
    assert.equal(replayRes.statusCode, 401, "pre-rotation refresh token must be dead");

    // The rotated access token works against /me.
    const meRes = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { cookie: `${ACCESS_COOKIE}=${rotatedAccess}` },
      remoteAddress: nextIp(),
    });
    assert.equal(meRes.statusCode, 200);
    assert.equal((meRes.json() as { userId: string }).userId, userId);

    // Logout revokes the currently active (rotated) pair.
    blocklistedJtis.push(verifyAccessToken(rotatedAccess).jti, verifyRefreshToken(rotatedRefresh).jti);
    const logoutRes = await app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: { cookie: `${ACCESS_COOKIE}=${rotatedAccess}; ${REFRESH_COOKIE}=${rotatedRefresh}` },
      remoteAddress: nextIp(),
    });
    assert.equal(logoutRes.statusCode, 204);

    // /me now rejects the revoked access token.
    const meAfterLogout = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { cookie: `${ACCESS_COOKIE}=${rotatedAccess}` },
      remoteAddress: nextIp(),
    });
    assert.equal(meAfterLogout.statusCode, 401);

    // The revoked refresh token can no longer mint a new pair either.
    const refreshAfterLogout = await app.inject({
      method: "POST",
      url: "/api/auth/refresh",
      headers: { cookie: `${REFRESH_COOKIE}=${rotatedRefresh}` },
      remoteAddress: nextIp(),
    });
    assert.equal(refreshAfterLogout.statusCode, 401);
  });
});
