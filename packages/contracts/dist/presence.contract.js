// CONTRACT CATEGORY: domain (UI signal — see SAFEGUARD 9: presence ≠ system truth)
import { Type } from "@sinclair/typebox";
// ── Schemas ──────────────────────────────────────────────────────────────────
export const PresenceSchema = Type.Object({
    userId: Type.String({ format: "uuid" }),
    isOnline: Type.Boolean(),
    lastSeen: Type.Optional(Type.String({ format: "date-time" })),
});
// ── Socket event names ───────────────────────────────────────────────────────
export const PRESENCE_EVENTS = {
    ONLINE: "presence:online", // server → all clients
    OFFLINE: "presence:offline", // server → all clients
    PING: "presence:ping", // client → server (heartbeat, no payload)
    SYNC_REQUEST: "presence:sync-request", // client → server (on connect/reconnect)
    SYNC_RESPONSE: "presence:sync-response", // server → requesting client only
};
// ── Timing contract ──────────────────────────────────────────────────────────
// These three values form a coupled system — change one and you must verify
// the others still hold the invariants below.
//
//   PING_INTERVAL_MS < HEARTBEAT_TTL_S * 1000
//     One dropped ping must not flip the user offline.
//     Current ratio: 10s / 30s = 33% — tolerates ~2 missed pings before offline.
//
//   GRACE_MS > HEARTBEAT_TTL_S * 1000
//     The post-disconnect offline check must fire AFTER the heartbeat could
//     have expired. Worst case: a disconnect immediately after a ping leaves
//     the heartbeat alive for nearly the full TTL. If GRACE ≤ TTL, the check
//     can see a still-live heartbeat and skip — stranding the user "online"
//     with a stale lastSeen (the ~30% disconnect bug). checkAndMarkOffline
//     re-arms on a live heartbeat as a backstop, but keeping GRACE > TTL means
//     a genuinely-gone user resolves on the first check instead of looping.
//     33s also far exceeds the 1–3s typical reconnect latency, so a tab reload
//     never flips the user offline.
export const PRESENCE_PING_INTERVAL_MS = 10_000; // ms — client sends presence:ping this often
export const PRESENCE_HEARTBEAT_TTL_S = 30; // s  — Redis key TTL for heartbeat (existence ⇒ isOnline)
export const PRESENCE_GRACE_MS = PRESENCE_HEARTBEAT_TTL_S * 1000 + 3_000; // ms — 33s; MUST stay > HEARTBEAT_TTL_S * 1000 (see invariant above)
// Durable "last seen" lives in Postgres (UserPresence.lastSeenAt), written by the
// presence service on heartbeats — throttled to at most one DB write per user per
// window so steady-state pings don't hammer the DB. See presence.repository.ts.
export const PRESENCE_LASTSEEN_DB_THROTTLE_S = 60; // s — min gap between durable lastSeen writes per user
