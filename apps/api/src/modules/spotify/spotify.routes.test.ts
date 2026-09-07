import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import Fastify from "fastify";
import { TypeBoxTypeProvider, TypeBoxValidatorCompiler } from "@fastify/type-provider-typebox";
import cookie from "@fastify/cookie";
import "../../backend-core/runtime/formats.js";
import { ProblemError, problemResponse } from "../../backend-core/http/errors.js";
import { env } from "../../backend-core/runtime/env.js";
import prismaPlugin from "../../plugins/prisma.js";
import redisPlugin from "../../plugins/redis.js";
import authPlugin from "../../plugins/auth.js";
import spotifyRoutes from "./spotify.routes.js";
import { signAccessToken } from "../../backend-core/auth/tokens.js";
import { ACCESS_COOKIE } from "../../backend-core/auth/cookies.js";
import type { PrismaClient } from "@prisma/client";

// Real integration test — real Postgres/Redis (the throwaway local services,
// same as spotify.service.test.ts), real routing/schema/auth wiring, with
// Spotify's own HTTP API mocked via globalThis.fetch only where a test
// actually needs a token exchange to succeed or fail a specific way.
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
  await app.register(spotifyRoutes, { prefix: "/api" });
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
      username: `sp-${label}-${suffix}`,
      passwordHash: "not-a-real-hash",
      passwordSalt: randomBytes(32).toString("hex"), // matches passwordSalt @db.Char(64)
    },
  });
}

async function createConnection(prisma: PrismaClient, userId: string) {
  return prisma.spotifyConnection.create({
    data: {
      userId,
      accessToken: "irrelevant-ciphertext", // these tests never decrypt it
      refreshToken: "irrelevant-ciphertext",
      expiresAt: new Date(Date.now() + 3600_000),
      scope: "user-read-currently-playing user-read-recently-played",
    },
  });
}

const stateKey = (state: string) => `spotify:oauth:state:${state}`;

// env.ts's `as const` is TypeScript-only — the exported object is a plain,
// mutable singleton at runtime — so this temporarily flips isSpotifyConfigured()
// to true for the duration of fn, then always restores the blank .env.test
// defaults, even on throw.
async function withSpotifyConfigured<T>(fn: () => Promise<T>): Promise<T> {
  const prev = {
    id: env.SPOTIFY_CLIENT_ID,
    secret: env.SPOTIFY_CLIENT_SECRET,
    redirect: env.SPOTIFY_REDIRECT_URI,
  };
  Object.assign(env, {
    SPOTIFY_CLIENT_ID: "test-client-id",
    SPOTIFY_CLIENT_SECRET: "test-client-secret",
    SPOTIFY_REDIRECT_URI: "https://cloud.effxct.us/api/spotify/callback",
  });
  try {
    return await fn();
  } finally {
    Object.assign(env, {
      SPOTIFY_CLIENT_ID: prev.id,
      SPOTIFY_CLIENT_SECRET: prev.secret,
      SPOTIFY_REDIRECT_URI: prev.redirect,
    });
  }
}

function jsonResponse(status: number, body: unknown) {
  return { status, ok: status >= 200 && status < 300, json: async () => body } as Response;
}

function locationOf(res: { headers: Record<string, unknown> }): URL {
  return new URL(res.headers.location as string);
}

describe("Spotify routes — real Postgres + real Redis, mocked Spotify HTTP API", () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>;
  const createdUserIds: string[] = [];

  before(async () => {
    app = await buildTestApp();
  });

  after(async () => {
    await app.prisma.spotifyConnection.deleteMany({ where: { userId: { in: createdUserIds } } });
    await app.prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    await app.close();
  });

  describe("GET /api/spotify/connect", () => {
    it("redirects with a config error when Spotify isn't configured (the .env.test default)", async () => {
      const user = await createUser(app.prisma, "conn-unconf");
      createdUserIds.push(user.id);

      const res = await app.inject({
        method: "GET",
        url: "/api/spotify/connect",
        headers: { cookie: cookieFor(user.id) },
      });

      assert.equal(res.statusCode, 302);
      const location = locationOf(res);
      assert.equal(location.origin + location.pathname, `${env.WEB_ORIGIN}/profile`);
      assert.equal(location.searchParams.get("spotify"), "error");
      assert.equal(location.searchParams.get("reason"), "not_configured");
    });

    it("redirects to Spotify's authorize URL with the right params when configured, and records state→userId in Redis", async () => {
      const user = await createUser(app.prisma, "conn-ok");
      createdUserIds.push(user.id);

      const res = await withSpotifyConfigured(() =>
        app.inject({ method: "GET", url: "/api/spotify/connect", headers: { cookie: cookieFor(user.id) } }),
      );

      assert.equal(res.statusCode, 302);
      const location = locationOf(res);
      assert.equal(location.origin + location.pathname, "https://accounts.spotify.com/authorize");
      assert.equal(location.searchParams.get("client_id"), "test-client-id");
      assert.equal(location.searchParams.get("response_type"), "code");
      assert.equal(location.searchParams.get("redirect_uri"), "https://cloud.effxct.us/api/spotify/callback");
      assert.equal(location.searchParams.get("scope"), "user-read-currently-playing user-read-recently-played");

      const state = location.searchParams.get("state");
      assert.ok(state && state.length > 0, "a state param must be present");
      assert.equal(await app.redis.get(stateKey(state!)), user.id, "state must map back to the caller in Redis");
    });

    it("401s when unauthenticated", async () => {
      const res = await app.inject({ method: "GET", url: "/api/spotify/connect" });
      assert.equal(res.statusCode, 401);
    });
  });

  describe("GET /api/spotify/callback", () => {
    it("a valid code+state succeeds: exchanges the code, stores the connection, redirects to profile?spotify=connected", async (t) => {
      const user = await createUser(app.prisma, "cb-ok");
      createdUserIds.push(user.id);
      const state = randomBytes(24).toString("hex");
      await app.redis.set(stateKey(state), user.id, "EX", 600);

      t.mock.method(globalThis, "fetch", async () =>
        jsonResponse(200, {
          access_token: "at-1",
          token_type: "Bearer",
          expires_in: 3600,
          refresh_token: "rt-1",
          scope: "user-read-currently-playing user-read-recently-played",
        }),
      );

      const res = await app.inject({ method: "GET", url: `/api/spotify/callback?code=auth-code-1&state=${state}` });

      assert.equal(res.statusCode, 302);
      const location = locationOf(res);
      assert.equal(location.origin + location.pathname, `${env.WEB_ORIGIN}/profile`);
      assert.equal(location.searchParams.get("spotify"), "connected");

      const row = await app.prisma.spotifyConnection.findUniqueOrThrow({ where: { userId: user.id } });
      assert.equal(row.needsReconnect, false);

      // One-time use: the state key must be gone from Redis after a successful exchange.
      assert.equal(await app.redis.get(stateKey(state)), null);
    });

    it("Spotify's own error param (e.g. the user declined) fails gracefully, before any state lookup", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/spotify/callback?error=access_denied&state=whatever&code=whatever",
      });

      assert.equal(res.statusCode, 302);
      const location = locationOf(res);
      assert.equal(location.searchParams.get("spotify"), "error");
      assert.equal(location.searchParams.get("reason"), "denied");
    });

    it("a state with no matching Redis entry fails gracefully as invalid_state, not a 500", async () => {
      const res = await app.inject({ method: "GET", url: "/api/spotify/callback?code=x&state=never-existed" });

      assert.equal(res.statusCode, 302);
      const location = locationOf(res);
      assert.equal(location.searchParams.get("spotify"), "error");
      assert.equal(location.searchParams.get("reason"), "invalid_state");
    });

    it("an expired state (real Redis TTL expiry, not simulated) fails gracefully as invalid_state", async () => {
      const user = await createUser(app.prisma, "cb-expired");
      createdUserIds.push(user.id);
      const state = randomBytes(24).toString("hex");
      await app.redis.set(stateKey(state), user.id, "EX", 1);
      await new Promise((r) => setTimeout(r, 1200)); // let Redis actually expire it

      const res = await app.inject({ method: "GET", url: `/api/spotify/callback?code=x&state=${state}` });

      assert.equal(res.statusCode, 302);
      assert.equal(locationOf(res).searchParams.get("reason"), "invalid_state");
    });

    it("a reused state (replayed after a successful exchange) fails gracefully as invalid_state", async (t) => {
      const user = await createUser(app.prisma, "cb-reused");
      createdUserIds.push(user.id);
      const state = randomBytes(24).toString("hex");
      await app.redis.set(stateKey(state), user.id, "EX", 600);

      t.mock.method(globalThis, "fetch", async () =>
        jsonResponse(200, { access_token: "at-2", token_type: "Bearer", expires_in: 3600, refresh_token: "rt-2" }),
      );

      const first = await app.inject({ method: "GET", url: `/api/spotify/callback?code=auth-code-2&state=${state}` });
      assert.equal(locationOf(first).searchParams.get("spotify"), "connected", "sanity: the first use must succeed");

      const replay = await app.inject({ method: "GET", url: `/api/spotify/callback?code=auth-code-2&state=${state}` });
      assert.equal(replay.statusCode, 302);
      const location = locationOf(replay);
      assert.equal(location.searchParams.get("spotify"), "error");
      assert.equal(location.searchParams.get("reason"), "invalid_state", "a state must never be usable twice");
    });

    it("missing code or state fails gracefully as missing_params", async () => {
      const res = await app.inject({ method: "GET", url: "/api/spotify/callback" });
      assert.equal(res.statusCode, 302);
      assert.equal(locationOf(res).searchParams.get("reason"), "missing_params");
    });

    it("a failed token exchange fails gracefully as exchange_failed, not a 500, and leaves no connection row behind", async (t) => {
      const user = await createUser(app.prisma, "cb-exchfail");
      createdUserIds.push(user.id);
      const state = randomBytes(24).toString("hex");
      await app.redis.set(stateKey(state), user.id, "EX", 600);

      t.mock.method(globalThis, "fetch", async () =>
        ({ status: 400, ok: false, json: async () => ({ error: "invalid_grant" }) }) as Response,
      );

      const res = await app.inject({ method: "GET", url: `/api/spotify/callback?code=bad-code&state=${state}` });

      assert.equal(res.statusCode, 302);
      assert.equal(locationOf(res).searchParams.get("reason"), "exchange_failed");
      assert.equal(await app.prisma.spotifyConnection.findUnique({ where: { userId: user.id } }), null);
    });
  });

  describe("DELETE /api/spotify/disconnect", () => {
    it("is idempotent: calling it twice never errors, before or after a connection actually existed", async () => {
      const user = await createUser(app.prisma, "disconnect");
      createdUserIds.push(user.id);
      await createConnection(app.prisma, user.id);

      const first = await app.inject({
        method: "DELETE",
        url: "/api/spotify/disconnect",
        headers: { cookie: cookieFor(user.id) },
      });
      assert.equal(first.statusCode, 204);
      assert.equal(await app.prisma.spotifyConnection.findUnique({ where: { userId: user.id } }), null);

      const second = await app.inject({
        method: "DELETE",
        url: "/api/spotify/disconnect",
        headers: { cookie: cookieFor(user.id) },
      });
      assert.equal(second.statusCode, 204, "disconnecting an already-disconnected account must not error");
    });

    it("is a 204 no-op for a user who never connected in the first place", async () => {
      const user = await createUser(app.prisma, "disconn-none");
      createdUserIds.push(user.id);

      const res = await app.inject({
        method: "DELETE",
        url: "/api/spotify/disconnect",
        headers: { cookie: cookieFor(user.id) },
      });
      assert.equal(res.statusCode, 204);
    });

    it("401s when unauthenticated", async () => {
      const res = await app.inject({ method: "DELETE", url: "/api/spotify/disconnect" });
      assert.equal(res.statusCode, 401);
    });
  });

  describe("GET /api/spotify/status", () => {
    it("401s when unauthenticated", async () => {
      const res = await app.inject({ method: "GET", url: "/api/spotify/status" });
      assert.equal(res.statusCode, 401);
    });

    it("returns connected:false for a user who never connected", async () => {
      const user = await createUser(app.prisma, "status-none");
      createdUserIds.push(user.id);

      const res = await app.inject({
        method: "GET",
        url: "/api/spotify/status",
        headers: { cookie: cookieFor(user.id) },
      });
      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.json(), {
        connected: false,
        showOnProfile: false,
        needsReconnect: false,
        connectedAt: null,
      });
    });
  });

  describe("PATCH /api/spotify/preferences", () => {
    it("401s when unauthenticated", async () => {
      const res = await app.inject({
        method: "PATCH",
        url: "/api/spotify/preferences",
        headers: { "content-type": "application/json" },
        payload: { showOnProfile: false },
      });
      assert.equal(res.statusCode, 401);
    });

    it("404s when the caller has no Spotify connection to update", async () => {
      const user = await createUser(app.prisma, "prefs-none");
      createdUserIds.push(user.id);

      const res = await app.inject({
        method: "PATCH",
        url: "/api/spotify/preferences",
        headers: { cookie: cookieFor(user.id), "content-type": "application/json" },
        payload: { showOnProfile: false },
      });
      assert.equal(res.statusCode, 404);
    });

    it("updates showOnProfile and returns the refreshed status", async () => {
      const user = await createUser(app.prisma, "prefs-ok");
      createdUserIds.push(user.id);
      await createConnection(app.prisma, user.id);

      const res = await app.inject({
        method: "PATCH",
        url: "/api/spotify/preferences",
        headers: { cookie: cookieFor(user.id), "content-type": "application/json" },
        payload: { showOnProfile: false },
      });
      assert.equal(res.statusCode, 200);
      assert.equal((res.json() as { showOnProfile: boolean }).showOnProfile, false);

      const row = await app.prisma.spotifyConnection.findUniqueOrThrow({ where: { userId: user.id } });
      assert.equal(row.showOnProfile, false);
    });
  });
});
