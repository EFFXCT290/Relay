import type { Socket } from "socket.io";
import type { FastifyInstance } from "fastify";
import { PRESENCE_EVENTS, type PresenceSyncRequest } from "@relay/contracts";
import { PresenceService } from "./presence.service.js";

// ─────────────────────────────────────────────────────────────────────────────
// Presence socket layer — intentionally thin. Four signals:
//
//   connect          → markOnline  (cancels pending timer, sets heartbeat, broadcasts if new)
//   presence:ping    → pulse       (refreshes heartbeat TTL, silent)
//   presence:sync-request → getMany → sync-response (snapshot for reconnecting client)
//   disconnect       → scheduleOffline (timer lives in service, one per userId)
//
// Timer ownership is in PresenceService so markOnline can cancel a pending
// offline check the moment the user reconnects — regardless of which socket
// instance created the timer.
// ─────────────────────────────────────────────────────────────────────────────

export function registerPresenceSocket(
  socket:  Socket,
  fastify: FastifyInstance,
  userId:  string,
) {
  const service = new PresenceService(fastify);

  // Fire-and-forget — but uncaught, a rejection here (e.g. a transient DB
  // error, or the user's row vanishing mid-connect) would be an unhandled
  // promise rejection, which by default crashes the whole process for every
  // connected user, not just this one. Same defensive pattern as
  // MessageService.sweepUndelivered in plugins/socket.ts.
  void service.markOnline(userId).catch((err) => fastify.log.error({ err, userId }, "presence: markOnline failed"));

  socket.on(PRESENCE_EVENTS.PING, () => {
    void service.pulse(userId).catch((err) => fastify.log.error({ err, userId }, "presence: pulse failed"));
  });

  socket.on(PRESENCE_EVENTS.SYNC_REQUEST, (payload: PresenceSyncRequest) => {
    if (!Array.isArray(payload?.userIds)) return;
    void service.getMany(payload.userIds)
      .then((users) => {
        socket.emit(PRESENCE_EVENTS.SYNC_RESPONSE, { users });
      })
      .catch((err) => fastify.log.error({ err, userId }, "presence: sync-request failed"));
  });

  socket.on("disconnect", () => {
    service.scheduleOffline(userId);
  });
}
