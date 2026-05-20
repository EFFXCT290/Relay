import type { PrismaClient } from "@prisma/client";
import type { EventEnvelope } from "@relay/contracts";

// ─────────────────────────────────────────────────────────────────────────────
// SAFEGUARD 4 — load-bearing reconciliation engine.
// SAFEGUARD 8 — ACK is the immutable truth source.
//
// The outbox is the system's authoritative record of "what was emitted to
// whom, and did it land?". Replay returns only the rows where the recipient
// has NOT yet ACKed — never re-emits events that the ACK protocol confirms
// were delivered. This is what keeps sync and ack from disagreeing.
//
// The sync module MUST NOT depend on socket internals, frontend logic, or
// other domain modules. Stays a pure outbox reader/writer.
//
// REQUIRED Prisma model (add to apps/api/prisma/schema.prisma):
//
//   model EventOutbox {
//     id           String    @id @default(uuid()) @db.Uuid
//     eventId      String    @unique @db.Uuid          // matches EventEnvelope.eventId
//     eventName    String
//     payload      Json
//     recipientId  String    @db.Uuid                  // who should see this on replay
//     createdAt    DateTime  @default(now())
//     ackedAt      DateTime?                            // SAFEGUARD 8 — null until ACK received
//
//     @@index([recipientId, ackedAt, createdAt])
//   }
//
// Run `pnpm prisma migrate dev --name add_event_outbox` after adding the model.
// Until then, the methods below are typed but no-op.
// ─────────────────────────────────────────────────────────────────────────────

export class SyncRepository {
  constructor(private prisma: PrismaClient) {}

  // Record an emitted event (ackedAt=null implicit). Caller emits AFTER this.
  async record(envelope: EventEnvelope, recipientId: string): Promise<void> {
    // TODO once EventOutbox model exists:
    // await this.prisma.eventOutbox.create({
    //   data: {
    //     eventId:     envelope.eventId,
    //     eventName:   envelope.eventName,
    //     payload:     envelope.payload as never,
    //     recipientId,
    //     createdAt:   new Date(envelope.timestamp),
    //   },
    // });
    void this.prisma; void envelope; void recipientId;
  }

  // Stamp ackedAt when the recipient confirms receipt. Idempotent — repeat
  // calls (from retried ACKs) are no-ops on already-ACKed rows.
  async markAcked(eventId: string, recipientId: string): Promise<void> {
    // TODO once EventOutbox model exists:
    // await this.prisma.eventOutbox.updateMany({
    //   where:  { eventId, recipientId, ackedAt: null },
    //   data:   { ackedAt: new Date() },
    // });
    void this.prisma; void eventId; void recipientId;
  }

  // Replay returns ONLY un-ACKed events since the cursor — that's the
  // SAFEGUARD 8 invariant in code form. Already-ACKed events are never
  // re-emitted, no matter the cursor.
  async fetchPendingSince(
    recipientId: string,
    since: Date,
    limit = 100,
  ): Promise<{ events: EventEnvelope[]; nextCursor: string | null }> {
    // TODO once EventOutbox model exists:
    // const rows = await this.prisma.eventOutbox.findMany({
    //   where:   {
    //     recipientId,
    //     ackedAt:   null,                  // ← ACK is truth
    //     createdAt: { gt: since },
    //   },
    //   orderBy: { createdAt: "asc" },
    //   take:    limit + 1,
    // });
    // const hasMore = rows.length > limit;
    // const events  = rows.slice(0, limit).map((r) => ({
    //   eventId:   r.eventId,
    //   eventName: r.eventName,
    //   payload:   r.payload,
    //   timestamp: r.createdAt.toISOString(),
    // })) satisfies EventEnvelope[];
    // const nextCursor = hasMore ? events[events.length - 1].timestamp : null;
    // return { events, nextCursor };
    void this.prisma; void recipientId; void since; void limit;
    return { events: [], nextCursor: null };
  }
}
