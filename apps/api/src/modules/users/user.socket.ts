import type { FastifyInstance } from "fastify";
import { USER_EVENTS, type UserProfileUpdatedEvent } from "@relay/contracts";

// ─────────────────────────────────────────────────────────────────────────────
// Users socket layer — outbound only (for now).
//
//   user:profile-updated — a user changed their avatar. Fanned out to everyone
//   who shares a conversation with them, plus the user's own other tabs so a
//   multi-tab session stays consistent.
// ─────────────────────────────────────────────────────────────────────────────

/** Notify co-participants (+ the user's own other tabs) of a profile change. */
export async function broadcastProfileUpdate(
  fastify:   FastifyInstance,
  userId:    string,
  avatarUrl: string | null,
): Promise<void> {
  // Everyone in any conversation that includes this user — which already
  // includes the user themself. distinct keeps it one emit per recipient.
  const rows = await fastify.prisma.participant.findMany({
    where:    { conversation: { participants: { some: { userId } } } },
    select:   { userId: true },
    distinct: ["userId"],
  });

  const event: UserProfileUpdatedEvent = { userId, avatarUrl };
  const recipientIds = new Set(rows.map((r) => r.userId));
  recipientIds.add(userId); // covers a user with no conversations yet

  for (const id of recipientIds) {
    fastify.io.to(`user:${id}`).emit(USER_EVENTS.PROFILE_UPDATED, event);
  }
}
