import type { FastifyInstance } from "fastify";
import {
  MESSAGE_EVENTS,
  type MessageDeliveredEvent,
} from "@relay/contracts";

// ─────────────────────────────────────────────────────────────────────────────
// MessageService — owns side effects for the messages domain that are NOT
// tied to a single HTTP request. Today that's the on-connect delivery sweep;
// future work will move the per-message create/edit/delete/react paths here
// so the routes shrink to thin Fastify wrappers.
//
// What lives here:
//   - sweepUndelivered(userId): on socket connect, mark every undelivered
//     message addressed to this user as delivered and notify each sender
//     so their ✓ flips to ✓✓ without anyone opening a chat.
//
// What does NOT live here:
//   - "is the recipient online?" — that's a PresenceService concern (and
//     even that's just a hint per SAFEGUARD 9). The actual delivered state
//     comes from this sweep + the create-time check in message.routes.ts.
// ─────────────────────────────────────────────────────────────────────────────

export class MessageService {
  constructor(private fastify: FastifyInstance) {}

  // Called from plugins/socket.ts on every new connection. Idempotent and
  // safe to call concurrently — the updateMany filter excludes anything
  // already stamped, so a second invocation does nothing.
  async sweepUndelivered(userId: string): Promise<void> {
    const undelivered = await this.fastify.prisma.message.findMany({
      where: {
        conversation: { participants: { some: { userId } } },
        senderId:     { not: userId },
        isDeleted:    false,
        deliveredAt:  null,
      },
      select: { id: true, senderId: true, conversationId: true },
    });
    if (undelivered.length === 0) return;

    const deliveredAt = new Date();
    await this.fastify.prisma.message.updateMany({
      where: { id: { in: undelivered.map((m) => m.id) } },
      data:  { deliveredAt },
    });

    // Group by (sender, conversation) so each emit is well-scoped — one
    // recipient socket per sender per conversation gets a single batched event.
    const groups = new Map<
      string,
      { senderId: string; conversationId: string; ids: string[] }
    >();
    for (const m of undelivered) {
      const key = `${m.senderId}|${m.conversationId}`;
      const g = groups.get(key);
      if (g) g.ids.push(m.id);
      else groups.set(key, { senderId: m.senderId, conversationId: m.conversationId, ids: [m.id] });
    }

    const deliveredIso = deliveredAt.toISOString();
    for (const { senderId, conversationId, ids } of groups.values()) {
      const event: MessageDeliveredEvent = {
        conversationId,
        messageIds:  ids,
        deliveredAt: deliveredIso,
      };
      this.fastify.io.to(`user:${senderId}`).emit(MESSAGE_EVENTS.DELIVERED, event);
    }
  }
}
