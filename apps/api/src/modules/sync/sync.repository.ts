import type { PrismaClient } from "@prisma/client";
import type { EventEnvelope } from "@relay/contracts";

// ─────────────────────────────────────────────────────────────────────────────
// SAFEGUARD 4 — load-bearing reconciliation engine.
// SAFEGUARD 8 — ACK is the immutable truth source.
//
// The outbox is the system's authoritative record of "what was emitted to
// whom, and did it land?". Replay returns only the rows where the recipient
// has NOT yet ACKed — never re-emits events that the ACK protocol confirms
// were delivered.
//
// The sync module MUST NOT depend on socket internals, frontend logic, or
// other domain modules. Stays a pure outbox reader/writer.
// ─────────────────────────────────────────────────────────────────────────────

export class SyncRepository {
  constructor(private prisma: PrismaClient) {}

  async record(
    envelope:       EventEnvelope,
    recipientId:    string,
    conversationId?: string,
  ): Promise<void> {
    await this.prisma.eventOutbox.create({
      data: {
        eventId:       envelope.eventId,
        eventName:     envelope.eventName,
        conversationId,
        payload:       envelope.payload as never,
        recipientId,
        createdAt:     new Date(envelope.timestamp),
      },
    });
  }

  // Stamp ackedAt when the recipient confirms receipt. Idempotent — repeat
  // calls (from retried ACKs) are no-ops on already-ACKed rows.
  async markAcked(eventId: string, recipientId: string): Promise<void> {
    await this.prisma.eventOutbox.updateMany({
      where: { eventId, recipientId, ackedAt: null },
      data:  { ackedAt: new Date() },
    });
  }

  // Replay returns ONLY un-ACKed events since the cursor.
  // conversationId narrows the result to one thread; omit for user-global events.
  // Ordering: createdAt ASC, then id ASC as a tiebreaker for same-millisecond
  // events so replay order is deterministic under burst load.
  async fetchPendingSince(
    recipientId:     string,
    since:           Date,
    limit           = 100,
    conversationId?: string,
  ): Promise<{ events: EventEnvelope[]; nextCursor: string | null }> {
    const rows = await this.prisma.eventOutbox.findMany({
      where: {
        recipientId,
        ackedAt:   null,
        createdAt: { gt: since },
        ...(conversationId ? { conversationId } : {}),
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take:    limit + 1,
    });
    const hasMore    = rows.length > limit;
    const slice      = rows.slice(0, limit);
    const events     = slice.map((r) => ({
      eventId:   r.eventId,
      eventName: r.eventName,
      payload:   r.payload,
      timestamp: r.createdAt.toISOString(),
    })) satisfies EventEnvelope[];
    const nextCursor = hasMore ? (events[events.length - 1]?.timestamp ?? null) : null;
    return { events, nextCursor };
  }
}
