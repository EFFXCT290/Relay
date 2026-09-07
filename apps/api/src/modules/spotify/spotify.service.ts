import type { FastifyBaseLogger } from "fastify";
import type { PrismaClient, SpotifyConnection } from "@prisma/client";
import type { Redis } from "ioredis";
import type { SpotifyBadge, SpotifyConnectionStatus } from "@relay/contracts";
import { env } from "../../backend-core/runtime/env.js";
import { decryptSecret, encryptSecret } from "../../backend-core/crypto/token-cipher.js";
import { SpotifyRepository } from "./spotify.repository.js";

const AUTHORIZE_URL = "https://accounts.spotify.com/authorize";
const TOKEN_URL = "https://accounts.spotify.com/api/token";
const API_BASE = "https://api.spotify.com/v1";
const SCOPES = "user-read-currently-playing user-read-recently-played";

const CACHE_TTL_S = 45;
const REFRESH_SKEW_MS = 60_000; // refresh 60s before actual expiry, not right at the wire
const HIDE_AFTER_MS = 24 * 60 * 60 * 1000; // "last played" older than this shows nothing at all

type TokenResponse = {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
};

type SpotifyImage = { url: string };
type SpotifyArtist = { name: string };
type SpotifyTrack = {
  name: string;
  artists: SpotifyArtist[];
  album?: { images?: SpotifyImage[] };
  external_urls?: { spotify?: string };
};
type CurrentlyPlayingResponse = { is_playing?: boolean; item?: SpotifyTrack | null };
type RecentlyPlayedResponse = { items?: Array<{ track: SpotifyTrack; played_at: string }> };

type RawNowPlaying =
  | { kind: "playing"; track: SpotifyTrack }
  | { kind: "recent"; track: SpotifyTrack; playedAt: string }
  | { kind: "none" }
  | { kind: "unauthorized" };

export class SpotifyNotConnectedError extends Error {}

export class SpotifyService {
  private repo: SpotifyRepository;
  constructor(private prisma: PrismaClient, private redis: Redis, private log: FastifyBaseLogger) {
    this.repo = new SpotifyRepository(prisma);
  }

  buildAuthorizeUrl(state: string): string {
    const params = new URLSearchParams({
      client_id:     env.SPOTIFY_CLIENT_ID,
      response_type: "code",
      redirect_uri:  env.SPOTIFY_REDIRECT_URI,
      scope:         SCOPES,
      state,
    });
    return `${AUTHORIZE_URL}?${params.toString()}`;
  }

  // Exchanges an authorization code for the first access+refresh token pair
  // and stores them encrypted. Throws on any failure (bad code, network error,
  // malformed response) — the route maps that to a redirect-with-error.
  async connect(userId: string, code: string): Promise<void> {
    const tokens = await this.postToken({
      grant_type:   "authorization_code",
      code,
      redirect_uri: env.SPOTIFY_REDIRECT_URI,
    });
    if (!tokens.refresh_token) {
      throw new Error("Spotify did not return a refresh_token for this authorization");
    }
    await this.repo.upsertConnection(userId, {
      accessToken:  encryptSecret(tokens.access_token, env.SPOTIFY_TOKEN_ENC_KEY),
      refreshToken: encryptSecret(tokens.refresh_token, env.SPOTIFY_TOKEN_ENC_KEY),
      expiresAt:    new Date(Date.now() + tokens.expires_in * 1000),
      scope:        tokens.scope ?? SCOPES,
    });
  }

  // We only ever delete our own copy of the tokens — Spotify has no API for a
  // third party to revoke its own grant server-side. The user's Spotify
  // account will still list this app under Apps until they remove it there
  // themselves; the frontend surfaces that caveat in the disconnect copy.
  async disconnect(userId: string): Promise<void> {
    await this.repo.delete(userId);
    await this.redis.del(this.cacheKey(userId));
  }

  async getStatus(userId: string): Promise<SpotifyConnectionStatus> {
    const connection = await this.repo.findByUserId(userId);
    if (!connection) {
      return { connected: false, showOnProfile: false, needsReconnect: false, connectedAt: null };
    }
    return {
      connected:      true,
      showOnProfile:  connection.showOnProfile,
      needsReconnect: connection.needsReconnect,
      connectedAt:    connection.connectedAt.toISOString(),
    };
  }

  async setShowOnProfile(userId: string, showOnProfile: boolean): Promise<void> {
    const connection = await this.repo.findByUserId(userId);
    if (!connection) throw new SpotifyNotConnectedError();
    await this.repo.setShowOnProfile(userId, showOnProfile);
    await this.redis.del(this.cacheKey(userId)); // reflect the change on the next view immediately
  }

  // The one method the badge route calls. Cache-first (45s); a genuine miss
  // may refresh the access token and/or call Spotify's now-playing endpoints.
  async getBadgeForUser(userId: string): Promise<SpotifyBadge | null> {
    const cached = await this.getCachedBadge(userId);
    if (cached.hit) return cached.badge;

    const connection = await this.repo.findByUserId(userId);
    if (!connection || !connection.showOnProfile) {
      await this.setCachedBadge(userId, null);
      return null;
    }

    const accessToken = await this.ensureFreshAccessToken(connection);
    if (!accessToken) {
      // Either already flagged needsReconnect, or the refresh attempt above
      // just failed and flagged it — cache the "nothing to show" result too,
      // so a burst of profile views doesn't retry the refresh 45 times/session.
      await this.setCachedBadge(userId, null);
      return null;
    }

    let badge: SpotifyBadge | null;
    try {
      const raw = await this.fetchRaw(accessToken);
      if (raw.kind === "unauthorized") {
        // The token looked fresh (per expiresAt) but Spotify rejected it
        // anyway — e.g. revoked mid-window. Degrade the same way a failed
        // refresh does, rather than throwing on every subsequent view.
        await this.repo.markNeedsReconnect(userId);
        badge = null;
      } else {
        badge = this.shapeBadge(raw);
      }
    } catch (err) {
      this.log.warn({ err, userId }, "[spotify] now-playing fetch failed");
      badge = null; // transient failure (network blip) — not a reconnect-worthy state
    }

    await this.setCachedBadge(userId, badge);
    return badge;
  }

  // ── Token refresh ──────────────────────────────────────────────────────────

  private async ensureFreshAccessToken(connection: SpotifyConnection): Promise<string | null> {
    if (connection.needsReconnect) return null;

    if (connection.expiresAt.getTime() - REFRESH_SKEW_MS > Date.now()) {
      return decryptSecret(connection.accessToken, env.SPOTIFY_TOKEN_ENC_KEY);
    }

    try {
      const refreshToken = decryptSecret(connection.refreshToken, env.SPOTIFY_TOKEN_ENC_KEY);
      const refreshed = await this.postToken({ grant_type: "refresh_token", refresh_token: refreshToken });
      // Spotify only sometimes rotates the refresh token on renewal; keep the
      // old one when it doesn't.
      const nextRefreshToken = refreshed.refresh_token ?? refreshToken;
      await this.repo.updateTokens(connection.userId, {
        accessToken:  encryptSecret(refreshed.access_token, env.SPOTIFY_TOKEN_ENC_KEY),
        refreshToken: encryptSecret(nextRefreshToken, env.SPOTIFY_TOKEN_ENC_KEY),
        expiresAt:    new Date(Date.now() + refreshed.expires_in * 1000),
        scope:        refreshed.scope ?? connection.scope,
      });
      return refreshed.access_token;
    } catch (err) {
      // The refresh_token itself is no good anymore (revoked, expired) —
      // this won't fix itself on retry, so stop trying until the user
      // reconnects. This is the graceful-degradation path: no throw, no
      // error surfaced to the profile viewer, just a quietly empty badge.
      this.log.warn({ err, userId: connection.userId }, "[spotify] refresh_token exchange failed — marking needsReconnect");
      await this.repo.markNeedsReconnect(connection.userId);
      return null;
    }
  }

  private async postToken(body: Record<string, string>): Promise<TokenResponse> {
    const basicAuth = Buffer.from(`${env.SPOTIFY_CLIENT_ID}:${env.SPOTIFY_CLIENT_SECRET}`).toString("base64");
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${basicAuth}`,
      },
      body: new URLSearchParams(body).toString(),
    });
    if (!res.ok) {
      throw new Error(`Spotify token endpoint returned ${res.status}`);
    }
    return res.json() as Promise<TokenResponse>;
  }

  // ── Now-playing / recently-played ────────────────────────────────────────

  private async fetchRaw(accessToken: string): Promise<RawNowPlaying> {
    const headers = { Authorization: `Bearer ${accessToken}` };

    const currentRes = await fetch(`${API_BASE}/me/player/currently-playing?additional_types=track`, { headers });
    if (currentRes.status === 401) return { kind: "unauthorized" };
    if (currentRes.status === 200) {
      const data = (await currentRes.json().catch(() => null)) as CurrentlyPlayingResponse | null;
      if (data?.is_playing && data.item) {
        return { kind: "playing", track: data.item };
      }
    }

    // 204 (nothing playing), or 200 with is_playing=false/no item → last played.
    const recentRes = await fetch(`${API_BASE}/me/player/recently-played?limit=1`, { headers });
    if (recentRes.status === 401) return { kind: "unauthorized" };
    if (!recentRes.ok) throw new Error(`Spotify recently-played returned ${recentRes.status}`);
    const recentData = (await recentRes.json()) as RecentlyPlayedResponse;
    const item = recentData.items?.[0];
    if (!item) return { kind: "none" };
    return { kind: "recent", track: item.track, playedAt: item.played_at };
  }

  private shapeBadge(raw: RawNowPlaying): SpotifyBadge | null {
    if (raw.kind === "none" || raw.kind === "unauthorized") return null;

    const track = raw.track;
    const base = {
      trackName:   track.name,
      artistName:  track.artists.map((a) => a.name).join(", "),
      albumArtUrl: track.album?.images?.[0]?.url ?? null,
      trackUrl:    track.external_urls?.spotify ?? null,
    };

    if (raw.kind === "playing") {
      return { ...base, isPlaying: true, playedAt: null };
    }

    if (Date.now() - new Date(raw.playedAt).getTime() > HIDE_AFTER_MS) return null;
    return { ...base, isPlaying: false, playedAt: raw.playedAt };
  }

  // ── Cache ─────────────────────────────────────────────────────────────────

  private cacheKey(userId: string): string {
    return `spotify:badge:${userId}`;
  }

  private async getCachedBadge(userId: string): Promise<{ hit: true; badge: SpotifyBadge | null } | { hit: false }> {
    const raw = await this.redis.get(this.cacheKey(userId));
    if (raw === null) return { hit: false };
    return { hit: true, badge: JSON.parse(raw) as SpotifyBadge | null };
  }

  private async setCachedBadge(userId: string, badge: SpotifyBadge | null): Promise<void> {
    await this.redis.set(this.cacheKey(userId), JSON.stringify(badge), "EX", CACHE_TTL_S);
  }
}
