import type { Socket, Server as IOServer } from "socket.io";
import type { FastifyInstance } from "fastify";
import {
  CONVERSATION_EVENTS,
  type ConversationAcceptedEvent,
  type ConversationCreateInbound,
  type ConversationDeletedEvent,
  type ConversationJoinInbound,
  type ConversationLeaveInbound,
  type ConversationReadInbound,
  type ConversationRequestEvent,
} from "@relay/contracts";
import { withAck } from "../../sockets/ack.js";

// ─────────────────────────────────────────────────────────────────────────────
// Conversations socket layer — single per-domain file.
//
// Inbound (client → server):
//   - conversation:create  — start a 1:1 (HTTP is the canonical path today)
//   - conversation:read    — bulk mark conversation read
//   - conversation:join    — join the conversation room for live fan-out
//   - conversation:leave   — leave the conversation room
//
// Outbound (server → clients):
//   - conversation:request  — recipient sees a pending request
//   - conversation:accepted — both sides see acceptance
//   - conversation:deleted  — both sides remove from inbox
//
// Inbound handlers stay thin; the room mgmt cases (join/leave) ARE the work
// and can run inline — there's no service-level state for them.
// ─────────────────────────────────────────────────────────────────────────────

export function registerConversationSocket(
  socket:   Socket,
  _fastify: FastifyInstance,
  _userId:  string,
) {
  // ── conversation:create ─────────────────────────────────────────────────
  socket.on(CONVERSATION_EVENTS.CREATE, withAck<ConversationCreateInbound>(socket, async (_env) => {
    // TODO: await createConversation(_fastify, _env.payload, _userId);
  }));

  // ── conversation:read ───────────────────────────────────────────────────
  socket.on(CONVERSATION_EVENTS.READ, withAck<ConversationReadInbound>(socket, async (_env) => {
    // TODO: await markConversationRead(_fastify, _env.payload, _userId);
  }));

  // ── conversation:join ───────────────────────────────────────────────────
  // Pure room mgmt — no DB. Done inline because there's nothing for a service
  // to own. Guard the type at the boundary; everything past the if is safe.
  socket.on(CONVERSATION_EVENTS.JOIN, (payload: ConversationJoinInbound) => {
    if (typeof payload?.conversationId !== "string") return;
    socket.join(`conversation:${payload.conversationId}`);
  });

  // ── conversation:leave ──────────────────────────────────────────────────
  socket.on(CONVERSATION_EVENTS.LEAVE, (payload: ConversationLeaveInbound) => {
    if (typeof payload?.conversationId !== "string") return;
    socket.leave(`conversation:${payload.conversationId}`);
  });
}

// ── Outbound emit helpers ────────────────────────────────────────────────────

export function emitConversationRequest(
  io:           IOServer,
  recipientId:  string,
  event:        ConversationRequestEvent,
) {
  io.to(`user:${recipientId}`).emit(CONVERSATION_EVENTS.REQUEST, event);
}

export function emitConversationAccepted(
  io:          IOServer,
  recipientId: string,
  event:       ConversationAcceptedEvent,
) {
  io.to(`user:${recipientId}`).emit(CONVERSATION_EVENTS.ACCEPTED, event);
}

export function emitConversationDeleted(
  io:          IOServer,
  recipientId: string,
  event:       ConversationDeletedEvent,
) {
  io.to(`user:${recipientId}`).emit(CONVERSATION_EVENTS.DELETED, event);
}
