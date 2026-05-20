import type { EventEnvelope, ReplayResponse } from "@relay/contracts";
import { SyncRepository } from "./sync.repository.js";

// ─────────────────────────────────────────────────────────────────────────────
// SAFEGUARD 8 — ACK is the truth source.
//
// Three responsibilities:
//   1. record(envelope, recipientId) — persist an emit to the outbox with
//      ackedAt=null. Caller emits AFTER this so we cannot lose an envelope
//      between "sent" and "recorded".
//   2. markAcked(eventId, recipientId) — stamp ackedAt when the recipient
//      confirms. Called from withAck on every successful ACK round-trip.
//   3. replayFor(userId, sinceISO, limit) — return ONLY un-ACKed events
//      since the cursor. ACKed events are never re-emitted, even on replay.
//
// Anything that emits to a user MUST go through record() first. Anything that
// receives an ACK MUST call markAcked(). These two invariants are what keep
// the reconciliation engine honest.
// ─────────────────────────────────────────────────────────────────────────────

export class SyncService {
  constructor(private repo: SyncRepository) {}

  async record(envelope: EventEnvelope, recipientId: string): Promise<void> {
    await this.repo.record(envelope, recipientId);
  }

  async markAcked(eventId: string, recipientId: string): Promise<void> {
    await this.repo.markAcked(eventId, recipientId);
  }

  async replayFor(userId: string, sinceISO: string, limit?: number): Promise<ReplayResponse> {
    const since = new Date(sinceISO);
    if (Number.isNaN(since.getTime())) {
      throw new Error("invalid 'since' cursor — expected ISO date-time");
    }
    return this.repo.fetchPendingSince(userId, since, limit);
  }
}
