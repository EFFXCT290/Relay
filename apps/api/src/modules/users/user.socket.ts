import type { FastifyInstance } from "fastify";
import { USER_EVENTS, type UserProfileUpdatedEvent } from "@relay/contracts";
import { connectedUserIds } from "../conversations/connection.service.js";

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

  const candidateIds = rows.map((r) => r.userId).filter((id) => id !== userId);
  // Same gate as every HTTP avatarUrl response (see connection.service.ts):
  // a co-participant only gets the real URL once BOTH sides have accepted —
  // otherwise this live push would bypass the HTTP-side gating entirely.
  const connected = await connectedUserIds(fastify, userId, candidateIds);

  const realEvent:     UserProfileUpdatedEvent = { userId, avatarUrl };
  const redactedEvent: UserProfileUpdatedEvent = { userId, avatarUrl: null };

  fastify.io.to(`user:${userId}`).emit(USER_EVENTS.PROFILE_UPDATED, realEvent); // the uploader's own other tabs
  for (const id of candidateIds) {
    const event = connected.has(id) ? realEvent : redactedEvent;
    fastify.io.to(`user:${id}`).emit(USER_EVENTS.PROFILE_UPDATED, event);
  }
}
