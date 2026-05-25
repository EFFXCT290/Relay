// CONTRACT CATEGORY: domain (UI signal — pure broadcast, never persisted)
import { Type, type Static } from "@sinclair/typebox";

// ── Schemas ──────────────────────────────────────────────────────────────────
export const TypingPayloadSchema = Type.Object({
  conversationId: Type.String({ format: "uuid" }),
});
export type TypingPayload = Static<typeof TypingPayloadSchema>;

// ── Socket event names ───────────────────────────────────────────────────────
// Typing is a self-contained UI signal — completely separate from the
// socket-level heartbeat / presence system. The client signals intent with
// typing:start / typing:stop; the server is the single source of truth for
// "is this user currently typing?" and broadcasts typing:update to others
// in the room. The receiver never sets its own timeout — it just mirrors
// the latest typing:update.
//
// On connect/reconnect the client emits typing:sync-request so the server can
// return the current active-typing map — this prevents ghost indicators after
// a reload or reconnect without waiting for the next sweep tick.
export const TYPING_EVENTS = {
  START:         "typing:start",         // client → server
  STOP:          "typing:stop",          // client → server
  UPDATE:        "typing:update",        // server → clients in conversation room
  SYNC_REQUEST:  "typing:sync-request",  // client → server (on connect/reconnect)
  SYNC_RESPONSE: "typing:sync-response", // server → requesting client
} as const;
export type TypingEventName = (typeof TYPING_EVENTS)[keyof typeof TYPING_EVENTS];

// ── Timing contract ──────────────────────────────────────────────────────────
// Client suppresses repeat typing:start for DEBOUNCE_MS so the server can
// refresh expiresAt without being spammed on every keystroke. Server expires
// the entry after TIMEOUT_MS of no refresh; sweep runs every SWEEP_INTERVAL_MS
// to broadcast cleanup. TIMEOUT must be > DEBOUNCE so a steadily-typing user
// is never prematurely cleared. The client does NOT run its own expiry timer —
// the server sweep is the sole authority.
export const TYPING_DEBOUNCE_MS       = 2_500;
export const TYPING_TIMEOUT_MS        = 5_000;
export const TYPING_SWEEP_INTERVAL_MS = 1_000;

// ── Socket event payloads ────────────────────────────────────────────────────
export type TypingInbound      = TypingPayload;
export type TypingUpdateEvent  = {
  conversationId: string;
  userId:         string;
  isTyping:       boolean;
};

// conversationId → array of userIds currently typing (only active entries)
export type TypingSyncRequest  = { conversationIds: string[] };
export type TypingSyncResponse = { active: Record<string, string[]> };
