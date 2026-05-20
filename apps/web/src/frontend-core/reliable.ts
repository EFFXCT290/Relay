"use client";

import {
  ACK_BACKOFF_BASE,
  ACK_EVENT,
  ACK_MAX_ATTEMPTS,
  ACK_TIMEOUT_MS,
  SYNC_EVENTS,
  type Ack,
  type EventEnvelope,
  type ReplayRequest,
  type ReplayResponse,
} from "@relay/contracts";
import { getSocket } from "./socket";

// ─────────────────────────────────────────────────────────────────────────────
// SAFEGUARD 5 — load-bearing. Sibling: apps/api/src/sockets/ack.ts.
// These two files evolve as a SINGLE LOGICAL UNIT. All timing constants
// (ACK_TIMEOUT_MS, ACK_MAX_ATTEMPTS, ACK_BACKOFF_BASE, DEDUP_WINDOW) live in
// packages/contracts/src/realtime.contract.ts so neither side can drift.
//
// Touching this file? You almost certainly need to touch ack.ts in the SAME
// PR. Drift between them produces duplicate messages, ghost delivery, and
// inconsistent read receipts that are extremely hard to debug.
//
// Public API:
//   - emitReliable(eventName, payload): emits an EventEnvelope and resolves
//     when the server returns an Ack with the matching eventId. Retries with
//     exponential backoff up to ACK_MAX_ATTEMPTS before rejecting.
//   - bindAckListener(): registers the single 'ack' handler. Call once at
//     app bootstrap (e.g. from NotificationsProvider or app shell).
//   - bindReconnectReplay(getCursor, onEnvelope): on every reconnect, asks
//     the server for events since the last cursor and dispatches each
//     envelope as if it had arrived live.
// ─────────────────────────────────────────────────────────────────────────────

type Pending = {
  resolve: () => void;
  reject:  (err: Error) => void;
  timer:   ReturnType<typeof setTimeout>;
  attempts: number;
  envelope: EventEnvelope;
};

const pending = new Map<string, Pending>();
let   ackBound = false;

export function emitReliable<T>(eventName: string, payload: T): Promise<void> {
  const eventId   = crypto.randomUUID();
  const envelope: EventEnvelope<T> = {
    eventId,
    eventName,
    payload,
    timestamp: new Date().toISOString(),
    attempts:  0,
  };

  if (!ackBound) bindAckListener();

  return new Promise<void>((resolve, reject) => {
    const send = () => {
      envelope.attempts = (envelope.attempts ?? 0) + 1;
      getSocket().emit(eventName, envelope);

      const backoff = ACK_BACKOFF_BASE * 2 ** ((envelope.attempts ?? 1) - 1);
      const timer   = setTimeout(() => {
        const p = pending.get(eventId);
        if (!p) return;
        if (p.attempts >= ACK_MAX_ATTEMPTS) {
          pending.delete(eventId);
          reject(new Error(`No ACK for ${eventName} after ${ACK_MAX_ATTEMPTS} attempts`));
          return;
        }
        send();  // retry — replaces the pending entry below
      }, ACK_TIMEOUT_MS + backoff);

      pending.set(eventId, { resolve, reject, timer, attempts: envelope.attempts ?? 1, envelope });
    };

    send();
  });
}

export function bindAckListener(): void {
  if (ackBound) return;
  ackBound = true;
  getSocket().on(ACK_EVENT, (ack: Ack) => {
    const p = pending.get(ack.eventId);
    if (!p) return;
    clearTimeout(p.timer);
    pending.delete(ack.eventId);
    if (ack.status === "ok") p.resolve();
    else p.reject(new Error(ack.error?.message ?? `ACK error: ${ack.error?.code ?? "unknown"}`));
  });
}

// ── Reconnect-replay ────────────────────────────────────────────────────────
// getCursor: returns the ISO timestamp of the last envelope the client
//   successfully processed (read from localStorage or a store).
// onEnvelope: called for each missed envelope so feature stores can dispatch
//   them as if they'd arrived live.
export function bindReconnectReplay(
  getCursor:  () => string | null,
  onEnvelope: (env: EventEnvelope) => void,
): () => void {
  const socket = getSocket();

  const requestReplay = () => {
    const since = getCursor();
    if (!since) return;
    const req: ReplayRequest = { since, limit: 500 };
    socket.emit(SYNC_EVENTS.REPLAY_REQUEST, req);
  };

  const handleResponse = (res: ReplayResponse) => {
    for (const env of res.events) onEnvelope(env);
    // If nextCursor is non-null, more events remain — caller will be invoked
    // again on the next reconnect tick. Future work: paginate within a single
    // reconnect by re-emitting REPLAY_REQUEST with res.nextCursor.
  };

  socket.on("connect",                       requestReplay);
  socket.on(SYNC_EVENTS.REPLAY_RESPONSE,     handleResponse);

  // Fire once for the current session (in case we're already connected)
  if (socket.connected) requestReplay();

  return () => {
    socket.off("connect",                    requestReplay);
    socket.off(SYNC_EVENTS.REPLAY_RESPONSE,  handleResponse);
  };
}
