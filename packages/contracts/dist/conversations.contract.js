// CONTRACT CATEGORY: domain
import { Type } from "@sinclair/typebox";
// ─────────────────────────────────────────────────────────────────────────────
// Conversations source of truth. The frontend list uses `ConversationListItem`
// shape, the detail page uses `ConversationDetail`. Both live here.
// ─────────────────────────────────────────────────────────────────────────────
// ── ConversationListItem — what GET /api/conversations returns per row ──────
export const ConversationParticipantSchema = Type.Object({
    userId: Type.String({ format: "uuid" }),
    username: Type.String(),
    isOnline: Type.Optional(Type.Boolean()),
    lastSeenAt: Type.Optional(Type.Union([Type.String({ format: "date-time" }), Type.Null()])),
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
