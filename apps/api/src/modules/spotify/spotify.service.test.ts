import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import Fastify from "fastify";
import prismaPlugin from "../../plugins/prisma.js";
import redisPlugin from "../../plugins/redis.js";
import { SpotifyService } from "./spotify.service.js";
import { encryptSecret } from "../../backend-core/crypto/token-cipher.js";
import { env } from "../../backend-core/runtime/env.js";
import type { PrismaClient } from "@prisma/client";

// Integration tests — real Postgres (SpotifyConnection rows) and real Redis
// (the 45s badge cache + token-refresh bookkeeping), with Spotify's own HTTP
// API mocked via globalThis.fetch (same pattern as
// providers/tiktok.provider.test.ts) so nothing here ever makes a real network
// call to Spotify.
async function buildTestApp() {
  const app = Fastify({ logger: false });
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  return app;
}

async function createUser(prisma: PrismaClient, label: string) {
  const suffix = randomUUID().slice(0, 8);
  return prisma.user.create({
    data: {
      username: `spotify-${label}-${suffix}`,
      passwordHash: "not-a-real-hash",
      passwordSalt: randomBytes(32).toString("hex"),
    },
  });
}

function enc(plaintext: string): string {
  return encryptSecret(plaintext, env.SPOTIFY_TOKEN_ENC_KEY);
}

async function createConnection(
  prisma: PrismaClient,
  userId: string,
  overrides: Partial<{
    accessToken: string;
    refreshToken: string;
    expiresAt: Date;
    scope: string;
    showOnProfile: boolean;
    needsReconnect: boolean;
  }> = {},
) {
  return prisma.spotifyConnection.create({
    data: {
      userId,
      accessToken: enc(overrides.accessToken ?? "valid-access-token"),
      refreshToken: enc(overrides.refreshToken ?? "valid-refresh-token"),
      expiresAt: overrides.expiresAt ?? new Date(Date.now() + 60 * 60 * 1000),
      scope: overrides.scope ?? "user-read-currently-playing user-read-recently-played",
      showOnProfile: overrides.showOnProfile ?? true,
      needsReconnect: overrides.needsReconnect ?? false,
    },
  });
}

const currentlyPlayingUrl = "https://api.spotify.com/v1/me/player/currently-playing?additional_types=track";
const recentlyPlayedUrl = "https://api.spotify.com/v1/me/player/recently-played?limit=1";
const tokenUrl = "https://accounts.spotify.com/api/token";

function jsonResponse(status: number, body: unknown) {
  return { status, ok: status >= 200 && status < 300, json: async () => body } as Response;
}

const track = {
  name: "Nightcall",
  artists: [{ name: "Kavinsky" }],
  album: { images: [{ url: "https://i.scdn.co/image/abc123" }] },
  external_urls: { spotify: "https://open.spotify.com/track/abc123" },
};

describe("SpotifyService — real Postgres + real Redis, mocked Spotify HTTP API", () => {
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

  it("cache hit: returns the cached badge without calling Spotify at all", async (t) => {
    const user = await createUser(app.prisma, "cachehit");
    createdUserIds.push(user.id);
    await createConnection(app.prisma, user.id);

    let fetchCalls = 0;
    t.mock.method(globalThis, "fetch", async () => {
      fetchCalls++;
      throw new Error("must not be called on a cache hit");
    });

    const cachedBadge = {
      isPlaying: true,
      trackName: "Cached Track",
      artistName: "Cached Artist",
      albumArtUrl: null,
      trackUrl: null,
      playedAt: null,
    };
    await app.redis.set(`spotify:badge:${user.id}`, JSON.stringify(cachedBadge), "EX", 45);

    const service = new SpotifyService(app.prisma, app.redis, app.log);
    const badge = await service.getBadgeForUser(user.id);

    assert.deepEqual(badge, cachedBadge);
    assert.equal(fetchCalls, 0, "a cache hit must never touch Spotify's API");
  });

  it("cache miss: calls Spotify once, then a second call within the TTL is served from cache", async (t) => {
    const user = await createUser(app.prisma, "cachemiss");
    createdUserIds.push(user.id);
    await createConnection(app.prisma, user.id);

    let currentlyPlayingCalls = 0;
    t.mock.method(globalThis, "fetch", async (url: string) => {
      if (url === currentlyPlayingUrl) {
        currentlyPlayingCalls++;
        return jsonResponse(200, { is_playing: true, item: track });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const service = new SpotifyService(app.prisma, app.redis, app.log);

    const first = await service.getBadgeForUser(user.id);
    assert.equal(currentlyPlayingCalls, 1, "a genuine miss must call Spotify");
    assert.equal(first?.isPlaying, true);
    assert.equal(first?.trackName, "Nightcall");
    assert.equal(first?.artistName, "Kavinsky");
    assert.equal(first?.albumArtUrl, "https://i.scdn.co/image/abc123");
    assert.equal(first?.playedAt, null);

    const second = await service.getBadgeForUser(user.id);
    assert.equal(currentlyPlayingCalls, 1, "a second call within the 45s TTL must be served from cache");
    assert.deepEqual(second, first);
  });

  it("falls back to recently-played when nothing is currently playing", async (t) => {
    const user = await createUser(app.prisma, "recent");
    createdUserIds.push(user.id);
    await createConnection(app.prisma, user.id);

    const playedAt = new Date(Date.now() - 5 * 60 * 1000).toISOString(); // 5 min ago
    t.mock.method(globalThis, "fetch", async (url: string) => {
      if (url === currentlyPlayingUrl) return { status: 204, ok: true, json: async () => ({}) } as Response;
      if (url === recentlyPlayedUrl) return jsonResponse(200, { items: [{ track, played_at: playedAt }] });
      throw new Error(`unexpected fetch: ${url}`);
    });

    const service = new SpotifyService(app.prisma, app.redis, app.log);
    const badge = await service.getBadgeForUser(user.id);

    assert.equal(badge?.isPlaying, false);
    assert.equal(badge?.trackName, "Nightcall");
    assert.equal(badge?.playedAt, playedAt);
  });

  it("hides the badge entirely when the last play is older than 24h", async (t) => {
    const user = await createUser(app.prisma, "stale");
    createdUserIds.push(user.id);
    await createConnection(app.prisma, user.id);

    const playedAt = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(); // 25h ago
    let fetchCalls = 0;
    t.mock.method(globalThis, "fetch", async (url: string) => {
      fetchCalls++;
      if (url === currentlyPlayingUrl) return { status: 204, ok: true, json: async () => ({}) } as Response;
      if (url === recentlyPlayedUrl) return jsonResponse(200, { items: [{ track, played_at: playedAt }] });
      throw new Error(`unexpected fetch: ${url}`);
    });

    const service = new SpotifyService(app.prisma, app.redis, app.log);
    const badge = await service.getBadgeForUser(user.id);

    assert.equal(badge, null, "nothing played in the last 24h must hide the badge");
    assert.equal(fetchCalls, 2, "sanity: both endpoints were actually consulted before hiding it");

    // The null result itself must be cached — a second call within the TTL
    // must not re-hit Spotify just to reconfirm "nothing to show".
    const second = await service.getBadgeForUser(user.id);
    assert.equal(second, null);
    assert.equal(fetchCalls, 2, "the cached null must not trigger another fetch");
  });

  it("showOnProfile=false hides the badge without ever calling Spotify", async (t) => {
    const user = await createUser(app.prisma, "hidden");
    createdUserIds.push(user.id);
    await createConnection(app.prisma, user.id, { showOnProfile: false });

    t.mock.method(globalThis, "fetch", async () => {
      throw new Error("must not be called when showOnProfile is false");
    });

    const service = new SpotifyService(app.prisma, app.redis, app.log);
    assert.equal(await service.getBadgeForUser(user.id), null);
  });

  it("a user who never connected gets null without ever calling Spotify", async (t) => {
    const user = await createUser(app.prisma, "noconn");
    createdUserIds.push(user.id);

    t.mock.method(globalThis, "fetch", async () => {
      throw new Error("must not be called for a user with no connection");
    });

    const service = new SpotifyService(app.prisma, app.redis, app.log);
    assert.equal(await service.getBadgeForUser(user.id), null);
  });

  it("refreshes an expired access token before calling Spotify's now-playing API, and persists the new (encrypted) tokens", async (t) => {
    const user = await createUser(app.prisma, "refresh");
    createdUserIds.push(user.id);
    await createConnection(app.prisma, user.id, {
      expiresAt: new Date(Date.now() - 1000), // already expired
      refreshToken: "old-refresh-token",
    });

    const calls: string[] = [];
    t.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
      calls.push(url);
      if (url === tokenUrl) {
        const body = new URLSearchParams(init!.body as string);
        assert.equal(body.get("grant_type"), "refresh_token");
        assert.equal(body.get("refresh_token"), "old-refresh-token");
        return jsonResponse(200, {
          access_token: "new-access-token",
          token_type: "Bearer",
          expires_in: 3600,
          refresh_token: "new-refresh-token",
          scope: "user-read-currently-playing user-read-recently-played",
        });
      }
      if (url === currentlyPlayingUrl) {
        return jsonResponse(200, { is_playing: true, item: track });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const service = new SpotifyService(app.prisma, app.redis, app.log);
    const badge = await service.getBadgeForUser(user.id);

    assert.deepEqual(calls, [tokenUrl, currentlyPlayingUrl], "must refresh before calling now-playing");
    assert.equal(badge?.trackName, "Nightcall");

    const row = await app.prisma.spotifyConnection.findUniqueOrThrow({ where: { userId: user.id } });
    assert.equal(row.needsReconnect, false);
    assert.ok(row.expiresAt.getTime() > Date.now() + 3000 * 1000, "expiresAt must reflect the new ~1h token");
    // Stored ciphertext must decrypt to the NEW tokens, not the old ones.
    const { decryptSecret } = await import("../../backend-core/crypto/token-cipher.js");
    assert.equal(decryptSecret(row.accessToken, env.SPOTIFY_TOKEN_ENC_KEY), "new-access-token");
    assert.equal(decryptSecret(row.refreshToken, env.SPOTIFY_TOKEN_ENC_KEY), "new-refresh-token");
  });

  it("gracefully degrades when the refresh_token exchange itself fails: no throw, badge is null, and it stops retrying on the next view", async (t) => {
    const user = await createUser(app.prisma, "revoked");
    createdUserIds.push(user.id);
    await createConnection(app.prisma, user.id, { expiresAt: new Date(Date.now() - 1000) });

    let tokenCalls = 0;
    t.mock.method(globalThis, "fetch", async (url: string) => {
      if (url === tokenUrl) {
        tokenCalls++;
        // Spotify's real shape for a dead refresh token.
        return { status: 400, ok: false, json: async () => ({ error: "invalid_grant" }) } as Response;
      }
      throw new Error(`unexpected fetch: ${url} (now-playing must never be reached without a token)`);
    });

    const service = new SpotifyService(app.prisma, app.redis, app.log);

    const badge = await service.getBadgeForUser(user.id);
    assert.equal(badge, null, "a failed refresh must degrade to null, never throw");
    assert.equal(tokenCalls, 1);

    const row = await app.prisma.spotifyConnection.findUniqueOrThrow({ where: { userId: user.id } });
    assert.equal(row.needsReconnect, true, "a failed refresh must flip needsReconnect");

    // Bust the badge cache (set by the call above) so the assertion below is
    // actually exercising the needsReconnect short-circuit, not just a cache hit.
    await app.redis.del(`spotify:badge:${user.id}`);

    const secondBadge = await service.getBadgeForUser(user.id);
    assert.equal(secondBadge, null);
    assert.equal(tokenCalls, 1, "once flagged, subsequent views must not retry the doomed refresh");
  });

  it("a connection already flagged needsReconnect never attempts a refresh or a now-playing call", async (t) => {
    const user = await createUser(app.prisma, "flagged");
    createdUserIds.push(user.id);
    await createConnection(app.prisma, user.id, {
      expiresAt: new Date(Date.now() - 1000),
      needsReconnect: true,
    });

    t.mock.method(globalThis, "fetch", async (url: string) => {
      throw new Error(`must not call Spotify at all once needsReconnect is set (got ${url})`);
    });

    const service = new SpotifyService(app.prisma, app.redis, app.log);
    assert.equal(await service.getBadgeForUser(user.id), null);
  });
});
