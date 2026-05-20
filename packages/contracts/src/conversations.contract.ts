// CONTRACT CATEGORY: domain
import { Type, type Static } from "@sinclair/typebox";

// ─────────────────────────────────────────────────────────────────────────────
// Conversations source of truth. The frontend list uses `ConversationListItem`
// shape, the detail page uses `ConversationDetail`. Both live here.
// ─────────────────────────────────────────────────────────────────────────────

// ── ConversationListItem — what GET /api/conversations returns per row ──────
export const ConversationParticipantSchema = Type.Object({
  userId:     Type.String({ format: "uuid" }),
  username:   Type.String(),
  isOnline:   Type.Optional(Type.Boolean()),
  lastSeenAt: Type.Optional(Type.Union([Type.String({ format: "date-time" }), Type.Null()])),
});

export const ConversationLastMessageSchema = Type.Union([
  Type.Null(),
  Type.Object({
    messageId: Type.String({ format: "uuid" }),
    type:      Type.String(),
    preview:   Type.Union([Type.String(), Type.Null()]),
    sentAt:    Type.String({ format: "date-time" }),
  }),
]);

export const ConversationListItemSchema = Type.Object({
  conversationId: Type.String({ format: "uuid" }),
  participant:    ConversationParticipantSchema,
  lastMessage:    ConversationLastMessageSchema,
  unreadCount:    Type.Optional(Type.Number()),
  isTyping:       Type.Optional(Type.Boolean()),
  captureAlert:   Type.Optional(Type.Boolean()),
  updatedAt:      Type.String({ format: "date-time" }),
});
export type ConversationListItem = Static<typeof ConversationListItemSchema>;

// ── Conversation (detail) — heavier shape for the /conversations/[id] view ─
export const ConversationSchema = Type.Object({
  conversationId: Type.String({ format: "uuid" }),
  participants:   Type.Array(ConversationParticipantSchema),
  lastMessage:    Type.Optional(ConversationLastMessageSchema),
  unreadCount:    Type.Number(),
  createdAt:      Type.String({ format: "date-time" }),
});
export type Conversation = Static<typeof ConversationSchema>;

// ── Request payloads ─────────────────────────────────────────────────────────
export const CreateConversationPayloadSchema = Type.Object({
  participantId: Type.String({ format: "uuid" }),
});
export type CreateConversationPayload = Static<typeof CreateConversationPayloadSchema>;

// ── Socket event names ───────────────────────────────────────────────────────
// Inbound (client → server): CREATE, READ, JOIN, LEAVE.
// Outbound (server → clients): REQUEST, ACCEPTED, DELETED.
export const CONVERSATION_EVENTS = {
  // Inbound
  CREATE:   "conversation:create",
  READ:     "conversation:read",
  JOIN:     "conversation:join",
  LEAVE:    "conversation:leave",
  // Outbound
  REQUEST:  "conversation:request",
  ACCEPTED: "conversation:accepted",
  DELETED:  "conversation:deleted",
} as const;
export type ConversationEventName = (typeof CONVERSATION_EVENTS)[keyof typeof CONVERSATION_EVENTS];

// ── Socket event payloads ────────────────────────────────────────────────────
// Inbound payloads
export type ConversationCreateInbound = CreateConversationPayload;
export type ConversationReadInbound   = { conversationId: string };
export type ConversationJoinInbound   = { conversationId: string };
export type ConversationLeaveInbound  = { conversationId: string };

// Outbound payloads
export type ConversationRequestEvent = {
  conversationId: string;
  from:           { userId: string; username: string };
  createdAt:      string;
};
export type ConversationAcceptedEvent = {
  conversationId: string;
  acceptedBy:     string;
  acceptedAt:     string;
};
export type ConversationDeletedEvent = { conversationId: string };
