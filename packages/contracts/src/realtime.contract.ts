// CONTRACT CATEGORY: transport
// This file IS the realtime protocol agreement between api and web. Both
// sides MUST source timing constants, event names, and envelope shapes from
// here. Drift here = ghost messages, duplicate delivery.
import { Type, type Static } from "@sinclair/typebox";

// ─────────────────────────────────────────────────────────────────────────────
// Transport-level contract for the socket reliability layer.
// Every domain event (message:new, notification:new, …) is wrapped in an
// EventEnvelope before transmission. Receivers reply with an Ack matching
// the eventId. Missed events are recovered via SYNC_EVENTS.REPLAY_REQUEST.
// ─────────────────────────────────────────────────────────────────────────────

// ── EventEnvelope ────────────────────────────────────────────────────────────
// Wraps every realtime event with correlation, timing, and retry metadata so
// senders can ACK, retry, and replay. The `payload` shape is determined by
// `eventName` — consumers narrow via the domain contracts.
export const EventEnvelopeSchema = Type.Object({
  eventId:   Type.String({ format: "uuid" }),
  eventName: Type.String(),
  payload:   Type.Unknown(),
  timestamp: Type.String({ format: "date-time" }),
  attempts:  Type.Optional(Type.Number()),
});
export type EventEnvelope<T = unknown> =
  Omit<Static<typeof EventEnvelopeSchema>, "payload"> & { payload: T };

// ── Ack ──────────────────────────────────────────────────────────────────────
export const AckSchema = Type.Object({
  eventId: Type.String({ format: "uuid" }),
  status:  Type.Union([Type.Literal("ok"), Type.Literal("error")]),
  error:   Type.Optional(Type.Object({
    code:    Type.String(),
    message: Type.String(),
  })),
});
export type Ack = Static<typeof AckSchema>;

// Single channel name for ACKs in both directions
export const ACK_EVENT = "ack" as const;

// ── Reliability defaults ─────────────────────────────────────────────────────
// These are part of the protocol agreement. Server commits to remembering at
// least DEDUP_WINDOW recent eventIds per connection; client commits to
// retrying at most ACK_MAX_ATTEMPTS times with the same eventId. If either
// side disagrees, you get ghost / duplicate deliveries.
export const ACK_TIMEOUT_MS    = 5_000;
export const ACK_MAX_ATTEMPTS  = 3;
export const ACK_BACKOFF_BASE  = 500;   // ms — exponential: base * 2^(attempt-1)
export const DEDUP_WINDOW      = 1024;  // server retains this many eventIds per socket

// ── Replay / offline sync ────────────────────────────────────────────────────
// On reconnect, the client emits REPLAY_REQUEST with a cursor (ISO timestamp
// of the last envelope it processed). The server streams missed envelopes
// from the outbox via REPLAY_RESPONSE.
export const SYNC_EVENTS = {
  REPLAY_REQUEST:  "sync:replay-request",
  REPLAY_RESPONSE: "sync:replay-response",
} as const;
export type SyncEventName = (typeof SYNC_EVENTS)[keyof typeof SYNC_EVENTS];

export const ReplayRequestSchema = Type.Object({
  since:          Type.String({ format: "date-time" }),
  limit:          Type.Optional(Type.Number({ minimum: 1, maximum: 1000 })),
  // Scopes replay to one conversation so the server returns only relevant
  // events and the client avoids ACKing events that belong to other threads.
  conversationId: Type.Optional(Type.String({ format: "uuid" })),
});
export type ReplayRequest = Static<typeof ReplayRequestSchema>;

export type ReplayResponse = {
  events:     EventEnvelope[];
  nextCursor: string | null;  // ISO timestamp of last returned envelope, or null when fully caught up
};
