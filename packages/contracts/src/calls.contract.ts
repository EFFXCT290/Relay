// CONTRACT CATEGORY: signaling (ephemeral realtime — NOT routed through the
// reliability layer in realtime.contract.ts).
//
// ⚠️  Call signaling (SDP/ICE) is fire-and-forget. It MUST NOT use withAck /
//     emitEnvelope / SyncService — replaying a stale offer or ICE candidate
//     against a torn-down peer connection produces ghost peer states. The
//     server relays these with raw fastify.io.to('user:${id}').emit(...), the
//     same way presence broadcasts. Durable call history lives in Postgres
//     (the Call model); these events carry none of that persistence guarantee.

import { Type, type Static } from "@sinclair/typebox";

// ── Domain enums (mirror the Prisma CallType / CallStatus) ──────────────────
export type CallType   = "AUDIO" | "VIDEO";
export type CallStatus =
  | "RINGING"
  | "ANSWERED"
  | "MISSED"
  | "REJECTED"
  | "FAILED"
  | "ENDED";

export type CallDirection = "incoming" | "outgoing";

// ── Timing contract ──────────────────────────────────────────────────────────
// An unanswered call is marked MISSED and torn down after this window. Kept on
// the server (the ring timer) AND shown by the caller UI; one constant so they
// can't drift.
export const CALL_RING_TIMEOUT_MS = 30_000;

// ── Socket event names ───────────────────────────────────────────────────────
// call:offer / call:answer / call:ice-candidate intentionally reuse the same
// string in both directions — the server `.on` and client `.on` handlers are
// independent, so there is no collision.
export const CALL_EVENTS = {
  // client → server
  INIT:   "call:init",          // { targetUserId, type, conversationId? }; ack → CallInitAck
  ACCEPT: "call:accept",        // { callId }
  REJECT: "call:reject",        // { callId }
  OFFER:  "call:offer",         // { callId, sdp }       caller → server → recipient
  ANSWER: "call:answer",        // { callId, sdp }       recipient → server → caller
  ICE:    "call:ice-candidate", // { callId, candidate } either → server → other peer
  END:    "call:end",           // { callId }
  // server → client
  RINGING:  "call:ringing",  // → recipient: incoming call
  ACCEPTED: "call:accepted", // → caller: recipient accepted; begin createOffer()
  BUSY:     "call:busy",     // → caller: recipient already in a call
  TIMEOUT:  "call:timeout",  // → both: unanswered past CALL_RING_TIMEOUT_MS (MISSED)
  ENDED:    "call:ended",    // → peer: other side hung up / rejected
  FAILED:   "call:failed",   // → peer: disconnect / negotiation failure
} as const;
export type CallEventName = (typeof CALL_EVENTS)[keyof typeof CALL_EVENTS];

// ── Inbound payloads (client → server) ─────────────────────────────────────
export type CallInitInbound = {
  targetUserId:   string;
  type:           CallType;
  conversationId?: string;
};
export type CallByIdInbound  = { callId: string };          // ACCEPT, REJECT, END
export type CallSdpInbound   = { callId: string; sdp: RTCSessionDescriptionInitLike };
export type CallIceInbound   = { callId: string; candidate: RTCIceCandidateInitLike };

// call:init ack (returned via the Socket.IO ack callback).
export type CallInitAck =
  | { ok: true;  callId: string }
  | { ok: false; reason: "self" | "offline" | "busy" | "not_found" | "error" };

// ── Outbound payloads (server → client) ─────────────────────────────────────
export type CallRingingEvent = {
  callId: string;
  caller: { id: string; username: string };
  type:   CallType;
  conversationId?: string;
};
export type CallAcceptedEvent = { callId: string };
export type CallSdpEvent      = { callId: string; sdp: RTCSessionDescriptionInitLike };
export type CallIceEvent      = { callId: string; candidate: RTCIceCandidateInitLike };
export type CallBusyEvent     = { callId: string };
export type CallTimeoutEvent  = { callId: string };
export type CallEndedEvent    = { callId: string; status: CallStatus };
export type CallFailedEvent   = { callId: string };

// SDP/ICE are relayed verbatim; we avoid depending on lib.dom types in shared
// code by mirroring just the fields WebRTC sends over the wire.
export type RTCSessionDescriptionInitLike = { type: "offer" | "answer"; sdp?: string };
export type RTCIceCandidateInitLike = {
  candidate?:     string;
  sdpMid?:        string | null;
  sdpMLineIndex?: number | null;
  usernameFragment?: string | null;
};

// ── Call history DTO (GET /api/calls) ────────────────────────────────────────
export type CallHistoryItem = {
  id:           string;
  direction:    CallDirection;
  otherUser:    { id: string; username: string };
  type:         CallType;
  status:       CallStatus;
  durationSec:  number;
  createdAt:    string; // ISO 8601
};

// ── Schemas (TypeBox — for the GET /api/calls response) ──────────────────────
export const CallHistoryItemSchema = Type.Object({
  id:          Type.String(),
  direction:   Type.Union([Type.Literal("incoming"), Type.Literal("outgoing")]),
  otherUser:   Type.Object({ id: Type.String(), username: Type.String() }),
  type:        Type.Union([Type.Literal("AUDIO"), Type.Literal("VIDEO")]),
  status:      Type.Union([
    Type.Literal("RINGING"),
    Type.Literal("ANSWERED"),
    Type.Literal("MISSED"),
    Type.Literal("REJECTED"),
    Type.Literal("FAILED"),
    Type.Literal("ENDED"),
  ]),
  durationSec: Type.Integer(),
  createdAt:   Type.String({ format: "date-time" }),
});
export const CallHistoryResponseSchema = Type.Object({
  calls: Type.Array(CallHistoryItemSchema),
});
export type CallHistoryResponse = Static<typeof CallHistoryResponseSchema>;
