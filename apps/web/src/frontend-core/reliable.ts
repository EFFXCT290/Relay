"use client";

import {
  ACK_BACKOFF_BASE,
  ACK_EVENT,
  ACK_MAX_ATTEMPTS,
  ACK_TIMEOUT_MS,
  type Ack,
  type EventEnvelope,
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
//
// Reconnect replay itself is NOT implemented here — see the per-conversation
// reconnect handler in app/(app)/conversations/[id]/page.tsx, which emits
// SYNC_EVENTS.REPLAY_REQUEST directly and falls back to the HTTP replay
// endpoint on a socket-side failure. A generic bindReconnectReplay() helper
// used to live here but had no callers and was removed.
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
