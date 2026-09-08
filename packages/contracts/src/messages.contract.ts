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

// ── Pinned messages (max MAX_PINNED_MESSAGES per conversation) ──────────────
export const MAX_PINNED_MESSAGES = 3;

export const PinnedMessageSchema = Type.Object({
  id:               Type.String({ format: "uuid" }),
  conversationId:   Type.String({ format: "uuid" }),
  messageId:        Type.String({ format: "uuid" }),
  pinnedBy:         Type.String({ format: "uuid" }),
  pinnedByUsername: Type.String(),
  pinnedAt:         Type.String({ format: "date-time" }),
  // Denormalized preview of the pinned message itself, so the banner/list view
  // can render without needing that message to already be in the client's
  // loaded window of the (virtualized, paginated) thread.
  message: Type.Object({
    senderId:       Type.String({ format: "uuid" }),
    senderUsername: Type.String(),
    body:           Type.Union([Type.String(), Type.Null()]),
    type:           Type.String(),
    createdAt:      Type.String({ format: "date-time" }),
  }),
});
export type PinnedMessage = Static<typeof PinnedMessageSchema>;

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

// ── Disappearing messages ────────────────────────────────────────────────────
// Two modes, mirroring the ephemeral-media pattern (media.contract.ts's
// EphemeralSendSchema/EphemeralStateSchema) but for a TEXT message's body
// instead of a media attachment:
//   - "views": Snapchat-style. `body` is withheld from every normal read path
//     (GET list, message:new, idempotent replay) exactly like an ephemeral
//     attachment's URL is withheld — the only way to read it is spending a
//     look via POST /messages/:messageId/view. The message soft-deletes once
//     viewCount reaches viewLimit.
//   - "time": Signal-style. `body` is visible immediately like a normal
//     message; the message soft-deletes itself once expiresAt passes, swept
//     by the same worker tick as ephemeral media's cleanup.worker.ts.
export const DisappearSendSchema = Type.Union([
  Type.Object({ mode: Type.Literal("views"), viewLimit: Type.Integer({ minimum: 1, maximum: 5 }) }),
  Type.Object({ mode: Type.Literal("time"), ttlSeconds: Type.Integer({ minimum: 5, maximum: 604800 }) }), // 5s..7d
]);
export type DisappearSend = Static<typeof DisappearSendSchema>;

// Wire state embedded in MessageSchema.disappear. viewLimit/expiresAt are
// mutually exclusive with the mode, mirroring EphemeralState's shape.
export const DisappearStateSchema = Type.Object({
  mode:      Type.Union([Type.Literal("views"), Type.Literal("time")]),
  viewLimit: Type.Union([Type.Integer(), Type.Null()]),
  viewCount: Type.Integer(),
  expiresAt: Type.Union([Type.String({ format: "date-time" }), Type.Null()]),
});
export type DisappearState = Static<typeof DisappearStateSchema>;

// Response of POST /api/messages/:messageId/view. `body` is the freshly-spent
// look's text, omitted once the message is consumed (mirrors MediaViewResponse).
export const MessageViewResponseSchema = Type.Object({
  consumed:  Type.Boolean(),
  viewCount: Type.Integer(),
  viewLimit: Type.Integer(),
  body:      Type.Optional(Type.String()),
});
export type MessageViewResponse = Static<typeof MessageViewResponseSchema>;

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
  embed:           Type.Optional(Type.Union([Type.Null(), MessageEmbedSchema])),
  attachments:     Type.Optional(Type.Array(MessageAttachmentSchema)),
  // Set only on message:new WS echoes for text sends — used by the sender's
  // client to atomically swap the optimistic tempId for the server's real ID.
  clientMessageId: Type.Optional(Type.Union([Type.String({ format: "uuid" }), Type.Null()])),
  // Present iff this message was sent with disappear-on (see DisappearStateSchema).
  disappear:       Type.Optional(Type.Union([Type.Null(), DisappearStateSchema])),
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
  PINNED:       "message:pinned",
  UNPINNED:     "message:unpinned",
  DISAPPEAR_PROGRESS: "message:disappear:progress",
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
export type MessagePinnedEvent   = { pin: PinnedMessage };
export type MessageUnpinnedEvent = { messageId: string; conversationId: string };

// Emitted to every participant when a look is spent on a "views"-mode
// disappearing message. Mirrors MediaViewedEvent — lets the sender's UI tick
// "Opened X/N" live and the recipient's other devices reconcile the locked
// state. `consumed` is true once viewCount reaches viewLimit; the DELETED
// event (above) fires separately once the underlying Message is soft-deleted.
export type MessageDisappearProgressEvent = {
  messageId:      string;
  conversationId: string;
  viewCount:      number;
  viewLimit:      number;
  consumed:       boolean;
  viewedAt:       string;
};
