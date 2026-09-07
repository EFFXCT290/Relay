// CONTRACT CATEGORY: domain
import { Type } from "@sinclair/typebox";
// ── Connect status (query-param state after the OAuth redirect lands back on
// the web app) ────────────────────────────────────────────────────────────
export const SpotifyConnectResultSchema = Type.Union([
    Type.Literal("connected"),
    Type.Literal("error"),
]);
// ── Badge (GET /api/users/:userId/spotify) ──────────────────────────────────
// isPlaying=true → "Live" (currently playing right now), playedAt is null.
// isPlaying=false → "last played", playedAt is the ISO timestamp to render as
// relative time. The endpoint never returns a badge for anything older than
// 24h — that case is `spotify: null` instead.
export const SpotifyBadgeSchema = Type.Object({
    isPlaying: Type.Boolean(),
    trackName: Type.String(),
    artistName: Type.String(),
    albumArtUrl: Type.Union([Type.String(), Type.Null()]),
    trackUrl: Type.Union([Type.String(), Type.Null()]),
    playedAt: Type.Union([Type.String({ format: "date-time" }), Type.Null()]),
});
export const SpotifyBadgeResponseSchema = Type.Object({
    spotify: Type.Union([SpotifyBadgeSchema, Type.Null()]),
});
// ── Connection status (GET/PATCH surfaced in settings) ──────────────────────
export const SpotifyConnectionStatusSchema = Type.Object({
    connected: Type.Boolean(),
    showOnProfile: Type.Boolean(),
    needsReconnect: Type.Boolean(),
    connectedAt: Type.Union([Type.String({ format: "date-time" }), Type.Null()]),
});
export const UpdateSpotifyPreferencesPayloadSchema = Type.Object({
    showOnProfile: Type.Boolean(),
});
// ── Conversation-list summary ───────────────────────────────────────────────
// Deliberately smaller than SpotifyBadge — no albumArtUrl/trackUrl — since this
// rides along on every GET /api/conversations response, one per row.
export const SpotifyConversationSummarySchema = Type.Object({
    trackName: Type.String(),
    artistName: Type.String(),
    isPlaying: Type.Boolean(),
});
