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
  ONLINE:        "presence:online",         // server → all clients
  OFFLINE:       "presence:offline",        // server → all clients
  PING:          "presence:ping",           // client → server (heartbeat, no payload)
  SYNC_REQUEST:  "presence:sync-request",   // client → server (on connect/reconnect)
  SYNC_RESPONSE: "presence:sync-response",  // server → requesting client only
} as const;
export type PresenceEventName = (typeof PRESENCE_EVENTS)[keyof typeof PRESENCE_EVENTS];

// ── Timing contract ──────────────────────────────────────────────────────────
// These three values form a coupled system — change one and you must verify
// the others still hold the invariants below.
//
//   PING_INTERVAL_MS < HEARTBEAT_TTL_S * 1000
//     One dropped ping must not flip the user offline.
//     Current ratio: 10s / 15s = 67% — healthy target is 60–70%.
//
//   GRACE_MS > typical reconnect latency
//     Tab reloads typically reconnect in 1–3s. 12s covers slow networks.
//     Grace must be < HEARTBEAT_TTL_S * 1000 or the heartbeat can expire
//     before the grace window ends, making the check unreliable.
export const PRESENCE_PING_INTERVAL_MS = 10_000;  // ms — client sends presence:ping this often
export const PRESENCE_HEARTBEAT_TTL_S  = 15;      // s  — Redis key TTL for heartbeat
export const PRESENCE_GRACE_MS         = 12_000;  // ms — delay between disconnect and offline check

// ── Socket event payloads ────────────────────────────────────────────────────
// ⚠️  STABLE PROTOCOL — treat these shapes as a versioned API.
//     Do not add required fields or rename keys without a migration plan.
//     Optional fields may be added; existing fields must not change type.
//
// presence:online   { userId: string }
//   Emitted when a user transitions from absent heartbeat → present heartbeat.
//   Not emitted when a second tab connects (already online — deduped server-side).
//
// presence:offline  { userId: string; lastSeen: string (ISO 8601) }
//   Emitted after GRACE_MS when heartbeat has not been refreshed.
//   lastSeen = timestamp of confirmed offline transition (not last ping time).
//   Not emitted if the user reconnected within the grace window.
//
// presence:ping     (no payload)
//   Client → server heartbeat. Refreshes Redis TTL. No response emitted.
//   Must be sent every PING_INTERVAL_MS while the socket is connected.
//
// presence:sync-request  { userIds: string[] }
//   Client requests current presence state for a list of users.
//   Sent on connect/reconnect so clients don't depend on missed events.
//
// presence:sync-response  { users: PresenceSyncResponse["users"] }
//   Server responds with current computed state for each requested userId.
//   isOnline is computed from heartbeat existence — never stored as a boolean.
//   lastSeen is null if the user has never gone offline (new account or first session).

export type PresenceOnlineEvent  = { userId: string };
export type PresenceOfflineEvent = { userId: string; lastSeen: string };

export type PresenceSyncRequest  = { userIds: string[] };
export type PresenceSyncResponse = {
  users: Array<{ userId: string; isOnline: boolean; lastSeen: string | null }>;
};
