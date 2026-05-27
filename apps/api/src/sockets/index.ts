import type { Socket } from "socket.io";
import type { FastifyInstance } from "fastify";

import { registerCallSocket }         from "../modules/calls/calls.socket.js";
import { registerConversationSocket } from "../modules/conversations/conversation.socket.js";
import { registerMessageSocket }      from "../modules/messages/message.socket.js";
import { registerNotificationSocket } from "../modules/notifications/notification.socket.js";
import { registerPresenceSocket }     from "../modules/presence/presence.socket.js";
import { registerSyncSocket }         from "../modules/sync/sync.socket.js";
import { registerTypingSocket }       from "../modules/typing/typing.socket.js";

// ─────────────────────────────────────────────────────────────────────────────
// One-stop registration. plugins/socket.ts calls this for each new
// connection; each per-domain register fn wires its events on the given
// socket. The actual handler implementations live next to their service +
// repository in modules/<domain>/<domain>.socket.ts — this file only fans in.
//
// Shared transport helpers (withAck, emitEnvelope) stay in sockets/ack.ts
// because they're domain-agnostic infrastructure.
// ─────────────────────────────────────────────────────────────────────────────
export function registerAllSocketHandlers(
  socket:  Socket,
  fastify: FastifyInstance,
  userId:  string,
) {
  registerConversationSocket(socket, fastify, userId);
  registerCallSocket(socket, fastify, userId);
  registerMessageSocket(socket, fastify, userId);
  registerNotificationSocket(socket, fastify, userId);
  registerPresenceSocket(socket, fastify, userId);
  registerSyncSocket(socket, fastify, userId);
  registerTypingSocket(socket, fastify, userId);
}

export { withAck, emitEnvelope } from "./ack.js";
