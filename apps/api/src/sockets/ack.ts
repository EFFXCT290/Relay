import type { Socket } from "socket.io";
import { ACK_EVENT, DEDUP_WINDOW, type Ack, type EventEnvelope } from "@relay/contracts";

// ─────────────────────────────────────────────────────────────────────────────
// SAFEGUARD 5 — load-bearing. Sibling: apps/web/src/frontend-core/reliable.ts.
// These two files evolve as a SINGLE LOGICAL UNIT. All timing constants live
// in packages/contracts/src/realtime.contract.ts so neither side can drift.
//
// withAck mirrors the client retry/dedup behavior in reliable.ts:
//   - Client may retry an envelope up to ACK_MAX_ATTEMPTS times with the same
//     eventId on missed ACKs.
//   - withAck remembers the last DEDUP_WINDOW eventIds per socket. A retry
//     with a known eventId re-ACKs WITHOUT re-running the handler. This is
//     what prevents duplicate messages / double reads / phantom reactions.
//
// If you change anything about the retry policy here, change reliable.ts in
// the SAME PR. Drift here is the most common source of "ghost delivery" bugs.
// ─────────────────────────────────────────────────────────────────────────────

type DedupCacheEntry = { lastAck: Ack };

// WeakMap so cache evicts when socket disconnects. Inside: sliding FIFO of
// (eventId → lastAck) for fast lookup + bounded memory.
const cachePerSocket = new WeakMap<Socket, {
  order: string[];
  acks:  Map<string, Ack>;
}>();

function getCache(socket: Socket) {
  let c = cachePerSocket.get(socket);
  if (!c) {
    c = { order: [], acks: new Map() };
    cachePerSocket.set(socket, c);
  }
  return c;
}

function remember(socket: Socket, eventId: string, ack: Ack) {
  const c = getCache(socket);
  if (c.acks.has(eventId)) return;
  c.order.push(eventId);
  c.acks.set(eventId, ack);
  while (c.order.length > DEDUP_WINDOW) {
    const oldest = c.order.shift()!;
    c.acks.delete(oldest);
  }
}

function recall(socket: Socket, eventId: string): DedupCacheEntry | undefined {
  const ack = getCache(socket).acks.get(eventId);
  return ack ? { lastAck: ack } : undefined;
}

// ── withAck ──────────────────────────────────────────────────────────────────
// Wraps a domain socket handler:
//   socket.on(MESSAGE_EVENTS.NEW, withAck(socket, async (env) => {
//     await messageService.handleNew(env.payload);
//   }));
// On success: emits Ack{ok}. On throw: emits Ack{error}. On retry (seen
// eventId): re-emits the prior Ack without re-invoking the handler.
export function withAck<T>(
  socket: Socket,
  handler: (envelope: EventEnvelope<T>) => Promise<void> | void,
) {
  return async (envelope: EventEnvelope<T>) => {
    const cached = recall(socket, envelope.eventId);
    if (cached) {
      socket.emit(ACK_EVENT, cached.lastAck);
      return;
    }

    let ack: Ack;
    try {
      await handler(envelope);
      ack = { eventId: envelope.eventId, status: "ok" };
    } catch (err) {
      ack = {
        eventId: envelope.eventId,
        status:  "error",
        error: {
          code:    err instanceof Error ? err.name    : "unknown",
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }

    remember(socket, envelope.eventId, ack);
    socket.emit(ACK_EVENT, ack);
  };
}

// ── emitEnvelope ─────────────────────────────────────────────────────────────
// Server-initiated emit (e.g. message:new fan-out). Caller MUST also call
// SyncService.record(envelope, recipientId) before this for the envelope to
// survive a recipient disconnect — that's what makes the reliability layer
// work end-to-end.
export function emitEnvelope<T>(socket: Socket, eventName: string, payload: T): EventEnvelope<T> {
  const envelope: EventEnvelope<T> = {
    eventId:   crypto.randomUUID(),
    eventName,
    payload,
    timestamp: new Date().toISOString(),
  };
  socket.emit(eventName, envelope);
  return envelope;
}
