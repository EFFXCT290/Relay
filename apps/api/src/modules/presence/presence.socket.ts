import type { Socket } from "socket.io";
import type { FastifyInstance } from "fastify";
import { PresenceService } from "./presence.service.js";

// ─────────────────────────────────────────────────────────────────────────────
// Presence socket layer is INTENTIONALLY thin: it only signals
// connect/disconnect to PresenceService. It does NOT decide who's online,
// store state, broadcast events, or do anything that could be tested without
// a socket. All of that lives in PresenceService.
// ─────────────────────────────────────────────────────────────────────────────

export function registerPresenceSocket(
  socket: Socket,
  fastify: FastifyInstance,
  userId: string,
) {
  const service = new PresenceService(fastify);

  // Mark online on connection. Already-connected case is handled because
  // plugins/socket.ts invokes this registration on every new socket.
  void service.markOnline(userId);

  socket.on("disconnect", () => {
    void service.markOffline(userId);
  });
}
