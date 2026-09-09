// CONTRACT CATEGORY: domain
import { Type } from "@sinclair/typebox";
import { SpotifyConversationSummarySchema } from "./spotify.contract.js";
// ─────────────────────────────────────────────────────────────────────────────
// Conversations source of truth. The frontend list uses `ConversationListItem`
// shape, the detail page uses `ConversationDetail`. Both live here.
// ─────────────────────────────────────────────────────────────────────────────
// ── ConversationListItem — what GET /api/conversations returns per row ──────
export const ConversationParticipantSchema = Type.Object({
    userId: Type.String({ format: "uuid" }),
    username: Type.String(),
    avatarUrl: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    isOnline: Type.Optional(Type.Boolean()),
    lastSeenAt: Type.Optional(Type.Union([Type.String({ format: "date-time" }), Type.Null()])),
    // The REQUESTING user's own private nickname for this participant — never
    // global, never another viewer's. null/absent means "use username". The
    // real username above is always still present alongside it — callers
    // decide per-surface whether to substitute (see conversation-row.tsx) or
    // show both (the Contact Info screen).
    nickname: Type.Optional(Type.Union([Type.String(), Type.Null()])),
});
export const ConversationLastMessageSchema = Type.Union([
    Type.Null(),
    Type.Object({
        messageId: Type.String({ format: "uuid" }),
        type: Type.String(),
        preview: Type.Union([Type.String(), Type.Null()]),
        sentAt: Type.String({ format: "date-time" }),
    }),
]);
export const ConversationListItemSchema = Type.Object({
    conversationId: Type.String({ format: "uuid" }),
    participant: ConversationParticipantSchema,
    lastMessage: ConversationLastMessageSchema,
    unreadCount: Type.Optional(Type.Number()),
    isTyping: Type.Optional(Type.Boolean()),
    captureAlert: Type.Optional(Type.Boolean()),
    // The OTHER participant's "now playing", already respecting showOnProfile —
    // null covers not-connected, hidden, and quiet-24h+ alike (same privacy
    // collapsing as the standalone badge endpoint). Optional because rows built
    // client-side from socket events (e.g. an incoming conversation:request)
    // don't set it.
    spotify: Type.Optional(Type.Union([SpotifyConversationSummarySchema, Type.Null()])),
    updatedAt: Type.String({ format: "date-time" }),
});
// ── Conversation (detail) — heavier shape for the /conversations/[id] view ─
export const ConversationSchema = Type.Object({
    conversationId: Type.String({ format: "uuid" }),
    participants: Type.Array(ConversationParticipantSchema),
    lastMessage: Type.Optional(ConversationLastMessageSchema),
    unreadCount: Type.Number(),
    createdAt: Type.String({ format: "date-time" }),
});
// ── Global inbox search (GET /conversations/search) ─────────────────────────
// One row per matching conversation, scoped to the caller's own accepted
// conversations. "participant" means the other participant's username or the
// caller's own nickname override for them matched; "content" means a message
// body or voice transcript inside that conversation matched (same
// disappearing-message exclusion as the per-conversation search — see
// message-search.service.ts) and carries the most recent such match as
// `snippet`/`messageId`. A conversation matched by name never sets a snippet
// even if it also happens to contain matching content — the name match alone
// is reason enough to surface it.
export const ConversationSearchHitSchema = Type.Object({
    conversationId: Type.String({ format: "uuid" }),
    participant: ConversationParticipantSchema,
    matchType: Type.Union([Type.Literal("participant"), Type.Literal("content")]),
    snippet: Type.Union([Type.String(), Type.Null()]),
    messageId: Type.Union([Type.String({ format: "uuid" }), Type.Null()]),
    updatedAt: Type.String({ format: "date-time" }),
});
// ── Request payloads ─────────────────────────────────────────────────────────
export const CreateConversationPayloadSchema = Type.Object({
    participantId: Type.String({ format: "uuid" }),
});
// ── Socket event names ───────────────────────────────────────────────────────
// Inbound (client → server): CREATE, READ, JOIN, LEAVE.
// Outbound (server → clients): REQUEST, ACCEPTED, DELETED.
export const CONVERSATION_EVENTS = {
    // Inbound
    CREATE: "conversation:create",
    READ: "conversation:read",
    JOIN: "conversation:join",
    LEAVE: "conversation:leave",
    // Outbound
    REQUEST: "conversation:request",
    ACCEPTED: "conversation:accepted",
    DELETED: "conversation:deleted",
};
