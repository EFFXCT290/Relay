// CONTRACT CATEGORY: domain (UI signal — see SAFEGUARD 9: presence ≠ system truth)
import { Type, type Static } from "@sinclair/typebox";

// ── Domain types ─────────────────────────────────────────────────────────────
export type Presence = Static<typeof PresenceSchema>;

// ── Schemas ──────────────────────────────────────────────────────────────────
export const PresenceSchema = Type.Object({
  userId:   Type.String({ format: "uuid" }),
  isOnline: Type.Boolean(),
  lastSeen: Type.Optional(Type.String({ format: "date-time" })),
});

// ── Socket event names ───────────────────────────────────────────────────────
export const PRESENCE_EVENTS = {
  ONLINE:  "presence:online",
  OFFLINE: "presence:offline",
} as const;
export type PresenceEventName = (typeof PRESENCE_EVENTS)[keyof typeof PRESENCE_EVENTS];

// ── Socket event payloads ────────────────────────────────────────────────────
export type PresenceOnlineEvent  = { userId: string };
export type PresenceOfflineEvent = { userId: string; lastSeen: string };
