import type { Socket, Server as IOServer } from "socket.io";
import type { FastifyInstance } from "fastify";
import {
  NOTIFICATION_EVENTS,
  type NotificationNewEvent,
} from "@relay/contracts";

// ─────────────────────────────────────────────────────────────────────────────
// Notifications socket layer.
//
// Server → client only for MVP+ — there is no inbound event. The canonical
// emit path is NotificationService.notify() (notification.service.ts), which
// creates the row and broadcasts in one seam so we can't accidentally insert
// a notification without firing the WS event (or vice versa).
//
// The emit helper below is here for non-service callers (dev seeds, tests).
// Production code should still go through NotificationService.
// ─────────────────────────────────────────────────────────────────────────────

export function registerNotificationSocket(
  _socket:  Socket,
  _fastify: FastifyInstance,
  _userId:  string,
) {
  // Reserved for future inbound (e.g. "notification:dismissed").
}

// ── Outbound emit helper ─────────────────────────────────────────────────────
export function emitNotificationNew(io: IOServer, userId: string, event: NotificationNewEvent) {
  io.to(`user:${userId}`).emit(NOTIFICATION_EVENTS.NEW, event);
}
