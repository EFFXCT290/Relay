import type { Socket } from "socket.io";
import type { FastifyInstance } from "fastify";
import { TYPING_EVENTS, type TypingInbound, type TypingSyncRequest } from "@relay/contracts";
import {
  getActiveTypers,
  typingClearForSocket,
  typingStart,
  typingStop,
} from "./typing.service.js";

// ─────────────────────────────────────────────────────────────────────────────
// Typing socket layer — thin. Inbound typing:start / typing:stop go straight
// to the service; the service is the single source of truth for "who's
// typing right now" and owns broadcast of typing:update events. Receivers
// never run their own timeout — the server's TIMEOUT_MS + sweep handles
// every stuck-indicator case (lost typing:stop, browser close, crash).
// ─────────────────────────────────────────────────────────────────────────────

export function registerTypingSocket(
  socket:  Socket,
  fastify: FastifyInstance,
  userId:  string,
) {
  socket.on(TYPING_EVENTS.START, (payload: TypingInbound) => {
    if (typeof payload?.conversationId !== "string") return;
    typingStart(fastify, payload.conversationId, userId, socket.id);
  });

  socket.on(TYPING_EVENTS.STOP, (payload: TypingInbound) => {
    if (typeof payload?.conversationId !== "string") return;
    typingStop(fastify, payload.conversationId, userId);
  });

  socket.on(TYPING_EVENTS.SYNC_REQUEST, (payload: TypingSyncRequest) => {
    if (!Array.isArray(payload?.conversationIds)) return;
    const active = getActiveTypers(payload.conversationIds);
    socket.emit(TYPING_EVENTS.SYNC_RESPONSE, { active });
  });

  socket.on("disconnect", () => {
    typingClearForSocket(fastify, socket.id);
  });
}
