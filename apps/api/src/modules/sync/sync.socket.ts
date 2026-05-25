import type { Socket } from "socket.io";
import type { FastifyInstance } from "fastify";
import {
  ACK_EVENT,
  SYNC_EVENTS,
  type Ack,
  type ReplayRequest,
  type ReplayResponse,
} from "@relay/contracts";
import { SyncRepository } from "./sync.repository.js";
import { SyncService } from "./sync.service.js";

// ─────────────────────────────────────────────────────────────────────────────
// SAFEGUARD 2 — socket is transport-only.
// SAFEGUARD 8 — ACK is the truth source; this is where it enters the outbox.
//
// Two listeners per connection:
//   1. SYNC_EVENTS.REPLAY_REQUEST → service.replayFor() → REPLAY_RESPONSE.
//      The client asks for un-ACKed events since a cursor, optionally scoped
//      to one conversationId so only relevant events are returned.
//   2. ACK_EVENT → service.markAcked(). When the client confirms receipt of a
//      server-emitted envelope, the outbox row is stamped. After that, the
//      same eventId is never returned by a replay.
//
// `withAck` (apps/api/src/sockets/ack.ts) handles the OTHER direction —
// client→server ACKs. This file handles server→client ACK persistence.
// ─────────────────────────────────────────────────────────────────────────────

export function registerSyncSocket(socket: Socket, fastify: FastifyInstance, userId: string) {
  const service = new SyncService(new SyncRepository(fastify.prisma));

  // ── 1. Replay ──────────────────────────────────────────────────────────────
  socket.on(SYNC_EVENTS.REPLAY_REQUEST, async (req: ReplayRequest) => {
    try {
      const response: ReplayResponse = await service.replayFor(
        userId,
        req.since,
        req.limit,
        req.conversationId,
      );
      socket.emit(SYNC_EVENTS.REPLAY_RESPONSE, response);
    } catch (err) {
      // Replay failures are non-fatal for the socket; emit an empty response
      // with a null cursor so the client knows to fall back to HTTP replay.
      socket.emit(SYNC_EVENTS.REPLAY_RESPONSE, {
        events:     [],
        nextCursor: null,
        error:      err instanceof Error ? err.message : "replay_failed",
      });
    }
  });

  // ── 2. ACK → outbox ────────────────────────────────────────────────────────
  // Idempotent: markAcked is a no-op on rows that aren't ours or are already
  // acked, so unrecognized eventIds (e.g. ACKs for events this user wasn't
  // the recipient of) cost a single indexed UPDATE WHERE … no-rows.
  socket.on(ACK_EVENT, (ack: Ack) => {
    if (ack.status !== "ok") return;  // errors don't advance the outbox
    void service.markAcked(ack.eventId, userId).catch((err) => {
      fastify.log.error({ err, eventId: ack.eventId }, "markAcked failed");
    });
  });
}
