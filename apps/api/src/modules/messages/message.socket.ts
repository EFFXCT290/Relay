import type { Socket, Server as IOServer } from "socket.io";
import type { FastifyInstance } from "fastify";
import {
  MESSAGE_EVENTS,
  type MessageDeletedEvent,
  type MessageDeleteInbound,
  type MessageDeliveredEvent,
  type MessageEditInbound,
  type MessageEditedEvent,
  type MessageNewEvent,
  type MessageReactionEvent,
  type MessageReactionInbound,
  type MessageReadEvent,
  type MessageReadInbound,
  type MessageSendInbound,
} from "@relay/contracts";
import { withAck } from "../../sockets/ack.js";

// ─────────────────────────────────────────────────────────────────────────────
// Messages socket layer — single per-domain file. Two responsibilities:
//   1. Register inbound (client → server) handlers via socket.on. Each
//      section below maps to ONE event in the MVP+ catalog. Handlers stay
//      thin: validate via withAck, delegate to a service, emit via the
//      outbound helpers below.
//   2. Export outbound (server → clients) emit helpers. Any code that fans
//      out a message event — routes, services, dev seeds — calls these
//      helpers instead of `io.emit("message:edited", ...)` so the wire
//      format lives in one place.
//
// HTTP-first today: the create/edit/delete/react routes in message.routes.ts
// drive most state changes and call the same emit helpers. Inbound socket
// handlers are scaffolded for the eventual realtime-first path (where the
// composer emits message:send directly without round-tripping HTTP).
// ─────────────────────────────────────────────────────────────────────────────

// ── Inbound registration ─────────────────────────────────────────────────────
export function registerMessageSocket(
  socket:   Socket,
  _fastify: FastifyInstance,
  _userId:  string,
) {
  // ── message:send ────────────────────────────────────────────────────────
  // Client posts a new message over the socket. Today the HTTP POST drives
  // the real path; this stub stays wired so reconnect-replay and future
  // realtime-first sends share the same envelope shape.
  socket.on(MESSAGE_EVENTS.SEND, withAck<MessageSendInbound>(socket, async (_env) => {
    // TODO: await new MessageRoutesService(_fastify).send(_env.payload, _userId);
  }));

  // ── message:edit ────────────────────────────────────────────────────────
  socket.on(MESSAGE_EVENTS.EDIT, withAck<MessageEditInbound>(socket, async (_env) => {
    // TODO: await editMessage(_fastify, _env.payload, _userId);
  }));

  // ── message:delete ──────────────────────────────────────────────────────
  socket.on(MESSAGE_EVENTS.DELETE, withAck<MessageDeleteInbound>(socket, async (_env) => {
    // TODO: await softDeleteMessage(_fastify, _env.payload, _userId);
  }));

  // ── message:reaction ────────────────────────────────────────────────────
  // Single inbound for add / replace / toggle-off (server figures out which
  // based on existing reaction state).
  socket.on(MESSAGE_EVENTS.REACTION, withAck<MessageReactionInbound>(socket, async (_env) => {
    // TODO: await reactToMessage(_fastify, _env.payload, _userId);
  }));

  // ── message:read ────────────────────────────────────────────────────────
  // Bulk mark-as-read; payload may include messageIds to scope, or omit them
  // to mark the whole conversation.
  socket.on(MESSAGE_EVENTS.READ, withAck<MessageReadInbound>(socket, async (_env) => {
    // TODO: await markConversationRead(_fastify, _env.payload, _userId);
  }));
}

// ── Outbound emit helpers ────────────────────────────────────────────────────
// One function per outbound event. Routes and services call these instead of
// formatting wire payloads inline so the schema lives in one place.

export function emitMessageNew(io: IOServer, conversationId: string, event: MessageNewEvent) {
  io.to(`conversation:${conversationId}`).emit(MESSAGE_EVENTS.NEW, event);
}

export function emitMessageNewToUser(io: IOServer, userId: string, event: MessageNewEvent) {
  io.to(`user:${userId}`).emit(MESSAGE_EVENTS.NEW, event);
}

export function emitMessageEdited(io: IOServer, conversationId: string, event: MessageEditedEvent) {
  io.to(`conversation:${conversationId}`).emit(MESSAGE_EVENTS.EDITED, event);
}

export function emitMessageDeleted(io: IOServer, conversationId: string, event: MessageDeletedEvent) {
  io.to(`conversation:${conversationId}`).emit(MESSAGE_EVENTS.DELETED, event);
}

export function emitMessageReaction(io: IOServer, conversationId: string, event: MessageReactionEvent) {
  io.to(`conversation:${conversationId}`).emit(MESSAGE_EVENTS.REACTION, event);
}

export function emitMessageRead(io: IOServer, recipientUserId: string, event: MessageReadEvent) {
  io.to(`user:${recipientUserId}`).emit(MESSAGE_EVENTS.READ, event);
}

export function emitMessageDelivered(io: IOServer, senderUserId: string, event: MessageDeliveredEvent) {
  io.to(`user:${senderUserId}`).emit(MESSAGE_EVENTS.DELIVERED, event);
}
