// CONTRACT CATEGORY: domain
import { Type, type Static } from "@sinclair/typebox";
import { MessageAttachmentSchema } from "./media.contract.js";

// ─────────────────────────────────────────────────────────────────────────────
// SAFEGUARD 1 — Source of truth for the Messages domain. Owns HTTP I/O schemas
// AND socket event names + payloads. Routes import schemas from here; web
// components import types from here. Defining the same shape inline anywhere
// else is a Rule 1 violation.
// ─────────────────────────────────────────────────────────────────────────────

// ── Message type & schema (canonical wire shape — both api emits and web reads) ──
export const ReplyToSchema = Type.Union([
  Type.Null(),
  Type.Object({
    messageId: Type.String({ format: "uuid" }),
    preview:   Type.Union([Type.String(), Type.Null()]),
    type:      Type.String(),
  }),
]);

export const ReadReceiptSchema = Type.Object({
  userId: Type.String({ format: "uuid" }),
  readAt: Type.String({ format: "date-time" }),
});

export const MessageEmbedSchema = Type.Object({
  url:         Type.String(),
  title:       Type.Union([Type.String(), Type.Null()]),
  description: Type.Union([Type.String(), Type.Null()]),
  imageUrl:    Type.Union([Type.String(), Type.Null()]),
  siteName:    Type.Union([Type.String(), Type.Null()]),
  faviconUrl:  Type.Union([Type.String(), Type.Null()]),
  provider:    Type.Optional(Type.Union([Type.String(), Type.Null()])),
});
export type MessageEmbed = Static<typeof MessageEmbedSchema>;

export const MessageSchema = Type.Object({
  messageId:      Type.String({ format: "uuid" }),
  conversationId: Type.String({ format: "uuid" }),
  senderId:       Type.String({ format: "uuid" }),
  senderUsername: Type.String(),
  type:           Type.String(),  // "TEXT" | "IMAGE" | "VIDEO" | "AUDIO"
  body:           Type.Union([Type.String(), Type.Null()]),
  replyTo:        ReplyToSchema,
  isEdited:       Type.Boolean(),
  editedAt:       Type.Union([Type.String({ format: "date-time" }), Type.Null()]),
  isDeleted:      Type.Boolean(),
  reactions:      Type.Record(Type.String(), Type.Integer()),  // emoji → count
  myReaction:     Type.Union([Type.String(), Type.Null()]),
  readBy:         Type.Array(ReadReceiptSchema),
  deliveredAt:    Type.Union([Type.String({ format: "date-time" }), Type.Null()]),
  createdAt:      Type.String({ format: "date-time" }),
  embed:          Type.Optional(Type.Union([Type.Null(), MessageEmbedSchema])),
  attachments:    Type.Optional(Type.Array(MessageAttachmentSchema)),
});
export type Message = Static<typeof MessageSchema>;

// Narrowed media-type literal — components and DB switch on this
export type MessageType = "TEXT" | "IMAGE" | "VIDEO" | "AUDIO";

// ── Request payloads ─────────────────────────────────────────────────────────
export const SendMessagePayloadSchema = Type.Object({
  conversationId: Type.String({ format: "uuid" }),
  body:           Type.String({ minLength: 1, maxLength: 10000 }),
  replyToId:      Type.Optional(Type.String({ format: "uuid" })),
});
export type SendMessagePayload = Static<typeof SendMessagePayloadSchema>;

export const EditMessagePayloadSchema = Type.Object({
  body: Type.String({ minLength: 1, maxLength: 10000 }),
});
export type EditMessagePayload = Static<typeof EditMessagePayloadSchema>;

// ── Socket event names ───────────────────────────────────────────────────────
// Inbound (client → server): SEND, EDIT, DELETE, REACTION, READ.
// Outbound (server → clients): NEW, EDITED, DELETED, DELIVERED, REACTION, READ.
// REACTION and READ are bidirectional — same name, payload shape varies by
// direction (the *Event types below split them).
export const MESSAGE_EVENTS = {
  // Inbound
  SEND:         "message:send",
  EDIT:         "message:edit",
  DELETE:       "message:delete",
  REACTION:     "message:reaction",
  READ:         "message:read",
  // Outbound
  NEW:          "message:new",
  EDITED:       "message:edited",
  DELETED:      "message:deleted",
  DELIVERED:    "message:delivered",
  EMBED_UPDATE: "message:embed:update",
} as const;
export type MessageEventName = (typeof MESSAGE_EVENTS)[keyof typeof MESSAGE_EVENTS];

// ── Socket event payloads ────────────────────────────────────────────────────
// Inbound payloads (client → server)
export type MessageSendInbound     = SendMessagePayload & { clientMessageId?: string };
export type MessageEditInbound     = { messageId: string; body: string };
export type MessageDeleteInbound   = { messageId: string };
export type MessageReactionInbound = { messageId: string; emoji: string };
export type MessageReadInbound     = { conversationId: string; messageIds?: string[] };

// Outbound payloads (server → clients)
export type MessageNewEvent        = { message: Message };
export type MessageEditedEvent     = { messageId: string; body: string; editedAt: string };
export type MessageDeletedEvent    = { messageId: string; conversationId?: string };
export type MessageDeliveredEvent  = { conversationId: string; messageIds: string[]; deliveredAt: string };
export type MessageReactionEvent   = {
  messageId: string;
  reactions: Record<string, number>;
  actorId:   string;
};
export type MessageReadEvent       = {
  conversationId: string;
  readBy:         string;
  messageIds:     string[];
  readAt:         string;
  deliveredAt?:   string | null;
};
export type MessageEmbedUpdateEvent = {
  messageId: string;
  embed:     MessageEmbed;
};
